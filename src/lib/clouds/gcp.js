import { createSign } from "crypto";
import { readFileSync } from "fs";

export var RUN_API = "https://run.googleapis.com/v2";
var FIREBASE_API = "https://firebase.googleapis.com/v1beta1";
var FIREBASE_HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
var CRM_API = "https://cloudresourcemanager.googleapis.com/v1";
var TOKEN_URI = "https://oauth2.googleapis.com/token";
var SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export var AR_API = "https://artifactregistry.googleapis.com/v1";
export var SQLADMIN_API = "https://sqladmin.googleapis.com/v1";
export var DNS_API = "https://dns.googleapis.com/dns/v1";
export var LOGGING_API = "https://logging.googleapis.com/v2";
export var MONITORING_API = "https://monitoring.googleapis.com/v3";

// --- Service account key file ---

export function readKeyFile(path) {
  var raw = readFileSync(path, "utf-8");
  var key = JSON.parse(raw);

  if (!key.client_email || !key.private_key) {
    throw new Error(
      "Invalid service account key file. Expected client_email and private_key fields."
    );
  }

  return {
    clientEmail: key.client_email,
    privateKey: key.private_key,
    project: key.project_id || null,
  };
}

// --- JWT -> access token ---

export async function mintAccessToken(clientEmail, privateKey) {
  var now = Math.floor(Date.now() / 1000);

  var header = { alg: "RS256", typ: "JWT" };
  var payload = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
  };

  var segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];

  var sign = createSign("RSA-SHA256");
  sign.update(segments.join("."));
  var signature = sign.sign(privateKey, "base64url");

  var jwt = segments.join(".") + "." + signature;

  var res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  var data = await res.json();
  return data.access_token;
}

function base64url(str) {
  return Buffer.from(str).toString("base64url");
}

// --- GCP API ---

export async function gcpApi(method, url, body, token) {
  var headers = {
    Authorization: `Bearer ${token}`,
  };

  if (body && typeof body === "object") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  var res = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`GCP API ${method} ${url}: ${res.status} ${text}`);
  }

  var contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) return {};
  return res.json();
}

// --- LRO polling ---

