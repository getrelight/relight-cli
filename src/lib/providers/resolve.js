import { resolveCloud } from "../link.js";
import { getDefaultCloud, resolveCloudConfig, CLOUD_NAMES } from "../config.js";
import { fatal, fmt } from "../output.js";

var LAYERS = ["app", "dns", "db", "registry"];

export function getProvider(cloudId, layer) {
  if (!LAYERS.includes(layer)) {
    throw new Error(`Unknown provider layer: ${layer}`);
  }

  var providers = {
    cf: () => import(`./cf/${layer}.js`),
    gcp: () => import(`./gcp/${layer}.js`),
    aws: () => import(`./aws/${layer}.js`),
    slicervm: () => import(`./slicervm/${layer}.js`),
  };

  if (!providers[cloudId]) {
    fatal(
      `Unknown cloud: ${cloudId}`,
      `Supported: ${Object.keys(CLOUD_NAMES).join(", ")}`
    );
  }

  return providers[cloudId]();
}

export function resolveCloudId(cloudFlag) {
  // --cloud flag > .relight file > config.default_cloud > fatal
  var cloud = cloudFlag || resolveCloud(null) || getDefaultCloud();
  if (!cloud) {
    fatal(
      "No cloud specified.",
      `Use ${fmt.cmd("--cloud <cf|gcp|aws|slicervm>")} or set a default with ${fmt.cmd("relight auth")}.`
    );
  }
  if (!CLOUD_NAMES[cloud]) {
    fatal(
      `Unknown cloud: ${cloud}`,
      `Supported: ${Object.keys(CLOUD_NAMES).join(", ")}`
    );
  }
  return cloud;
}

export function getCloudCfg(cloudId) {
  return resolveCloudConfig(cloudId);
}
