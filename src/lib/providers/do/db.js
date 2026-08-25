import {
  getClusterConnection,
  createDatabaseInCluster,
  deleteDatabaseInCluster,
  createUserInCluster,
  deleteUserInCluster,
  getUserInCluster,
  getDatabaseInCluster,
} from "../../clouds/do.js";

export var IS_POSTGRES = true;

function sanitize(name) {
  return name.replace(/-/g, "_").replace(/[^a-z0-9_]/gi, "").toLowerCase();
}

function dbName(appName) {
  return `relight_${sanitize(appName)}`;
}

function userName(appName) {
  return `relight_${sanitize(appName)}`;
}

function buildConnectionUrl(user, password, host, port, db, sslmode) {
  var encodedPw = encodeURIComponent(password);
  return `postgresql://${user}:${encodedPw}@${host}:${port}/${db}?sslmode=${sslmode}`;
}

export async function createDatabase(cfg, name, opts = {}) {
  var db = dbName(name);
  var user = userName(name);

  var conn = await getClusterConnection(cfg.apiToken, cfg.clusterId);

  var dbResult = await createDatabaseInCluster(cfg.apiToken, cfg.clusterId, db);
  var userResult = await createUserInCluster(cfg.apiToken, cfg.clusterId, user);

  // Grant the app user full access to the new database's public schema.
  // The DO API has no endpoint for schema-level grants, so we connect directly as admin.
  await grantSchemaPrivileges(conn, db, userResult.name);

  var connectionUrl = buildConnectionUrl(
    userResult.name,
    userResult.password,
    conn.host,
    conn.port,
    dbResult.name,
    conn.sslmode
  );

  return {
    dbName: dbResult.name,
    dbUser: userResult.name,
    dbPassword: userResult.password,
    connectionUrl,
  };
}

async function grantSchemaPrivileges(conn, dbName, appUser) {
  var { default: pg } = await import("pg");
  var client = new pg.Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: dbName,
    ssl: conn.sslmode === "require" ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${appUser}"`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${appUser}"`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${appUser}"`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${appUser}"`);
  } finally {
    await client.end();
  }
}

export async function destroyDatabase(cfg, name) {
  var db = dbName(name);
  var user = userName(name);

  try { await deleteDatabaseInCluster(cfg.apiToken, cfg.clusterId, db); } catch {}
  try { await deleteUserInCluster(cfg.apiToken, cfg.clusterId, user); } catch {}
}

export async function getDatabaseInfo(cfg, name) {
  var db = dbName(name);
  var user = userName(name);

  var dbResult = await getDatabaseInCluster(cfg.apiToken, cfg.clusterId, db);
  if (!dbResult) throw new Error(`Database '${db}' not found in cluster.`);

  var conn = await getClusterConnection(cfg.apiToken, cfg.clusterId);

  return {
    dbName: db,
    dbUser: user,
    connectionUrl: `postgresql://${user}:***@${conn.host}:${conn.port}/${db}?sslmode=${conn.sslmode}`,
  };
}

export async function listManagedDatabases(cfg) {
  var { doApi } = await import("../../clouds/do.js");
  var res = await doApi("GET", `/databases/${cfg.clusterId}/dbs`, undefined, cfg.apiToken);
  var dbs = (res?.dbs || []).filter((d) => d.name.startsWith("relight_"));
  return dbs.map((d) => ({
    name: d.name.replace(/^relight_/, "").replace(/_/g, "-"),
    dbName: d.name,
  }));
}

export async function getAttachCredentials(cfg, name) {
  var db = dbName(name);
  var user = userName(name);
  var conn = await getClusterConnection(cfg.apiToken, cfg.clusterId);

  return {
    connectionUrl: `postgresql://${user}:***@${conn.host}:${conn.port}/${db}?sslmode=${conn.sslmode}`,
    isPostgres: true,
  };
}

// Not supported: queryDatabase, importDatabase, exportDatabase, rotateToken, resetDatabase
// These would require a direct Postgres connection via pg client — out of scope for DO logical DB.
export async function queryDatabase() {
  throw new Error("Direct SQL queries not supported for DigitalOcean managed databases via API. Use db shell with a Postgres client.");
}
export async function importDatabase() {
  throw new Error("Database import not supported for DigitalOcean provider.");
}
export async function exportDatabase() {
  throw new Error("Database export not supported for DigitalOcean provider.");
}
export async function rotateToken() {
  throw new Error("Token rotation not supported for DigitalOcean provider.");
}
export async function resetDatabase() {
  throw new Error("Database reset not supported for DigitalOcean provider.");
}
