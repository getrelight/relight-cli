// Azure REST API helpers using service principal auth (OAuth2 client credentials)

var LOGIN_URL = "https://login.microsoftonline.com";
var MGMT_URL = "https://management.azure.com";
var API_VERSION = "2022-09-01";

export async function mintAccessToken(tenantId, clientId, clientSecret) {
  var body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://management.azure.com/.default",
  });

  var res = await fetch(`${LOGIN_URL}/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Azure auth failed: ${res.status} ${text}`);
  }

  var data = await res.json();
  return data.access_token;
}

export async function azureApi(method, path, body, token, opts) {
  var url = path.startsWith("https://") ? path : `${MGMT_URL}${path}`;

  // Append api-version if not already present
  if (!url.includes("api-version=")) {
    var apiVersion = opts?.apiVersion || API_VERSION;
    url += (url.includes("?") ? "&" : "?") + `api-version=${apiVersion}`;
  }

  var headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  var res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Azure ${method} ${path}: ${res.status} ${text}`);
  }

  var ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return res.text();
}

// Poll a long-running operation via Location or Azure-AsyncOperation header
export async function pollOperation(method, path, body, token, opts) {
  var url = path.startsWith("https://") ? path : `${MGMT_URL}${path}`;
  if (!url.includes("api-version=")) {
    var apiVersion = opts?.apiVersion || API_VERSION;
    url += (url.includes("?") ? "&" : "?") + `api-version=${apiVersion}`;
  }

  var headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  var res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  // If 200/201 with body, return immediately
  if (res.ok && res.status !== 202) {
    var ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return res.json();
    return null;
  }

  if (!res.ok && res.status !== 202) {
    var text = await res.text();
    throw new Error(`Azure ${method} ${path}: ${res.status} ${text}`);
  }

  // 202 Accepted - poll the operation
  var pollUrl = res.headers.get("azure-asyncoperation") || res.headers.get("location");
  if (!pollUrl) {
    // Try to get result from body
    var ct2 = res.headers.get("content-type") || "";
    if (ct2.includes("json")) return res.json();
    return null;
  }

  for (var i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    var pollRes = await fetch(pollUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!pollRes.ok) continue;

    var pollData = await pollRes.json();
    var status = pollData.status || pollData.provisioningState;

    if (status === "Succeeded" || status === "Completed") {
      // Fetch the actual resource
      try {
        return await azureApi("GET", path, null, token, opts);
      } catch {
        return pollData;
      }
    }
    if (status === "Failed" || status === "Canceled") {
      throw new Error(`Azure operation failed: ${JSON.stringify(pollData.error || pollData)}`);
    }
  }
  throw new Error("Timed out waiting for Azure operation to complete.");
}

export async function verifyCredentials(tenantId, clientId, clientSecret, subscriptionId) {
  var token = await mintAccessToken(tenantId, clientId, clientSecret);
  // Verify by listing resource groups
  await azureApi("GET", `/subscriptions/${subscriptionId}/resourcegroups`, null, token);
  return token;
}

export async function getToken(cfg) {
  return mintAccessToken(cfg.tenantId, cfg.clientId, cfg.clientSecret);
}

// Resource group path helper
export function rgPath(cfg) {
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}`;
}
