import {
  createD1Database,
  deleteD1Database,
  getD1Database,
  queryD1,
  exportD1,
  importD1,
  getWorkersSubdomain,
} from "../../clouds/cf.js";
import { randomBytes } from "crypto";

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
  if (!opts.dbId) {
    throw new Error("dbId is required to destroy a CF database.");
  }
  await deleteD1Database(cfg.accountId, cfg.apiToken, opts.dbId);
}

export async function getDatabaseInfo(cfg, name, opts = {}) {
  if (!opts.dbId) {
    throw new Error("dbId is required to get CF database info.");
  }

  var dbDetails = await getD1Database(cfg.accountId, cfg.apiToken, opts.dbId);
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${name}.${subdomain}.workers.dev`
    : null;

  return {
    dbId: opts.dbId,
    dbName: dbDetails.name || `relight-${name}`,
    connectionUrl,
    size: dbDetails.file_size,
    numTables: dbDetails.num_tables,
    createdAt: dbDetails.created_at,
  };
}

export async function queryDatabase(cfg, name, sql, params, opts = {}) {
  if (!opts.dbId) {
    throw new Error("dbId is required to query a CF database.");
  }
  return queryD1(cfg.accountId, cfg.apiToken, opts.dbId, sql, params);
}

export async function importDatabase(cfg, name, sqlContent, opts = {}) {
  if (!opts.dbId) {
    throw new Error("dbId is required to import into a CF database.");
  }
  var dbId = opts.dbId;

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
  if (!opts.dbId) {
    throw new Error("dbId is required to export a CF database.");
  }
  var dbId = opts.dbId;

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
  if (!opts.dbId) {
    throw new Error("dbId is required to reset a CF database.");
  }
  var dbId = opts.dbId;

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
