import {
  mintAccessToken,
  listManagedZones,
  createDnsChange,
  listResourceRecordSets,
} from "../../clouds/gcp.js";
import { getAppConfig, pushAppConfig, getAppUrl, mapCustomDomain as mapDomain, unmapCustomDomain as unmapDomain } from "./app.js";

export async function getZones(cfg) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var zones = await listManagedZones(token, cfg.project);
  return zones.map((z) => ({
    id: z.name,
    name: z.dnsName.replace(/\.$/, ""),
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
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);

  // Get Cloud Run service URL as default domain
  var url = await getAppUrl(cfg, appName);
  var defaultDomain = url ? new URL(url).hostname : null;

  // Get custom domains from app config
  var appConfig = await getAppConfig(cfg, appName);
  var custom = appConfig?.domains || [];

  return {
    default: defaultDomain,
    custom,
  };
}

export async function addDomain(cfg, appName, domain, { zone }) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);

  // Set up Firebase Hosting and get CNAME target
  var mapping = await mapDomain(cfg, appName, domain);
  var target = mapping.dnsTarget;

  // FQDN for Cloud DNS (trailing dot)
  var fqdn = domain.endsWith(".") ? domain : domain + ".";
  var targetFqdn = target.endsWith(".") ? target : target + ".";

  // Check for existing records
  var records = await listResourceRecordSets(token, cfg.project, zone.id);
  var existing = records.find(
    (r) => r.name === fqdn && r.type === "CNAME"
  );
  if (existing) {
    throw new Error(
      `CNAME record already exists for ${domain} -> ${existing.rrdatas.join(", ")}`
    );
  }

  // Create CNAME record pointing to Firebase Hosting
  await createDnsChange(token, cfg.project, zone.id, {
    additions: [
      {
        name: fqdn,
        type: "CNAME",
        ttl: 300,
        rrdatas: [targetFqdn],
      },
    ],
  });

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
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var fqdn = domain.endsWith(".") ? domain : domain + ".";

  // Find the zone for this domain
  var zones = await getZones(cfg);
  var zone = findZoneForHostname(zones, domain);

  if (zone) {
    // Find and delete CNAME record
    var records = await listResourceRecordSets(token, cfg.project, zone.id);
    var existing = records.find(
      (r) => r.name === fqdn && r.type === "CNAME"
    );
    if (existing) {
      await createDnsChange(token, cfg.project, zone.id, {
        deletions: [existing],
      });
    }
  }

  // Remove Firebase Hosting custom domain
  await unmapDomain(cfg, appName, domain);

  // Update app config
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig) {
    appConfig.domains = (appConfig.domains || []).filter((d) => d !== domain);
    await pushAppConfig(cfg, appName, appConfig);
  }
}

// --- Pure DNS record operations (for cross-cloud use) ---

export async function addDnsRecord(cfg, domain, target, zone, opts = {}) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var fqdn = domain.endsWith(".") ? domain : domain + ".";
  var targetFqdn = target.endsWith(".") ? target : target + ".";

  // Check for existing CNAME
  var records = await listResourceRecordSets(token, cfg.project, zone.id);
  var existing = records.find((r) => r.name === fqdn && r.type === "CNAME");
  if (existing) {
    throw new Error(
      `CNAME record already exists for ${domain} -> ${existing.rrdatas.join(", ")}`
    );
  }

  // Create CNAME record
  await createDnsChange(token, cfg.project, zone.id, {
    additions: [
      {
        name: fqdn,
        type: "CNAME",
        ttl: 300,
        rrdatas: [targetFqdn],
      },
    ],
  });
}

export async function removeDnsRecord(cfg, domain) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
  var fqdn = domain.endsWith(".") ? domain : domain + ".";

  var zones = await getZones(cfg);
  var zone = findZoneForHostname(zones, domain);
  if (!zone) return;

  var records = await listResourceRecordSets(token, cfg.project, zone.id);
  var existing = records.find((r) => r.name === fqdn && r.type === "CNAME");
  if (existing) {
    await createDnsChange(token, cfg.project, zone.id, {
      deletions: [existing],
    });
  }
}
