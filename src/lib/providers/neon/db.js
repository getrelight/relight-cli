import {
  listProjects,
  createProject,
  deleteProject,
  listBranches,
  listDatabases,
  createDatabase as neonCreateDb,
  deleteDatabase as neonDeleteDb,
  listRoles,
  createRole,
  deleteRole,
  getRolePassword,
  resetRolePassword,
  getConnectionUri,
} from "../../clouds/neon.js";
import { getProviderMeta, setProviderMeta } from "../../config.js";

export var IS_POSTGRES = true;

function userName(appName) {
  return `app_${appName.replace(/-/g, "_")}`;
}

function appUserName(dbAppName, appName) {
  return `app_${dbAppName.replace(/-/g, "_")}_${appName.replace(/-/g, "_")}`;
}

function dbName(appName) {
  return `relight_${appName.replace(/-/g, "_")}`;
}

async function connectPg(connectionUrl) {
  var pg = await import("pg");
  var Client = pg.default?.Client || pg.Client;
  var client = new Client({ connectionString: connectionUrl });
  await client.connect();
  return client;
}

async function getOrCreateSharedProject(cfg) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");

  if (meta && meta.projectId) {
    // Verify project still exists
    try {
      var projects = await listProjects(cfg.apiKey);
      var found = projects.find((p) => p.id === meta.projectId);
      if (found) return meta;
    } catch {
      // Fall through to create
    }
  }

  // Find existing "relight" project or create one
  var projects = await listProjects(cfg.apiKey);
  var existing = projects.find((p) => p.name === "relight");

  var projectId;
  var branchId;

  if (existing) {
    projectId = existing.id;
    var branches = await listBranches(cfg.apiKey, projectId);
    branchId = branches.find((b) => b.primary)?.id || branches[0]?.id;
  } else {
    process.stderr.write("  Creating shared Neon project...\n");
    var result = await createProject(cfg.apiKey, { name: "relight" });
    projectId = result.project.id;
    branchId = result.branch?.id;
    if (!branchId) {
      var branches = await listBranches(cfg.apiKey, projectId);
      branchId = branches.find((b) => b.primary)?.id || branches[0]?.id;
    }
  }

  meta = { projectId, branchId };
  setProviderMeta(cfg.providerName, "sharedProject", meta);
  return meta;
}

async function destroySharedProjectIfEmpty(cfg) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) return false;

  var databases = await listDatabases(cfg.apiKey, meta.projectId, meta.branchId);
  var relightDbs = databases.filter((d) => d.name.startsWith("relight_"));
  if (relightDbs.length > 0) return false;

  // No relight databases remain - destroy the project
  await deleteProject(cfg.apiKey, meta.projectId);
  setProviderMeta(cfg.providerName, "sharedProject", undefined);
  return true;
}

// --- Public API ---

export async function createDatabase(cfg, appName, opts = {}) {
  var meta = await getOrCreateSharedProject(cfg);
  var database = dbName(appName);
  var user = userName(appName);

  // Create role (Neon auto-generates password)
  var roleResult = await createRole(cfg.apiKey, meta.projectId, meta.branchId, user);
  var password = roleResult.role?.password;

  // Create database owned by the role
  await neonCreateDb(cfg.apiKey, meta.projectId, meta.branchId, database, user);

  // Get connection URI
  var connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);

  return {
    dbId: meta.projectId,
    dbName: database,
    dbUser: user,
    dbToken: password,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, appName, opts = {}) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(appName);
  var user = userName(appName);
  var appUserPrefix = `app_${appName.replace(/-/g, "_")}_`;

  // Delete per-app roles first (app_<dbName>_<appName>)
  try {
    var branchId = meta.branchId;
    if (!branchId) {
      var branches = await listBranches(cfg.apiKey, meta.projectId);
      branchId = branches.find((b) => b.primary)?.id;
    }
    if (branchId) {
      var roles = await listRoles(cfg.apiKey, meta.projectId, branchId);
      for (var role of roles) {
        if (role.name.startsWith(appUserPrefix)) {
          try {
            await deleteRole(cfg.apiKey, meta.projectId, branchId, role.name);
          } catch {}
        }
      }
    }
  } catch {}

  // Delete database then owner role
  try {
    await neonDeleteDb(cfg.apiKey, meta.projectId, meta.branchId, database);
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }

  try {
    await deleteRole(cfg.apiKey, meta.projectId, meta.branchId, user);
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }

  // Check if shared project should be destroyed
  await destroySharedProjectIfEmpty(cfg);
}

export async function getDatabaseInfo(cfg, appName, opts = {}) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(appName);
  var user = userName(appName);

  var connectionUrl;
  try {
    connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);
    // Mask password in display URL
    connectionUrl = connectionUrl.replace(/:([^@]+)@/, ":****@");
  } catch {
    connectionUrl = null;
  }

  return {
    dbId: meta.projectId,
    dbName: database,
    connectionUrl,
    size: null,
    numTables: null,
    createdAt: null,
  };
}

