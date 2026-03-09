import {
  listGroups,
  createGroup,
  listDatabases,
  createDatabase as tursoCreateDb,
  deleteDatabase as tursoDeleteDb,
  getDatabase,
  createAuthToken,
  queryPipeline,
  getDatabaseDump,
} from "../../clouds/turso.js";
import { getProviderMeta, setProviderMeta } from "../../config.js";

export var IS_POSTGRES = false;

function tursoDbName(appName) {
  return `relight-${appName}`;
}

function dbUrl(dbName, orgSlug) {
  return `libsql://${dbName}-${orgSlug}.turso.io`;
}

async function getOrCreateSharedGroup(cfg) {
  var meta = getProviderMeta(cfg.providerName, "sharedGroup");

  if (meta) {
    // Verify group still exists
    try {
      var groups = await listGroups(cfg.apiToken, cfg.orgSlug);
      var found = groups.find((g) => g.name === meta);
      if (found) return meta;
    } catch {
      // Fall through to create
    }
  }

  // Find existing "relight" group or create one
  var groups = await listGroups(cfg.apiToken, cfg.orgSlug);
  var existing = groups.find((g) => g.name === "relight");

  if (existing) {
    setProviderMeta(cfg.providerName, "sharedGroup", "relight");
    return "relight";
  }

  process.stderr.write("  Creating shared Turso group...\n");
  await createGroup(cfg.apiToken, cfg.orgSlug, "relight", "ord");
  setProviderMeta(cfg.providerName, "sharedGroup", "relight");
  return "relight";
}

function parseHranaResult(result) {
  if (!result || result.type === "error") {
    var msg = result?.error?.message || "Query error";
    throw new Error(msg);
  }

  var response = result.response;
  if (!response || response.type !== "execute") return { results: [], meta: {} };

  var execResult = response.result;
  var cols = (execResult.cols || []).map((c) => c.name);
  var rows = (execResult.rows || []).map((row) =>
    Object.fromEntries(cols.map((c, i) => [c, extractValue(row[i])]))
  );

  return {
    results: rows,
    meta: {
      changes: execResult.affected_row_count || 0,
      rows_read: rows.length,
    },
  };
}

function extractValue(cell) {
  if (!cell) return null;
  if (cell.type === "null") return null;
  if (cell.type === "integer") return Number(cell.value);
  if (cell.type === "float") return Number(cell.value);
  if (cell.type === "text") return cell.value;
  if (cell.type === "blob") return cell.value;
  return cell.value;
}

// --- Public API ---

