import { success, fatal, fmt } from "../lib/output.js";
import { resolveAppName } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";
import { getPortal, portalApi, getPortalAppByName } from "../lib/portal.js";
import { VALID_HINTS } from "../lib/providers/cf/app.js";

function formatScaleJson(appConfig) {
  return {
    regions: appConfig.regions,
    instances: appConfig.instances,
    instanceType: appConfig.instanceType,
    vcpu: appConfig.vcpu,
    memory: appConfig.memory,
    disk: appConfig.disk,
    sleepAfter: appConfig.sleepAfter,
  };
}

function printScaleSummary(name, appConfig) {
  console.log(`\n${fmt.bold("App:")}        ${fmt.app(name)}`);
  console.log(`${fmt.bold("Regions:")}    ${(appConfig.regions || []).join(", ")}`);
  console.log(`${fmt.bold("Instances:")}  ${appConfig.instances} per region`);
  if (appConfig.vcpu || appConfig.memory || appConfig.disk) {
    if (appConfig.vcpu) console.log(`${fmt.bold("vCPU:")}       ${appConfig.vcpu}`);
    if (appConfig.memory) console.log(`${fmt.bold("Memory:")}     ${appConfig.memory} MiB`);
    if (appConfig.disk) console.log(`${fmt.bold("Disk:")}       ${appConfig.disk} MB`);
  } else {
    console.log(`${fmt.bold("Type:")}       ${appConfig.instanceType || "lite"}`);
  }
  if (appConfig.sleepAfter) {
    console.log(`${fmt.bold("Sleep:")}      ${appConfig.sleepAfter}`);
  }
  console.log(
    `\n${fmt.dim("Geo-routing is automatic - requests route to the closest deployed region.")}`
  );
}

function buildScalePatch(options) {
  var patch = {};
  if (options.regions) patch.regions = options.regions;
  if (options.instances) patch.instances = options.instances;
  if (options.instanceType) patch.instanceType = options.instanceType;
  if (options.vcpu) patch.vcpu = options.vcpu;
  if (options.memory) patch.memory = options.memory;
  if (options.disk) patch.disk = options.disk;
  if (options.sleep) patch.sleep = options.sleep;
  return patch;
}

async function scaleViaPortal(name, options) {
  var patch = buildScalePatch(options);
  var changed = Object.keys(patch).length > 0;

  if (!changed) {
    var app = await getPortalAppByName(name);
    if (!app) {
      fatal(
        `App ${fmt.app(name)} not found.`,
        `Run ${fmt.cmd(`relight deploy ${name} .`)} first.`
      );
    }
    var appConfig = Object.assign({}, app.config || {}, app.liveInfo?.appConfig || {});
    if (options.json) {
      console.log(JSON.stringify(formatScaleJson(appConfig), null, 2));
      return;
    }
    printScaleSummary(name, appConfig);
    return;
  }

  if (patch.regions) {
    var regions = patch.regions.split(",").map((r) => r.trim().toLowerCase());
    for (var r of regions) {
      if (!VALID_HINTS.includes(r)) {
        fatal(
          `Invalid location hint '${r}'.`,
          `Valid hints: ${VALID_HINTS.join(", ")}`
        );
      }
    }
  }

  var result = await portalApi("PATCH", `/apps/${name}/scale`, patch).catch((err) => {
    fatal(err.message);
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  success(`Scaled ${fmt.app(name)} (live).`);
  process.stderr.write(`  Regions:    ${(result.regions || []).join(", ")}\n`);
  process.stderr.write(`  Instances:  ${result.instances}\n`);
  if (result.vcpu || result.memory || result.disk) {
    if (result.vcpu) process.stderr.write(`  vCPU:       ${result.vcpu}\n`);
    if (result.memory) process.stderr.write(`  Memory:     ${result.memory} MiB\n`);
    if (result.disk) process.stderr.write(`  Disk:       ${result.disk} MB\n`);
  } else {
    process.stderr.write(`  Type:       ${result.instanceType || "lite"}\n`);
  }
  if (result.sleepAfter) process.stderr.write(`  Sleep:      ${result.sleepAfter}\n`);
}

export async function scale(name, options) {
  name = resolveAppName(name);

  if (!options.compute && getPortal()) {
    return scaleViaPortal(name, options);
  }

  var stack = await resolveStack(options);
  var { cfg, provider: appProvider } = stack.app;

  var appConfig = await appProvider.getAppConfig(cfg, name);

  if (!appConfig) {
    fatal(
      `App ${fmt.app(name)} not found.`,
      `Run ${fmt.cmd(`relight deploy ${name} .`)} first.`
    );
  }

  var changed = false;

  if (options.regions) {
    var validRegions = appProvider.getRegions();
    var validCodes = validRegions.map((r) => r.code);
    var regions = options.regions.split(",").map((r) => r.trim().toLowerCase());
    for (var r of regions) {
      if (!validCodes.includes(r)) {
        fatal(
          `Invalid location hint '${r}'.`,
          `Valid hints: ${validCodes.join(", ")}`
        );
      }
    }
    appConfig.regions = regions;
    changed = true;
  }

  if (options.instances) {
    appConfig.instances = options.instances;
    changed = true;
  }

  if (options.instanceType) {
    appConfig.instanceType = options.instanceType;
    delete appConfig.vcpu;
    delete appConfig.memory;
    delete appConfig.disk;
    changed = true;
  }
  if (options.vcpu) {
    appConfig.vcpu = options.vcpu;
    delete appConfig.instanceType;
    changed = true;
  }
  if (options.memory) {
    appConfig.memory = options.memory;
    delete appConfig.instanceType;
    changed = true;
  }
  if (options.disk) {
    appConfig.disk = options.disk;
    delete appConfig.instanceType;
    changed = true;
  }
  if (options.sleep) {
    appConfig.sleepAfter = options.sleep;
    changed = true;
  }

  if (!changed) {
    if (options.json) {
      console.log(JSON.stringify(formatScaleJson(appConfig), null, 2));
      return;
    }
    printScaleSummary(name, appConfig);
    return;
  }

  await appProvider.scale(cfg, name, { appConfig });

  if (options.json) {
    console.log(JSON.stringify(formatScaleJson(appConfig), null, 2));
    return;
  }

  success(`Scaled ${fmt.app(name)} (live).`);
  process.stderr.write(`  Regions:    ${appConfig.regions.join(", ")}\n`);
  process.stderr.write(`  Instances:  ${appConfig.instances}\n`);
  if (appConfig.vcpu || appConfig.memory || appConfig.disk) {
    if (appConfig.vcpu) process.stderr.write(`  vCPU:       ${appConfig.vcpu}\n`);
    if (appConfig.memory) process.stderr.write(`  Memory:     ${appConfig.memory} MiB\n`);
    if (appConfig.disk) process.stderr.write(`  Disk:       ${appConfig.disk} MB\n`);
  } else {
    process.stderr.write(`  Type:       ${appConfig.instanceType || "lite"}\n`);
  }
  if (appConfig.sleepAfter) process.stderr.write(`  Sleep:      ${appConfig.sleepAfter}\n`);
}
