import { success, fatal, fmt, table } from "../lib/output.js";
import { portalApi, getPortalAppByName } from "../lib/portal.js";
import { resolveAppName } from "../lib/link.js";

// relight ssh-keys list [app]
export async function sshKeysList(appName, options) {
  appName = appName || resolveAppName(options);
  if (!appName) fatal("App name required. Run inside a linked directory or provide app name.");

  var app = await getPortalAppByName(appName);
  if (!app) fatal(`App ${fmt.app(appName)} not found.`);
  var keys = app.liveInfo?.appConfig?.sshKeys || app.config?.sshKeys || [];

  if (keys.length === 0) {
    process.stderr.write(`No SSH keys configured for ${fmt.app(appName)}.\n`);
    return;
  }

  var rows = keys.map((k) => [k.name, k.public_key.slice(0, 60) + "…"]);
  console.log(table(["NAME", "PUBLIC KEY"], rows));
}

// relight ssh-keys add [app] <name> <public-key>
export async function sshKeysAdd(args, options) {
  var appName, keyName, publicKey;

  if (args.length >= 3) {
    [appName, keyName, publicKey] = args;
  } else if (args.length === 2) {
    appName = resolveAppName(options);
    [keyName, publicKey] = args;
  } else {
    fatal("Usage: relight ssh-keys add [app] <name> <public-key>");
  }

  if (!appName) fatal("App name required.");
  if (!publicKey || !publicKey.startsWith("ssh-ed25519 ")) {
    fatal("Only ssh-ed25519 keys are supported by Cloudflare Containers.");
  }

  await portalApi("PATCH", `/apps/${appName}/ssh-keys`, {
    add: { name: keyName, public_key: publicKey },
  }).catch((err) => fatal(err.message));

  success(`SSH key "${keyName}" added to ${fmt.app(appName)}. Container rollout triggered.`);
  process.stderr.write(fmt.dim(`Connect: npx wrangler containers ssh <INSTANCE_ID>\n`));
}

// relight ssh-keys remove [app] <name>
export async function sshKeysRemove(args, options) {
  var appName, keyName;

  if (args.length >= 2) {
    [appName, keyName] = args;
  } else if (args.length === 1) {
    appName = resolveAppName(options);
    keyName = args[0];
  } else {
    fatal("Usage: relight ssh-keys remove [app] <name>");
  }

  if (!appName) fatal("App name required.");

  await portalApi("PATCH", `/apps/${appName}/ssh-keys`, {
    remove: keyName,
  }).catch((err) => fatal(err.message));

  success(`SSH key "${keyName}" removed from ${fmt.app(appName)}. Container rollout triggered.`);
}
