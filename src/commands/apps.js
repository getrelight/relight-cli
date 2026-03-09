import { success, fatal, hint, fmt, table } from "../lib/output.js";
import { resolveAppName, readLink, unlinkApp } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";
import { createInterface } from "readline";

export async function appsList(options) {
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

  console.log("");
  console.log(`${fmt.bold("App:")}        ${fmt.app(name)}`);
  if (info.url) console.log(`${fmt.bold("URL:")}        ${fmt.url(info.url)}`);
  console.log(
    `${fmt.bold("Image:")}      ${appConfig.image || fmt.dim("(not deployed)")}`
  );
  console.log(`${fmt.bold("Regions:")}    ${appConfig.regions.join(", ")}`);
  console.log(`${fmt.bold("Instances:")}  ${appConfig.instances} per region`);
  console.log(`${fmt.bold("Port:")}       ${appConfig.port}`);
  console.log(
    `${fmt.bold("Domains:")}    ${(appConfig.domains || []).join(", ") || fmt.dim("(none)")}`
  );
  var envCount = (appConfig.envKeys || []).length;
  var secretCount = (appConfig.secretKeys || []).length;
  var totalCount = envCount + secretCount;
  if (!appConfig.envKeys && appConfig.env) totalCount = Object.keys(appConfig.env).length;
  var envDisplay = secretCount > 0 ? `${totalCount} (${secretCount} secret)` : `${totalCount}`;
  console.log(
    `${fmt.bold("Env vars:")}   ${envDisplay}`
  );
  if (appConfig.dbId) {
    console.log(`${fmt.bold("Database:")}   ${appConfig.dbName || appConfig.dbId}`);
  }
  if (appConfig.deployedAt) {
    console.log(`${fmt.bold("Deployed:")}   ${appConfig.deployedAt}`);
  }
  if (appConfig.createdAt) {
    console.log(`${fmt.bold("Created:")}    ${appConfig.createdAt}`);
  }
  if (info.consoleUrl) {
    console.log(`${fmt.bold("Console:")}    ${fmt.url(info.consoleUrl)}`);
  }
}

export async function appsDestroy(name, options) {
  name = resolveAppName(name);
  var stack = await resolveStack(options);
  var { cfg, provider: appProvider } = stack.app;

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
