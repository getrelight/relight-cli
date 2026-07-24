import { success, fatal, hint, fmt, table } from "../lib/output.js";
import { resolveAppName, readLink, unlinkApp } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";
import { getPortal, portalApi, getPortalAppByName } from "../lib/portal.js";
import { createInterface } from "readline";

function formatInstanceDesc(appConfig) {
  if (appConfig.vcpu) {
    return `${appConfig.vcpu} vCPU, ${appConfig.memory || "?"} MiB`;
  }
  return appConfig.instanceType || "lite";
}

function printAppInfo(name, appConfig, { url, gatewayHostname, provider, updatedAt, consoleUrl } = {}) {
  console.log("");
  console.log(`${fmt.bold("App:")}        ${fmt.app(name)}`);
  if (url) console.log(`${fmt.bold("URL:")}        ${fmt.url(url)}`);
  if (provider) console.log(`${fmt.bold("Provider:")}   ${provider}`);
  if (gatewayHostname) console.log(`${fmt.bold("Gateway:")}    ${gatewayHostname}`);
  console.log(
    `${fmt.bold("Image:")}      ${appConfig.image || fmt.dim("(not deployed)")}`
  );
  if (appConfig.regions?.length) {
    console.log(`${fmt.bold("Regions:")}    ${appConfig.regions.join(", ")}`);
  }
  if (appConfig.instances) {
    console.log(`${fmt.bold("Instances:")}  ${appConfig.instances} per region`);
  }
  console.log(`${fmt.bold("Type:")}       ${formatInstanceDesc(appConfig)}`);
  if (appConfig.disk) console.log(`${fmt.bold("Disk:")}       ${appConfig.disk} MB`);
  if (appConfig.port) console.log(`${fmt.bold("Port:")}       ${appConfig.port}`);
  if (appConfig.sleepAfter) console.log(`${fmt.bold("Sleep:")}      ${appConfig.sleepAfter}`);
  console.log(
    `${fmt.bold("Domains:")}    ${(appConfig.domains || []).join(", ") || fmt.dim("(none)")}`
  );
  var envCount = (appConfig.envKeys || []).length;
  var secretCount = (appConfig.secretKeys || []).length;
  var totalCount = envCount + secretCount;
  if (!appConfig.envKeys && appConfig.env) totalCount = Object.keys(appConfig.env).length;
  var envDisplay = secretCount > 0 ? `${totalCount} (${secretCount} secret)` : `${totalCount}`;
  console.log(`${fmt.bold("Env vars:")}   ${envDisplay}`);
  if (appConfig.dbId) {
    console.log(`${fmt.bold("Database:")}   ${appConfig.dbName || appConfig.dbId}`);
  }
  if (appConfig.deployedAt) {
    console.log(`${fmt.bold("Deployed:")}   ${appConfig.deployedAt}`);
  }
  if (appConfig.createdAt) {
    console.log(`${fmt.bold("Created:")}    ${appConfig.createdAt}`);
  }
  if (updatedAt) {
    console.log(`${fmt.bold("Updated:")}    ${new Date(updatedAt).toISOString()}`);
  }
  if (consoleUrl) {
    console.log(`${fmt.bold("Console:")}    ${fmt.url(consoleUrl)}`);
  }
  console.log("");
}
export async function appsList(options) {
  // Portal mode: list apps from portal
  if (!options.compute && getPortal()) {
    var data = await portalApi("GET", "/apps");
    var apps = data.apps ?? data;
    if (apps.length === 0) {
      if (options.json) {
        console.log("[]");
      } else {
        process.stderr.write("No apps deployed.\n");
        hint("Next", "relight deploy");
      }
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(apps, null, 2));
      return;
    }
    var rows = apps.map((a) => [
      fmt.app(a.name),
      a.provider || "-",
      a.url ? fmt.url(a.url) : fmt.dim("(no url)"),
      a.gateway_enabled ? (a.gateway_hostname || fmt.dim("(gateway)")) : "-",
      a.updated_at ? new Date(a.updated_at).toISOString().slice(0, 16) : "-",
    ]);
    console.log(table(["NAME", "PROVIDER", "URL", "HOSTNAME", "LAST UPDATED"], rows));
    return;
  }

  // BYOC mode: list apps from compute provider
  var stack = await resolveStack(options);
  var { cfg, provider: appProvider } = stack.app;

  var apps = await appProvider.listApps(cfg);

  if (apps.length === 0) {
    if (options.json) {
      console.log("[]");
    } else {
      process.stderr.write("No apps deployed.\n");
      hint("Next", "relight deploy");
    }
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(apps, null, 2));
    return;
  }

  var rows = apps.map((a) => [
    fmt.app(a.name),
    a.modified ? new Date(a.modified).toISOString() : "-",
  ]);

  console.log(table(["NAME", "LAST MODIFIED"], rows));
}

