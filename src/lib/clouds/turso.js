var API_BASE = "https://api.turso.tech";

export async function tursoApi(apiToken, method, path, body) {
  var headers = {
    Authorization: `Bearer ${apiToken}`,
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
    throw new Error(`Turso API ${method} ${path}: ${res.status} ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// --- Organizations ---

export async function listOrganizations(apiToken) {
  var data = await tursoApi(apiToken, "GET", "/v1/organizations");
  return data || [];
}

// --- Groups ---

export async function listGroups(apiToken, orgSlug) {
  var data = await tursoApi(apiToken, "GET", `/v1/organizations/${orgSlug}/groups`);
  return data.groups || [];
}

export async function createGroup(apiToken, orgSlug, name, location) {
  return tursoApi(apiToken, "POST", `/v1/organizations/${orgSlug}/groups`, {
    name,
    location,
  });
}

// --- Databases ---

export async function listDatabases(apiToken, orgSlug) {
  var data = await tursoApi(apiToken, "GET", `/v1/organizations/${orgSlug}/databases`);
  return data.databases || [];
}

export async function createDatabase(apiToken, orgSlug, name, group) {
  return tursoApi(apiToken, "POST", `/v1/organizations/${orgSlug}/databases`, {
    name,
    group,
  });
}

export async function deleteDatabase(apiToken, orgSlug, name) {
  return tursoApi(apiToken, "DELETE", `/v1/organizations/${orgSlug}/databases/${name}`);
}

export async function getDatabase(apiToken, orgSlug, name) {
  var data = await tursoApi(apiToken, "GET", `/v1/organizations/${orgSlug}/databases/${name}`);
  return data.database || data;
}

export async function getDatabaseUsage(apiToken, orgSlug, name) {
  var data = await tursoApi(apiToken, "GET", `/v1/organizations/${orgSlug}/databases/${name}/usage`);
  return data.database || data;
}

// --- Auth tokens ---

export async function createAuthToken(apiToken, orgSlug, dbName) {
  var data = await tursoApi(
    apiToken,
    "POST",
    `/v1/organizations/${orgSlug}/databases/${dbName}/auth/tokens`,
    { permissions: { read_attach: { databases: [dbName] } } }
  );
  return data.jwt;
}

// --- Query via HTTP Pipeline (Hrana protocol) ---

export async function queryPipeline(dbUrl, authToken, statements) {
  // dbUrl is like "libsql://db-org.turso.io"
  // Convert to HTTPS for HTTP API
  var httpUrl = dbUrl.replace(/^libsql:\/\//, "https://");

  var requests = statements.map((stmt, i) => ({
    type: "execute",
    stmt: typeof stmt === "string" ? { sql: stmt } : stmt,
  }));

  // Close the stream at the end
  requests.push({ type: "close" });

  var res = await fetch(`${httpUrl}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Turso query failed: ${res.status} ${text}`);
  }

  var data = await res.json();
  return data.results || [];
}

// --- Dump (export) ---

export async function getDatabaseDump(apiToken, orgSlug, dbName) {
  var res = await fetch(
    `${API_BASE}/v1/organizations/${orgSlug}/databases/${dbName}/dump`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    }
  );

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Turso dump failed: ${res.status} ${text}`);
  }

  return res.text();
}

// --- Verification ---

export async function verifyApiToken(apiToken) {
  var orgs = await listOrganizations(apiToken);
  return orgs;
}
