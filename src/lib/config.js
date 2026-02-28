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
  slicervm: "SlicerVM",
};

export var CLOUD_IDS = Object.keys(CLOUD_NAMES);

export function getConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("Not authenticated. Run `relight auth` first.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function tryGetConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
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
  if (cloudId === "slicervm") {
    var slicerCfg = { hostGroup: cloud.hostGroup, baseDomain: cloud.baseDomain };
    if (cloud.socketPath) {
      slicerCfg.socketPath = cloud.socketPath;
    } else {
      slicerCfg.apiUrl = cloud.apiUrl;
      slicerCfg.apiToken = cloud.token;
    }
    return slicerCfg;
  }
  return cloud;
}
