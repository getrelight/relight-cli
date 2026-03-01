#!/usr/bin/env node

import { Command } from "commander";
import { auth } from "./commands/auth.js";
import { doctor } from "./commands/doctor.js";
import { deploy } from "./commands/deploy.js";
import { appsList, appsInfo, appsDestroy } from "./commands/apps.js";
import {
  configShow,
  configSet,
  configGet,
  configUnset,
  configImport,
} from "./commands/config.js";
import { scale } from "./commands/scale.js";
import { domainsList, domainsAdd, domainsRemove } from "./commands/domains.js";
import { ps } from "./commands/ps.js";
import { logs } from "./commands/logs.js";
import { open } from "./commands/open.js";
import { cost } from "./commands/cost.js";
import { serviceList, serviceAdd, serviceRemove } from "./commands/service.js";
import {
  dbCreate, dbDestroy, dbList, dbInfo, dbAttach, dbDetach,
  dbShell, dbQuery, dbImport, dbExport, dbToken, dbReset,
} from "./commands/db.js";
import { fmt } from "./lib/output.js";
import { createRequire } from "module";

var require = createRequire(import.meta.url);
var { version } = require("../package.json");

var program = new Command();

program
  .name("relight")
  .description("Deploy and manage Docker containers across clouds with scale-to-zero")
  .version(version);

// --- Auth ---

program
  .command("auth")
  .description("Authenticate with a cloud provider")
  .option(
    "-c, --cloud <cloud>",
    "Cloud provider (cf, gcp, aws)"
  )
  .action(auth);

// --- Service ---

var serviceCmd = program.command("service").description("Manage services (compute, databases, etc.)");

serviceCmd
  .command("list", { isDefault: true })
  .description("List registered services")
  .action(serviceList);

serviceCmd
  .command("add [name]")
  .description("Register a service")
  .action(serviceAdd);

serviceCmd
  .command("remove <name>")
  .description("Remove a service")
  .action(serviceRemove);

// --- Deploy ---

program
  .command("deploy [name] [path]")
  .description("Deploy an app from a Dockerfile (name auto-generated if omitted)")
  .option("-c, --cloud <cloud>", "Cloud provider (cf, gcp, aws)")
  .option("--compute <name>", "Compute service name")
  .option("-t, --tag <tag>", "Image tag (default: deploy-<timestamp>)")
  .option("-e, --env <vars...>", "Set env vars (KEY=VALUE)")
  .option(
    "--regions <hints>",
    "Comma-separated location hints (wnam,enam,sam,weur,eeur,apac,oc,afr,me)"
  )
  .option("-i, --instances <n>", "Instances per region", parseInt)
  .option("--port <port>", "Container port", parseInt)
  .option("--sleep <duration>", "Sleep after idle (e.g. 5m, 30s, never)", "30s")
  .option("--instance-type <type>", "Instance type (lite, base, standard, large)")
  .option("--vcpu <n>", "vCPU allocation (e.g. 0.0625, 0.5, 1, 2)", parseFloat)
  .option("--memory <mb>", "Memory in MiB (e.g. 256, 512, 1024)", parseInt)
  .option("--disk <mb>", "Disk in MB (e.g. 2000, 5000)", parseInt)
  .option("--dns <cloud>", "Cloud provider for DNS records (cross-cloud)")
  .option("--no-observability", "Disable Workers observability/logs")
  .option("--json", "Output result as JSON")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(deploy);

// --- Apps (topic root = list) ---

var apps = program.command("apps").description("Manage apps");

apps
  .command("list", { isDefault: true })
  .description("List all deployed apps")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--json", "Output as JSON")
  .action(appsList);

apps
  .command("info [name]")
  .description("Show detailed app information")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--json", "Output as JSON")
  .action(appsInfo);

apps
  .command("destroy [name]")
  .description("Destroy an app and its resources")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--confirm <name>", "Confirm by providing the app name")
  .action(appsDestroy);

// --- Config (topic root = show) ---

var configCmd = program
  .command("config")
  .description("Manage app config/env vars")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name");

function configOpts(cmd) {
  var parentOpts = cmd?.parent?.opts() || {};
  return { cloud: parentOpts.cloud, compute: parentOpts.compute };
}

configCmd
  .command("show [name]", { isDefault: true })
  .description("Show all env vars for an app")
  .option("--json", "Output as JSON")
  .action((name, options, cmd) => configShow(name, { ...options, ...configOpts(cmd) }));

configCmd
  .command("set <args...>")
  .description("Set env vars ([name] KEY=VALUE ...) - applies live")
  .option("-s, --secret", "Store values as encrypted secrets (write-only)")
  .action((args, options, cmd) => configSet(args, { ...options, ...configOpts(cmd) }));

configCmd
  .command("get <args...>")
  .description("Get a single env var value ([name] KEY)")
  .action((args, options, cmd) => configGet(args, { ...options, ...configOpts(cmd) }));

configCmd
  .command("unset <args...>")
  .description("Remove env vars ([name] KEY ...) - applies live")
  .action((args, options, cmd) => configUnset(args, { ...options, ...configOpts(cmd) }));

configCmd
  .command("import [name]")
  .description("Import env vars from .env file or stdin")
  .option("-f, --file <path>", "Path to .env file")
  .option("-s, --secret", "Store values as encrypted secrets (write-only)")
  .action((name, options, cmd) => configImport(name, { ...options, ...configOpts(cmd) }));

// --- Scale ---

