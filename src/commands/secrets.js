import { createInterface } from "readline";
import { phase, success, fatal, hint, fmt } from "../lib/output.js";
import { portalApi, getPortal } from "../lib/portal.js";
import { resolveAppName } from "../lib/link.js";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// relight secrets list [app]
export async function secretsList(appName, options) {
  appName = appName || resolveAppName(options);
  if (!appName) fatal("App name required. Run inside a linked directory or provide app name.");

  var data = await portalApi("GET", `/apps/${appName}/secrets`).catch((err) => {
    fatal(err.message);
  });

  if (data.keys.length === 0) {
    process.stderr.write(`No secrets configured for ${fmt.app(appName)}.\n`);
    return;
  }

  process.stderr.write(`${fmt.bold(`Secrets for ${fmt.app(appName)}:`)}\n`);
  for (var key of data.keys) {
    process.stderr.write(`  ${key}\n`);
  }
  process.stderr.write(`\n${fmt.dim(`${data.keys.length} secret(s) (values hidden)`)}\n`);
}

// relight secrets push [app] KEY=VAL ...
export async function secretsPush(args, options) {
  var appName;
  var pairs;

  // Check if first arg looks like KEY=VALUE or just a name
  if (args.length > 0 && args[0].includes("=")) {
    appName = resolveAppName(options);
    pairs = args;
  } else {
    appName = args[0];
    pairs = args.slice(1);
  }

  if (!appName) fatal("App name required.");
  if (pairs.length === 0) fatal("No secrets provided. Usage: relight secrets push [app] KEY=VALUE ...");

  var secrets = {};
  for (var pair of pairs) {
    var eq = pair.indexOf("=");
    if (eq === -1) fatal(`Invalid format: ${pair}. Expected KEY=VALUE.`);
    secrets[pair.substring(0, eq)] = pair.substring(eq + 1);
  }

  await portalApi("POST", `/apps/${appName}/secrets`, secrets).catch((err) => {
    fatal(err.message);
  });

  success(`${Object.keys(secrets).length} secret(s) pushed to ${fmt.app(appName)}.`);
}

// relight secrets sync [app] — fetch from SM and push to CF Worker bindings
export async function secretsSync(appName, options) {
  appName = appName || resolveAppName(options);
  if (!appName) fatal("App name required.");

  var data = await portalApi("POST", `/apps/${appName}/secrets/sync`).catch((err) => {
    fatal(err.message);
  });

  success(`Synced ${data.synced} secret(s) to ${fmt.app(appName)} worker.`);
  for (var key of data.keys || []) {
    process.stderr.write(`  ${key}\n`);
  }
  if (data.hyperdriveId) {
    hint("Hyperdrive", data.hyperdriveId);
  }
  hint("Restart container", `curl your gateway URL to cold-start a new instance`);
}

// relight secrets delete [app] KEY
export async function secretsDelete(args, options) {
  var appName;
  var key;

  if (args.length === 1) {
    appName = resolveAppName(options);
    key = args[0];
  } else {
    appName = args[0];
    key = args[1];
  }

  if (!appName) fatal("App name required.");
  if (!key) fatal("Secret key required.");

  await portalApi("DELETE", `/apps/${appName}/secrets/${key}`).catch((err) => {
    fatal(err.message);
  });

  success(`Secret ${fmt.bold(key)} deleted from ${fmt.app(appName)}.`);
}

// relight secrets configure [app] — interactive setup of sm_* fields
export async function secretsConfigure(appName, options) {
  appName = appName || resolveAppName(options);
  if (!appName) fatal("App name required.");

  // Try to prefill from portal defaults
  var portalDefaults = null;
  try {
    portalDefaults = await portalApi("GET", "/settings/defaults");
  } catch {}

  var rl = createInterface({ input: process.stdin, output: process.stderr });

  process.stderr.write(`\n${fmt.bold(`Configure secret manager for ${fmt.app(appName)}`)}\n\n`);
  process.stderr.write(`${fmt.dim("Provider-agnostic fields. For Infisical: connection label = SECRETS_<LABEL> env var prefix.")}\n\n`);

  var defaultLabel = portalDefaults?.sm_connection_label || "infisical";

  var connLabel = await prompt(rl, `Connection label [${defaultLabel}]: `);
  connLabel = (connLabel || "").trim() || defaultLabel;

  var projectId = await prompt(rl, "Project ID (workspace / mount path): ");
  projectId = (projectId || "").trim();
  if (!projectId) {
    rl.close();
    fatal("Project ID is required.");
  }

  var env = await prompt(rl, "Environment [production]: ");
  env = (env || "").trim() || "production";

  var path = await prompt(rl, "Secret path [/]: ");
  path = (path || "").trim() || "/";

  rl.close();

  await portalApi("PATCH", `/apps/${appName}/secret-manager`, {
    connection_label: connLabel,
    project_id: projectId,
    environment: env,
    path,
  }).catch((err) => {
    fatal(err.message);
  });

  success(`Secret manager configured for ${fmt.app(appName)}.`);
  hint("Push secrets", `relight secrets push ${appName} KEY=VALUE ...`);
  hint("List keys", `relight secrets list ${appName}`);
}
