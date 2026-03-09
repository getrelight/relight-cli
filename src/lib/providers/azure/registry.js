import { azureApi, getToken, rgPath } from "../../clouds/azure.js";

var ACR_API_VERSION = "2023-07-01";

async function getAcr(cfg, token) {
  var path = `${rgPath(cfg)}/providers/Microsoft.ContainerRegistry/registries`;
  var res = await azureApi("GET", path, null, token, { apiVersion: ACR_API_VERSION });
  var registries = (res.value || []).filter((r) => r.name.startsWith("relight"));
  return registries[0] || null;
}

async function ensureAcr(cfg, token) {
  var existing = await getAcr(cfg, token);
  if (existing) return existing;

  // ACR names must be alphanumeric, globally unique
  var acrName = "relight" + cfg.subscriptionId.replace(/-/g, "").slice(0, 12);
  var path = `${rgPath(cfg)}/providers/Microsoft.ContainerRegistry/registries/${acrName}`;

  var body = {
    location: cfg.location || "eastus",
    sku: { name: "Basic" },
    properties: { adminUserEnabled: true },
  };

  var res = await azureApi("PUT", path, body, token, { apiVersion: ACR_API_VERSION });

  // Wait for provisioning
  for (var i = 0; i < 60; i++) {
    var check = await azureApi("GET", path, null, token, { apiVersion: ACR_API_VERSION });
    if (check.properties?.provisioningState === "Succeeded") return check;
    await new Promise((r) => setTimeout(r, 3000));
  }

  return res;
}

export async function getCredentials(cfg) {
  var token = await getToken(cfg);
  var acr = await ensureAcr(cfg, token);
  var acrName = acr.name;
  var loginServer = acr.properties?.loginServer || `${acrName}.azurecr.io`;

  // Get admin credentials
  var credsPath = `${rgPath(cfg)}/providers/Microsoft.ContainerRegistry/registries/${acrName}/listCredentials`;
  var creds = await azureApi("POST", credsPath, {}, token, { apiVersion: ACR_API_VERSION });

  return {
    registry: `https://${loginServer}`,
    username: creds.username,
    password: creds.passwords[0].value,
  };
}

export async function getImageTag(cfg, appName, tag) {
  var token = await getToken(cfg);
  var acr = await ensureAcr(cfg, token);
  var loginServer = acr.properties?.loginServer || `${acr.name}.azurecr.io`;
  return `${loginServer}/relight-${appName}:${tag}`;
}

export async function ensureRepository() {
  // ACR auto-creates repositories on push
}
