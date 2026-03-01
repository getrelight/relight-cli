import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

var CONFIG_DIR = join(homedir(), ".relight");
var CONFIG_PATH = join(CONFIG_DIR, "config.json");

export { CONFIG_DIR, CONFIG_PATH };

export var CLOUD_NAMES = {
  cf: "Cloudflare",
  gcp: "GCP",
  aws: "AWS",
};

export var CLOUD_IDS = Object.keys(CLOUD_NAMES);

export var SERVICE_TYPES = {
  slicervm: { layer: "compute", name: "SlicerVM" },
  neon: { layer: "db", name: "Neon" },
};

export function getConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("Not authenticated. Run `relight auth` first.");
    process.exit(1);
  }
  var config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  return migrateSlicervm(config);
}

function migrateSlicervm(config) {
  if (config.clouds && config.clouds.slicervm) {
    if (!config.services) config.services = {};
    if (!config.services.slicervm) {
      var old = config.clouds.slicervm;
      config.services.slicervm = {
        layer: "compute",
        type: "slicervm",
        ...old,
      };
    }
    delete config.clouds.slicervm;
    if (config.default_cloud === "slicervm") {
      delete config.default_cloud;
    }
    saveConfig(config);
  }
  // Migrate old "addons" key to "services"
  if (config.addons && !config.services) {
    config.services = config.addons;
    delete config.addons;
    saveConfig(config);
  }
  return config;
}

export function tryGetConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    var config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return migrateSlicervm(config);
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function getCloudConfig(cloudId) {
  var config = getConfig();
  var cloud = config.clouds && config.clouds[cloudId];
  if (!cloud) {
    console.error(
      `Not authenticated with ${CLOUD_NAMES[cloudId] || cloudId}. Run \`relight auth --cloud ${cloudId}\` first.`
    );
    process.exit(1);
  }
  return cloud;
}

export function getAuthenticatedClouds() {
  var config = tryGetConfig();
  if (!config || !config.clouds) return [];
  return Object.keys(config.clouds).filter(
    (id) => config.clouds[id] && Object.keys(config.clouds[id]).length > 0
  );
}

export function getDefaultCloud() {
  var config = tryGetConfig();
  if (!config) return null;
  return config.default_cloud || null;
}

export function resolveCloudConfig(cloudId) {
  var config = getConfig();
  var cloud = config.clouds && config.clouds[cloudId];
  if (!cloud) {
    console.error(
      `Not authenticated with ${CLOUD_NAMES[cloudId] || cloudId}. Run \`relight auth --cloud ${cloudId}\` first.`
    );
    process.exit(1);
  }

  // Return a normalized config object that providers can use
  if (cloudId === "cf") {
    return { accountId: cloud.accountId, apiToken: cloud.token };
  }
  if (cloudId === "gcp") {
    return { clientEmail: cloud.clientEmail, privateKey: cloud.privateKey, project: cloud.project };
  }
  if (cloudId === "aws") {
    return { accessKeyId: cloud.accessKeyId, secretAccessKey: cloud.secretAccessKey, region: cloud.region };
  }
  return cloud;
}

export function getServiceConfig(name) {
  var config = getConfig();
  var service = config.services && config.services[name];
  if (!service) {
    console.error(
      `Service '${name}' not found. Run \`relight service add\` to register it.`
    );
    process.exit(1);
  }
  return service;
}

export function tryGetServiceConfig(name) {
  var config = tryGetConfig();
  if (!config || !config.services) return null;
  return config.services[name] || null;
}

export function getRegisteredServices() {
  var config = tryGetConfig();
  if (!config || !config.services) return [];
  return Object.entries(config.services).map(([name, service]) => ({
    name,
    ...service,
  }));
}

export function saveServiceConfig(name, data) {
  var config = tryGetConfig() || { clouds: {} };
  if (!config.services) config.services = {};
  config.services[name] = data;
  saveConfig(config);
}

export function removeServiceConfig(name) {
  var config = tryGetConfig();
  if (!config || !config.services) return;
  delete config.services[name];
  saveConfig(config);
}

export function getCloudMeta(cloudId, key) {
  var config = tryGetConfig();
  if (!config || !config.clouds || !config.clouds[cloudId]) return undefined;
  var meta = config.clouds[cloudId]._meta;
  if (!meta) return undefined;
  return key ? meta[key] : meta;
}

export function setCloudMeta(cloudId, key, value) {
  var config = getConfig();
  if (!config.clouds[cloudId]._meta) config.clouds[cloudId]._meta = {};
  if (value === undefined) {
    delete config.clouds[cloudId]._meta[key];
    if (Object.keys(config.clouds[cloudId]._meta).length === 0) {
      delete config.clouds[cloudId]._meta;
    }
  } else {
    config.clouds[cloudId]._meta[key] = value;
  }
  saveConfig(config);
}

export function getServiceMeta(serviceName, key) {
  var config = tryGetConfig();
  if (!config || !config.services || !config.services[serviceName]) return undefined;
  var meta = config.services[serviceName]._meta;
  if (!meta) return undefined;
  return key ? meta[key] : meta;
}

export function setServiceMeta(serviceName, key, value) {
  var config = getConfig();
  if (!config.services || !config.services[serviceName]) {
    throw new Error(`Service '${serviceName}' not found.`);
  }
  if (!config.services[serviceName]._meta) config.services[serviceName]._meta = {};
  if (value === undefined) {
    delete config.services[serviceName]._meta[key];
    if (Object.keys(config.services[serviceName]._meta).length === 0) {
      delete config.services[serviceName]._meta;
    }
  } else {
    config.services[serviceName]._meta[key] = value;
  }
  saveConfig(config);
}

// --- Database registry ---

export function getDatabaseConfig(name) {
  var config = tryGetConfig();
  if (!config || !config.databases) return null;
  return config.databases[name] || null;
}

export function saveDatabaseConfig(name, data) {
  var config = tryGetConfig() || { clouds: {} };
  if (!config.databases) config.databases = {};
  config.databases[name] = data;
  saveConfig(config);
}

export function removeDatabaseConfig(name) {
  var config = tryGetConfig();
  if (!config || !config.databases) return;
  delete config.databases[name];
  saveConfig(config);
}

export function listDatabases() {
  var config = tryGetConfig();
  if (!config || !config.databases) return [];
  return Object.entries(config.databases).map(([name, data]) => ({
    name,
    ...data,
  }));
}

export function normalizeServiceConfig(service) {
  if (service.type === "slicervm") {
    var cfg = { hostGroup: service.hostGroup, baseDomain: service.baseDomain };
    if (service.socketPath) {
      cfg.socketPath = service.socketPath;
    } else {
      cfg.apiUrl = service.apiUrl;
      cfg.apiToken = service.token;
    }
    return cfg;
  }
  if (service.type === "neon") {
    return { apiKey: service.apiKey };
  }
  return service;
}
