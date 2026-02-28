import {
  uploadWorker,
  deleteWorker,
  listWorkerScripts,
  getWorkerSettings,
  getDONamespaceId,
  listContainerApps,
  findContainerApp,
  createContainerApp,
  deleteContainerApp,
  modifyContainerApp,
  createRollout,
  createTail,
  deleteTail,
  getWorkersSubdomain,
  enableWorkerSubdomain,
  cfGraphQL,
} from "../../clouds/cf.js";
import { getWorkerBundle, templateHash } from "./bundle.js";

var VALID_HINTS = [
  "wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me",
];

export { VALID_HINTS };

// --- App config (stored in the deployed worker's RELIGHT_APP_CONFIG binding) ---

export async function getAppConfig(cfg, appName) {
  var scriptName = `relight-${appName}`;
  var settings = await getWorkerSettings(cfg.accountId, cfg.apiToken, scriptName);
  var bindings = settings?.bindings || [];
  var binding = bindings.find((b) => b.name === "RELIGHT_APP_CONFIG");
  if (!binding) return null;
  var appConfig = JSON.parse(binding.text);

  // Migration: old format has env object with values but no envKeys/secretKeys
  if (appConfig.env && !appConfig.envKeys) {
    appConfig.envKeys = Object.keys(appConfig.env);
    appConfig.secretKeys = [];
    return appConfig;
  }

  // New format: reconstruct env from native bindings
  if (!appConfig.env) appConfig.env = {};
  for (var key of (appConfig.envKeys || [])) {
    var b = bindings.find((x) => x.name === key && x.type === "plain_text");
    if (b) appConfig.env[key] = b.text;
  }
  for (var key of (appConfig.secretKeys || [])) {
    appConfig.env[key] = "[hidden]";
  }

  return appConfig;
}

export async function pushAppConfig(cfg, appName, appConfig, { newSecrets } = {}) {
  var code = getWorkerBundle();
  var metadata = buildWorkerMetadata(appConfig, { firstDeploy: false, newSecrets });
  await uploadWorker(cfg.accountId, cfg.apiToken, `relight-${appName}`, code, metadata);
}

// --- Metadata builder ---

export function buildWorkerMetadata(appConfig, { firstDeploy = false, newSecrets } = {}) {
  var envKeys = appConfig.envKeys || [];
  var secretKeys = appConfig.secretKeys || [];
  var configJson = Object.assign({}, appConfig);

  // Backward compat: keep env with plain_text values only
  var backcompatEnv = {};
  for (var key of envKeys) {
    if (appConfig.env && appConfig.env[key] !== undefined) {
      backcompatEnv[key] = appConfig.env[key];
    }
  }
  configJson.env = backcompatEnv;

  var bindings = [
    {
      type: "durable_object_namespace",
      name: "APP_CONTAINER",
      class_name: "AppContainer",
    },
    {
      type: "plain_text",
      name: "RELIGHT_APP_CONFIG",
      text: JSON.stringify(configJson),
    },
  ];

  // D1 binding
  if (appConfig.dbId) {
    bindings.push({ type: "d1", name: "DB", id: appConfig.dbId });
  }

  // Emit native plain_text bindings for each envKey
  for (var key of envKeys) {
    if (appConfig.env && appConfig.env[key] !== undefined) {
      bindings.push({ type: "plain_text", name: key, text: appConfig.env[key] });
    }
  }

  // Emit native secret_text bindings only for new/updated secrets
  for (var key of secretKeys) {
    if (newSecrets && newSecrets[key] !== undefined) {
      bindings.push({ type: "secret_text", name: key, text: newSecrets[key] });
    }
  }

  var metadata = {
    main_module: "index.js",
    compatibility_date: "2025-10-08",
    bindings,
    observability: {
      enabled: appConfig.observability !== false,
    },
    containers: [
      {
        class_name: "AppContainer",
      },
    ],
  };

  if (firstDeploy) {
    metadata.migrations = {
      new_tag: "v1",
      new_sqlite_classes: ["AppContainer"],
    };
  } else {
    metadata.migrations = {
      old_tag: "v1",
      new_tag: "v1",
    };
  }

  return metadata;
}

