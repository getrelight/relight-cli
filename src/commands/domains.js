import { createInterface } from "readline";
import { phase, status, success, fatal, hint, fmt } from "../lib/output.js";
import { resolveAppName, readLink, linkApp } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";
import kleur from "kleur";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function domainsList(name, options) {
  name = resolveAppName(name);
  var stack = await resolveStack(options, ["dns"]);
  var { cfg, provider: dnsProvider } = stack.dns;

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

  // Resolve app and dns providers - may be different
  var appStack = await resolveStack(options, ["app"]);
  var { cfg: appCfg, provider: appProvider, name: appProviderName } = appStack.app;

  var dnsStack = await resolveStack(options, ["dns"]);
  var { cfg: dnsCfg, provider: dnsProvider, name: dnsProviderName } = dnsStack.dns;

  var crossCloud = appProviderName !== dnsProviderName;

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
    // Cross-cloud: some providers need a pre-DNS step, others can map immediately.
    var dnsTarget;
    var dnsProxied = true;
    var mapping;
    if (appProvider.prepareCustomDomain) {
      status(`Preparing custom domain for ${domain}...`);
      mapping = await appProvider.prepareCustomDomain(appCfg, name, domain);
      dnsTarget = mapping.dnsTarget;
      if (mapping.proxied === false) dnsProxied = false;
    } else if (appProvider.mapCustomDomain) {
      status(`Setting up hosting for ${domain}...`);
      mapping = await appProvider.mapCustomDomain(appCfg, name, domain);
      dnsTarget = mapping.dnsTarget;
      if (mapping.proxied === false) dnsProxied = false;
    } else {
      var appUrl = await appProvider.getAppUrl(appCfg, name);
      dnsTarget = new URL(appUrl).hostname;
    }

    // Create DNS record pointing to the hosting provider
    status(`Creating DNS record for ${domain}...`);
    try {
      await dnsProvider.addDnsRecord(dnsCfg, domain, dnsTarget, zone, { proxied: dnsProxied });
    } catch (e) {
      fatal(e.message);
    }

    for (var record of mapping?.validationRecords || []) {
      status(`Creating ${record.type} record for ${record.name}...`);
      try {
        await dnsProvider.addDnsRecord(dnsCfg, record.name, record.content, zone, {
          type: record.type,
          proxied: false,
        });
      } catch (e) {
        fatal(e.message);
      }
    }

    if (appProvider.finalizeCustomDomain) {
      status(`Finalizing custom domain in ${appProviderName}...`);
      try {
        await appProvider.finalizeCustomDomain(appCfg, name, domain, mapping);
      } catch (e) {
        fatal(e.message);
      }
    }

    if (mapping?.restoreProxied !== undefined && mapping.restoreProxied !== dnsProxied) {
      status(`Restoring DNS proxy for ${domain}...`);
      try {
        await dnsProvider.addDnsRecord(dnsCfg, domain, dnsTarget, zone, {
          proxied: mapping.restoreProxied,
        });
      } catch (e) {
        fatal(e.message);
      }
    }

    // Update app config
    status(`Updating app config...`);
    if (!appConfig.domains) appConfig.domains = [];
    if (!appConfig.domains.includes(domain)) {
      appConfig.domains.push(domain);
      await appProvider.pushAppConfig(appCfg, name, appConfig);
    }

    // Persist dns provider in .relight
    var linked = readLink();
    if (linked && !linked.dns) {
      linkApp(
        linked.app,
        linked.compute,
        dnsProviderName,
        linked.db,
        linked.dbProvider,
        linked.registry
      );
    }
  } else {
    // Same provider: existing flow
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

  var appStack = await resolveStack(options, ["app"]);
  var { cfg: appCfg, provider: appProvider, name: appProviderName } = appStack.app;

  var dnsStack = await resolveStack(options, ["dns"]);
  var { cfg: dnsCfg, provider: dnsProvider, name: dnsProviderName } = dnsStack.dns;

  var crossCloud = appProviderName !== dnsProviderName;

  status(`Removing ${domain}...`);

  if (crossCloud) {
    await dnsProvider.removeDnsRecord(dnsCfg, domain);

    if (appProvider.unmapCustomDomain) {
      await appProvider.unmapCustomDomain(appCfg, name, domain);
    }

    var appConfig = await appProvider.getAppConfig(appCfg, name);
    if (appConfig) {
      appConfig.domains = (appConfig.domains || []).filter((d) => d !== domain);
      await appProvider.pushAppConfig(appCfg, name, appConfig);
    }
  } else {
    await dnsProvider.removeDomain(dnsCfg, name, domain);
  }

  success(`Domain ${fmt.bold(domain)} removed from ${fmt.app(name)}.`);
}
