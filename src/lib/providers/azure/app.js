import { azureApi, pollOperation, getToken, rgPath } from "../../clouds/azure.js";

var CAPP_API = "2024-03-01";

// --- Internal helpers ---

function cappPath(cfg, appName) {
  return `${rgPath(cfg)}/providers/Microsoft.App/containerApps/relight-${appName}`;
}

function envPath(cfg) {
  return `${rgPath(cfg)}/providers/Microsoft.App/managedEnvironments/relight-env`;
}

async function ensureEnvironment(cfg, token) {
  var path = envPath(cfg);
  try {
    var env = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
    if (env.properties?.provisioningState === "Succeeded") return env;
  } catch {}

  var body = {
    location: cfg.location || "eastus",
    properties: {
      zoneRedundant: false,
    },
  };

  var res = await pollOperation("PUT", path, body, token, { apiVersion: CAPP_API });
  return res;
}

function buildEnvVars(appConfig, newSecrets) {
  var envVars = [];

  // Master config (without env values)
  var configCopy = Object.assign({}, appConfig);
  delete configCopy.env;
  envVars.push({ name: "RELIGHT_APP_CONFIG", value: JSON.stringify(configCopy) });

  for (var key of (appConfig.envKeys || [])) {
    if (appConfig.env && appConfig.env[key] !== undefined && appConfig.env[key] !== "[hidden]") {
      envVars.push({ name: key, value: String(appConfig.env[key]) });
    }
  }

  for (var key of (appConfig.secretKeys || [])) {
    if (newSecrets && newSecrets[key] !== undefined) {
      envVars.push({ name: key, value: String(newSecrets[key]) });
    }
  }

  return envVars;
}

async function getRegistryConfig(cfg, token) {
  var { getCredentials } = await import("./registry.js");
  var creds = await getCredentials(cfg);
  var server = creds.registry.replace("https://", "").replace("http://", "");
  return {
    server,
    username: creds.username,
    passwordSecretRef: "acr-password",
    password: creds.password,
  };
}

function buildContainerApp(appConfig, imageTag, newSecrets, env, registryCfg, opts) {
  var envVars = buildEnvVars(appConfig, newSecrets);
  var port = appConfig.port || 8080;

  var vcpu = appConfig.vcpu || 0.25;
  var memory = appConfig.memory ? `${(appConfig.memory / 1024).toFixed(2)}Gi` : "0.5Gi";

  return {
    location: opts?.location || "eastus",
    properties: {
      managedEnvironmentId: env.id,
      configuration: {
        ingress: {
          external: true,
          targetPort: port,
          transport: "auto",
        },
        registries: [
          {
            server: registryCfg.server,
            username: registryCfg.username,
            passwordSecretRef: "acr-password",
          },
        ],
        secrets: [
          { name: "acr-password", value: registryCfg.password },
        ],
        activeRevisionsMode: "Single",
      },
      template: {
        containers: [
          {
            name: "app",
            image: imageTag,
            env: envVars,
            resources: {
              cpu: vcpu,
              memory,
            },
          },
        ],
        scale: {
          minReplicas: 0,
          maxReplicas: appConfig.instances || 2,
          rules: [
            {
              name: "http-scaling",
              http: { metadata: { concurrentRequests: "50" } },
            },
          ],
        },
      },
    },
  };
}

