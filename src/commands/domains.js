import { createInterface } from "readline";
import { phase, status, success, fatal, hint, fmt } from "../lib/output.js";
import { resolveAppName, resolveDns, readLink, linkApp } from "../lib/link.js";
import { resolveCloudId, getCloudCfg, getProvider } from "../lib/providers/resolve.js";
import kleur from "kleur";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function domainsList(name, options) {
  name = resolveAppName(name);
  var cloud = resolveCloudId(options.cloud);
  var cfg = getCloudCfg(cloud);
  var dnsProvider = await getProvider(cloud, "dns");

  var result = await dnsProvider.listDomains(cfg, name);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.default) {
    console.log(
      `\n${fmt.bold("Default:")} ${fmt.url(`https://${result.default}`)}`
    );
  }

  if (result.custom.length === 0) {
    console.log(`${fmt.bold("Custom:")}  ${fmt.dim("(none)")}`);
    hint("Add", `relight domains add ${name}`);
    return;
  }

  console.log(`\n${fmt.bold("Custom domains:")}`);
  for (var d of result.custom) {
    console.log(`  ${d}`);
  }
}

export async function domainsAdd(args, options) {
  var name, domain;

  if (args.length === 2) {
    name = args[0];
    domain = args[1];
  } else if (args.length === 1) {
    if (args[0].includes(".")) {
      name = resolveAppName(null);
      domain = args[0];
    } else {
      name = args[0];
      domain = null;
    }
  } else {
    name = resolveAppName(null);
    domain = null;
  }

  var appCloud = resolveCloudId(options.cloud);
  var appCfg = getCloudCfg(appCloud);
  var appProvider = await getProvider(appCloud, "app");

  // Cross-cloud DNS: --dns flag or .relight dns field specifies a different cloud for DNS records
  var dnsFlag = options.dns || resolveDns();
  var crossCloud = dnsFlag && resolveCloudId(dnsFlag) !== appCloud;
  var dnsCloud = crossCloud ? resolveCloudId(dnsFlag) : appCloud;
  var dnsCfg = crossCloud ? getCloudCfg(dnsCloud) : appCfg;
  var dnsProvider = await getProvider(dnsCloud, "dns");

  var appConfig = await appProvider.getAppConfig(appCfg, name);
  if (!appConfig) {
    fatal(
      `App ${fmt.app(name)} not found.`,
      `Run ${fmt.cmd(`relight deploy ${name} .`)} first.`
    );
  }

  // Fetch zones from the DNS provider
  status("Loading zones...");
  var zones = await dnsProvider.getZones(dnsCfg);

  if (zones.length === 0) {
    fatal(
      "No active zones found in the DNS account.",
      "Add a domain to your DNS provider first."
    );
  }

  var rl = createInterface({ input: process.stdin, output: process.stderr });
  var zone;

  if (domain) {
    zone = dnsProvider.findZoneForHostname(zones, domain);
    if (!zone) {
      rl.close();
      var zoneList = zones.map((z) => `  ${z.name}`).join("\n");
      fatal(
        `No zone found for '${domain}'.`,
        `Available zones:\n${zoneList}`
      );
    }
  } else {
    process.stderr.write(`\n${kleur.bold("Available zones:")}\n\n`);
    for (var i = 0; i < zones.length; i++) {
      process.stderr.write(
        `  ${kleur.bold(`[${i + 1}]`)} ${zones[i].name}\n`
      );
    }
    process.stderr.write("\n");

    var zoneChoice = await prompt(rl, `Select zone [1-${zones.length}]: `);
    var zoneIdx = parseInt(zoneChoice, 10) - 1;
    if (isNaN(zoneIdx) || zoneIdx < 0 || zoneIdx >= zones.length) {
      rl.close();
      fatal("Invalid selection.");
    }
    zone = zones[zoneIdx];

    process.stderr.write(`\n${kleur.bold("Route type:")}\n\n`);
    process.stderr.write(`  ${kleur.bold("[1]")} Root domain (${zone.name})\n`);
    process.stderr.write(`  ${kleur.bold("[2]")} Subdomain (*.${zone.name})\n`);
    process.stderr.write("\n");

    var routeChoice = await prompt(rl, "Select [1-2]: ");

    if (routeChoice.trim() === "1") {
      domain = zone.name;
    } else if (routeChoice.trim() === "2") {
      var sub = await prompt(rl, `Subdomain: ${fmt.dim("___." + zone.name + " -> ")} `);
      sub = (sub || "").trim();
      if (!sub) {
        rl.close();
        fatal("No subdomain provided.");
      }
      domain = `${sub}.${zone.name}`;
    } else {
      rl.close();
      fatal("Invalid selection.");
    }
  }

  rl.close();

  if (crossCloud) {
    // Cross-cloud: DNS record on one cloud, app config on another
    status(`Creating DNS record for ${domain}...`);
    var appUrl = await appProvider.getAppUrl(appCfg, name);
    var target = new URL(appUrl).hostname;
    try {
      await dnsProvider.addDnsRecord(dnsCfg, domain, target, zone);
    } catch (e) {
      fatal(e.message);
    }

    // Update app config on the app cloud
    status(`Updating app config on ${appCloud}...`);
    if (!appConfig.domains) appConfig.domains = [];
    if (!appConfig.domains.includes(domain)) {
      appConfig.domains.push(domain);
      await appProvider.pushAppConfig(appCfg, name, appConfig);
    }

    // Persist dns cloud in .relight so future commands don't need --dns
    var linked = readLink();
    if (linked && !linked.dns) {
      linkApp(linked.app, linked.cloud, dnsCloud);
    }
  } else {
    // Same-cloud: existing flow
    status(`Attaching ${domain} to relight-${name}...`);
    try {
      await dnsProvider.addDomain(dnsCfg, name, domain, { zone, zones });
    } catch (e) {
      fatal(e.message);
    }
  }

  success(`Domain ${fmt.bold(domain)} added to ${fmt.app(name)}.`);
  process.stderr.write(`  ${fmt.url(`https://${domain}`)}\n`);
}

export async function domainsRemove(args, options) {
  var name, domain;
  if (args.length === 2) {
    name = args[0];
    domain = args[1];
  } else if (args.length === 1) {
    name = resolveAppName(null);
    domain = args[0];
  } else {
    fatal("Usage: relight domains remove [name] <domain>");
  }

  var appCloud = resolveCloudId(options.cloud);
  var appCfg = getCloudCfg(appCloud);

  var dnsFlag = options.dns || resolveDns();
  var crossCloud = dnsFlag && resolveCloudId(dnsFlag) !== appCloud;
  var dnsCloud = crossCloud ? resolveCloudId(dnsFlag) : appCloud;
  var dnsCfg = crossCloud ? getCloudCfg(dnsCloud) : appCfg;
  var dnsProvider = await getProvider(dnsCloud, "dns");

  status(`Removing ${domain}...`);

  if (crossCloud) {
    // Cross-cloud: remove DNS record from dns cloud, update app config on app cloud
    await dnsProvider.removeDnsRecord(dnsCfg, domain);

    var appProvider = await getProvider(appCloud, "app");
    var appConfig = await appProvider.getAppConfig(appCfg, name);
    if (appConfig) {
      appConfig.domains = (appConfig.domains || []).filter((d) => d !== domain);
      await appProvider.pushAppConfig(appCfg, name, appConfig);
    }
  } else {
    // Same-cloud: existing flow
    await dnsProvider.removeDomain(dnsCfg, name, domain);
  }

  success(`Domain ${fmt.bold(domain)} removed from ${fmt.app(name)}.`);
}
