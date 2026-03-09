import { randomBytes } from "crypto";
import { azureApi, pollOperation, getToken, rgPath } from "../../clouds/azure.js";
import { getProviderMeta, setProviderMeta } from "../../config.js";

export var IS_POSTGRES = true;

var PG_API = "2023-06-01-preview";
var SERVER_NAME_PREFIX = "relight-pg";

function userName(name) {
  return `app_${name.replace(/-/g, "_")}`;
}

function appUserName(dbAppName, appName) {
  return `app_${dbAppName.replace(/-/g, "_")}_${appName.replace(/-/g, "_")}`;
}

function dbName(name) {
  return `relight_${name.replace(/-/g, "_")}`;
}

async function connectPg(connectionUrl) {
  var pg = await import("pg");
  var Client = pg.default?.Client || pg.Client;
  var client = new Client({ connectionString: connectionUrl });
  await client.connect();
  return client;
}

function serverPath(cfg, serverName) {
  return `${rgPath(cfg)}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${serverName}`;
}

// --- Shared server management ---

async function getOrCreateSharedServer(cfg) {
  var token = await getToken(cfg);
  var meta = getProviderMeta(cfg.providerName, "sharedDb");

  if (meta && meta.server) {
    // Verify server still exists
    try {
      var server = await azureApi("GET", serverPath(cfg, meta.server), null, token, { apiVersion: PG_API });
      if (server.properties?.state === "Ready") {
        var fqdn = server.properties?.fullyQualifiedDomainName;
        if (fqdn && fqdn !== meta.host) {
          meta.host = fqdn;
          setProviderMeta(cfg.providerName, "sharedDb", meta);
        }
        return meta;
      }
    } catch {}
  }

  // Create a new Flexible Server
  var serverName = `${SERVER_NAME_PREFIX}-${cfg.subscriptionId.slice(0, 8)}`;
  var adminPassword = randomBytes(24).toString("base64url");
  var location = cfg.location || "eastus";

  process.stderr.write("  Creating shared PostgreSQL server (one-time, takes 5-15 minutes)...\n");

  await pollOperation("PUT", serverPath(cfg, serverName), {
    location,
    sku: { name: "Standard_B1ms", tier: "Burstable" },
    properties: {
      version: "15",
      administratorLogin: "relight_admin",
      administratorLoginPassword: adminPassword,
      storage: { storageSizeGB: 32 },
      backup: { backupRetentionDays: 7, geoRedundantBackup: "Disabled" },
      highAvailability: { mode: "Disabled" },
    },
  }, token, { apiVersion: PG_API });

  // Enable public access via firewall rule (allow all IPs)
  var fwPath = `${serverPath(cfg, serverName)}/firewallRules/allow-all`;
  await pollOperation("PUT", fwPath, {
    properties: { startIpAddress: "0.0.0.0", endIpAddress: "255.255.255.255" },
  }, token, { apiVersion: PG_API });

  // Get FQDN
  var created = await azureApi("GET", serverPath(cfg, serverName), null, token, { apiVersion: PG_API });
  var host = created.properties?.fullyQualifiedDomainName;
  if (!host) throw new Error("No FQDN returned for PostgreSQL server.");

  meta = {
    server: serverName,
    host,
    port: "5432",
    masterPassword: adminPassword,
  };
  setProviderMeta(cfg.providerName, "sharedDb", meta);

  return meta;
}

async function connectAsAdmin(cfg) {
  var meta = getProviderMeta(cfg.providerName, "sharedDb");
  if (!meta || !meta.masterPassword) {
    throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
  }
  var url = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/postgres?sslmode=require`;
  var client = await connectPg(url);
  return { client, meta };
}

function buildConnectionUrl(user, password, meta, database) {
  return `postgresql://${user}:${encodeURIComponent(password)}@${meta.host}:${meta.port}/${database}?sslmode=require`;
}

async function destroySharedServerIfEmpty(cfg) {
  var { client } = await connectAsAdmin(cfg);
  try {
    var res = await client.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'relight_%'"
    );
    if (res.rows.length > 0) return false;
  } finally {
    await client.end();
  }

  var token = await getToken(cfg);
  var meta = getProviderMeta(cfg.providerName, "sharedDb");
  await pollOperation("DELETE", serverPath(cfg, meta.server), null, token, { apiVersion: PG_API });
  setProviderMeta(cfg.providerName, "sharedDb", undefined);
  return true;
}

// --- Public API ---