export async function createDatabase(cfg, appName, opts = {}) {
  var group = await getOrCreateSharedGroup(cfg);
  var name = tursoDbName(appName);

  await tursoCreateDb(cfg.apiToken, cfg.orgSlug, name, group);

  // Create auth token
  var token = await createAuthToken(cfg.apiToken, cfg.orgSlug, name);
  var connectionUrl = dbUrl(name, cfg.orgSlug);

  return {
    dbId: name,
    dbName: name,
    dbToken: token,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, appName, opts = {}) {
  var name = tursoDbName(appName);

  try {
    await tursoDeleteDb(cfg.apiToken, cfg.orgSlug, name);
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }
}

export async function getDatabaseInfo(cfg, appName, opts = {}) {
  var name = tursoDbName(appName);

  var db = await getDatabase(cfg.apiToken, cfg.orgSlug, name);
  var connectionUrl = dbUrl(name, cfg.orgSlug);

  return {
    dbId: name,
    dbName: name,
    connectionUrl,
    size: db.db_size_bytes || null,
    numTables: null,
    createdAt: null,
  };
}

export async function queryDatabase(cfg, appName, sql, params, opts = {}) {
  var name = tursoDbName(appName);
  var connectionUrl = dbUrl(name, cfg.orgSlug);

  // Create ephemeral auth token
  var token = await createAuthToken(cfg.apiToken, cfg.orgSlug, name);

  var stmt = params && params.length > 0
    ? { sql, args: params.map((p) => ({ type: "text", value: String(p) })) }
    : sql;

  var results = await queryPipeline(connectionUrl, token, [stmt]);
  return parseHranaResult(results[0]);
}

export async function importDatabase(cfg, appName, sqlContent, opts = {}) {
  var name = tursoDbName(appName);
  var connectionUrl = dbUrl(name, cfg.orgSlug);
  var token = await createAuthToken(cfg.apiToken, cfg.orgSlug, name);

  // Split SQL into individual statements
  var statements = sqlContent
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  // Execute in batches of 20 to avoid pipeline limits
  var batchSize = 20;
  for (var i = 0; i < statements.length; i += batchSize) {
    var batch = statements.slice(i, i + batchSize);
    await queryPipeline(connectionUrl, token, batch);
  }
}

export async function exportDatabase(cfg, appName, opts = {}) {
  var name = tursoDbName(appName);

  try {
    return await getDatabaseDump(cfg.apiToken, cfg.orgSlug, name);
  } catch {
    // Fallback: manual export via queries
    var connectionUrl = dbUrl(name, cfg.orgSlug);
    var token = await createAuthToken(cfg.apiToken, cfg.orgSlug, name);

    var tablesResult = await queryPipeline(connectionUrl, token, [
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ]);
    var parsed = parseHranaResult(tablesResult[0]);
    var tables = parsed.results.map((r) => r.name);

    var dump = [];
    dump.push("-- SQLite dump generated by relight (Turso)");
    dump.push(`-- Database: ${name}`);
    dump.push(`-- Date: ${new Date().toISOString()}`);
    dump.push("");

    for (var t of tables) {
      // Get CREATE TABLE statement
      var schemaResult = await queryPipeline(connectionUrl, token, [
        `SELECT sql FROM sqlite_master WHERE name='${t}'`,
      ]);
      var schemaParsed = parseHranaResult(schemaResult[0]);
      if (schemaParsed.results[0]?.sql) {
        dump.push(schemaParsed.results[0].sql + ";");
        dump.push("");
      }

      // Get data
      var dataResult = await queryPipeline(connectionUrl, token, [
        `SELECT * FROM "${t}"`,
      ]);
      var dataParsed = parseHranaResult(dataResult[0]);
      for (var row of dataParsed.results) {
        var values = Object.values(row).map((v) => {
          if (v === null) return "NULL";
          if (typeof v === "number") return String(v);
          return "'" + String(v).replace(/'/g, "''") + "'";
        });
        var colNames = Object.keys(row).map((c) => `"${c}"`).join(", ");
        dump.push(`INSERT INTO "${t}" (${colNames}) VALUES (${values.join(", ")});`);
      }
      dump.push("");
    }

    return dump.join("\n");
  }
}

export async function rotateToken(cfg, appName, opts = {}) {
  var name = tursoDbName(appName);
  var token = await createAuthToken(cfg.apiToken, cfg.orgSlug, name);
  var connectionUrl = dbUrl(name, cfg.orgSlug);

  return { dbToken: token, connectionUrl };
}

export async function resetDatabase(cfg, appName, opts = {}) {
  var name = tursoDbName(appName);
  var connectionUrl = dbUrl(name, cfg.orgSlug);
  var token = await createAuthToken(cfg.apiToken, cfg.orgSlug, name);

  var tablesResult = await queryPipeline(connectionUrl, token, [
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ]);
  var parsed = parseHranaResult(tablesResult[0]);
  var tables = parsed.results.map((r) => r.name);

  for (var t of tables) {
    await queryPipeline(connectionUrl, token, [`DROP TABLE IF EXISTS "${t}"`]);
  }

  return tables;
}

// --- Stateless API ---

export async function listManagedDatabases(cfg) {
  var databases = await listDatabases(cfg.apiToken, cfg.orgSlug);
  return databases
    .filter((db) => db.Name ? db.Name.startsWith("relight-") : (db.name || "").startsWith("relight-"))
    .map((db) => ({
      name: (db.Name || db.name || "").replace(/^relight-/, ""),
      dbName: db.Name || db.name,
      dbId: db.Name || db.name,
      connectionUrl: dbUrl(db.Name || db.name, cfg.orgSlug),
    }));
}

export async function getAttachCredentials(cfg, dbAppName, appName) {
  var name = tursoDbName(dbAppName);
  var token = await createAuthToken(cfg.apiToken, cfg.orgSlug, name);
  var connectionUrl = dbUrl(name, cfg.orgSlug);

  return { connectionUrl, token, isPostgres: false };
}
