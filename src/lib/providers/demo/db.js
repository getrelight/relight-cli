// Demo provider - database layer.
// Talks to relight-demo server, which manages PostgreSQL in Docker.

export var IS_POSTGRES = true;

async function api(cfg, method, path, body) {
  var opts = {
    method,
    headers: { "Authorization": `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    if (typeof body === "string") {
      opts.body = body;
      opts.headers["Content-Type"] = "text/plain";
    } else {
      opts.body = JSON.stringify(body);
    }
  }
  var res = await fetch(`${cfg.url}${path}`, opts);
  if (!res.ok) {
    var err = await res.text();
    throw new Error(`demo API ${method} ${path}: ${res.status} ${err}`);
  }
  return res;
}

export async function createDatabase(cfg, name, opts) {
  var res = await api(cfg, "POST", "/api/dbs", { name });
  var data = await res.json();
  return {
    dbId: data.dbName,
    dbName: data.dbName,
    dbToken: data.password,
    connectionUrl: data.connectionUrl,
  };
}

export async function destroyDatabase(cfg, name, opts) {
  await api(cfg, "DELETE", `/api/dbs/${name}`);
}

export async function getDatabaseInfo(cfg, name, opts) {
  var res = await api(cfg, "GET", `/api/dbs/${name}/info`);
  var data = await res.json();
  return {
    dbId: data.dbName,
    dbName: data.dbName,
    connectionUrl: data.connectionUrl,
    size: data.size,
    numTables: data.numTables,
    createdAt: data.createdAt,
  };
}

export async function queryDatabase(cfg, name, sql, params, opts) {
  var res = await api(cfg, "POST", `/api/dbs/${name}/query`, { sql });
  return await res.text();
}

export async function importDatabase(cfg, name, sqlContent, opts) {
  await api(cfg, "POST", `/api/dbs/${name}/import`, sqlContent);
}

export async function exportDatabase(cfg, name, opts) {
  var res = await api(cfg, "POST", `/api/dbs/${name}/export`);
  return await res.text();
}

export async function resetDatabase(cfg, name, opts) {
  var res = await api(cfg, "POST", `/api/dbs/${name}/reset`);
  var data = await res.json();
  return data.tables || [];
}

export async function rotateToken(cfg, name, opts) {
  // Demo doesn't support token rotation - just return the current one
  var res = await api(cfg, "GET", `/api/dbs/${name}/info`);
  var data = await res.json();
  return { dbToken: "demo", connectionUrl: data.connectionUrl };
}

export async function listManagedDatabases(cfg) {
  var res = await api(cfg, "GET", "/api/dbs");
  var dbs = await res.json();
  return dbs.map(d => ({
    name: d.name,
    dbName: d.dbName,
    dbId: d.dbName,
    connectionUrl: d.connectionUrl,
  }));
}

export async function getAttachCredentials(cfg, dbAppName, appName) {
  var res = await api(cfg, "GET", `/api/dbs/${dbAppName}/info`);
  var data = await res.json();
  return {
    connectionUrl: data.connectionUrl,
    token: "demo",
    isPostgres: true,
  };
}