// --- Container config builder ---

function buildContainerConfig(appConfig) {
  var cfg = {
    image: appConfig.image,
    observability: { logs: { enabled: appConfig.observability !== false } },
  };

  if (appConfig.vcpu || appConfig.memory || appConfig.disk) {
    if (appConfig.vcpu) cfg.vcpu = appConfig.vcpu;
    if (appConfig.memory) cfg.memory_mib = appConfig.memory;
    if (appConfig.disk) cfg.disk = { size_mb: appConfig.disk };
  } else {
    cfg.instance_type = appConfig.instanceType || "lite";
  }

  return cfg;
}

// --- Deploy ---

export async function deploy(cfg, appName, imageTag, opts) {
  var scriptName = `relight-${appName}`;
  var appConfig = opts.appConfig;
  var isFirstDeploy = opts.isFirstDeploy;
  var newSecrets = opts.newSecrets || {};

  // Upload worker
  var currentHash = templateHash();
  var needsWorkerUpload = isFirstDeploy || appConfig.templateHash !== currentHash;

  if (needsWorkerUpload) {
    var bundledCode = getWorkerBundle();
    appConfig.templateHash = currentHash;
    var metadata = buildWorkerMetadata(appConfig, { firstDeploy: isFirstDeploy, newSecrets });
    await uploadWorker(cfg.accountId, cfg.apiToken, scriptName, bundledCode, metadata);
  } else {
    await pushAppConfig(cfg, appName, appConfig, { newSecrets });
  }

  // Deploy container application
  var namespaceId = await getDONamespaceId(cfg.accountId, cfg.apiToken, scriptName, "AppContainer");
  if (!namespaceId) {
    throw new Error("Could not find Durable Object namespace for AppContainer. The worker upload may have failed.");
  }

  var existingApp = await findContainerApp(cfg.accountId, cfg.apiToken, scriptName);
  var maxInstances = (appConfig.regions?.length || 1) * (appConfig.instances || 2);

  if (existingApp) {
    if (existingApp.max_instances !== maxInstances) {
      await modifyContainerApp(cfg.accountId, cfg.apiToken, existingApp.id, {
        max_instances: maxInstances,
      });
    }
    await createRollout(cfg.accountId, cfg.apiToken, existingApp.id, {
      description: `Deploy ${imageTag}`,
      strategy: "rolling",
      kind: "full_auto",
      step_percentage: 100,
      target_configuration: buildContainerConfig(appConfig),
    });
  } else {
    await createContainerApp(cfg.accountId, cfg.apiToken, {
      name: scriptName,
      scheduling_policy: "default",
      instances: 0,
      max_instances: maxInstances,
      configuration: buildContainerConfig(appConfig),
      durable_objects: {
        namespace_id: namespaceId,
      },
    });
  }

  // Enable workers.dev route
  try {
    await enableWorkerSubdomain(cfg.accountId, cfg.apiToken, scriptName);
  } catch {}
}

// --- List apps ---

export async function listApps(cfg) {
  var scripts = await listWorkerScripts(cfg.accountId, cfg.apiToken);
  var apps = scripts.filter((s) => s.id.startsWith("relight-"));
  return apps.map((s) => ({
    name: s.id.replace("relight-", ""),
    modified: s.modified_on || null,
  }));
}

// --- Get app info ---

export async function getAppInfo(cfg, appName) {
  var appConfig = await getAppConfig(cfg, appName);
  if (!appConfig) return null;

  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var url = subdomain
    ? `https://relight-${appName}.${subdomain}.workers.dev`
    : null;

  return { appConfig, url };
}

// --- Destroy ---

