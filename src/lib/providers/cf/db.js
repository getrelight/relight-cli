import {
  createD1Database,
  deleteD1Database,
  getD1Database,
  queryD1,
  exportD1,
  importD1,
  getWorkersSubdomain,
  listD1Databases,
} from "../../clouds/cf.js";
import { randomBytes } from "crypto";

export var IS_POSTGRES = false;

async function resolveD1Id(cfg, name) {
  var d1Name = `relight-${name}`;
  var databases = await listD1Databases(cfg.accountId, cfg.apiToken);
  var found = databases.find((db) => db.name === d1Name);
  if (!found) throw new Error(`D1 database '${d1Name}' not found.`);
  return found.uuid;
}

export async function createDatabase(cfg, name, opts = {}) {
  var d1Name = `relight-${name}`;
  var result = await createD1Database(cfg.accountId, cfg.apiToken, d1Name, {
    locationHint: opts.location,
    jurisdiction: opts.jurisdiction,
  });

  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${name}.${subdomain}.workers.dev`
    : null;

  var dbToken = randomBytes(32).toString("hex");

  return {
    dbId: result.uuid,
    dbName: d1Name,
    dbToken,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, name, opts = {}) {
  var dbId = opts.dbId || await resolveD1Id(cfg, name);
  await deleteD1Database(cfg.accountId, cfg.apiToken, dbId);
}

export async function getDatabaseInfo(cfg, name, opts = {}) {
  var dbId = opts.dbId || await resolveD1Id(cfg, name);

  var dbDetails = await getD1Database(cfg.accountId, cfg.apiToken, dbId);
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${name}.${subdomain}.workers.dev`
    : null;

  return {
    dbId,
    dbName: dbDetails.name || `relight-${name}`,
    connectionUrl,
    size: dbDetails.file_size,
    numTables: dbDetails.num_tables,
    createdAt: dbDetails.created_at,
  };
}

export async function queryDatabase(cfg, name, sql, params, opts = {}) {
  var dbId = opts.dbId || await resolveD1Id(cfg, name);
  return queryD1(cfg.accountId, cfg.apiToken, dbId, sql, params);
}

export async function importDatabase(cfg, name, sqlContent, opts = {}) {
  var dbId = opts.dbId || await resolveD1Id(cfg, name);

  // Step 1: Init import
  var initRes = await importD1(cfg.accountId, cfg.apiToken, dbId, {
    action: "init",
  });
  var initResult = initRes.result || initRes;

  if (!initResult.filename || !initResult.upload_url) {
    throw new Error("Import init failed - no upload URL returned.");
  }

  // Step 2: Upload to signed URL
  var uploadRes = await fetch(initResult.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: sqlContent,
  });
  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  // Step 3: Ingest
  var ingestRes = await importD1(cfg.accountId, cfg.apiToken, dbId, {
    action: "ingest",
    filename: initResult.filename,
  });

  // Step 4: Poll until complete
  var polling = true;
  while (polling) {
    await new Promise((r) => setTimeout(r, 2000));
    var pollRes = await importD1(cfg.accountId, cfg.apiToken, dbId, {
      action: "poll",
      current_bookmark: (ingestRes.result || ingestRes).at_bookmark,
    });
    var pollResult = pollRes.result || pollRes;
    if (pollResult.status === "complete" || pollResult.type === "done") {
      polling = false;
    } else if (pollResult.status === "error" || pollResult.error) {
      throw new Error(pollResult.error || "Unknown error during ingest.");
    }
  }
}

export async function exportDatabase(cfg, name, opts = {}) {
  var dbId = opts.dbId || await resolveD1Id(cfg, name);

  var exportRes = await exportD1(cfg.accountId, cfg.apiToken, dbId, {
    output_format: "polling",
  });

  var signedUrl = null;
  while (!signedUrl) {
    var exportResult = exportRes.result || exportRes;
    if (exportResult.status === "complete" && exportResult.signed_url) {
      signedUrl = exportResult.signed_url;
    } else if (exportResult.status === "error") {
      throw new Error(exportResult.error || "Unknown error.");
    } else {
      await new Promise((r) => setTimeout(r, 2000));
      exportRes = await exportD1(cfg.accountId, cfg.apiToken, dbId, {
        output_format: "polling",
        current_bookmark: exportResult.at_bookmark,
      });
    }
  }

  // Download
  var dumpRes = await fetch(signedUrl);
  if (!dumpRes.ok) {
    throw new Error(`Download failed: ${dumpRes.status}`);
  }
  return dumpRes.text();
}

export async function rotateToken(cfg, name, opts = {}) {
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${name}.${subdomain}.workers.dev`
    : null;

  var dbToken = randomBytes(32).toString("hex");

  return { dbToken, connectionUrl };
}

export async function resetDatabase(cfg, name, opts = {}) {
  var dbId = opts.dbId || await resolveD1Id(cfg, name);

  var results = await queryD1(
    cfg.accountId, cfg.apiToken, dbId,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  );
  var result = Array.isArray(results) ? results[0] : results;
  var tables = (result && result.results) ? result.results.map((r) => r.name) : [];

  for (var t of tables) {
    await queryD1(cfg.accountId, cfg.apiToken, dbId, `DROP TABLE IF EXISTS "${t}"`);
  }

  return tables;
}

// --- Stateless API ---

export async function listManagedDatabases(cfg) {
  var databases = await listD1Databases(cfg.accountId, cfg.apiToken);
  return databases
    .filter((db) => db.name && db.name.startsWith("relight-"))
    .map((db) => ({
      name: db.name.replace(/^relight-/, ""),
      dbName: db.name,
      dbId: db.uuid,
      connectionUrl: null,
    }));
}

export async function getAttachCredentials(cfg, name, appName) {
  var dbId = await resolveD1Id(cfg, name);
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${name}.${subdomain}.workers.dev`
    : null;
  var token = randomBytes(32).toString("hex");

  return { connectionUrl, token, isPostgres: false };
}
