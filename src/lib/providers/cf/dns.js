import {
  listZones,
  findZoneForHostname,
  listDnsRecords,
  createDnsRecord,
  deleteDnsRecord,
  addWorkerDomain,
  removeWorkerDomain,
  listWorkerDomainsForService,
  getWorkersSubdomain,
} from "../../clouds/cf.js";
import { getAppConfig, pushAppConfig } from "./app.js";

export async function listDomains(cfg, appName) {
  var scriptName = `relight-${appName}`;
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var defaultDomain = subdomain
    ? `relight-${appName}.${subdomain}.workers.dev`
    : null;

  var domains = await listWorkerDomainsForService(cfg.accountId, cfg.apiToken, scriptName);

  return {
    default: defaultDomain,
    custom: domains.map((d) => d.hostname),
  };
}

export async function addDomain(cfg, appName, domain, { zone, zones }) {
  var scriptName = `relight-${appName}`;

  // Check for existing DNS records
  var existing = await listDnsRecords(cfg.accountId, cfg.apiToken, zone.id, { name: domain });
  if (existing.length > 0) {
    var types = existing.map((r) => `${r.type} -> ${r.content}`).join("\n  ");
    throw new Error(
      `DNS record already exists for ${domain}.\nExisting records:\n  ${types}\n\nRemove the existing record first, or choose a different domain.`
    );
  }

  // Attach domain to worker
  try {
    await addWorkerDomain(cfg.accountId, cfg.apiToken, scriptName, domain, zone.id);
  } catch (e) {
    if (e.message.includes("already has externally managed DNS records")) {
      throw new Error(
        `DNS record already exists for ${domain} (externally managed). Remove the existing DNS record first, or choose a different domain.`
      );
    }
    throw e;
  }

  // Create CNAME record
  var subdomain = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
  var target = subdomain ? `relight-${appName}.${subdomain}.workers.dev` : null;

  if (target) {
    try {
      await createDnsRecord(cfg.accountId, cfg.apiToken, zone.id, {
        type: "CNAME",
        name: domain,
        content: target,
        proxied: true,
      });
    } catch (e) {
      if (!e.message.includes("already exists")) {
        // Not fatal - worker domain is already attached
      }
    }
  }

  // Update app config metadata
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
  // Remove Worker Domain route
  await removeWorkerDomain(cfg.accountId, cfg.apiToken, domain);

  // Remove CNAME record if it exists
  var cfZones = await listZones(cfg.accountId, cfg.apiToken);
  var zone = findZoneForHostname(cfZones, domain);
  if (zone) {
    var records = await listDnsRecords(cfg.accountId, cfg.apiToken, zone.id, {
      type: "CNAME",
      name: domain,
    });
    for (var record of records) {
      await deleteDnsRecord(cfg.accountId, cfg.apiToken, zone.id, record.id);
    }
  }

  // Update app config metadata
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig) {
    appConfig.domains = (appConfig.domains || []).filter((d) => d !== domain);
    await pushAppConfig(cfg, appName, appConfig);
  }
}

// --- Pure DNS record operations (for cross-cloud use) ---

export async function addDnsRecord(cfg, domain, target, zone) {
  // Check for existing records
  var existing = await listDnsRecords(cfg.accountId, cfg.apiToken, zone.id, { name: domain });
  if (existing.length > 0) {
    var types = existing.map((r) => `${r.type} -> ${r.content}`).join("\n  ");
    throw new Error(
      `DNS record already exists for ${domain}.\nExisting records:\n  ${types}\n\nRemove the existing record first, or choose a different domain.`
    );
  }

  // Create CNAME: domain -> target, proxied
  await createDnsRecord(cfg.accountId, cfg.apiToken, zone.id, {
    type: "CNAME",
    name: domain,
    content: target,
    proxied: true,
  });
}

export async function removeDnsRecord(cfg, domain) {
  var cfZones = await listZones(cfg.accountId, cfg.apiToken);
  var zone = findZoneForHostname(cfZones, domain);
  if (!zone) return;

  var records = await listDnsRecords(cfg.accountId, cfg.apiToken, zone.id, {
    type: "CNAME",
    name: domain,
  });
  for (var record of records) {
    await deleteDnsRecord(cfg.accountId, cfg.apiToken, zone.id, record.id);
  }
}

// Re-export zone utilities for the domains command's interactive flow
export async function getZones(cfg) {
  return listZones(cfg.accountId, cfg.apiToken);
}

export { findZoneForHostname };