export async function destroyApp(cfg, appName) {
  var scriptName = `relight-${appName}`;

  // Delete D1 database if attached
  var appConfig;
  try {
    appConfig = await getAppConfig(cfg, appName);
    if (appConfig && appConfig.dbId) {
      var { deleteD1Database } = await import("../../clouds/cf.js");
      await deleteD1Database(cfg.accountId, cfg.apiToken, appConfig.dbId);
    }
  } catch {}

  // Delete container application
  try {
    var containerApp = await findContainerApp(cfg.accountId, cfg.apiToken, scriptName);
    if (containerApp) {
      await deleteContainerApp(cfg.accountId, cfg.apiToken, containerApp.id);
    }
  } catch {}

  // Delete worker
  await deleteWorker(cfg.accountId, cfg.apiToken, scriptName);
}

// --- Scale ---

export async function scale(cfg, appName, opts) {
  var appConfig = opts.appConfig;

  await pushAppConfig(cfg, appName, appConfig);

  var scriptName = `relight-${appName}`;
  var containerApp = await findContainerApp(cfg.accountId, cfg.apiToken, scriptName);
  if (containerApp) {
    var maxInstances = (appConfig.regions?.length || 1) * (appConfig.instances || 2);
    var modification = { max_instances: maxInstances };

    if (appConfig.vcpu || appConfig.memory || appConfig.disk) {
      modification.configuration = {};
      if (appConfig.vcpu) modification.configuration.vcpu = appConfig.vcpu;
      if (appConfig.memory) modification.configuration.memory_mib = appConfig.memory;
      if (appConfig.disk) modification.configuration.disk = { size_mb: appConfig.disk };
    } else if (appConfig.instanceType) {
      modification.configuration = { instance_type: appConfig.instanceType };
    }

    await modifyContainerApp(cfg.accountId, cfg.apiToken, containerApp.id, modification);
  }
}

// --- Container status ---

var containerMetricsGQL = `query($accountTag: string!, $filter: AccountContainersMetricsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersMetricsAdaptiveGroups(limit: 1000, filter: $filter) {
        dimensions { applicationId region active durableObjectId }
        avg { cpuLoad memory }
      }
    }
  }
}`;

