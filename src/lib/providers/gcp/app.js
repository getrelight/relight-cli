import {
  mintAccessToken,
  listAllServices,
  getService,
  createService,
  updateService,
  deleteService,
  setIamPolicy,
  listLogEntries,
  queryTimeSeries,
  deleteSqlInstance,
  ensureFirebaseProject,
  createHostingSite,
  getHostingSite,
  deleteHostingSite,
  deployHostingProxy,
  addHostingCustomDomain,
  deleteHostingCustomDomain,
} from "../../clouds/gcp.js";

// --- Helpers ---

function serviceName(project, region, name) {
  return `projects/${project}/locations/${region}/services/${name}`;
}

function parseRegionFromName(name) {
  // projects/{p}/locations/{region}/services/{s}
  var parts = name.split("/");
  return parts[3];
}

async function findService(token, project, appName) {
  var svcName = `relight-${appName}`;
  var all = await listAllServices(token, project);
  var svc = all.find(
    (s) => s.name.split("/").pop() === svcName
  );
  if (!svc) return null;
  return svc;
}

function buildServiceBody(appConfig, imageTag, newSecrets) {
  var envVars = [];

  // Master config (without env values to avoid duplication)
  var configCopy = Object.assign({}, appConfig);
  delete configCopy.env;
  envVars.push({ name: "RELIGHT_APP_CONFIG", value: JSON.stringify(configCopy) });

  // Individual env vars
  for (var key of (appConfig.envKeys || [])) {
    if (appConfig.env && appConfig.env[key] !== undefined && appConfig.env[key] !== "[hidden]") {
      envVars.push({ name: key, value: String(appConfig.env[key]) });
    }
  }

  // Secret keys as plain env vars (GCP encrypts at rest)
  for (var key of (appConfig.secretKeys || [])) {
    if (newSecrets && newSecrets[key] !== undefined) {
      envVars.push({ name: key, value: String(newSecrets[key]) });
    }
  }

  var port = appConfig.port || 8080;
  var maxInstances = appConfig.instances || 2;
  var vcpu = appConfig.vcpu || "1";
  var memory = appConfig.memory ? `${appConfig.memory}Mi` : "512Mi";

  return {
    template: {
      containers: [
        {
          image: imageTag || appConfig.image,
          env: envVars,
          ports: [{ containerPort: port }],
          resources: {
            limits: {
              cpu: String(vcpu),
              memory: memory,
            },
          },
        },
      ],
      scaling: {
        minInstanceCount: 0,
        maxInstanceCount: maxInstances,
      },
    },
    labels: {
      "managed-by": "relight",
      "relight-app": appConfig.name,
    },
    ingress: "INGRESS_TRAFFIC_ALL",
  };
}

// --- App config ---

export async function getAppConfig(cfg, appName) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var svc = await findService(token, cfg.project, appName);
  if (!svc) return null;

  var containers = svc.template?.containers || [];
  var envVars = containers[0]?.env || [];
  var configEnv = envVars.find((e) => e.name === "RELIGHT_APP_CONFIG");
  if (!configEnv) return null;

  var appConfig = JSON.parse(configEnv.value);

  // Reconstruct env from individual env vars on the service
  if (!appConfig.env) appConfig.env = {};
  for (var key of (appConfig.envKeys || [])) {
    var found = envVars.find((e) => e.name === key);
    if (found) appConfig.env[key] = found.value;
  }
  for (var key of (appConfig.secretKeys || [])) {
    var found = envVars.find((e) => e.name === key);
    if (found) appConfig.env[key] = "[hidden]";
  }

  return appConfig;
}

export async function pushAppConfig(cfg, appName, appConfig, opts) {
  var newSecrets = opts?.newSecrets || {};
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var svc = await findService(token, cfg.project, appName);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);

  // Carry forward existing secret values from the live service
  var liveEnvVars = svc.template?.containers?.[0]?.env || [];
  for (var key of (appConfig.secretKeys || [])) {
    if (!newSecrets[key]) {
      var existing = liveEnvVars.find((e) => e.name === key);
      if (existing) newSecrets[key] = existing.value;
    }
  }

  var body = buildServiceBody(appConfig, appConfig.image, newSecrets);
  await updateService(token, svc.name, body);
}

// --- Deploy ---

export async function deploy(cfg, appName, imageTag, opts) {
  var appConfig = opts.appConfig;
  var isFirstDeploy = opts.isFirstDeploy;
  var newSecrets = opts.newSecrets || {};
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);

  var svcId = `relight-${appName}`;
  var region = appConfig.regions?.[0] || "us-central1";

  var body = buildServiceBody(appConfig, imageTag, newSecrets);

  if (isFirstDeploy) {
    await createService(token, cfg.project, region, svcId, body);

    // Make service publicly accessible
    var fullName = serviceName(cfg.project, region, svcId);
    await setIamPolicy(token, fullName, {
      bindings: [
        {
          role: "roles/run.invoker",
          members: ["allUsers"],
        },
      ],
    });
  } else {
    var svc = await findService(token, cfg.project, appName);
    if (!svc) throw new Error(`Service ${svcId} not found.`);

    // Carry forward existing secret values
    var liveEnvVars = svc.template?.containers?.[0]?.env || [];
    for (var key of (appConfig.secretKeys || [])) {
      if (!newSecrets[key]) {
        var existing = liveEnvVars.find((e) => e.name === key);
        if (existing) newSecrets[key] = existing.value;
      }
    }

    body = buildServiceBody(appConfig, imageTag, newSecrets);
    await updateService(token, svc.name, body);
  }
}

