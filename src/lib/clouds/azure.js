// Azure REST API helpers - service principal auth (OAuth2 client credentials)
// and managed/workload identity (Container Apps, VMs, App Service)

var LOGIN_URL = "https://login.microsoftonline.com";
var MGMT_URL = "https://management.azure.com";
var MGMT_SCOPE = "https://management.azure.com/.default";
var MGMT_RESOURCE = "https://management.azure.com";
var API_VERSION = "2022-09-01";

export async function mintAccessToken(tenantId, clientId, clientSecret) {
  var body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: MGMT_SCOPE,
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

// Acquire a token via managed/workload identity.
// Works on Container Apps, App Service, Azure Functions (IDENTITY_ENDPOINT),
// and VMs/VMSS (IMDS at 169.254.169.254).
export async function mintManagedIdentityToken(clientId) {
  var identityEndpoint = process.env.IDENTITY_ENDPOINT;
  var identityHeader = process.env.IDENTITY_HEADER;

  if (identityEndpoint && identityHeader) {
    // Container Apps / App Service / Functions
    var url = `${identityEndpoint}?resource=${MGMT_RESOURCE}&api-version=2019-08-01`;
    if (clientId) url += `&client_id=${clientId}`;

    var res = await fetch(url, {
      headers: { "X-IDENTITY-HEADER": identityHeader },
    });

    if (!res.ok) {
      var text = await res.text();
      throw new Error(`Azure managed identity auth failed: ${res.status} ${text}`);
    }

    var data = await res.json();
    return data.access_token;
  }

  // VM / VMSS - Instance Metadata Service (IMDS)
  var imdsUrl = "http://169.254.169.254/metadata/identity/oauth2/token" +
    `?resource=${MGMT_RESOURCE}&api-version=2018-02-01`;
  if (clientId) imdsUrl += `&client_id=${clientId}`;

  var res = await fetch(imdsUrl, {
    headers: { Metadata: "true" },
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Azure IMDS auth failed: ${res.status} ${text}`);
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
      var err = pollData.error;
      var msg = err?.message || pollData.message || "Unknown error";
      if (err?.details) msg += " " + (Array.isArray(err.details) ? err.details.map((d) => d.message || d.code).join("; ") : err.details);
      throw new Error(`Azure operation failed: ${msg}`);
    }
  }
  throw new Error("Timed out waiting for Azure operation to complete.");
}

export async function verifyCredentials(
  tenantId,
  clientId,
  clientSecret,
  subscriptionId,
  opts = {}
) {
  var token = await mintAccessToken(tenantId, clientId, clientSecret);

  // When an existing RG is provided, verify access at RG scope only.
  if (opts.resourceGroupId && opts.existingOnly) {
    await azureApi("GET", opts.resourceGroupId, null, token);
    return token;
  }

  // Otherwise verify by listing resource groups in the subscription.
  await azureApi("GET", `/subscriptions/${subscriptionId}/resourcegroups`, null, token);
  return token;
}

export async function getToken(cfg) {
  if (cfg.identity) return mintManagedIdentityToken(cfg.clientId);
  return mintAccessToken(cfg.tenantId, cfg.clientId, cfg.clientSecret);
}

// Resource group path helper
export function rgPath(cfg) {
  if (cfg.resourceGroupId) return cfg.resourceGroupId;
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}`;
}

export function parseResourceGroupInput(subscriptionId, input) {
  var value = (input || "").trim().replace(/\/+$/, "");
  if (!value) value = "relight";

  if (value.startsWith("/subscriptions/")) {
    var match = value.match(/^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)$/i);
    if (!match) {
      throw new Error(
        "Invalid resource group ID. Expected /subscriptions/<id>/resourceGroups/<name>."
      );
    }
    return {
      subscriptionId: match[1],
      resourceGroup: match[2],
      resourceGroupId: `/subscriptions/${match[1]}/resourceGroups/${match[2]}`,
      isFullId: true,
    };
  }

  return {
    subscriptionId,
    resourceGroup: value,
    resourceGroupId: `/subscriptions/${subscriptionId}/resourceGroups/${value}`,
    isFullId: false,
  };
}
