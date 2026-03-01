import { randomBytes } from "crypto";
import {
  mintAccessToken,
  createSqlInstance,
  getSqlInstance,
  deleteSqlInstance,
  createSqlDatabase,
  deleteSqlDatabase,
  createSqlUser,
  updateSqlUser,
  deleteSqlUser,
  listSqlDatabases,
} from "../../clouds/gcp.js";
import { getCloudMeta, setCloudMeta } from "../../config.js";

var SHARED_INSTANCE = "relight-shared";

function userName(name) {
  return `app_${name.replace(/-/g, "_")}`;
}

function dbName(name) {
  return `relight_${name.replace(/-/g, "_")}`;
}

function isSharedInstance(dbId) {
  return dbId === SHARED_INSTANCE;
}

async function connectPg(connectionUrl) {
  var pg = await import("pg");
  var Client = pg.default?.Client || pg.Client;
  var client = new Client({ connectionString: connectionUrl });
  await client.connect();
  return client;
}

function getPublicIp(instance) {
  for (var addr of (instance.ipAddresses || [])) {
    if (addr.type === "PRIMARY") return addr.ipAddress;
  }
  return null;
}

async function getOrCreateSharedInstance(cfg, region) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var meta = getCloudMeta("gcp", "sharedDb");

  if (meta && meta.instance) {
    // Verify instance still exists
    try {
      var instance = await getSqlInstance(token, cfg.project, SHARED_INSTANCE);
      var ip = getPublicIp(instance);
      if (ip && ip !== meta.ip) {
        meta.ip = ip;
        setCloudMeta("gcp", "sharedDb", meta);
      }
      return { token, ip: ip || meta.ip, meta };
    } catch (e) {
      // Instance gone, recreate
    }
  }

  // Create shared instance
  process.stderr.write("  Creating shared Cloud SQL instance (one-time, takes 5-15 minutes)...\n");
  await createSqlInstance(token, cfg.project, {
    name: SHARED_INSTANCE,
    region: region || "us-central1",
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

  // Create master user with random password
  var masterPassword = randomBytes(24).toString("base64url");
  await createSqlUser(token, cfg.project, SHARED_INSTANCE, "relight_admin", masterPassword);

  var instance = await getSqlInstance(token, cfg.project, SHARED_INSTANCE);
  var ip = getPublicIp(instance);
  if (!ip) throw new Error("No public IP assigned to shared Cloud SQL instance.");

  meta = { instance: SHARED_INSTANCE, ip, masterPassword };
  setCloudMeta("gcp", "sharedDb", meta);

  return { token, ip, meta };
}

async function connectAsAdmin(cfg) {
  var meta = getCloudMeta("gcp", "sharedDb");
  if (!meta || !meta.masterPassword) {
    throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
  }

  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instance = await getSqlInstance(token, cfg.project, SHARED_INSTANCE);
  var ip = getPublicIp(instance);
  if (!ip) throw new Error("No public IP on shared instance.");

  var url = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${ip}:5432/postgres`;
  var client = await connectPg(url);
  return { client, ip };
}

async function destroySharedInstanceIfEmpty(cfg) {
  var { client } = await connectAsAdmin(cfg);
  try {
    var res = await client.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'relight_%'"
    );
    if (res.rows.length > 0) return false;
  } finally {
    await client.end();
  }

  // No relight databases remain - destroy the shared instance
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  await deleteSqlInstance(token, cfg.project, SHARED_INSTANCE);
  setCloudMeta("gcp", "sharedDb", undefined);
  return true;
}

// --- Public API ---

export async function createDatabase(cfg, name, opts = {}) {
  var region = opts.location || "us-central1";

  var { token, ip, meta } = await getOrCreateSharedInstance(cfg, region);
  var database = dbName(name);
  var user = userName(name);
  var password = randomBytes(24).toString("base64url");

  // Connect as admin to create database and user
  var adminUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${ip}:5432/postgres`;
  var client = await connectPg(adminUrl);
  try {
    await client.query(`CREATE USER ${user} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    await client.query(`CREATE DATABASE ${database} OWNER ${user}`);
  } finally {
    await client.end();
  }

  var connectionUrl = `postgresql://${user}:${encodeURIComponent(password)}@${ip}:5432/${database}`;

  return {
    dbId: SHARED_INSTANCE,
    dbName: database,
    dbUser: user,
    dbToken: password,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, name, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    throw new Error("dbId is required to destroy a GCP database.");
  }

  // Legacy per-app instance: delete the whole instance
  if (!isSharedInstance(dbId)) {
    var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
    await deleteSqlInstance(token, cfg.project, dbId);
    return;
  }

  // Shared instance: drop database and user
  var database = dbName(name);
  var user = userName(name);

  var { client } = await connectAsAdmin(cfg);
  try {
    // Terminate active connections to the database
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`
    );
    await client.query(`DROP DATABASE IF EXISTS ${database}`);
    await client.query(`DROP USER IF EXISTS ${user}`);
  } finally {
    await client.end();
  }

  // Check if shared instance should be destroyed
  await destroySharedInstanceIfEmpty(cfg);
}

export async function getDatabaseInfo(cfg, name, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    throw new Error("dbId is required to get GCP database info.");
  }

  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var instance = await getSqlInstance(token, cfg.project, dbId);
  var publicIp = getPublicIp(instance);

  var displayUser = isSharedInstance(dbId) ? userName(name) : "relight";
  var database = dbName(name);

  var connectionUrl = publicIp
    ? `postgresql://${displayUser}:****@${publicIp}:5432/${database}`
    : null;

  return {
    dbId,
    dbName: database,
    connectionUrl,
    size: null,
    numTables: null,
    createdAt: instance.createTime || null,
  };
}

export async function queryDatabase(cfg, name, sql, params, opts = {}) {
  if (!opts.connectionUrl) {
    throw new Error("connectionUrl is required to query a GCP database.");
  }

  var client = await connectPg(opts.connectionUrl);

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

export async function importDatabase(cfg, name, sqlContent, opts = {}) {
  if (!opts.connectionUrl) {
    throw new Error("connectionUrl is required to import into a GCP database.");
  }

  var client = await connectPg(opts.connectionUrl);

  try {
    await client.query(sqlContent);
  } finally {
    await client.end();
  }
}

export async function exportDatabase(cfg, name, opts = {}) {
  if (!opts.connectionUrl) {
    throw new Error("connectionUrl is required to export a GCP database.");
  }

  var database = dbName(name);
  var client = await connectPg(opts.connectionUrl);

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

export async function rotateToken(cfg, name, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    throw new Error("dbId is required to rotate a GCP database token.");
  }

  var database = dbName(name);
  var newPassword = randomBytes(24).toString("base64url");
  var connectionUrl;

  if (isSharedInstance(dbId)) {
    // Update via admin connection
    var user = userName(name);
    var { client, ip } = await connectAsAdmin(cfg);
    try {
      await client.query(`ALTER USER ${user} WITH PASSWORD '${newPassword.replace(/'/g, "''")}'`);
    } finally {
      await client.end();
    }
    connectionUrl = `postgresql://${user}:${encodeURIComponent(newPassword)}@${ip}:5432/${database}`;
  } else {
    // Legacy: update via Cloud SQL API
    var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
    await updateSqlUser(token, cfg.project, dbId, "relight", newPassword);
    var instance = await getSqlInstance(token, cfg.project, dbId);
    var publicIp = getPublicIp(instance);
    connectionUrl = publicIp
      ? `postgresql://relight:${encodeURIComponent(newPassword)}@${publicIp}:5432/${database}`
      : null;
  }

  return { dbToken: newPassword, connectionUrl };
}

export async function resetDatabase(cfg, name, opts = {}) {
  if (!opts.connectionUrl) {
    throw new Error("connectionUrl is required to reset a GCP database.");
  }

  var client = await connectPg(opts.connectionUrl);

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