async function waitForApp(cfg, appName, token) {
  var path = cappPath(cfg, appName);
  for (var i = 0; i < 120; i++) {
    var app = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
    var state = app.properties?.provisioningState;
    if (state === "Succeeded") return app;
    if (state === "Failed" || state === "Canceled") {
      throw new Error(`Container App reached state: ${state}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out waiting for Container App.");
}

// --- App config ---

export async function getAppConfig(cfg, appName) {
  var token = await getToken(cfg);
  var path = cappPath(cfg, appName);

  var app;
  try {
    app = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
  } catch {
    return null;
  }

  var containers = app.properties?.template?.containers || [];
  var envVars = {};
  for (var e of (containers[0]?.env || [])) {
    envVars[e.name] = e.value;
  }

  var configStr = envVars.RELIGHT_APP_CONFIG;
  if (!configStr) return null;

  var appConfig = JSON.parse(configStr);

  if (!appConfig.env) appConfig.env = {};
  for (var key of (appConfig.envKeys || [])) {
    if (envVars[key] !== undefined) appConfig.env[key] = envVars[key];
  }
  for (var key of (appConfig.secretKeys || [])) {
    if (envVars[key] !== undefined) appConfig.env[key] = "[hidden]";
  }

  return appConfig;
}

export async function pushAppConfig(cfg, appName, appConfig, opts) {
  var token = await getToken(cfg);
  var newSecrets = opts?.newSecrets || {};

  // Get current app to carry forward secrets
  var path = cappPath(cfg, appName);
  var existing = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
  var containers = existing.properties?.template?.containers || [];
  var liveEnvVars = {};
  for (var e of (containers[0]?.env || [])) {
    liveEnvVars[e.name] = e.value;
  }
  for (var key of (appConfig.secretKeys || [])) {
    if (!newSecrets[key] && liveEnvVars[key]) {
      newSecrets[key] = liveEnvVars[key];
    }
  }

  var envVars = buildEnvVars(appConfig, newSecrets);
  var vcpu = appConfig.vcpu || 0.25;
  var memory = appConfig.memory ? `${(appConfig.memory / 1024).toFixed(2)}Gi` : "0.5Gi";

  // Patch the container
  existing.properties.template.containers[0].env = envVars;
  existing.properties.template.containers[0].image = appConfig.image;
  existing.properties.template.containers[0].resources = { cpu: vcpu, memory };
  existing.properties.template.scale.maxReplicas = appConfig.instances || 2;

  if (appConfig.port) {
    existing.properties.configuration.ingress.targetPort = appConfig.port;
  }

  await pollOperation("PUT", path, existing, token, { apiVersion: CAPP_API });
  await waitForApp(cfg, appName, token);
}

// --- Deploy ---

export async function deploy(cfg, appName, imageTag, opts) {
  var appConfig = opts.appConfig;
  var isFirstDeploy = opts.isFirstDeploy;
  var newSecrets = opts.newSecrets || {};
  var token = await getToken(cfg);

  var env = await ensureEnvironment(cfg, token);
  var registryCfg = await getRegistryConfig(cfg, token);

  var path = cappPath(cfg, appName);
  var body = buildContainerApp(appConfig, imageTag, newSecrets, env, registryCfg, {
    location: cfg.location || "eastus",
  });

  if (isFirstDeploy) {
    body.tags = { "managed-by": "relight", "relight-app": appName };
    await pollOperation("PUT", path, body, token, { apiVersion: CAPP_API });
  } else {
    // Get existing to preserve secrets and registries
    var existing;
    try {
      existing = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
    } catch {}

    if (existing) {
      // Carry forward live secret values
      var containers = existing.properties?.template?.containers || [];
      var liveEnvVars = {};
      for (var e of (containers[0]?.env || [])) {
        liveEnvVars[e.name] = e.value;
      }
      for (var key of (appConfig.secretKeys || [])) {
        if (!newSecrets[key] && liveEnvVars[key]) {
          newSecrets[key] = liveEnvVars[key];
        }
      }
      // Rebuild env with carried-forward secrets
      body.properties.template.containers[0].env = buildEnvVars(appConfig, newSecrets);
    }

    await pollOperation("PUT", path, body, token, { apiVersion: CAPP_API });
  }

  await waitForApp(cfg, appName, token);
}

// --- List apps ---

export async function listApps(cfg) {
  var token = await getToken(cfg);
  var path = `${rgPath(cfg)}/providers/Microsoft.App/containerApps`;
  var res = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });

  return (res.value || [])
    .filter((a) => a.name.startsWith("relight-"))
    .map((a) => ({
      name: a.name.replace("relight-", ""),
      modified: a.systemData?.lastModifiedAt || null,
    }));
}

// --- Get app info ---

export async function getAppInfo(cfg, appName) {
  var appConfig = await getAppConfig(cfg, appName);
  if (!appConfig) return null;

  var url = await getAppUrl(cfg, appName);
  return { appConfig, url };
}

// --- Destroy ---

export async function destroyApp(cfg, appName) {
  var token = await getToken(cfg);
  var path = cappPath(cfg, appName);

  try {
    await pollOperation("DELETE", path, null, token, { apiVersion: CAPP_API });
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }
}

// --- Scale ---

export async function scale(cfg, appName, opts) {
  var appConfig = opts.appConfig;
  await pushAppConfig(cfg, appName, appConfig);
}

// --- Container status ---

export async function getContainerStatus(cfg, appName) {
  var token = await getToken(cfg);
  var path = cappPath(cfg, appName);

  try {
    var app = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
    var replicas = app.properties?.template?.scale?.minReplicas || 0;
    return [
      {
        dimensions: { region: app.location, status: app.properties?.provisioningState || "Unknown" },
        avg: { cpuLoad: 0, memory: 0 },
      },
    ];
  } catch {
    return [];
  }
}

// --- App URL ---

export async function getAppUrl(cfg, appName) {
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig?.domains?.length > 0) {
    return `https://${appConfig.domains[0]}`;
  }

  var token = await getToken(cfg);
  var path = cappPath(cfg, appName);

  try {
    var app = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
    var fqdn = app.properties?.configuration?.ingress?.fqdn;
    return fqdn ? `https://${fqdn}` : null;
  } catch {
    return null;
  }
}

// --- Log streaming ---

export async function streamLogs(cfg, appName) {
  var token = await getToken(cfg);
  var path = cappPath(cfg, appName);
  var app = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });

  var envId = app.properties?.managedEnvironmentId;
  if (!envId) throw new Error("No managed environment found for log streaming.");

  // Use the Log Analytics workspace via system logs
  var logsPath = `${envId}/getAuthToken`;
  var running = true;
  var lastTimestamp = new Date(Date.now() - 60000).toISOString();

  var interval = setInterval(async () => {
    if (!running) return;
    try {
      // Query container app system logs
      var logPath = `${rgPath(cfg)}/providers/Microsoft.App/containerApps/relight-${appName}/revisions`;
      var revisions = await azureApi("GET", logPath, null, token, { apiVersion: CAPP_API });
      // Basic log polling - Azure Container Apps logs are best accessed via Log Analytics
      // This provides revision-level status updates
      for (var rev of (revisions.value || []).slice(-1)) {
        var ts = rev.properties?.createdTime || new Date().toISOString();
        if (ts > lastTimestamp) {
          console.log(`${ts}  [${rev.name}] ${rev.properties?.runningState || "unknown"}`);
          lastTimestamp = ts;
        }
      }
    } catch {}
  }, 5000);

  return {
    url: null,
    id: null,
    cleanup: async () => {
      running = false;
      clearInterval(interval);
    },
  };
}