export async function appsInfo(name, options) {
  name = resolveAppName(name);

  // Portal mode: fetch full app detail (config + live CF worker config)
  if (!options.compute && getPortal()) {
    var app = await getPortalAppByName(name);
    if (!app) fatal(`App ${fmt.app(name)} not found.`);
    var appConfig = Object.assign({}, app.config || {}, app.liveInfo?.appConfig || {});
    if (options.json) {
      console.log(JSON.stringify({ app, appConfig }, null, 2));
      return;
    }
    printAppInfo(name, appConfig, {
      url: app.url || app.liveInfo?.url,
      gatewayHostname: app.gateway_enabled ? (app.gateway_hostname || fmt.dim("(no hostname)")) : null,
      provider: app.provider || fmt.dim("(unknown)"),
      updatedAt: app.updated_at,
    });
    return;
  }

  var stack = await resolveStack(options);
  var { cfg, provider: appProvider } = stack.app;

  var info = await appProvider.getAppInfo(cfg, name);

  if (!info) {
    fatal(
      `App ${fmt.app(name)} not found.`,
      `Run ${fmt.cmd(`relight deploy ${name} .`)} first.`
    );
  }

  var appConfig = info.appConfig;

  if (options.json) {
    console.log(JSON.stringify(appConfig, null, 2));
    return;
  }

  printAppInfo(name, appConfig, { url: info.url, consoleUrl: info.consoleUrl });
}

