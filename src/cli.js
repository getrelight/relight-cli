#!/usr/bin/env node

import { Command } from "commander";
import { providersList, providersAdd, providersRemove, providersDefaultCmd } from "./commands/providers.js";
import { doctor } from "./commands/doctor.js";
import { deploy } from "./commands/deploy.js";
import { appsList, appsInfo, appsCreate, appsDestroy } from "./commands/apps.js";
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
import {
  dbCreate, dbDestroy, dbList, dbInfo, dbAttach, dbDetach,
  dbShell, dbQuery, dbImport, dbExport, dbToken, dbReset,
  dbBackup, dbBackups, dbRestore,
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

// --- Providers ---

var providersCmd = program.command("providers").description("Manage providers");

providersCmd
  .command("list", { isDefault: true })
  .description("List configured providers")
  .action(providersList);

providersCmd
  .command("add [type]")
  .description("Add a provider (cf, gcp, aws, azure, do, ghcr, slicervm)")
  .action(providersAdd);

providersCmd
  .command("remove <name>")
  .description("Remove a provider")
  .action(providersRemove);

providersCmd
  .command("default <args...>")
  .description("Set default provider for a layer (app, db, dns, registry)")
  .action(providersDefaultCmd);

// --- Deploy ---

program
  .command("deploy [name] [path]")
  .description("Build and deploy an app (portal: app must exist — create with apps create)")
  .option("-t, --tag <tag>", "Image tag (default: timestamp)")
  .option("--dockerfile <path>", "Path to Dockerfile (relative to build context)")
  .option("--build-secret <secrets...>", "Docker BuildKit secrets passed to docker build (e.g. id=github_token,env=MY_TOKEN)")
  .option("--build-arg <args...>", "Docker build args (KEY=VALUE)")
  .option("--json", "Output result as JSON")
  .option("-y, --yes", "Skip confirmation prompt")
  // BYOC-only options (ignored in portal mode):
  .option("--compute <name>", "BYOC: compute provider")
  .option("--registry <name>", "BYOC: container registry provider")
  .option("-e, --env <vars...>", "BYOC: set env vars (KEY=VALUE)")
  .option("--regions <hints>", "BYOC: location hints (wnam,enam,sam,weur,eeur,apac,oc,afr,me)")
  .option("-i, --instances <n>", "BYOC: instances per region", parseInt)
  .option("--port <port>", "BYOC: container port", parseInt)
  .option("--sleep <duration>", "BYOC: sleep after idle (e.g. 5m, 30s, never)")
  .option("--instance-type <type>", "BYOC: instance type (lite, basic, standard, standard-2..4, dev)")
  .option("--vcpu <n>", "BYOC: vCPU allocation", parseFloat)
  .option("--memory <mb>", "BYOC: memory in MiB", parseInt)
  .option("--disk <mb>", "BYOC: disk in MB", parseInt)
  .option("--dns <name>", "BYOC: DNS provider")
  .option("--no-observability", "BYOC: disable Workers observability/logs")
  .option("--db <name>", "BYOC: database provider (for --backup-db)")
  .option("--pre-deploy <cmd>", "Run command in the built image before push")
  .option("--backup-db", "BYOC: backup database before deploying")
  .option("--gateway", "BYOC: deploy behind gateway")
  .option("--hostname <domain>", "BYOC: gateway hostname")
  .option("--groups <groups>", "BYOC: gateway access groups (comma-separated)")
  .option("--match-mode <mode>", "BYOC: gateway group match mode (any|all)", "any")
  .option("--path-prefix <prefix>", "BYOC: gateway path prefix", "/")
  .action(deploy);

// --- Apps (topic root = list) ---

var apps = program.command("apps").description("Manage apps");

apps
  .command("list", { isDefault: true })
  .description("List all deployed apps")
  .option("--compute <name>", "Provider for compute")
  .option("--json", "Output as JSON")
  .action(appsList);

apps
  .command("create <name>")
  .description("Register a new app with its configuration (portal mode)")
  .option("--compute <label>", "Cloud provider label (required)")
  .option("--registry <label>", "Container registry label")
  .option("--regions <hints>", "Location hints, comma-separated (e.g. euw,wnam)")
  .option("-i, --instances <n>", "Instances per region (default: 2)", parseInt)
  .option("--port <port>", "Container port (default: 8080)", parseInt)
  .option("--sleep <duration>", "Idle sleep timeout (e.g. 5m, 30s, never; default: 30s)")
  .option("--instance-type <type>", "Instance type (lite, basic, standard, standard-2..4, dev)")
  .option("--vcpu <n>", "vCPU allocation (e.g. 0.0625, 0.5, 1, 2)", parseFloat)
  .option("--memory <mb>", "Memory in MiB (e.g. 256, 512, 1024)", parseInt)
  .option("--disk <mb>", "Disk in MB (e.g. 2000, 5000)", parseInt)
  .option("-e, --env <vars...>", "Initial env vars (KEY=VALUE)")
  .option("--no-observability", "Disable Workers observability/logs")
  .option("--gateway", "Place app behind gateway (protected by shared secret)")
  .option("--hostname <domain>", "Gateway: public hostname (e.g. app.example.com)")
  .option("--groups <groups>", "Gateway: required access groups (comma-separated)")
  .option("--match-mode <mode>", "Gateway: group match mode (any|all)", "any")
  .option("--path-prefix <prefix>", "Gateway: path prefix (default: /)", "/")
  .option("--sm-connection <label>", "Secret manager: connection label (e.g. infisical)")
  .option("--sm-project-id <id>", "Secret manager: project / workspace ID")
  .option("--sm-environment <env>", "Secret manager: environment (default: production)")
  .option("--sm-path <path>", "Secret manager: secret path (default: /)")
  .action(appsCreate);

apps
  .command("info [name]")
  .description("Show detailed app information")
  .option("--compute <name>", "Provider for compute")
  .option("--json", "Output as JSON")
  .action(appsInfo);

apps
  .command("destroy [name]")
  .description("Destroy an app and its resources")
  .option("--compute <name>", "Provider for compute")
  .option("--confirm <name>", "Confirm by providing the app name")
  .action(appsDestroy);

// --- Config (topic root = show) ---

var configCmd = program
  .command("config")
  .description("Manage app config/env vars")
  .option("--compute <name>", "Provider for compute");

function configOpts(cmd) {
  var parentOpts = cmd?.parent?.opts() || {};
  return { compute: parentOpts.compute };
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
  .option("--compute <name>", "Provider for compute")
  .option(
    "-r, --regions <hints>",
    "Comma-separated location hints (wnam,enam,sam,weur,eeur,apac,oc,afr,me)"
  )
  .option("-i, --instances <n>", "Instances per region", parseInt)
  .option("--instance-type <type>", "Instance type (lite, basic, standard, standard-2..4, dev)")
  .option("--vcpu <n>", "vCPU allocation (e.g. 0.0625, 0.5, 1, 2)", parseFloat)
  .option("--memory <mb>", "Memory in MiB (e.g. 256, 512, 1024)", parseInt)
  .option("--disk <mb>", "Disk in MB (e.g. 2000, 5000)", parseInt)
  .option("--sleep <duration>", "Sleep after idle (e.g. 10m, 30s, 1h)")
  .option("--json", "Output as JSON")
  .action(scale);

// --- Domains (topic root = list) ---

var domainsCmd = program
  .command("domains")
  .description("Manage custom domains")
  .option("--compute <name>", "Provider for compute")
  .option("--dns <name>", "Provider for DNS records");

domainsCmd
  .command("list [name]", { isDefault: true })
  .description("List custom domains for an app")
  .option("--compute <name>", "Provider for compute")
  .option("--json", "Output as JSON")
  .action(domainsList);

function domainsOpts(cmd) {
  var parentOpts = cmd?.parent?.opts() || {};
  return { compute: parentOpts.compute, dns: parentOpts.dns };
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
  .option("--db <name>", "Database provider")
  .option("--json", "Output as JSON")
  .action(dbList);

dbCmd
  .command("create <name>")
  .description("Create a standalone database")
  .option("--db <name>", "Database provider")
  .option("--location <hint>", "Location hint (wnam, enam, weur, eeur, apac)")
  .option("--jurisdiction <j>", "Jurisdiction (eu, fedramp)")
  .option("--json", "Output as JSON")
  .action(dbCreate);

dbCmd
  .command("destroy <name>")
  .description("Destroy a database")
  .option("--db <name>", "Database provider")
  .option("--confirm <name>", "Confirm by providing the database name")
  .action(dbDestroy);

dbCmd
  .command("info <name>")
  .description("Show database details")
  .option("--db <name>", "Database provider")
  .option("--json", "Output as JSON")
  .action(dbInfo);

dbCmd
  .command("attach <name> [app]")
  .description("Attach database to an app (injects env vars)")
  .option("--db <name>", "Database provider")
  .option("--compute <name>", "App compute provider")
  .action(dbAttach);

dbCmd
  .command("detach [app]")
  .description("Detach database from an app (removes env vars)")
  .option("--compute <name>", "App compute provider")
  .action(dbDetach);

dbCmd
  .command("shell <name>")
  .description("Interactive SQL REPL")
  .option("--db <name>", "Database provider")
  .action(dbShell);

dbCmd
  .command("query <args...>")
  .description("Run a single SQL query ([name] <sql>)")
  .option("--db <name>", "Database provider")
  .option("--json", "Output as JSON")
  .action(dbQuery);

dbCmd
  .command("import <args...>")
  .description("Import a .sql file (<name> <path>)")
  .option("--db <name>", "Database provider")
  .action(dbImport);

dbCmd
  .command("export <name>")
  .description("Export database as SQL dump")
  .option("--db <name>", "Database provider")
  .option("-o, --output <path>", "Write to file instead of stdout")
  .action(dbExport);

dbCmd
  .command("token <name>")
  .description("Show or rotate auth token")
  .option("--db <name>", "Database provider")
  .option("--rotate", "Generate a new token")
  .action(dbToken);

dbCmd
  .command("reset <name>")
  .description("Drop all tables (confirmation required)")
  .option("--db <name>", "Database provider")
  .option("--confirm <name>", "Confirm by providing the database name")
  .action(dbReset);

dbCmd
  .command("backup [name]")
  .description("Create a database backup (SQL dump)")
  .option("--db <name>", "Database provider")
  .option("--keep <n>", "Keep only N most recent backups", parseInt)
  .option("--json", "Output as JSON")
  .action(dbBackup);

dbCmd
  .command("backups [name]")
  .description("List database backups")
  .option("--db <name>", "Database provider")
  .option("--json", "Output as JSON")
  .action(dbBackups);

dbCmd
  .command("restore [name] [backupId]")
  .description("Restore database from backup")
  .option("--db <name>", "Database provider")
  .option("--confirm <name>", "Confirm by providing the database name")
  .option("--json", "Output as JSON")
  .action(dbRestore);

// --- PS ---

program
  .command("ps [name]")
  .description("Show app containers and status")
  .option("--compute <name>", "Provider for compute")
  .option("--json", "Output as JSON")
  .action(ps);

// --- Logs ---

program
  .command("logs [name]")
  .description("Stream live logs from an app")
  .option("--compute <name>", "Provider for compute")
  .action(logs);

// --- Open ---

program
  .command("open [name]")
  .description("Open app in browser")
  .option("--compute <name>", "Provider for compute")
  .action(open);

// --- Regions ---

program
  .command("regions")
  .description("List available deployment regions")
  .option("--compute <name>", "Provider for compute")
  .option("--json", "Output as JSON")
  .action(async function (options) {
    var { resolveStack } = await import("./lib/providers/resolve.js");
    var stack = await resolveStack(options);
    var appProvider = stack.app.provider;

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
  .option("--compute <name>", "Provider for compute")
  .option("--since <period>", "Date range: Nd (e.g. 7d) or YYYY-MM-DD (default: month to date)")
  .option("--json", "Output as JSON")
  .action(cost);

// --- Portals ---

import { portalsAdd, portalsList, portalsRemove, portalsDefaults } from "./commands/portals.js";

var portalsCmd = program.command("portals").description("Manage portal connections");

portalsCmd
  .command("list", { isDefault: true })
  .description("Show connected portal")
  .action(portalsList);

portalsCmd
  .command("add <url>")
  .description("Connect to a self-hosted Relight portal")
  .action(portalsAdd);

portalsCmd
  .command("remove")
  .description("Disconnect from portal")
  .action(portalsRemove);

var portalsDefaultsCmd = portalsCmd
  .command("defaults")
  .description("Show or set portal-level defaults");

portalsDefaultsCmd
  .command("show", { isDefault: true })
  .description("Show current portal defaults")
  .action(() => portalsDefaults([]));

portalsDefaultsCmd
  .command("set <args...>")
  .description("Set portal defaults (KEY=VALUE ...)")
  .action((args) => portalsDefaults(["set", ...args]));

// --- Doctor ---

program
  .command("doctor")
  .description("Check system setup and provider connectivity")
  .action(doctor);

// --- Secrets ---

import {
  secretsList,
  secretsPush,
  secretsDelete,
  secretsConfigure,
  secretsSync,
} from "./commands/secrets.js";

var secretsCmd = program
  .command("secrets")
  .description("Manage per-app secrets in configured secret manager");

secretsCmd
  .command("list [app]", { isDefault: true })
  .description("List secret keys for an app (values hidden)")
  .action(secretsList);

secretsCmd
  .command("push [args...]")
  .description("Push secrets to app (KEY=VALUE ...)")
  .action((args) => secretsPush(args, {}));

secretsCmd
  .command("sync [app]")
  .description("Fetch secrets from SM and sync to CF Worker bindings")
  .action(secretsSync);

secretsCmd
  .command("delete <args...>")
  .description("Delete a secret from app ([app] KEY)")
  .action((args) => secretsDelete(args, {}));

secretsCmd
  .command("configure [app]")
  .description("Configure secret manager for an app (interactive)")
  .action(secretsConfigure);

// --- SSH Keys ---

import { sshKeysList, sshKeysAdd, sshKeysRemove } from "./commands/ssh-keys.js";

var sshKeysCmd = program
  .command("ssh-keys")
  .description("Manage SSH authorized keys for container access");

sshKeysCmd
  .command("list [app]", { isDefault: true })
  .description("List SSH keys configured for an app")
  .action(sshKeysList);

sshKeysCmd
  .command("add [args...]")
  .description("Add SSH key ([app] <name> <public-key>)")
  .action((args) => sshKeysAdd(args, {}));

sshKeysCmd
  .command("remove [args...]")
  .description("Remove SSH key by name ([app] <key-name>)")
  .action((args) => sshKeysRemove(args, {}));

// --- Top-level aliases ---

program
  .command("destroy [name]")
  .description("Destroy an app (alias for apps destroy)")
  .option("--compute <name>", "Provider for compute")
  .option("--confirm <name>", "Confirm by providing the app name")
  .action(appsDestroy);

program.parse();