program
  .command("scale [name]")
  .description("Show or adjust app scaling")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option(
    "-r, --regions <hints>",
    "Comma-separated location hints (wnam,enam,sam,weur,eeur,apac,oc,afr,me)"
  )
  .option("-i, --instances <n>", "Instances per region", parseInt)
  .option("--instance-type <type>", "Instance type (lite, base, standard, large)")
  .option("--vcpu <n>", "vCPU allocation (e.g. 0.0625, 0.5, 1, 2)", parseFloat)
  .option("--memory <mb>", "Memory in MiB (e.g. 256, 512, 1024)", parseInt)
  .option("--disk <mb>", "Disk in MB (e.g. 2000, 5000)", parseInt)
  .option("--json", "Output as JSON")
  .action(scale);

// --- Domains (topic root = list) ---

var domainsCmd = program
  .command("domains")
  .description("Manage custom domains")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--dns <cloud>", "Cloud provider for DNS records (cross-cloud)");

domainsCmd
  .command("list [name]", { isDefault: true })
  .description("List custom domains for an app")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--json", "Output as JSON")
  .action(domainsList);

function domainsOpts(cmd) {
  var parentOpts = cmd?.parent?.opts() || {};
  return { cloud: parentOpts.cloud, compute: parentOpts.compute, dns: parentOpts.dns };
}

domainsCmd
  .command("add [args...]")
  .description("Add a custom domain (interactive if no domain given)")
  .action((args, options, cmd) => domainsAdd(args, { ...options, ...domainsOpts(cmd) }));

domainsCmd
  .command("remove <args...>")
  .description("Remove a custom domain ([name] domain) - applies live")
  .action((args, options, cmd) => domainsRemove(args, { ...options, ...domainsOpts(cmd) }));

// --- DB (topic root = list) ---

var dbCmd = program
  .command("db")
  .description("Manage databases");

dbCmd
  .command("list", { isDefault: true })
  .description("List all databases")
  .option("--json", "Output as JSON")
  .action(dbList);

dbCmd
  .command("create <name>")
  .description("Create a standalone database")
  .option("--provider <id>", "Provider: cf, gcp, aws, or service name (e.g. neon)")
  .option("--location <hint>", "Location hint (wnam, enam, weur, eeur, apac)")
  .option("--jurisdiction <j>", "Jurisdiction (eu, fedramp)")
  .option("--json", "Output as JSON")
  .action(dbCreate);

dbCmd
  .command("destroy <name>")
  .description("Destroy a database")
  .option("--confirm <name>", "Confirm by providing the database name")
  .action(dbDestroy);

dbCmd
  .command("info <name>")
  .description("Show database details")
  .option("--json", "Output as JSON")
  .action(dbInfo);

dbCmd
  .command("attach <name> [app]")
  .description("Attach database to an app (injects env vars)")
  .option("-c, --cloud <cloud>", "App cloud")
  .option("--compute <name>", "App compute service")
  .action(dbAttach);

dbCmd
  .command("detach [app]")
  .description("Detach database from an app (removes env vars)")
  .option("-c, --cloud <cloud>", "App cloud")
  .option("--compute <name>", "App compute service")
  .action(dbDetach);

dbCmd
  .command("shell <name>")
  .description("Interactive SQL REPL")
  .action(dbShell);

dbCmd
  .command("query <args...>")
  .description("Run a single SQL query ([name] <sql>)")
  .option("--json", "Output as JSON")
  .action(dbQuery);

dbCmd
  .command("import <args...>")
  .description("Import a .sql file (<name> <path>)")
  .action(dbImport);

dbCmd
  .command("export <name>")
  .description("Export database as SQL dump")
  .option("-o, --output <path>", "Write to file instead of stdout")
  .action(dbExport);

dbCmd
  .command("token <name>")
  .description("Show or rotate auth token")
  .option("--rotate", "Generate a new token")
  .action(dbToken);

dbCmd
  .command("reset <name>")
  .description("Drop all tables (confirmation required)")
  .option("--confirm <name>", "Confirm by providing the database name")
  .action(dbReset);

// --- PS ---

program
  .command("ps [name]")
  .description("Show app containers and status")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--json", "Output as JSON")
  .action(ps);

// --- Logs ---

program
  .command("logs [name]")
  .description("Stream live logs from an app")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .action(logs);

// --- Open ---

program
  .command("open [name]")
  .description("Open app in browser")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .action(open);

// --- Regions ---

program
  .command("regions")
  .description("List available deployment regions")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--json", "Output as JSON")
  .action(async function (options) {
    var { resolveTarget } = await import("./lib/providers/resolve.js");
    var target = await resolveTarget(options);
    var appProvider = await target.provider("app");

    var regions = appProvider.getRegions();
    if (options.json) {
      console.log(JSON.stringify(regions, null, 2));
      return;
    }
    console.log("");
    for (var r of regions) {
      console.log(`  ${fmt.bold(r.code.padEnd(6))} ${r.name.padEnd(25)} ${fmt.dim(r.location)}`);
    }
    console.log("");
    console.log(fmt.dim("  These are location hints. The cloud provider will attempt to place"));
    console.log(fmt.dim("  containers near the specified region but exact placement is not guaranteed."));
    console.log("");
  });

// --- Cost ---

program
  .command("cost [name]")
  .description("Show estimated costs for an app or all apps")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(cost);

// --- Doctor ---

program
  .command("doctor")
  .description("Check system setup and cloud connectivity")
  .action(doctor);

// --- Top-level aliases ---

program
  .command("destroy [name]")
  .description("Destroy an app (alias for apps destroy)")
  .option("-c, --cloud <cloud>", "Cloud provider")
  .option("--compute <name>", "Compute service name")
  .option("--confirm <name>", "Confirm by providing the app name")
  .action(appsDestroy);

program.parse();
