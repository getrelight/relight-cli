import { success, fatal, fmt } from "../lib/output.js";
import { resolveAppName } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";

export async function scale(name, options) {
  name = resolveAppName(name);
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

  if (!changed) {
    // Show current scale
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            regions: appConfig.regions,
            instances: appConfig.instances,
            instanceType: appConfig.instanceType,
            vcpu: appConfig.vcpu,
            memory: appConfig.memory,
            disk: appConfig.disk,
          },
          null,
          2
        )
      );
      return;
    }

    console.log(`\n${fmt.bold("App:")}        ${fmt.app(name)}`);
    console.log(`${fmt.bold("Regions:")}    ${appConfig.regions.join(", ")}`);
    console.log(`${fmt.bold("Instances:")}  ${appConfig.instances} per region`);
    if (appConfig.vcpu || appConfig.memory || appConfig.disk) {
      if (appConfig.vcpu) console.log(`${fmt.bold("vCPU:")}       ${appConfig.vcpu}`);
      if (appConfig.memory) console.log(`${fmt.bold("Memory:")}     ${appConfig.memory} MiB`);
      if (appConfig.disk) console.log(`${fmt.bold("Disk:")}       ${appConfig.disk} MB`);
    } else {
      console.log(`${fmt.bold("Type:")}       ${appConfig.instanceType || "lite"}`);
    }
    console.log(
      `\n${fmt.dim("Geo-routing is automatic - requests route to the closest deployed region.")}`
    );
    return;
  }

  await appProvider.scale(cfg, name, { appConfig });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          regions: appConfig.regions,
          instances: appConfig.instances,
          instanceType: appConfig.instanceType,
          vcpu: appConfig.vcpu,
          memory: appConfig.memory,
          disk: appConfig.disk,
        },
        null,
        2
      )
    );
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
}
