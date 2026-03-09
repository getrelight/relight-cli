import { azureApi, getToken, rgPath } from "../../clouds/azure.js";
import { getAppConfig, pushAppConfig, getAppUrl } from "./app.js";

var DNS_API = "2023-07-01-preview";

export async function getZones(cfg) {
  var token = await getToken(cfg);
  var path = `${rgPath(cfg)}/providers/Microsoft.Network/dnsZones`;
  var res = await azureApi("GET", path, null, token, { apiVersion: DNS_API });

  return (res.value || []).map((z) => ({
    id: z.id,
    name: z.name,
  }));
}

export function findZoneForHostname(zones, hostname) {
  var match = null;
  for (var zone of zones) {
    if (hostname === zone.name || hostname.endsWith("." + zone.name)) {
      if (!match || zone.name.length > match.name.length) {
        match = zone;
      }
    }
  }
  return match;
}

export async function listDomains(cfg, appName) {
  var url = await getAppUrl(cfg, appName);
  var defaultDomain = url ? new URL(url).hostname : null;

  var appConfig = await getAppConfig(cfg, appName);
  var custom = appConfig?.domains || [];

  return {
    default: defaultDomain,
    custom,
  };
}

export async function addDomain(cfg, appName, domain, { zone }) {
  var token = await getToken(cfg);

  // Get app URL to use as CNAME target
  var url = await getAppUrl(cfg, appName);
  if (!url) throw new Error("Could not determine app URL for CNAME target.");
  var target = new URL(url).hostname;

  // Extract relative record name (e.g. "app" from "app.example.com" with zone "example.com")
  var recordName = domain === zone.name ? "@" : domain.replace("." + zone.name, "");

  var recordPath = `${zone.id}/CNAME/${recordName}`;
  await azureApi("PUT", recordPath, {
    properties: {
      TTL: 300,
      CNAMERecord: { cname: target },
    },
  }, token, { apiVersion: DNS_API });

  // Update app config
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig) {
    if (!appConfig.domains) appConfig.domains = [];
    if (!appConfig.domains.includes(domain)) {
      appConfig.domains.push(domain);
      await pushAppConfig(cfg, appName, appConfig);
    }
  }
}

export async function removeDomain(cfg, appName, domain) {
  var token = await getToken(cfg);

  var zones = await getZones(cfg);
  var zone = findZoneForHostname(zones, domain);

  if (zone) {
    var recordName = domain === zone.name ? "@" : domain.replace("." + zone.name, "");
    var recordPath = `${zone.id}/CNAME/${recordName}`;

    try {
      await azureApi("DELETE", recordPath, null, token, { apiVersion: DNS_API });
    } catch {}
  }

  // Update app config
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig) {
    appConfig.domains = (appConfig.domains || []).filter((d) => d !== domain);
    await pushAppConfig(cfg, appName, appConfig);
  }
}

// --- Pure DNS record operations (for cross-cloud use) ---

export async function addDnsRecord(cfg, domain, target, zone) {
  var token = await getToken(cfg);

  var recordName = domain === zone.name ? "@" : domain.replace("." + zone.name, "");

  // Check for existing CNAME
  try {
    var existing = await azureApi("GET", `${zone.id}/CNAME/${recordName}`, null, token, { apiVersion: DNS_API });
    if (existing.properties?.CNAMERecord?.cname) {
      throw new Error(`CNAME record already exists for ${domain} -> ${existing.properties.CNAMERecord.cname}`);
    }
  } catch (e) {
    if (!e.message.includes("404") && e.message.includes("already exists")) throw e;
  }

  await azureApi("PUT", `${zone.id}/CNAME/${recordName}`, {
    properties: {
      TTL: 300,
      CNAMERecord: { cname: target },
    },
  }, token, { apiVersion: DNS_API });
}

export async function removeDnsRecord(cfg, domain) {
  var token = await getToken(cfg);

  var zones = await getZones(cfg);
  var zone = findZoneForHostname(zones, domain);
  if (!zone) return;

  var recordName = domain === zone.name ? "@" : domain.replace("." + zone.name, "");

  try {
    await azureApi("DELETE", `${zone.id}/CNAME/${recordName}`, null, token, { apiVersion: DNS_API });
  } catch {}
}
