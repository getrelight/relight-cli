import { azureApi, pollOperation, getToken, rgPath } from "../../clouds/azure.js";
import { status } from "../../output.js";

var CAPP_API = "2024-03-01";
var CERT_API = "2025-07-01";

// --- Internal helpers ---

function cappPath(cfg, appName) {
  return `${rgPath(cfg)}/providers/Microsoft.App/containerApps/relight-${appName}`;
}

function envPath(cfg) {
  return `${rgPath(cfg)}/providers/Microsoft.App/managedEnvironments/relight-env`;
}

function certNameForDomain(domain) {
  return `relight-${domain.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 50)}`;
}

function certPath(cfg, domain) {
  return `${envPath(cfg)}/managedCertificates/${certNameForDomain(domain)}`;
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

async function getLiveApp(cfg, appName, token) {
  return azureApi("GET", cappPath(cfg, appName), null, token, { apiVersion: CAPP_API });
}

async function getDefaultHostname(cfg, appName, token) {
  var app = await getLiveApp(cfg, appName, token);
  return app.properties?.configuration?.ingress?.fqdn || null;
}

async function waitForManagedCertificate(cfg, domain, token) {
  var path = certPath(cfg, domain);
  var lastState = null;
  for (var i = 0; i < 120; i++) {
    var cert = await azureApi("GET", path, null, token, { apiVersion: CERT_API });
    var state = cert.properties?.provisioningState;
    if (state && state !== lastState) {
      status(`Managed certificate state: ${state}`);
      lastState = state;
    }
    if (state === "Succeeded") return cert;
    if (state === "Failed" || state === "Canceled") {
      throw new Error(`Managed certificate for ${domain} reached state: ${state}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timed out waiting for managed certificate for ${domain}.`);
}

async function updateCustomDomainBinding(cfg, appName, domain, binding, token) {
  var app = await getLiveApp(cfg, appName, token);
  var registryCfg = await getRegistryConfig(cfg, {});
  var ingress = app.properties?.configuration?.ingress || {};
  var customDomains = ingress.customDomains || [];
  var existing = customDomains.find((d) => d.name === domain);

  if (!existing) {
    existing = { name: domain };
    customDomains.push(existing);
  }

  existing.bindingType = binding.bindingType;
  if (binding.certificateId) {
    existing.certificateId = binding.certificateId;
  } else {
    delete existing.certificateId;
  }

  // Azure omits secret values on GET, so rehydrate registry auth on every PUT.
  app.properties.configuration.registries = [
    {
      server: registryCfg.server,
      username: registryCfg.username,
      passwordSecretRef: "registry-password",
    },
  ];
  app.properties.configuration.secrets = [
    { name: "registry-password", value: registryCfg.password },
  ];
  app.properties.configuration.ingress.customDomains = customDomains;
  await pollOperation("PUT", cappPath(cfg, appName), app, token, { apiVersion: CAPP_API });
  await waitForApp(cfg, appName, token);
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

async function getRegistryConfig(cfg, opts) {
  var creds = opts?.registryCredentials;
  var server = opts?.registryServer;

  if (!creds) {
    var { resolveStack } = await import("../resolve.js");
    var registryStack = await resolveStack(opts?.providerOptions || {}, ["registry"]);
    creds = await registryStack.registry.provider.getCredentials(registryStack.registry.cfg);
    server = creds.registry;
  }

  server = (server || creds.registry)
    .replace("https://", "")
    .replace("http://", "");

  if (!creds.username || !creds.password) {
    throw new Error("Registry credentials are incomplete. Re-check your registry provider config.");
  }

  return {
    server,
    username: creds.username,
    passwordSecretRef: "registry-password",
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
            passwordSecretRef: "registry-password",
          },
        ],
        secrets: [
          { name: "registry-password", value: registryCfg.password },
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
  var registryCfg = await getRegistryConfig(cfg, opts);

  // Patch the container
  existing.properties.template.containers[0].env = envVars;
  existing.properties.template.containers[0].image = appConfig.image;
  existing.properties.template.containers[0].resources = { cpu: vcpu, memory };
  existing.properties.template.scale.maxReplicas = appConfig.instances || 2;
  existing.properties.configuration.registries = [
    {
      server: registryCfg.server,
      username: registryCfg.username,
      passwordSecretRef: "registry-password",
    },
  ];
  existing.properties.configuration.secrets = [
    { name: "registry-password", value: registryCfg.password },
  ];

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
  var registryCfg = await getRegistryConfig(cfg, opts);

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

export async function prepareCustomDomain(cfg, appName, domain) {
  var token = await getToken(cfg);
  var app = await getLiveApp(cfg, appName, token);
  var fqdn = app.properties?.configuration?.ingress?.fqdn;
  var verificationId = app.properties?.customDomainVerificationId;
  if (!fqdn) {
    throw new Error(`Could not determine default hostname for ${appName}.`);
  }
  if (!verificationId) {
    throw new Error(`Could not determine custom domain verification ID for ${appName}.`);
  }

  return {
    dnsTarget: fqdn,
    proxied: false,
    restoreProxied: true,
    domain,
    validationRecords: [
      {
        type: "TXT",
        name: `asuid.${domain}`,
        content: verificationId,
      },
    ],
  };
}

export async function finalizeCustomDomain(cfg, appName, domain) {
  var token = await getToken(cfg);
  var certId = certPath(cfg, domain);

  // Azure requires the hostname to exist on the app before a managed cert can be issued.
  await updateCustomDomainBinding(cfg, appName, domain, { bindingType: "Disabled" }, token);

  // Create or reconcile the managed certificate once DNS points directly to ACA.
  await pollOperation(
    "PUT",
    certId,
    {
      location: cfg.location || "eastus",
      properties: {
        subjectName: domain,
        domainControlValidation: "CNAME",
      },
    },
    token,
    { apiVersion: CERT_API }
  );

  var cert = await waitForManagedCertificate(cfg, domain, token);
  await updateCustomDomainBinding(
    cfg,
    appName,
    domain,
    { bindingType: "SniEnabled", certificateId: cert.id },
    token
  );
}

export async function unmapCustomDomain(cfg, appName, domain) {
  var token = await getToken(cfg);
  var app = await getLiveApp(cfg, appName, token);
  var ingress = app.properties?.configuration?.ingress || {};
  var current = ingress.customDomains || [];
  var next = current.filter((d) => d.name !== domain);

  if (next.length !== current.length) {
    app.properties.configuration.ingress.customDomains = next;
    await pollOperation("PUT", cappPath(cfg, appName), app, token, { apiVersion: CAPP_API });
    await waitForApp(cfg, appName, token);
  }

  try {
    await pollOperation("DELETE", certPath(cfg, domain), null, token, { apiVersion: CERT_API });
  } catch (e) {
    if (!e.message.includes("404")) throw e;
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
    { code: "polandcentral", name: "Poland Central", location: "Warsaw" },
    { code: "uksouth", name: "UK South", location: "London" },
    { code: "southeastasia", name: "Southeast Asia", location: "Singapore" },
    { code: "eastasia", name: "East Asia", location: "Hong Kong" },
    { code: "australiaeast", name: "Australia East", location: "Sydney" },
    { code: "japaneast", name: "Japan East", location: "Tokyo" },
    { code: "brazilsouth", name: "Brazil South", location: "São Paulo" },
    { code: "canadacentral", name: "Canada Central", location: "Toronto" },
  ];
}