// --- List apps ---

export async function listApps(cfg) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var all = await listAllServices(token, cfg.project);
  return all
    .filter((s) => s.labels?.["managed-by"] === "relight")
    .map((s) => ({
      name: s.name.split("/").pop().replace("relight-", ""),
      modified: s.updateTime || null,
    }));
}

// --- Get app info ---

export async function getAppInfo(cfg, appName) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var svc = await findService(token, cfg.project, appName);
  if (!svc) return null;

  var region = parseRegionFromName(svc.name);
  var svcId = svc.name.split("/").pop();
  var appConfig = await getAppConfig(cfg, appName);
  return {
    appConfig,
    url: svc.uri || null,
    consoleUrl: `https://console.cloud.google.com/run/detail/${region}/${svcId}?project=${cfg.project}`,
  };
}

// --- Destroy ---

export async function destroyApp(cfg, appName) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);

  // Delete Cloud SQL instance if attached
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig?.dbId) {
    try {
      await deleteSqlInstance(token, cfg.project, appConfig.dbId);
    } catch {}
  }

  // Delete Firebase Hosting site if exists
  try {
    await deleteHostingSite(token, cfg.project, hostingSiteId(appName));
  } catch {}

  // Delete Cloud Run service
  var svc = await findService(token, cfg.project, appName);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);
  await deleteService(token, svc.name);
}

// --- Scale ---

export async function scale(cfg, appName, opts) {
  var appConfig = opts.appConfig;
  await pushAppConfig(cfg, appName, appConfig);
}

// --- Container status ---

export async function getContainerStatus(cfg, appName) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var svc = await findService(token, cfg.project, appName);
  if (!svc) return [];

  var region = parseRegionFromName(svc.name);
  var now = new Date();
  var since = new Date(now.getTime() - 15 * 60000);

  try {
    var res = await queryTimeSeries(token, cfg.project, {
      query: `fetch cloud_run_revision
        | metric 'run.googleapis.com/container/instance_count'
        | filter resource.service_name == 'relight-${appName}'
        | within ${15}m
        | group_by [resource.service_name], mean(val())`,
    });

    var series = res.timeSeriesData || [];
    return series.map((s) => ({
      dimensions: { region, active: true },
      avg: {
        cpuLoad: 0,
        memory: 0,
      },
    }));
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

  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var svc = await findService(token, cfg.project, appName);
  return svc?.uri || null;
}

// --- Custom domain via Firebase Hosting ---

function hostingSiteId(appName) {
  return `relight-${appName}`;
}

async function ensureHostingSite(token, project, appName) {
  var siteId = hostingSiteId(appName);
  try {
    await getHostingSite(token, project, siteId);
  } catch {
    await ensureFirebaseProject(token, project);
    await createHostingSite(token, project, siteId);
  }

  // Deploy proxy config pointing to Cloud Run
  var svc = await findService(token, project, appName);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);
  var region = parseRegionFromName(svc.name);
  var svcId = svc.name.split("/").pop();
  await deployHostingProxy(token, siteId, svcId, region);

  return siteId;
}

export async function mapCustomDomain(cfg, appName, domain) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var siteId = await ensureHostingSite(token, cfg.project, appName);
  await addHostingCustomDomain(token, cfg.project, siteId, domain);
  return { dnsTarget: `${siteId}.web.app`, proxied: false };
}

export async function unmapCustomDomain(cfg, appName, domain) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var siteId = hostingSiteId(appName);
  try {
    await deleteHostingCustomDomain(token, cfg.project, siteId, domain);
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }
}

// --- Log streaming ---