export async function createDatabase(cfg, name) {
  var meta = await getOrCreateSharedServer(cfg);
  var database = dbName(name);
  var user = userName(name);
  var password = randomBytes(24).toString("base64url");

  var adminUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/postgres?sslmode=require`;
  var client = await connectPg(adminUrl);
  try {
    await client.query(`CREATE USER ${user} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    await client.query(`CREATE DATABASE ${database} OWNER ${user}`);
  } finally {
    await client.end();
  }

  var connectionUrl = buildConnectionUrl(user, password, meta, database);

  return {
    dbId: meta.server,
    dbName: database,
    dbUser: user,
    dbToken: password,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, name, opts = {}) {
  var database = dbName(name);
  var user = userName(name);
  var appUserPrefix = `app_${name.replace(/-/g, "_")}_`;

  var { client } = await connectAsAdmin(cfg);
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`
    );
    await client.query(`DROP DATABASE IF EXISTS ${database}`);

    // Drop all per-app users (app_<dbName>_<appName>)
    var rolesRes = await client.query(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE $1", [appUserPrefix + "%"]
    );
    for (var row of rolesRes.rows) {
      await client.query(`DROP USER IF EXISTS ${row.rolname}`);
    }

    await client.query(`DROP USER IF EXISTS ${user}`);
  } finally {
    await client.end();
  }

  await destroySharedServerIfEmpty(cfg);
}

export async function getDatabaseInfo(cfg, name, opts = {}) {
  var database = dbName(name);
  var meta = getProviderMeta(cfg.providerName, "sharedDb");
  if (!meta) throw new Error("No shared PostgreSQL server found.");

  var displayUser = userName(name);
  var connectionUrl = meta.host
    ? `postgresql://${displayUser}:****@${meta.host}:${meta.port}/${database}?sslmode=require`
    : null;

  return {
    dbId: meta.server,
    dbName: database,
    connectionUrl,
    size: null,
    numTables: null,
    createdAt: null,
  };
}

export async function queryDatabase(cfg, name, sql, params, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}?sslmode=require`;
  }

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

export async function importDatabase(cfg, name, sqlContent, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}?sslmode=require`;
  }

  var client = await connectPg(connectionUrl);
  try {
    await client.query(sqlContent);
  } finally {
    await client.end();
  }
}

export async function exportDatabase(cfg, name, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}?sslmode=require`;
  }

  var database = dbName(name);
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

export async function rotateToken(cfg, name, opts = {}) {
  var newPassword = randomBytes(24).toString("base64url");
  var database = dbName(name);
  var user = userName(name);

  var { client, meta } = await connectAsAdmin(cfg);
  try {
    await client.query(`ALTER USER ${user} WITH PASSWORD '${newPassword.replace(/'/g, "''")}'`);
  } finally {
    await client.end();
  }

  var connectionUrl = buildConnectionUrl(user, newPassword, meta, database);
  return { dbToken: newPassword, connectionUrl };
}

export async function resetDatabase(cfg, name, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}?sslmode=require`;
  }

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

export async function listManagedDatabases(cfg) {
  var { client, meta } = await connectAsAdmin(cfg);
  try {
    var res = await client.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'relight_%' ORDER BY datname"
    );
    return res.rows.map((r) => ({
      name: r.datname.replace(/^relight_/, "").replace(/_/g, "-"),
      dbName: r.datname,
      dbId: meta.server,
      connectionUrl: `postgresql://${userName(r.datname.replace(/^relight_/, ""))}:****@${meta.host}:${meta.port}/${r.datname}?sslmode=require`,
    }));
  } finally {
    await client.end();
  }
}

export async function getAttachCredentials(cfg, dbAppName, appName) {
  var { client, meta } = await connectAsAdmin(cfg);
  var database = dbName(dbAppName);
  var user = appUserName(dbAppName, appName);
  var password = randomBytes(24).toString("base64url");

  try {
    var exists = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1", [user]
    );
    if (exists.rows.length > 0) {
      await client.query(`ALTER USER ${user} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    } else {
      await client.query(`CREATE USER ${user} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    }

    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
  } finally {
    await client.end();
  }

  // Grant schema-level privileges (must connect to the target database)
  var dbUrl = buildConnectionUrl("relight_admin", meta.masterPassword, meta, database);
  var dbClient = await connectPg(dbUrl);
  try {
    await dbClient.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
    await dbClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${user}`);
    await dbClient.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO ${user}`);
  } finally {
    await dbClient.end();
  }

  var connectionUrl = buildConnectionUrl(user, password, meta, database);
  return { connectionUrl, token: password, isPostgres: true };
}

export async function revokeAppAccess(cfg, dbAppName, appName) {
  var { client, meta } = await connectAsAdmin(cfg);
  var database = dbName(dbAppName);
  var user = appUserName(dbAppName, appName);

  try {
    var exists = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1", [user]
    );
    if (exists.rows.length === 0) return;

    await client.query(`REVOKE CONNECT ON DATABASE ${database} FROM ${user}`);
  } finally {
    await client.end();
  }

  var dbUrl = buildConnectionUrl("relight_admin", meta.masterPassword, meta, database);
  var dbClient = await connectPg(dbUrl);
  try {
    await dbClient.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${user}`);
    await dbClient.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${user}`);
    await dbClient.query(`REVOKE USAGE ON SCHEMA public FROM ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${user}`);
  } finally {
    await dbClient.end();
  }

  var adminUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/postgres?sslmode=require`;
  var adminClient = await connectPg(adminUrl);
  try {
    await adminClient.query(`DROP USER IF EXISTS ${user}`);
  } finally {
    await adminClient.end();
  }
}
