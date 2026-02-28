import { listNodes } from "../../clouds/slicervm.js";
import { getAppConfig, pushAppConfig } from "./app.js";

export async function listDomains(cfg, appName) {
  var appConfig = await getAppConfig(cfg, appName);
  var defaultDomain = `${appName}.${cfg.baseDomain}`;

  return {
    default: defaultDomain,
    custom: appConfig?.domains || [],
  };
}

export async function addDomain(cfg, appName, domain) {
  var appConfig = await getAppConfig(cfg, appName);
  if (!appConfig) {
    throw new Error(`App ${appName} not found.`);
  }

  if (!appConfig.domains) appConfig.domains = [];
  if (appConfig.domains.includes(domain)) {
    throw new Error(`Domain ${domain} is already attached to ${appName}.`);
  }

  // Add domain as a tag on the VM node so Caddy can route to it
  var nodes = await listNodes(cfg);
  var node = nodes.find((n) => n.tags && n.tags.includes(appName));
  if (node && !node.tags.includes(domain)) {
    node.tags.push(domain);
    // Tags are updated via the app config - the Caddy module reads tags from the node
  }

  appConfig.domains.push(domain);
  await pushAppConfig(cfg, appName, appConfig);

  process.stderr.write(
    `\n  Point your DNS A record for ${domain} to your Slicer host IP.\n`
  );
}

export async function removeDomain(cfg, appName, domain) {
  var appConfig = await getAppConfig(cfg, appName);
  if (!appConfig) {
    throw new Error(`App ${appName} not found.`);
  }

  appConfig.domains = (appConfig.domains || []).filter((d) => d !== domain);
  await pushAppConfig(cfg, appName, appConfig);
}

// SlicerVM doesn't use zones - custom domains use VM tags + manual DNS
export async function getZones() {
  return [];
}

export function findZoneForHostname() {
  return null;
}