export async function streamLogs(cfg, appName) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var svc = await findService(token, cfg.project, appName);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);

  var lastTimestamp = new Date(Date.now() - 60000).toISOString();
  var running = true;

  var interval = setInterval(async () => {
    if (!running) return;
    try {
      var freshToken = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
      var res = await listLogEntries(freshToken, {
        resourceNames: [`projects/${cfg.project}`],
        filter: `resource.type="cloud_run_revision" AND resource.labels.service_name="relight-${appName}" AND timestamp>="${lastTimestamp}"`,
        orderBy: "timestamp asc",
        pageSize: 100,
      });

      var entries = res.entries || [];
      for (var entry of entries) {
        var ts = entry.timestamp || new Date().toISOString();
        var msg =
          entry.textPayload ||
          entry.jsonPayload?.message ||
          (entry.httpRequest
            ? `${entry.httpRequest.requestMethod} ${entry.httpRequest.requestUrl} ${entry.httpRequest.status}`
            : JSON.stringify(entry.jsonPayload || ""));
        var severity = entry.severity || "DEFAULT";
        console.log(`${ts}  [${severity}] ${msg}`);
        lastTimestamp = ts;
      }
    } catch {}
  }, 3000);

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
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var { sinceISO, untilISO } = dateRange;

  // MQL datetime format: YYYY/MM/DD-HH:MM:SS (not ISO 8601)
  var sinceMql = isoToMql(sinceISO);
  var untilMql = isoToMql(untilISO);

  // Discover apps
  var apps;
  if (appNames) {
    apps = appNames.map((n) => ({ name: n, serviceName: `relight-${n}` }));
  } else {
    var allSvcs = await listAllServices(token, cfg.project);
    apps = allSvcs
      .filter((s) => s.labels?.["managed-by"] === "relight")
      .map((s) => ({
        name: s.name.split("/").pop().replace("relight-", ""),
        serviceName: s.name.split("/").pop(),
      }));
  }

  // Query Cloud Monitoring for each metric
  var results = [];
  for (var app of apps) {
    var usage = { requests: 0, cpuSeconds: 0, memGibSeconds: 0, egressGb: 0 };

    try {
      // Request count
      var reqRes = await queryTimeSeries(token, cfg.project, {
        query: `fetch cloud_run_revision
          | metric 'run.googleapis.com/request_count'
          | filter resource.service_name == '${app.serviceName}'
          | within d'${sinceMql}', d'${untilMql}'
          | group_by [], sum(val())`,
      });
      var reqData = reqRes.timeSeriesData || [];
      for (var ts of reqData) {
        for (var pt of (ts.pointData || [])) {
          usage.requests += Number(pt.values?.[0]?.int64Value || 0);
        }
      }
    } catch (e) {
      process.stderr.write(`  Warning: failed to fetch request metrics: ${e.message}\n`);
    }

    try {
      // CPU allocation
      var cpuRes = await queryTimeSeries(token, cfg.project, {
        query: `fetch cloud_run_revision
          | metric 'run.googleapis.com/container/cpu/allocation_time'
          | filter resource.service_name == '${app.serviceName}'
          | within d'${sinceMql}', d'${untilMql}'
          | group_by [], sum(val())`,
      });
      var cpuData = cpuRes.timeSeriesData || [];
      for (var ts of cpuData) {
        for (var pt of (ts.pointData || [])) {
          usage.cpuSeconds += Number(pt.values?.[0]?.doubleValue || 0);
        }
      }
    } catch (e) {
      process.stderr.write(`  Warning: failed to fetch CPU metrics: ${e.message}\n`);
    }

    try {
      // Memory allocation
      var memRes = await queryTimeSeries(token, cfg.project, {
        query: `fetch cloud_run_revision
          | metric 'run.googleapis.com/container/memory/allocation_time'
          | filter resource.service_name == '${app.serviceName}'
          | within d'${sinceMql}', d'${untilMql}'
          | group_by [], sum(val())`,
      });
      var memData = memRes.timeSeriesData || [];
      for (var ts of memData) {
        for (var pt of (ts.pointData || [])) {
          // allocation_time is in GiB-seconds
          usage.memGibSeconds += Number(pt.values?.[0]?.doubleValue || 0);
        }
      }
    } catch (e) {
      process.stderr.write(`  Warning: failed to fetch memory metrics: ${e.message}\n`);
    }

    results.push({ name: app.name, usage });
  }

  return results;
}

function isoToMql(iso) {
  // Convert 2026-03-01T00:00:00Z -> 2026/03/01-00:00:00
  return iso.replace(/Z$/, "").replace(/^(\d{4})-(\d{2})-(\d{2})T/, "$1/$2/$3-");
}

// --- Regions ---

export function getRegions() {
  return [
    { code: "us-central1", name: "Iowa", location: "Council Bluffs, Iowa, USA" },
    { code: "us-east1", name: "South Carolina", location: "Moncks Corner, South Carolina, USA" },
    { code: "us-east4", name: "Northern Virginia", location: "Ashburn, Virginia, USA" },
    { code: "us-west1", name: "Oregon", location: "The Dalles, Oregon, USA" },
    { code: "us-west2", name: "Los Angeles", location: "Los Angeles, California, USA" },
    { code: "us-west4", name: "Las Vegas", location: "Las Vegas, Nevada, USA" },
    { code: "europe-west1", name: "Belgium", location: "St. Ghislain, Belgium" },
    { code: "europe-west2", name: "London", location: "London, England, UK" },
    { code: "europe-west4", name: "Netherlands", location: "Eemshaven, Netherlands" },
    { code: "europe-west9", name: "Paris", location: "Paris, France" },
    { code: "asia-east1", name: "Taiwan", location: "Changhua County, Taiwan" },
    { code: "asia-northeast1", name: "Tokyo", location: "Tokyo, Japan" },
    { code: "asia-southeast1", name: "Singapore", location: "Jurong West, Singapore" },
    { code: "australia-southeast1", name: "Sydney", location: "Sydney, Australia" },
    { code: "southamerica-east1", name: "Sao Paulo", location: "Sao Paulo, Brazil" },
    { code: "me-west1", name: "Tel Aviv", location: "Tel Aviv, Israel" },
  ];
}
