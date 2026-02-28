import {
  createD1Database,
  deleteD1Database,
  getD1Database,
  queryD1,
  exportD1,
  importD1,
  getWorkersSubdomain,
} from "../../clouds/cf.js";
import { getAppConfig, pushAppConfig } from "./app.js";
import { randomBytes } from "crypto";

export async function createDatabase(cfg, appName, opts = {}) {
  if (!opts.skipAppConfig) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig) {
      throw new Error(`App ${appName} not found.`);
    }
    if (appConfig.dbId) {
      throw new Error(`App ${appName} already has a database: ${appConfig.dbName}`);
    }
  }

  var dbName = `relight-${appName}`;
  var result = await createD1Database(cfg.accountId, cfg.apiToken, dbName, {
    locationHint: opts.location,
    jurisdiction: opts.jurisdiction,
  });

  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${appName}.${subdomain}.workers.dev`
    : null;

  var dbToken = randomBytes(32).toString("hex");

  if (!opts.skipAppConfig) {
    appConfig.dbId = result.uuid;
    appConfig.dbName = dbName;

    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    if (connectionUrl) {
      appConfig.env["DB_URL"] = connectionUrl;
      if (!appConfig.envKeys.includes("DB_URL")) appConfig.envKeys.push("DB_URL");
    }

    appConfig.env["DB_TOKEN"] = "[hidden]";
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
    appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    var newSecrets = { DB_TOKEN: dbToken };

    await pushAppConfig(cfg, appName, appConfig, { newSecrets });
  }

  return {
    dbId: result.uuid,
    dbName,
    dbToken,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }

  await deleteD1Database(cfg.accountId, cfg.apiToken, dbId);

  if (!opts.dbId) {
    delete appConfig.dbId;
    delete appConfig.dbName;

    if (appConfig.env) {
      delete appConfig.env["DB_URL"];
      delete appConfig.env["DB_TOKEN"];
    }
    if (appConfig.envKeys) appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_URL");
    if (appConfig.secretKeys) appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");

    await pushAppConfig(cfg, appName, appConfig);
  }
}

export async function getDatabaseInfo(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }

  var dbDetails = await getD1Database(cfg.accountId, cfg.apiToken, dbId);
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${appName}.${subdomain}.workers.dev`
    : null;

  return {
    dbId,
    dbName: dbDetails.name || `relight-${appName}`,
    connectionUrl,
    size: dbDetails.file_size,
    numTables: dbDetails.num_tables,
    createdAt: dbDetails.created_at,
  };
}

export async function queryDatabase(cfg, appName, sql, params, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }
  return queryD1(cfg.accountId, cfg.apiToken, dbId, sql, params);
}

export async function importDatabase(cfg, appName, sqlContent, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }

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

export async function exportDatabase(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }

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

export async function rotateToken(cfg, appName, opts = {}) {
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var connectionUrl = subdomain
    ? `https://relight-${appName}.${subdomain}.workers.dev`
    : null;

  var dbToken = randomBytes(32).toString("hex");

  if (!opts.skipAppConfig) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }

    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    appConfig.env["DB_TOKEN"] = "[hidden]";
    if (!appConfig.secretKeys.includes("DB_TOKEN")) appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    if (connectionUrl) {
      appConfig.env["DB_URL"] = connectionUrl;
      if (!appConfig.envKeys.includes("DB_URL")) appConfig.envKeys.push("DB_URL");
    }

    await pushAppConfig(cfg, appName, appConfig, { newSecrets: { DB_TOKEN: dbToken } });
  }

  return { dbToken, connectionUrl };
}

export async function resetDatabase(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }

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
