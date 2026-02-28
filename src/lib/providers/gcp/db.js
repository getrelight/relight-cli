import { randomBytes } from "crypto";
import {
  mintAccessToken,
  createSqlInstance,
  getSqlInstance,
  deleteSqlInstance,
  createSqlDatabase,
  createSqlUser,
  updateSqlUser,
} from "../../clouds/gcp.js";
import { getAppConfig, pushAppConfig } from "./app.js";

function instanceName(appName) {
  return `relight-${appName}`;
}

function dbName(appName) {
  return `relight_${appName}`;
}

async function getDbPassword(cfg, appName) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);

  // Read from Cloud Run service env vars
  var { listAllServices } = await import("../../clouds/gcp.js");
  var all = await listAllServices(token, cfg.project);
  var svc = all.find((s) => s.name.split("/").pop() === `relight-${appName}`);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);

  var envVars = svc.template?.containers?.[0]?.env || [];
  var dbToken = envVars.find((e) => e.name === "DB_TOKEN");
  if (!dbToken) throw new Error("DB_TOKEN not found on service.");
  return dbToken.value;
}

async function connectPg(connectionUrl) {
  var pg = await import("pg");
  var Client = pg.default?.Client || pg.Client;
  var client = new Client({ connectionString: connectionUrl });
  await client.connect();
  return client;
}

export async function createDatabase(cfg, appName, opts = {}) {
  var region = "us-central1";

  if (!opts.skipAppConfig) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig) {
      throw new Error(`App ${appName} not found.`);
    }
    if (appConfig.dbId) {
      throw new Error(`App ${appName} already has a database: ${appConfig.dbId}`);
    }
    region = appConfig.regions?.[0] || "us-central1";
  }

  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instName = instanceName(appName);

  // Create Cloud SQL instance
  await createSqlInstance(token, cfg.project, {
    name: instName,
    region,
    databaseVersion: "POSTGRES_15",
    settings: {
      tier: "db-f1-micro",
      ipConfiguration: {
        ipv4Enabled: true,
        authorizedNetworks: [
          { name: "all", value: "0.0.0.0/0" },
        ],
      },
      backupConfiguration: { enabled: false },
    },
  });

  // Create database
  var database = dbName(appName);
  await createSqlDatabase(token, cfg.project, instName, database);

  // Create user with random password
  var password = randomBytes(24).toString("base64url");
  await createSqlUser(token, cfg.project, instName, "relight", password);

  // Get public IP
  var instance = await getSqlInstance(token, cfg.project, instName);
  var publicIp = null;
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") {
      publicIp = addr.ipAddress;
      break;
    }
  }

  if (!publicIp) throw new Error("No public IP assigned to Cloud SQL instance.");

  var connectionUrl = `postgresql://relight:${encodeURIComponent(password)}@${publicIp}:5432/${database}`;

  if (!opts.skipAppConfig) {
    // Store in app config
    appConfig.dbId = instName;
    appConfig.dbName = database;

    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    appConfig.env["DATABASE_URL"] = connectionUrl;
    if (!appConfig.envKeys.includes("DATABASE_URL")) appConfig.envKeys.push("DATABASE_URL");

    appConfig.env["DB_TOKEN"] = "[hidden]";
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
    appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    var newSecrets = { DB_TOKEN: password };
    await pushAppConfig(cfg, appName, appConfig, { newSecrets });
  }

  return {
    dbId: instName,
    dbName: database,
    dbToken: password,
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

  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  await deleteSqlInstance(token, cfg.project, dbId);

  if (!opts.dbId) {
    delete appConfig.dbId;
    delete appConfig.dbName;

    if (appConfig.env) {
      delete appConfig.env["DATABASE_URL"];
      delete appConfig.env["DB_TOKEN"];
    }
    if (appConfig.envKeys) appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DATABASE_URL");
    if (appConfig.secretKeys) appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");

    await pushAppConfig(cfg, appName, appConfig);
  }
}

