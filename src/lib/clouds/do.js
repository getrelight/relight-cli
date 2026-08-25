var DO_API = "https://api.digitalocean.com/v2";

export async function doApi(method, path, body, token) {
  var headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  var res = await fetch(`${DO_API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`DO API ${method} ${path}: ${res.status} ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export async function verifyToken(token) {
  return doApi("GET", "/account", undefined, token);
}

// --- Database cluster operations ---

export async function getClusterConnection(token, clusterId) {
  var res = await doApi("GET", `/databases/${clusterId}`, undefined, token);
  var db = res.database;
  return {
    host: db.connection.host,
    port: db.connection.port,
    user: db.connection.user,
    password: db.connection.password,
    database: db.connection.database || "defaultdb",
    sslmode: db.connection.ssl ? "require" : "disable",
  };
}

export async function createDatabaseInCluster(token, clusterId, dbName) {
  var res = await doApi(
    "POST",
    `/databases/${clusterId}/dbs`,
    { name: dbName },
    token
  );
  return res.db;
}

export async function deleteDatabaseInCluster(token, clusterId, dbName) {
  return doApi("DELETE", `/databases/${clusterId}/dbs/${dbName}`, undefined, token);
}

export async function createUserInCluster(token, clusterId, userName) {
  var res = await doApi(
    "POST",
    `/databases/${clusterId}/users`,
    { name: userName },
    token
  );
  return { name: res.user.name, password: res.user.password };
}

export async function deleteUserInCluster(token, clusterId, userName) {
  return doApi("DELETE", `/databases/${clusterId}/users/${userName}`, undefined, token);
}

export async function getUserInCluster(token, clusterId, userName) {
  try {
    var res = await doApi("GET", `/databases/${clusterId}/users/${userName}`, undefined, token);
    return res.user || null;
  } catch {
    return null;
  }
}

export async function getDatabaseInCluster(token, clusterId, dbName) {
  try {
    var res = await doApi("GET", `/databases/${clusterId}/dbs/${dbName}`, undefined, token);
    return res.db || null;
  } catch {
    return null;
  }
}