export async function queryDatabase(cfg, appName, sql, params, opts = {}) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(appName);
  var user = userName(appName);

  var connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);
  var client = await connectPg(connectionUrl);

  try {
    var result = await client.query(sql, params || []);
    return {
      results: result.rows,
      meta: { changes: result.rowCount, rows_read: result.rows.length },
    };
  } finally {
    await client.end();
  }
}

export async function importDatabase(cfg, appName, sqlContent, opts = {}) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(appName);
  var user = userName(appName);

  var connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);
  var client = await connectPg(connectionUrl);

  try {
    await client.query(sqlContent);
  } finally {
    await client.end();
  }
}

export async function exportDatabase(cfg, appName, opts = {}) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(appName);
  var user = userName(appName);

  var connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);
  var client = await connectPg(connectionUrl);

  try {
    var tablesRes = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    var tables = tablesRes.rows.map((r) => r.tablename);

    var dump = [];
    dump.push("-- PostgreSQL dump generated by relight");
    dump.push(`-- Database: ${database}`);
    dump.push(`-- Date: ${new Date().toISOString()}`);
    dump.push("");

    for (var t of tables) {
      var colsRes = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`,
        [t]
      );

      var cols = colsRes.rows.map((c) => {
        var def = `  "${c.column_name}" ${c.data_type}`;
        if (c.column_default) def += ` DEFAULT ${c.column_default}`;
        if (c.is_nullable === "NO") def += " NOT NULL";
        return def;
      });

      dump.push(`CREATE TABLE IF NOT EXISTS "${t}" (`);
      dump.push(cols.join(",\n"));
      dump.push(");");
      dump.push("");

      var dataRes = await client.query(`SELECT * FROM "${t}"`);
      for (var row of dataRes.rows) {
        var values = Object.values(row).map((v) => {
          if (v === null) return "NULL";
          if (typeof v === "number") return String(v);
          if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
          return "'" + String(v).replace(/'/g, "''") + "'";
        });
        var colNames = Object.keys(row).map((c) => `"${c}"`).join(", ");
        dump.push(`INSERT INTO "${t}" (${colNames}) VALUES (${values.join(", ")});`);
      }
      dump.push("");
    }

    return dump.join("\n");
  } finally {
    await client.end();
  }
}

export async function rotateToken(cfg, appName, opts = {}) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(appName);
  var user = userName(appName);

  // Reset password via Neon API
  var result = await resetRolePassword(cfg.apiKey, meta.projectId, meta.branchId, user);
  var newPassword = result;

  // Get updated connection URI
  var connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);

  return { dbToken: newPassword, connectionUrl };
}

export async function resetDatabase(cfg, appName, opts = {}) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(appName);
  var user = userName(appName);

  var connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);
  var client = await connectPg(connectionUrl);

  try {
    var tablesRes = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    var tables = tablesRes.rows.map((r) => r.tablename);

    for (var t of tables) {
      await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }

    return tables;
  } finally {
    await client.end();
  }
}

// --- Stateless API ---

export async function listManagedDatabases(cfg) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) return [];

  var databases = await listDatabases(cfg.apiKey, meta.projectId, meta.branchId);
  return databases
    .filter((d) => d.name.startsWith("relight_"))
    .map((d) => ({
      name: d.name.replace(/^relight_/, "").replace(/_/g, "-"),
      dbName: d.name,
      dbId: meta.projectId,
      connectionUrl: null,
    }));
}

export async function getAttachCredentials(cfg, dbAppName, appName) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) throw new Error("No shared Neon project found.");

  var database = dbName(dbAppName);
  var user = appUserName(dbAppName, appName);

  // Create per-app role if it doesn't exist
  try {
    await createRole(cfg.apiKey, meta.projectId, meta.branchId, user);
  } catch (e) {
    // Role may already exist
    if (!e.message.includes("already exists") && !e.message.includes("409")) throw e;
  }

  // Grant access via SQL
  var ownerUser = userName(dbAppName);
  var ownerUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, ownerUser);
  var client = await connectPg(ownerUrl);
  try {
    await client.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${user}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${user}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${user}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO ${user}`);
  } finally {
    await client.end();
  }

  var connectionUrl = await getConnectionUri(cfg.apiKey, meta.projectId, database, user);
  return { connectionUrl, token: null, isPostgres: true };
}

export async function revokeAppAccess(cfg, dbAppName, appName) {
  var meta = getProviderMeta(cfg.providerName, "sharedProject");
  if (!meta) return;

  var user = appUserName(dbAppName, appName);

  try {
    await deleteRole(cfg.apiKey, meta.projectId, meta.branchId, user);
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }
}