export async function getDatabaseInfo(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  var dbNameVal;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
    dbNameVal = appConfig.dbName;
  }

  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instance = await getSqlInstance(token, cfg.project, dbId);

  var publicIp = null;
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") {
      publicIp = addr.ipAddress;
      break;
    }
  }

  var connectionUrl = publicIp
    ? `postgresql://relight:****@${publicIp}:5432/${appConfig.dbName}`
    : null;

  return {
    dbId,
    dbName: dbNameVal || dbName(appName),
    connectionUrl,
    size: null,
    numTables: null,
    createdAt: instance.createTime || null,
  };
}

export async function queryDatabase(cfg, appName, sql, params, opts = {}) {
  var dbId = opts.dbId;
  var database;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
    database = appConfig.dbName;
  } else {
    database = dbName(appName);
  }

  var password = await getDbPassword(cfg, appName);
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instance = await getSqlInstance(token, cfg.project, dbId);

  var publicIp = null;
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") {
      publicIp = addr.ipAddress;
      break;
    }
  }

  var connectionUrl = `postgresql://relight:${encodeURIComponent(password)}@${publicIp}:5432/${database}`;
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
  var dbId = opts.dbId;
  var database;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
    database = appConfig.dbName;
  } else {
    database = dbName(appName);
  }

  var password = await getDbPassword(cfg, appName);
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instance = await getSqlInstance(token, cfg.project, dbId);

  var publicIp = null;
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") {
      publicIp = addr.ipAddress;
      break;
    }
  }

  var connectionUrl = `postgresql://relight:${encodeURIComponent(password)}@${publicIp}:5432/${database}`;
  var client = await connectPg(connectionUrl);

  try {
    await client.query(sqlContent);
  } finally {
    await client.end();
  }
}

export async function exportDatabase(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  var database;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
    database = appConfig.dbName;
  } else {
    database = dbName(appName);
  }

  var password = await getDbPassword(cfg, appName);
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instance = await getSqlInstance(token, cfg.project, dbId);

  var publicIp = null;
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") {
      publicIp = addr.ipAddress;
      break;
    }
  }

  var connectionUrl = `postgresql://relight:${encodeURIComponent(password)}@${publicIp}:5432/${database}`;
  var client = await connectPg(connectionUrl);

  try {
    // Get all user tables
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
      // Get CREATE TABLE via information_schema
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

      // Dump data
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
  var dbId = opts.dbId;
  var database;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
    database = appConfig.dbName;
  } else {
    database = dbName(appName);
  }

  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var newPassword = randomBytes(24).toString("base64url");

  // Update SQL user password
  await updateSqlUser(token, cfg.project, dbId, "relight", newPassword);

  // Get public IP for connection URL
  var instance = await getSqlInstance(token, cfg.project, dbId);
  var publicIp = null;
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") {
      publicIp = addr.ipAddress;
      break;
    }
  }

  var connectionUrl = publicIp
    ? `postgresql://relight:${encodeURIComponent(newPassword)}@${publicIp}:5432/${database}`
    : null;

  if (!opts.skipAppConfig) {
    if (!appConfig) {
      appConfig = await getAppConfig(cfg, appName);
    }

    // Update app config
    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    appConfig.env["DB_TOKEN"] = "[hidden]";
    if (!appConfig.secretKeys.includes("DB_TOKEN")) appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    if (connectionUrl) {
      appConfig.env["DATABASE_URL"] = connectionUrl;
      if (!appConfig.envKeys.includes("DATABASE_URL")) appConfig.envKeys.push("DATABASE_URL");
    }

    await pushAppConfig(cfg, appName, appConfig, { newSecrets: { DB_TOKEN: newPassword } });
  }

  return { dbToken: newPassword, connectionUrl };
}

export async function resetDatabase(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  var database;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
    database = appConfig.dbName;
  } else {
    database = dbName(appName);
  }

  var password = await getDbPassword(cfg, appName);
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instance = await getSqlInstance(token, cfg.project, dbId);

  var publicIp = null;
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") {
      publicIp = addr.ipAddress;
      break;
    }
  }

  var connectionUrl = `postgresql://relight:${encodeURIComponent(password)}@${publicIp}:5432/${database}`;
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
