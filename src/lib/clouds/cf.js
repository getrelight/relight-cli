var CF_API = "https://api.cloudflare.com/client/v4";
var CF_REGISTRY = "registry.cloudflare.com";

export { CF_REGISTRY };

export var TOKEN_URL =
  "https://dash.cloudflare.com/profile/api-tokens?" +
  "permissionGroupKeys=" +
  encodeURIComponent(
    JSON.stringify([
      { key: "workers_scripts", type: "edit" },
      { key: "containers", type: "edit" },
      { key: "zone", type: "read" },
      { key: "dns", type: "edit" },
    ])
  ) +
  "&name=relight-cli";

// --- CF API base ---

export async function cfApi(method, path, body, apiToken, contentType) {
  var headers = {
    Authorization: `Bearer ${apiToken}`,
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  } else if (body && typeof body === "object") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  var res = await fetch(`${CF_API}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`CF API ${method} ${path}: ${res.status} ${text}`);
  }

  var ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

// --- CF GraphQL Analytics API ---

export async function cfGraphQL(apiToken, query, variables) {
  var res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`CF GraphQL: ${res.status} ${text}`);
  }

  var json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(`CF GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  return json.data;
}

// --- Auth verification ---

export async function verifyToken(apiToken) {
  return cfApi("GET", "/user/tokens/verify", null, apiToken);
}

export async function listAccounts(apiToken) {
  var res = await cfApi("GET", "/accounts", null, apiToken);
  return res.result || [];
}

// --- Registry ---

export async function getRegistryCredentials(accountId, apiToken) {
  var res = await cfApi(
    "POST",
    `/accounts/${accountId}/containers/registries/${CF_REGISTRY}/credentials`,
    { permissions: ["push", "pull"], expiration_minutes: 15 },
    apiToken
  );
  return res.result;
}

// --- Worker scripts ---

export async function uploadWorker(accountId, apiToken, scriptName, code, metadata) {
  var form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  form.append(
    "index.js",
    new Blob([code], { type: "application/javascript+module" }),
    "index.js"
  );

  var res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    }
  );

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Worker upload failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function deleteWorker(accountId, apiToken, scriptName) {
  return cfApi(
    "DELETE",
    `/accounts/${accountId}/workers/scripts/${scriptName}`,
    null,
    apiToken
  );
}

export async function patchWorkerSettings(accountId, apiToken, scriptName, settings) {
  var form = new FormData();
  form.append(
    "settings",
    new Blob([JSON.stringify(settings)], { type: "application/json" })
  );

  var res = await fetch(
    `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    }
  );

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Settings update failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function listWorkerScripts(accountId, apiToken) {
  var res = await cfApi(
    "GET",
    `/accounts/${accountId}/workers/scripts`,
    null,
    apiToken
  );
  return res.result || [];
}

export async function getWorkerSettings(accountId, apiToken, scriptName) {
  var res = await cfApi(
    "GET",
    `/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
    null,
    apiToken
  );
  return res.result;
}

// --- Container applications ---

export async function getDONamespaceId(accountId, apiToken, scriptName, className) {
  var res = await cfApi(
    "GET",
    `/accounts/${accountId}/workers/durable_objects/namespaces`,
    null,
    apiToken
  );
  var namespaces = res.result || [];
  var ns = namespaces.find(
    (n) => n.script === scriptName && n.class === className
  );
  return ns ? ns.id : null;
}

export async function listContainerApps(accountId, apiToken) {
  var res = await cfApi(
    "GET",
    `/accounts/${accountId}/containers/applications`,
    null,
    apiToken
  );
  return res.result || [];
}

export async function findContainerApp(accountId, apiToken, name) {
  var apps = await listContainerApps(accountId, apiToken);
  return apps.find((a) => a.name === name) || null;
}

export async function createContainerApp(accountId, apiToken, app) {
  var res = await cfApi(
    "POST",
    `/accounts/${accountId}/containers/applications`,
    app,
    apiToken
  );
  return res.result;
}

export async function deleteContainerApp(accountId, apiToken, appId) {
  return cfApi(
    "DELETE",
    `/accounts/${accountId}/containers/applications/${appId}`,
    null,
    apiToken
  );
}

export async function modifyContainerApp(accountId, apiToken, appId, changes) {
  var res = await cfApi(
    "PATCH",
    `/accounts/${accountId}/containers/applications/${appId}`,
    changes,
    apiToken
  );
  return res.result;
}

export async function createRollout(accountId, apiToken, appId, rollout) {
  var res = await cfApi(
    "POST",
    `/accounts/${accountId}/containers/applications/${appId}/rollouts`,
    rollout,
    apiToken
  );
  return res.result;
}

// --- Tail/logs ---

export async function createTail(accountId, apiToken, scriptName) {
  var res = await cfApi(
    "POST",
    `/accounts/${accountId}/workers/scripts/${scriptName}/tails`,
    {},
    apiToken
  );
  return res.result;
}

export async function deleteTail(accountId, apiToken, scriptName, tailId) {
  return cfApi(
    "DELETE",
    `/accounts/${accountId}/workers/scripts/${scriptName}/tails/${tailId}`,
    null,
    apiToken
  );
}