export async function appsCreate(name, options) {
  if (!getPortal()) {
    fatal(
      "apps create requires a portal connection.",
      `Connect first: ${fmt.cmd("relight portals add <url>")}`
    );
  }

  // Fetch portal defaults once — used as fallback for all options
  var defaults = {};
  try {
    defaults = await portalApi("GET", "/settings/defaults") || {};
  } catch {}

  var compute = options.compute || defaults.compute || null;
  if (!compute) {
    fatal(
      "--compute is required (or set a default in portal Settings).",
      `Example: ${fmt.cmd(`relight apps create ${name} --compute cf-prod`)}`
    );
  }

  var registryLabel = options.registry || defaults.registry || null;

  // Build app config — flags take priority, then portal defaults, then hardcoded fallbacks
  var regions = options.regions
    ? options.regions.split(",").map((r) => r.trim())
    : (defaults.regions?.length ? defaults.regions : ["enam"]);

  var env = {};
  var envKeys = [];
  if (options.env) {
    for (var v of options.env) {
      var eq = v.indexOf("=");
      if (eq !== -1) {
        env[v.substring(0, eq)] = v.substring(eq + 1);
        envKeys.push(v.substring(0, eq));
      }
    }
  }

  var appConfig = {
    name,
    regions,
    instances: options.instances || defaults.instances || 2,
    port: options.port || 8080,
    sleepAfter: options.sleep || defaults.sleep_after || "30s",
    env,
    envKeys,
    secretKeys: [],
    domains: [],
    createdAt: new Date().toISOString(),
  };

  if (options.instanceType) {
    appConfig.instanceType = options.instanceType;
  } else if (options.vcpu) {
    appConfig.vcpu = options.vcpu;
    if (options.memory) appConfig.memory = options.memory;
  } else if (defaults.instance_type) {
    appConfig.instanceType = defaults.instance_type;
  } else {
    appConfig.instanceType = "lite";
  }
  if (options.disk) appConfig.disk = options.disk;
  if (options.observability === false) appConfig.observability = false;

  // Build gateway config (flag overrides default, default enables with no options)
  var gateway = null;
  var useGateway = options.gateway || defaults.gateway_enabled;
  if (useGateway) {
    gateway = {
      hostname: options.hostname || null,
      path_prefix: options.pathPrefix || "/",
      groups: options.groups
        ? options.groups.split(",").map((g) => g.trim()).filter(Boolean)
        : [],
      match_mode: options.matchMode || "any",
    };
  }

  // Build secret manager config (flag overrides default connection label)
  var secretManager = null;
  var smConnection = options.smConnection || defaults.sm_connection_label || null;
  if (smConnection || options.smProjectId) {
    secretManager = {};
    if (smConnection) secretManager.connection_label = smConnection;
    if (options.smProjectId) secretManager.project_id = options.smProjectId;
    if (options.smEnvironment) secretManager.environment = options.smEnvironment;
    if (options.smPath) secretManager.path = options.smPath;
  }

  var data = await portalApi("POST", "/apps", {
    name,
    cloudLabel: compute,
    registryLabel: registryLabel,
    config: appConfig,
    gateway,
    secretManager,
  }).catch((err) => fatal(err.message));

  success(`App ${fmt.app(name)} created.`);
  process.stderr.write(`  ${fmt.bold("Compute:")}  ${compute}\n`);
  process.stderr.write(`  ${fmt.bold("Regions:")}  ${regions.join(", ")}\n`);
  process.stderr.write(`  ${fmt.bold("Sleep:")}    ${appConfig.sleepAfter}\n`);
  if (appConfig.instanceType) {
    process.stderr.write(`  ${fmt.bold("Type:")}     ${appConfig.instanceType}\n`);
  } else if (appConfig.vcpu) {
    process.stderr.write(`  ${fmt.bold("vCPU:")}     ${appConfig.vcpu}${appConfig.memory ? `, ${appConfig.memory} MiB` : ""}\n`);
  }
  if (gateway) {
    process.stderr.write(`  ${fmt.bold("Gateway:")}  enabled${gateway.hostname ? ` → ${gateway.hostname}` : ""}\n`);
  }
  if (secretManager) {
    process.stderr.write(`  ${fmt.bold("SM:")}       ${secretManager.connection_label || "configured"}${secretManager.project_id ? ` / ${secretManager.project_id}` : ""}\n`);
  }
  process.stderr.write("\n");
  hint("Deploy", `relight deploy ${name}`);
}

export async function appsDestroy(name, options) {
  name = resolveAppName(name);

  if (options.confirm !== name) {
    if (process.stdin.isTTY) {
      var rl = createInterface({ input: process.stdin, output: process.stderr });
      var answer = await new Promise((resolve) =>
        rl.question(`Type "${name}" to confirm destruction: `, resolve)
      );
      rl.close();
      if (answer.trim() !== name) {
        fatal("Confirmation did not match. Aborting.");
      }
    } else {
      fatal(
        `Destroying ${fmt.app(name)} requires confirmation.`,
        `Run: relight apps destroy ${name} --confirm ${name}`
      );
    }
  }

  process.stderr.write(`Destroying ${fmt.app(name)}...\n`);

  // Portal mode
  if (!options.compute && getPortal()) {
    try {
      var data = await portalApi("GET", "/apps");
      var apps = data.apps ?? data;
      var app = apps.find((a) => a.name === name);
      if (!app) fatal(`App ${fmt.app(name)} not found.`);
      await portalApi("DELETE", `/apps/${app.id}`);
    } catch (e) {
      fatal(`Could not destroy ${fmt.app(name)}.`, e.message);
    }
    var linked = readLink();
    if (linked && linked.app === name) unlinkApp();
    success(`App ${fmt.app(name)} destroyed.`);
    return;
  }

  // BYOC mode
  var stack = await resolveStack(options);
  var { cfg, provider: appProvider } = stack.app;

  try {
    await appProvider.destroyApp(cfg, name);
  } catch (e) {
    fatal(`Could not destroy ${fmt.app(name)}.`, e.message);
  }

  // Remove .relight if it points to this app
  var linked = readLink();
  if (linked && linked.app === name) {
    unlinkApp();
  }

  success(`App ${fmt.app(name)} destroyed.`);
}
