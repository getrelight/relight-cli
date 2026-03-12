import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

var CONFIG_DIR = join(homedir(), ".relight");
var CONFIG_PATH = join(CONFIG_DIR, "config.json");

export { CONFIG_DIR, CONFIG_PATH };

export var PROVIDERS = {
  cf: { name: "Cloudflare", layers: ["app", "dns", "registry"] },
  gcp: { name: "Google Cloud", layers: ["app", "db", "dns", "registry"] },
  aws: { name: "AWS", layers: ["app", "db", "dns", "registry"] },
  azure: { name: "Azure", layers: ["app", "db", "dns", "registry"] },
  do: { name: "DigitalOcean", layers: ["db", "dns"] },
  ghcr: { name: "GitHub Container Registry", layers: ["registry"] },
  slicervm: { name: "SlicerVM", layers: ["app"] },
  demo: { name: "Demo (local)", layers: ["app", "db"] },
};

export var PROVIDER_TYPES = Object.keys(PROVIDERS);

export function getConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("Not authenticated. Run `relight providers add` first.");
    process.exit(1);
  }
  var config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  return migrateConfig(config);
}

export function tryGetConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    var config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return migrateConfig(config);
  } catch {
    return null;
  }
}

// Migrate old clouds/services/default_cloud format to unified providers/defaults
function migrateConfig(config) {
  if (!config.clouds && !config.services) return config;

  if (!config.providers) config.providers = {};
  if (!config.defaults) config.defaults = {};

  // Migrate clouds (cf, gcp, aws, azure)
  if (config.clouds) {
    for (var [id, data] of Object.entries(config.clouds)) {
      if (data && Object.keys(data).length > 0 && !config.providers[id]) {
        config.providers[id] = { type: id, ...data };
      }
    }
    delete config.clouds;
  }

  // Migrate services (slicervm, neon, turso instances)
  if (config.services) {
    for (var [name, data] of Object.entries(config.services)) {
      if (data && !config.providers[name]) {
        var { layer, ...rest } = data;
        config.providers[name] = rest;
      }
    }
    delete config.services;
  }

  // Migrate default_cloud -> defaults
  if (config.default_cloud) {
    var dc = config.default_cloud;
    if (config.providers[dc]) {
      var type = config.providers[dc].type;
      var layers = PROVIDERS[type]?.layers || [];
      for (var layer of layers) {
        if (!config.defaults[layer]) config.defaults[layer] = dc;
      }
    }
    delete config.default_cloud;
  }

  saveConfig(config);
  return config;
}

export function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function getProviderConfig(name) {
  var config = getConfig();
  var provider = config.providers && config.providers[name];
  if (!provider) {
    console.error(
      `Provider '${name}' not found. Run \`relight providers add\` to register it.`
    );
    process.exit(1);
  }
  return provider;
}

export function tryGetProviderConfig(name) {
  var config = tryGetConfig();
  if (!config || !config.providers) return null;
  return config.providers[name] || null;
}

export function getConfiguredProviders() {
  var config = tryGetConfig();
  if (!config || !config.providers) return [];
  return Object.entries(config.providers).map(([name, data]) => ({
    name,
    ...data,
  }));
}

export function saveProviderConfig(name, data) {
  var config = tryGetConfig() || {};
  if (!config.providers) config.providers = {};
  config.providers[name] = data;
  saveConfig(config);
}

export function removeProviderConfig(name) {
  var config = tryGetConfig();
  if (!config || !config.providers) return;
  delete config.providers[name];
  if (config.defaults) {
    for (var layer of Object.keys(config.defaults)) {
      if (config.defaults[layer] === name) delete config.defaults[layer];
    }
  }
  saveConfig(config);
}

export function getDefault(layer) {
  var config = tryGetConfig();
  if (!config || !config.defaults) return null;
  return config.defaults[layer] || null;
}

export function setDefault(layer, name) {
  var config = tryGetConfig() || {};
  if (!config.defaults) config.defaults = {};
  config.defaults[layer] = name;
  saveConfig(config);
}

export function getProviderMeta(name, key) {
  var config = tryGetConfig();
  if (!config || !config.providers || !config.providers[name]) return undefined;
  var meta = config.providers[name]._meta;
  if (!meta) return undefined;
  return key ? meta[key] : meta;
}

export function setProviderMeta(name, key, value) {
  var config = getConfig();
  if (!config.providers || !config.providers[name]) {
    throw new Error(`Provider '${name}' not found.`);
  }
  if (!config.providers[name]._meta) config.providers[name]._meta = {};
  if (value === undefined) {
    delete config.providers[name]._meta[key];
    if (Object.keys(config.providers[name]._meta).length === 0) {
      delete config.providers[name]._meta;
    }
  } else {
    config.providers[name]._meta[key] = value;
  }
  saveConfig(config);
}

export function normalizeProviderConfig(instance) {
  var { type, _meta, ...rest } = instance;

  if (type === "cf") {
    return { accountId: rest.accountId, apiToken: rest.token };
  }
  if (type === "demo") {
    return { url: rest.url || "http://localhost:9999", token: rest.token || "demo-token" };
  }
  if (type === "slicervm") {
    var cfg = { hostGroup: rest.hostGroup, baseDomain: rest.baseDomain };
    if (rest.socketPath) {
      cfg.socketPath = rest.socketPath;
    } else {
      cfg.apiUrl = rest.apiUrl;
      cfg.apiToken = rest.token;
    }
    return cfg;
  }
  return rest;
}