export async function waitForOperation(token, operationName, apiBase) {
  var url = apiBase
    ? `${apiBase}/${operationName}`
    : `https://run.googleapis.com/v2/${operationName}`;
  while (true) {
    var op = await gcpApi("GET", url, null, token);
    if (op.done) {
      if (op.error) {
        throw new Error(`Operation failed: ${op.error.message || JSON.stringify(op.error)}`);
      }
      return op.response || op;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function waitForSqlOperation(token, project, opName) {
  while (true) {
    var op = await gcpApi(
      "GET",
      `${SQLADMIN_API}/projects/${project}/operations/${opName}`,
      null,
      token
    );
    if (op.status === "DONE") {
      if (op.error) {
        var msgs = (op.error.errors || []).map((e) => e.message).join(", ");
        throw new Error(`SQL operation failed: ${msgs || JSON.stringify(op.error)}`);
      }
      return op;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// --- Project verification ---

export async function verifyProject(token, project) {
  return gcpApi("GET", `${CRM_API}/projects/${project}`, null, token);
}

// --- Cloud Run ---

export async function listRegions(token, project) {
  var res = await gcpApi(
    "GET",
    `${RUN_API}/projects/${project}/locations`,
    null,
    token
  );
  return res.locations || [];
}

export async function listServices(token, project, region) {
  var res = await gcpApi(
    "GET",
    `${RUN_API}/projects/${project}/locations/${region}/services`,
    null,
    token
  );
  return res.services || [];
}

export async function listAllServices(token, project) {
  var res = await gcpApi(
    "GET",
    `${RUN_API}/projects/${project}/locations/-/services`,
    null,
    token
  );
  return res.services || [];
}

export async function getService(token, serviceName) {
  return gcpApi("GET", `${RUN_API}/${serviceName}`, null, token);
}

export async function createService(token, project, region, serviceId, body) {
  var op = await gcpApi(
    "POST",
    `${RUN_API}/projects/${project}/locations/${region}/services?serviceId=${serviceId}`,
    body,
    token
  );
  return waitForOperation(token, op.name);
}

export async function updateService(token, serviceName, body) {
  var op = await gcpApi("PATCH", `${RUN_API}/${serviceName}`, body, token);
  return waitForOperation(token, op.name);
}

export async function deleteService(token, serviceName) {
  var op = await gcpApi("DELETE", `${RUN_API}/${serviceName}`, null, token);
  return waitForOperation(token, op.name);
}

export async function setIamPolicy(token, serviceName, policy) {
  return gcpApi(
    "POST",
    `${RUN_API}/${serviceName}:setIamPolicy`,
    { policy },
    token
  );
}

// --- Artifact Registry ---

export async function getRepository(token, project, location, repoName) {
  return gcpApi(
    "GET",
    `${AR_API}/projects/${project}/locations/${location}/repositories/${repoName}`,
    null,
    token
  );
}

export async function createRepository(token, project, location, repoName) {
  var op = await gcpApi(
    "POST",
    `${AR_API}/projects/${project}/locations/${location}/repositories?repositoryId=${repoName}`,
    { format: "DOCKER" },
    token
  );
  if (op.done) return op.response || op;
  return waitForOperation(token, op.name, AR_API);
}

// --- Cloud SQL ---

export async function createSqlInstance(token, project, body) {
  var op = await gcpApi(
    "POST",
    `${SQLADMIN_API}/projects/${project}/instances`,
    body,
    token
  );
  return waitForSqlOperation(token, project, op.name);
}

export async function getSqlInstance(token, project, instanceName) {
  return gcpApi(
    "GET",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}`,
    null,
    token
  );
}

export async function deleteSqlInstance(token, project, instanceName) {
  var op = await gcpApi(
    "DELETE",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}`,
    null,
    token
  );
  return waitForSqlOperation(token, project, op.name);
}

export async function createSqlDatabase(token, project, instanceName, dbName) {
  var op = await gcpApi(
    "POST",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}/databases`,
    { name: dbName },
    token
  );
  return waitForSqlOperation(token, project, op.name);
}

export async function deleteSqlDatabase(token, project, instanceName, dbName) {
  var op = await gcpApi(
    "DELETE",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}/databases/${dbName}`,
    null,
    token
  );
  return waitForSqlOperation(token, project, op.name);
}

export async function createSqlUser(token, project, instanceName, userName, password) {
  var op = await gcpApi(
    "POST",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}/users`,
    { name: userName, password },
    token
  );
  return waitForSqlOperation(token, project, op.name);
}

export async function updateSqlUser(token, project, instanceName, userName, password) {
  var op = await gcpApi(
    "PUT",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}/users?name=${encodeURIComponent(userName)}`,
    { name: userName, password },
    token
  );
  return waitForSqlOperation(token, project, op.name);
}

export async function deleteSqlUser(token, project, instanceName, userName) {
  var op = await gcpApi(
    "DELETE",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}/users?name=${encodeURIComponent(userName)}`,
    null,
    token
  );
  return waitForSqlOperation(token, project, op.name);
}

export async function listSqlDatabases(token, project, instanceName) {
  var res = await gcpApi(
    "GET",
    `${SQLADMIN_API}/projects/${project}/instances/${instanceName}/databases`,
    null,
    token
  );
  return res.items || [];
}

// --- Cloud DNS ---

export async function listManagedZones(token, project) {
  var res = await gcpApi(
    "GET",
    `${DNS_API}/projects/${project}/managedZones`,
    null,
    token
  );
  return res.managedZones || [];
}

export async function createDnsChange(token, project, zoneName, change) {
  return gcpApi(
    "POST",
    `${DNS_API}/projects/${project}/managedZones/${zoneName}/changes`,
    change,
    token
  );
}

export async function listResourceRecordSets(token, project, zoneName) {
  var res = await gcpApi(
    "GET",
    `${DNS_API}/projects/${project}/managedZones/${zoneName}/rrsets`,
    null,
    token
  );
  return res.rrsets || [];
}

// --- Firebase ---

export async function ensureFirebaseProject(token, project) {
  try {
    await gcpApi("GET", `${FIREBASE_API}/projects/${project}`, null, token);
    return;
  } catch {}

  // Try to add Firebase programmatically
  try {
    var op = await gcpApi("POST", `${FIREBASE_API}/projects/${project}:addFirebase`, {}, token);
    if (op.name && !op.done) {
      while (true) {
        var status = await gcpApi("GET", `${FIREBASE_API}/${op.name}`, null, token);
        if (status.done) {
          if (status.error) throw new Error(status.error.message);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return;
  } catch {
    throw new Error(
      "Could not enable Firebase for this project.\n" +
      "  This usually means the Firebase Terms of Service have not been accepted.\n" +
      "  Visit https://console.firebase.google.com/ and add your GCP project there first."
    );
  }
}

// --- Firebase Hosting ---

export async function createHostingSite(token, project, siteId) {
  return gcpApi("POST", `${FIREBASE_HOSTING_API}/projects/${project}/sites?siteId=${siteId}`, {}, token);
}

export async function getHostingSite(token, project, siteId) {
  return gcpApi("GET", `${FIREBASE_HOSTING_API}/projects/${project}/sites/${siteId}`, null, token);
}

export async function deleteHostingSite(token, project, siteId) {
  return gcpApi("DELETE", `${FIREBASE_HOSTING_API}/projects/${project}/sites/${siteId}`, null, token);
}

export async function deployHostingProxy(token, siteId, serviceId, region) {
  // Create version with Cloud Run rewrite
  var version = await gcpApi("POST", `${FIREBASE_HOSTING_API}/sites/${siteId}/versions`, {
    config: {
      rewrites: [{ glob: "**", run: { serviceId, region } }],
    },
  }, token);

  var versionId = version.name.split("/").pop();

  // Finalize version
  await gcpApi("PATCH", `${FIREBASE_HOSTING_API}/sites/${siteId}/versions/${versionId}?update_mask=status`, {
    status: "FINALIZED",
  }, token);

  // Create release
  await gcpApi("POST", `${FIREBASE_HOSTING_API}/sites/${siteId}/releases?versionName=sites/${siteId}/versions/${versionId}`, {}, token);
}

export async function addHostingCustomDomain(token, project, siteId, domain) {
  return gcpApi("POST", `${FIREBASE_HOSTING_API}/projects/${project}/sites/${siteId}/customDomains?customDomainId=${domain}`, {}, token);
}

export async function deleteHostingCustomDomain(token, project, siteId, domain) {
  return gcpApi("DELETE", `${FIREBASE_HOSTING_API}/projects/${project}/sites/${siteId}/customDomains/${domain}`, null, token);
}

// --- Cloud Logging ---

export async function listLogEntries(token, body) {
  return gcpApi("POST", `${LOGGING_API}/entries:list`, body, token);
}

// --- Cloud Monitoring ---

export async function queryTimeSeries(token, project, body) {
  return gcpApi(
    "POST",
    `${MONITORING_API}/projects/${project}/timeSeries:query`,
    body,
    token
  );
}
