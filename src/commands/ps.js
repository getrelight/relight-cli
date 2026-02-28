import { fatal, fmt, table } from "../lib/output.js";
import { resolveAppName } from "../lib/link.js";
import { resolveCloudId, getCloudCfg, getProvider } from "../lib/providers/resolve.js";
import kleur from "kleur";

export async function ps(name, options) {
  name = resolveAppName(name);
  var cloud = resolveCloudId(options.cloud);
  var cfg = getCloudCfg(cloud);
  var appProvider = await getProvider(cloud, "app");

  var appConfig = await appProvider.getAppConfig(cfg, name);

  if (!appConfig) {
    fatal(
      `App ${fmt.app(name)} not found.`,
      `Run ${fmt.cmd(`relight deploy ${name} .`)} first.`
    );
  }

  var instances = appConfig.instances || 2;

  // Fetch live metrics
  var metrics = await appProvider.getContainerStatus(cfg, name);

  // Aggregate: group by region + durableObjectId, keep only active instances
  var containers = [];
  for (var row of metrics) {
    var dim = row.dimensions;
    if (!dim.active) continue;
    var existing = containers.find(
      (c) => c.region === dim.region && c.doId === dim.durableObjectId
    );
    if (existing) {
      existing.cpuSamples++;
      existing.cpuLoad += row.avg?.cpuLoad || 0;
      existing.memory += row.avg?.memory || 0;
    } else {
      containers.push({
        region: dim.region,
        doId: dim.durableObjectId,
        cpuLoad: row.avg?.cpuLoad || 0,
        memory: row.avg?.memory || 0,
        cpuSamples: 1,
      });
    }
  }
  for (var c of containers) {
    c.cpuLoad = c.cpuLoad / c.cpuSamples;
    c.memory = c.memory / c.cpuSamples;
  }
  containers.sort((a, b) => a.region.localeCompare(b.region) || a.doId.localeCompare(b.doId));

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          name,
          image: appConfig.image,
          regions: appConfig.regions,
          instances,
          containers: containers.map((c) => ({
            region: c.region,
            id: c.doId,
            cpu: +(c.cpuLoad * 100).toFixed(1),
            memoryMiB: +(c.memory / 1024 / 1024).toFixed(0),
          })),
        },
        null,
        2
      )
    );
    return;
  }

  var url = await appProvider.getAppUrl(cfg, name);
  var customDomains = appConfig.domains || [];

  console.log("");
  console.log(`${fmt.bold("App:")}        ${fmt.app(name)}`);
  if (customDomains.length > 0) {
    console.log(`${fmt.bold("URL:")}        ${fmt.url(`https://${customDomains[0]}`)}`);
    for (var d of customDomains.slice(1)) {
      console.log(`             ${fmt.url(`https://${d}`)}`);
    }
    if (url) {
      console.log(`             ${fmt.dim(url)}`);
    }
  } else if (url) {
    console.log(`${fmt.bold("URL:")}        ${fmt.url(url)}`);
  }
  console.log(
    `${fmt.bold("Image:")}      ${appConfig.image || fmt.dim("(not deployed)")}`
  );
  console.log(`${fmt.bold("Regions:")}    ${appConfig.regions.join(", ")}`);
  console.log(`${fmt.bold("Instances:")}  ${instances} per region`);

  if (appConfig.deployedAt) {
    console.log(`${fmt.bold("Deployed:")}   ${appConfig.deployedAt}`);
  }

  console.log(`\n${fmt.bold("Containers:")}`);

  if (containers.length > 0) {
    var headers = ["", "REGION", "ID", "CPU", "MEMORY"];
    var rows = containers.map((c) => [
      kleur.green("*"),
      c.region,
      c.doId.slice(0, 8),
      (c.cpuLoad * 100).toFixed(1) + "%",
      (c.memory / 1024 / 1024).toFixed(0) + " MiB",
    ]);
    console.log(table(headers, rows));
  } else {
    console.log(fmt.dim("  No active containers (app may be sleeping)"));
  }

  console.log(
    `\n${fmt.dim("Metrics from the last 15 minutes. Expect some delay in reporting.")}`
  );
}