// --- Zones ---

export async function listZones(accountId, apiToken) {
  var all = [];
  var page = 1;
  while (true) {
    var res = await cfApi(
      "GET",
      `/zones?account.id=${accountId}&per_page=50&status=active&page=${page}`,
      null,
      apiToken
    );
    var zones = res.result || [];
    all.push(...zones);
    if (zones.length < 50) break;
    page++;
  }
  return all;
}

export function findZoneForHostname(zones, hostname) {
  var match = null;
  for (var zone of zones) {
    if (hostname === zone.name || hostname.endsWith("." + zone.name)) {
      if (!match || zone.name.length > match.name.length) {
        match = zone;
      }
    }
  }
  return match;
}

// --- DNS records ---

export async function listDnsRecords(accountId, apiToken, zoneId, params) {
  var qs = new URLSearchParams(params || {}).toString();
  var path = `/zones/${zoneId}/dns_records${qs ? "?" + qs : ""}`;
  var res = await cfApi("GET", path, null, apiToken);
  return res.result || [];
}

export async function createDnsRecord(accountId, apiToken, zoneId, record) {
  return cfApi(
    "POST",
    `/zones/${zoneId}/dns_records`,
    record,
    apiToken
  );
}

export async function deleteDnsRecord(accountId, apiToken, zoneId, recordId) {
  return cfApi(
    "DELETE",
    `/zones/${zoneId}/dns_records/${recordId}`,
    null,
    apiToken
  );
}

// --- Workers custom domains ---

export async function addWorkerDomain(accountId, apiToken, scriptName, hostname, zoneId) {
  return cfApi(
    "PUT",
    `/accounts/${accountId}/workers/domains`,
    {
      hostname,
      zone_id: zoneId,
      service: scriptName,
      environment: "production",
    },
    apiToken
  );
}

export async function removeWorkerDomain(accountId, apiToken, hostname) {
  var res = await cfApi(
    "GET",
    `/accounts/${accountId}/workers/domains`,
    null,
    apiToken
  );
  var domains = res.result || [];
  var domain = domains.find((d) => d.hostname === hostname);
  if (!domain) return;

  return cfApi(
    "DELETE",
    `/accounts/${accountId}/workers/domains/${domain.id}`,
    null,
    apiToken
  );
}

export async function listWorkerDomainsForService(accountId, apiToken, scriptName) {
  var res = await cfApi(
    "GET",
    `/accounts/${accountId}/workers/domains`,
    null,
    apiToken
  );
  return (res.result || []).filter((d) => d.service === scriptName);
}

// --- Workers subdomain ---

export async function getWorkersSubdomain(accountId, apiToken) {
  try {
    var res = await cfApi(
      "GET",
      `/accounts/${accountId}/workers/subdomain`,
      null,
      apiToken
    );
    return res.result?.subdomain || null;
  } catch {
    return null;
  }
}

export async function enableWorkerSubdomain(accountId, apiToken, scriptName) {
  return cfApi(
    "POST",
    `/accounts/${accountId}/workers/services/${scriptName}/environments/production/subdomain`,
    { enabled: true },
    apiToken
  );
}

// --- D1 databases ---

export async function listD1Databases(accountId, apiToken) {
  var allDbs = [];
  var page = 1;
  while (true) {
    var res = await cfApi(
      "GET",
      `/accounts/${accountId}/d1/database?page=${page}&per_page=50`,
      null,
      apiToken
    );
    var databases = res.result || [];
    allDbs.push(...databases);
    if (databases.length < 50) break;
    page++;
  }
  return allDbs;
}

export async function createD1Database(accountId, apiToken, name, { locationHint, jurisdiction } = {}) {
  var body = { name };
  if (jurisdiction) body.jurisdiction = jurisdiction;
  else if (locationHint) body.primary_location_hint = locationHint;
  var res = await cfApi(
    "POST",
    `/accounts/${accountId}/d1/database`,
    body,
    apiToken
  );
  return res.result;
}

export async function deleteD1Database(accountId, apiToken, dbId) {
  return cfApi(
    "DELETE",
    `/accounts/${accountId}/d1/database/${dbId}`,
    null,
    apiToken
  );
}

export async function getD1Database(accountId, apiToken, dbId) {
  var res = await cfApi(
    "GET",
    `/accounts/${accountId}/d1/database/${dbId}`,
    null,
    apiToken
  );
  return res.result;
}

export async function queryD1(accountId, apiToken, dbId, sql, params) {
  var body = { sql };
  if (params) body.params = params;
  var res = await cfApi(
    "POST",
    `/accounts/${accountId}/d1/database/${dbId}/query`,
    body,
    apiToken
  );
  return res.result;
}

export async function exportD1(accountId, apiToken, dbId, body) {
  return cfApi(
    "POST",
    `/accounts/${accountId}/d1/database/${dbId}/export`,
    body,
    apiToken
  );
}

export async function importD1(accountId, apiToken, dbId, body) {
  return cfApi(
    "POST",
    `/accounts/${accountId}/d1/database/${dbId}/import`,
    body,
    apiToken
  );
}
