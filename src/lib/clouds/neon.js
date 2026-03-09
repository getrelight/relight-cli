var API_BASE = "https://console.neon.tech/api/v2";

export async function neonApi(apiKey, method, path, body) {
  var headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  if (body && typeof body === "object") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  var res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: method === "GET" || method === "DELETE" ? undefined : body,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Neon API ${method} ${path}: ${res.status} ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// --- Projects ---

export async function listProjects(apiKey) {
  var data = await neonApi(apiKey, "GET", "/projects");
  return data.projects || [];
}

export async function createProject(apiKey, opts = {}) {
  var body = {
    project: {
      name: opts.name || "relight",
      pg_version: opts.pgVersion || 16,
    },
  };
  if (opts.regionId) body.project.region_id = opts.regionId;
  return neonApi(apiKey, "POST", "/projects", body);
}

export async function getProject(apiKey, projectId) {
  return neonApi(apiKey, "GET", `/projects/${projectId}`);
}

export async function deleteProject(apiKey, projectId) {
  return neonApi(apiKey, "DELETE", `/projects/${projectId}`);
}

// --- Branches ---

export async function listBranches(apiKey, projectId) {
  var data = await neonApi(apiKey, "GET", `/projects/${projectId}/branches`);
  return data.branches || [];
}

// --- Databases ---

export async function listDatabases(apiKey, projectId, branchId) {
  var data = await neonApi(
    apiKey,
    "GET",
    `/projects/${projectId}/branches/${branchId}/databases`
  );
  return data.databases || [];
}

export async function createDatabase(apiKey, projectId, branchId, dbName, ownerName) {
  return neonApi(
    apiKey,
    "POST",
    `/projects/${projectId}/branches/${branchId}/databases`,
    { database: { name: dbName, owner_name: ownerName } }
  );
}

export async function deleteDatabase(apiKey, projectId, branchId, dbName) {
  return neonApi(
    apiKey,
    "DELETE",
    `/projects/${projectId}/branches/${branchId}/databases/${dbName}`
  );
}

// --- Roles ---

export async function listRoles(apiKey, projectId, branchId) {
  var res = await neonApi(
    apiKey,
    "GET",
    `/projects/${projectId}/branches/${branchId}/roles`
  );
  return res.roles || [];
}

export async function createRole(apiKey, projectId, branchId, roleName) {
  return neonApi(
    apiKey,
    "POST",
    `/projects/${projectId}/branches/${branchId}/roles`,
    { role: { name: roleName } }
  );
}

export async function deleteRole(apiKey, projectId, branchId, roleName) {
  return neonApi(
    apiKey,
    "DELETE",
    `/projects/${projectId}/branches/${branchId}/roles/${roleName}`
  );
}

export async function getRolePassword(apiKey, projectId, branchId, roleName) {
  var data = await neonApi(
    apiKey,
    "GET",
    `/projects/${projectId}/branches/${branchId}/roles/${roleName}/reveal_password`
  );
  return data.password;
}

export async function resetRolePassword(apiKey, projectId, branchId, roleName) {
  var data = await neonApi(
    apiKey,
    "POST",
    `/projects/${projectId}/branches/${branchId}/roles/${roleName}/reset_password`
  );
  return data.password;
}

// --- Connection URI ---

export async function getConnectionUri(apiKey, projectId, dbName, roleName) {
  var params = new URLSearchParams({
    database_name: dbName,
    role_name: roleName,
  });
  var data = await neonApi(
    apiKey,
    "GET",
    `/projects/${projectId}/connection_uri?${params}`
  );
  return data.uri;
}

// --- Verification ---

export async function verifyApiKey(apiKey) {
  var projects = await listProjects(apiKey);
  return projects;
}