// --- Cost analytics ---

export async function getCosts(cfg, appNames, dateRange) {
  var token = await getToken(cfg);
  var apps;

  if (appNames) {
    apps = appNames.map((n) => ({ name: n }));
  } else {
    apps = await listApps(cfg);
  }

  var { sinceDate, untilDate } = dateRange;
  var hours = (untilDate - sinceDate) / (1000 * 60 * 60);

  var results = [];
  for (var app of apps) {
    var path = cappPath(cfg, app.name);
    try {
      var detail = await azureApi("GET", path, null, token, { apiVersion: CAPP_API });
      var resources = detail.properties?.template?.containers?.[0]?.resources || {};
      var vcpu = resources.cpu || 0.25;
      var memGb = parseFloat(resources.memory) || 0.5;

      results.push({
        name: app.name,
        usage: {
          activeVcpuHrs: 0,
          provisionedVcpuHrs: vcpu * hours,
          memGbHrs: memGb * hours,
          vcpu,
          memGb,
          hours,
        },
      });
    } catch {
      results.push({ name: app.name, usage: { hours } });
    }
  }

  return results;
}

// --- Regions ---

export function getRegions() {
  return [
    { code: "eastus", name: "East US", location: "Virginia" },
    { code: "eastus2", name: "East US 2", location: "Virginia" },
    { code: "westus2", name: "West US 2", location: "Washington" },
    { code: "westus3", name: "West US 3", location: "Arizona" },
    { code: "centralus", name: "Central US", location: "Iowa" },
    { code: "northeurope", name: "North Europe", location: "Ireland" },
    { code: "westeurope", name: "West Europe", location: "Netherlands" },
    { code: "uksouth", name: "UK South", location: "London" },
    { code: "southeastasia", name: "Southeast Asia", location: "Singapore" },
    { code: "eastasia", name: "East Asia", location: "Hong Kong" },
    { code: "australiaeast", name: "Australia East", location: "Sydney" },
    { code: "japaneast", name: "Japan East", location: "Tokyo" },
    { code: "brazilsouth", name: "Brazil South", location: "São Paulo" },
    { code: "canadacentral", name: "Canada Central", location: "Toronto" },
  ];
}