export async function getContainerStatus(cfg, appName) {
  var scriptName = `relight-${appName}`;
  var containerApp = await findContainerApp(cfg.accountId, cfg.apiToken, scriptName);
  if (!containerApp) return [];

  var now = new Date();
  var since = new Date(now.getTime() - 15 * 60000);
  try {
    var data = await cfGraphQL(cfg.apiToken, containerMetricsGQL, {
      accountTag: cfg.accountId,
      filter: {
        datetimeFiveMinutes_geq: since.toISOString().slice(0, 19) + "Z",
        datetimeFiveMinutes_leq: now.toISOString().slice(0, 19) + "Z",
        applicationId_in: [containerApp.id],
      },
    });
    return data?.viewer?.accounts?.[0]?.containersMetricsAdaptiveGroups || [];
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
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  if (!subdomain) return null;
  return `https://relight-${appName}.${subdomain}.workers.dev`;
}

// --- Log streaming ---

export async function streamLogs(cfg, appName) {
  var scriptName = `relight-${appName}`;
  var tail = await createTail(cfg.accountId, cfg.apiToken, scriptName);
  return {
    url: tail.url,
    id: tail.id,
    cleanup: async () => {
      try {
        await deleteTail(cfg.accountId, cfg.apiToken, scriptName, tail.id);
      } catch {}
    },
  };
}

// --- Cost analytics ---

var workersGQL = `query Workers($accountTag: string!, $filter: WorkersInvocationsAdaptiveFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 10000, filter: $filter) {
        dimensions { scriptName }
        sum { requests cpuTimeUs }
        avg { sampleInterval }
      }
    }
  }
}`;

var doRequestsGQL = `query DORequests($accountTag: string!, $filter: DurableObjectsInvocationsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId }
        sum { requests }
        avg { sampleInterval }
      }
    }
  }
}`;

var doDurationGQL = `query DODuration($accountTag: string!, $filter: DurableObjectsPeriodicGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(limit: 10000, filter: $filter) {
        dimensions { namespaceId }
        sum { activeTime inboundWebsocketMsgCount }
      }
    }
  }
}`;

var containersGQL = `query Containers($accountTag: string!, $filter: AccountContainersMetricsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersMetricsAdaptiveGroups(limit: 10000, filter: $filter) {
        dimensions { applicationId }
        sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
      }
    }
  }
}`;

export async function getCosts(cfg, appNames, dateRange) {
  var { sinceISO, untilISO } = dateRange;

  // Discover all relight scripts and container apps
  var [allScripts, containerApps] = await Promise.all([
    listWorkerScripts(cfg.accountId, cfg.apiToken),
    listContainerApps(cfg.accountId, cfg.apiToken),
  ]);

  var containerAppMap = {};
  for (var ca of containerApps) {
    containerAppMap[ca.name] = ca.id;
  }

  // Build app list with namespace IDs
  var targetNames = appNames || allScripts
    .filter((s) => s.id.startsWith("relight-"))
    .map((s) => s.id.replace(/^relight-/, ""));

  var apps = [];
  await Promise.all(
    targetNames.map(async (appName) => {
      var scriptName = `relight-${appName}`;
      var [nsId, appConfig] = await Promise.all([
        getDONamespaceId(cfg.accountId, cfg.apiToken, scriptName, "AppContainer"),
        getAppConfig(cfg, appName),
      ]);
      apps.push({
        name: appName,
        namespaceId: nsId,
        appConfig,
        containerAppId: containerAppMap[scriptName] || null,
      });
    })
  );

  apps.sort((a, b) => a.name.localeCompare(b.name));

  // Fetch all analytics in parallel
  var scriptNames = apps.map((a) => `relight-${a.name}`);
  var namespaceIds = apps.map((a) => a.namespaceId).filter(Boolean);
  var containerAppIds = apps.map((a) => a.containerAppId).filter(Boolean);

  var queries = [];

  queries.push(
    cfGraphQL(cfg.apiToken, workersGQL, {
      accountTag: cfg.accountId,
      filter: {
        datetimeHour_geq: sinceISO,
        datetimeHour_leq: untilISO,
        scriptName_in: scriptNames,
      },
    })
  );

  if (namespaceIds.length > 0) {
    var doFilter = {
      datetimeHour_geq: sinceISO,
      datetimeHour_leq: untilISO,
      namespaceId_in: namespaceIds,
    };
    queries.push(
      cfGraphQL(cfg.apiToken, doRequestsGQL, { accountTag: cfg.accountId, filter: doFilter })
    );
    queries.push(
      cfGraphQL(cfg.apiToken, doDurationGQL, { accountTag: cfg.accountId, filter: doFilter })
    );
  } else {
    queries.push(Promise.resolve(null), Promise.resolve(null));
  }

  if (containerAppIds.length > 0) {
    queries.push(
      cfGraphQL(cfg.apiToken, containersGQL, {
        accountTag: cfg.accountId,
        filter: {
          datetimeHour_geq: sinceISO,
          datetimeHour_leq: untilISO,
          applicationId_in: containerAppIds,
        },
      })
    );
  } else {
    queries.push(Promise.resolve(null));
  }

  var [workersData, doReqData, doDurData, containersData] = await Promise.all(queries);

  // Aggregate per-app usage
  return aggregateResults(apps, { workersData, doReqData, doDurData, containersData });
}

function aggregateResults(apps, analytics) {
  var { workersData, doReqData, doDurData, containersData } = analytics;

  var workerRows =
    workersData?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  var workersByScript = {};
  for (var row of workerRows) {
    var sn = row.dimensions.scriptName;
    var si = row.avg?.sampleInterval || 1;
    if (!workersByScript[sn]) workersByScript[sn] = { requests: 0, cpuMs: 0 };
    workersByScript[sn].requests += (row.sum?.requests || 0) * si;
    workersByScript[sn].cpuMs += ((row.sum?.cpuTimeUs || 0) / 1000) * si;
  }

  var doReqRows =
    doReqData?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups || [];
  var doReqByNs = {};
  for (var row of doReqRows) {
    var ns = row.dimensions.namespaceId;
    var si = row.avg?.sampleInterval || 1;
    if (!doReqByNs[ns]) doReqByNs[ns] = 0;
    doReqByNs[ns] += (row.sum?.requests || 0) * si;
  }

  var doDurRows =
    doDurData?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups || [];
  var doDurByNs = {};
  for (var row of doDurRows) {
    var ns = row.dimensions.namespaceId;
    if (!doDurByNs[ns]) doDurByNs[ns] = { activeTime: 0, wsInbound: 0 };
    doDurByNs[ns].activeTime += row.sum?.activeTime || 0;
    doDurByNs[ns].wsInbound += row.sum?.inboundWebsocketMsgCount || 0;
  }

  var containerRows =
    containersData?.viewer?.accounts?.[0]?.containersMetricsAdaptiveGroups || [];
  var containersByAppId = {};
  for (var row of containerRows) {
    var appId = row.dimensions.applicationId;
    if (!containersByAppId[appId]) {
      containersByAppId[appId] = { cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 };
    }
    containersByAppId[appId].cpuTimeSec += row.sum?.cpuTimeSec || 0;
    containersByAppId[appId].allocatedMemory += row.sum?.allocatedMemory || 0;
    containersByAppId[appId].allocatedDisk += row.sum?.allocatedDisk || 0;
    containersByAppId[appId].txBytes += row.sum?.txBytes || 0;
  }

  return apps.map((app) => {
    var scriptName = `relight-${app.name}`;
    var w = workersByScript[scriptName] || { requests: 0, cpuMs: 0 };
    var nsId = app.namespaceId;

    var doDuration = nsId ? doDurByNs[nsId] || {} : {};
    var doRequests = (nsId ? doReqByNs[nsId] || 0 : 0) + (doDuration.wsInbound || 0) / 20;

    var c = app.containerAppId ? containersByAppId[app.containerAppId] || {} : {};
    var containerVcpuSec = c.cpuTimeSec || 0;
    var containerMemGibSec = (c.allocatedMemory || 0) / (1024 * 1024 * 1024);
    var containerDiskGbSec = (c.allocatedDisk || 0) / 1_000_000_000;
    var containerEgressGb = (c.txBytes || 0) / 1_000_000_000;

    return {
      name: app.name,
      usage: {
        workerRequests: Math.round(w.requests),
        workerCpuMs: Math.round(w.cpuMs),
        doRequests: Math.round(doRequests),
        doWsMsgs: Math.round(doDuration.wsInbound || 0),
        doGbSeconds: Math.round(((doDuration.activeTime || 0) / 1_000_000) * 128 / 1024),
        containerVcpuSec,
        containerMemGibSec,
        containerDiskGbSec,
        containerEgressGb,
      },
    };
  });
}

// --- Regions ---

export function getRegions() {
  return [
    { code: "wnam", name: "Western North America", location: "Los Angeles, Seattle, San Francisco" },
    { code: "enam", name: "Eastern North America", location: "New York, Chicago, Toronto" },
    { code: "sam", name: "South America", location: "Sao Paulo, Buenos Aires" },
    { code: "weur", name: "Western Europe", location: "London, Paris, Amsterdam, Frankfurt" },
    { code: "eeur", name: "Eastern Europe", location: "Warsaw, Helsinki, Bucharest" },
    { code: "apac", name: "Asia Pacific", location: "Tokyo, Singapore, Hong Kong, Mumbai" },
    { code: "oc", name: "Oceania", location: "Sydney, Auckland" },
    { code: "afr", name: "Africa", location: "Johannesburg, Nairobi" },
    { code: "me", name: "Middle East", location: "Dubai, Bahrain" },
  ];
}
