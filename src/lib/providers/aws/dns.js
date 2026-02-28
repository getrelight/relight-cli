import { awsRestXmlApi, xmlList, xmlVal, xmlBlock } from "../../clouds/aws.js";
import { getAppConfig, pushAppConfig, getAppUrl } from "./app.js";

export async function getZones(cfg) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var xml = await awsRestXmlApi("GET", "/2013-04-01/hostedzone", null, cr);

  var zones = xmlList(xml, "HostedZone");
  return zones.map((z) => {
    var id = xmlVal(z, "Id");
    var name = xmlVal(z, "Name");
    return {
      id: id ? id.replace("/hostedzone/", "") : null,
      name: name ? name.replace(/\.$/, "") : null,
    };
  });
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
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  // Get App Runner URL to use as CNAME target
  var url = await getAppUrl(cfg, appName);
  if (!url) throw new Error("Could not determine app URL for CNAME target.");
  var target = new URL(url).hostname;

  // FQDN with trailing dot for Route 53
  var fqdn = domain.endsWith(".") ? domain : domain + ".";
  var targetFqdn = target.endsWith(".") ? target : target + ".";

  var xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>UPSERT</Action>
        <ResourceRecordSet>
          <Name>${fqdn}</Name>
          <Type>CNAME</Type>
          <TTL>300</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${targetFqdn}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;

  await awsRestXmlApi("POST", `/2013-04-01/hostedzone/${zone.id}/rrset`, xmlBody, cr);

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
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var fqdn = domain.endsWith(".") ? domain : domain + ".";

  // Find the zone for this domain
  var zones = await getZones(cfg);
  var zone = findZoneForHostname(zones, domain);

  if (zone) {
    // List record sets to get current value and TTL for DELETE
    var xml = await awsRestXmlApi("GET", `/2013-04-01/hostedzone/${zone.id}/rrset`, null, cr);
    var recordSets = xmlList(xml, "ResourceRecordSet");

    var existing = null;
    for (var rs of recordSets) {
      var rsName = xmlVal(rs, "Name");
      var rsType = xmlVal(rs, "Type");
      if (rsName === fqdn && rsType === "CNAME") {
        existing = rs;
        break;
      }
    }

    if (existing) {
      var ttl = xmlVal(existing, "TTL") || "300";
      var value = xmlVal(xmlBlock(existing, "ResourceRecords") || "", "Value") || "";

      var xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>DELETE</Action>
        <ResourceRecordSet>
          <Name>${fqdn}</Name>
          <Type>CNAME</Type>
          <TTL>${ttl}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${value}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;

      await awsRestXmlApi("POST", `/2013-04-01/hostedzone/${zone.id}/rrset`, xmlBody, cr);
    }
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
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var fqdn = domain.endsWith(".") ? domain : domain + ".";
  var targetFqdn = target.endsWith(".") ? target : target + ".";

  // Check for existing CNAME
  var xml = await awsRestXmlApi("GET", `/2013-04-01/hostedzone/${zone.id}/rrset`, null, cr);
  var recordSets = xmlList(xml, "ResourceRecordSet");
  for (var rs of recordSets) {
    if (xmlVal(rs, "Name") === fqdn && xmlVal(rs, "Type") === "CNAME") {
      var value = xmlVal(xmlBlock(rs, "ResourceRecords") || "", "Value") || "";
      throw new Error(`CNAME record already exists for ${domain} -> ${value}`);
    }
  }

  var xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>CREATE</Action>
        <ResourceRecordSet>
          <Name>${fqdn}</Name>
          <Type>CNAME</Type>
          <TTL>300</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${targetFqdn}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;

  await awsRestXmlApi("POST", `/2013-04-01/hostedzone/${zone.id}/rrset`, xmlBody, cr);
}

export async function removeDnsRecord(cfg, domain) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var fqdn = domain.endsWith(".") ? domain : domain + ".";

  var zones = await getZones(cfg);
  var zone = findZoneForHostname(zones, domain);
  if (!zone) return;

  var xml = await awsRestXmlApi("GET", `/2013-04-01/hostedzone/${zone.id}/rrset`, null, cr);
  var recordSets = xmlList(xml, "ResourceRecordSet");

  for (var rs of recordSets) {
    if (xmlVal(rs, "Name") === fqdn && xmlVal(rs, "Type") === "CNAME") {
      var ttl = xmlVal(rs, "TTL") || "300";
      var value = xmlVal(xmlBlock(rs, "ResourceRecords") || "", "Value") || "";

      var xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>DELETE</Action>
        <ResourceRecordSet>
          <Name>${fqdn}</Name>
          <Type>CNAME</Type>
          <TTL>${ttl}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${value}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`;

      await awsRestXmlApi("POST", `/2013-04-01/hostedzone/${zone.id}/rrset`, xmlBody, cr);
      return;
    }
  }
}
