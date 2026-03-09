import { readFileSync } from "fs";
import { status, success, fatal, hint, fmt } from "../lib/output.js";
import { resolveAppName } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";

var RESERVED_NAMES = ["RELIGHT_APP_CONFIG", "APP_CONTAINER", "DB", "DB_URL", "DB_TOKEN"];

function validateKeyName(key) {
  if (RESERVED_NAMES.includes(key)) {
    fatal(`${fmt.key(key)} is a reserved binding name and cannot be used as an env var.`);
  }
}

function ensureKeyLists(appConfig) {
  if (!appConfig.envKeys) appConfig.envKeys = [];
  if (!appConfig.secretKeys) appConfig.secretKeys = [];
  if (!appConfig.env) appConfig.env = {};
}

export async function configShow(name, options) {
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

  var env = appConfig.env || {};
  var keys = Object.keys(env);

  if (keys.length === 0) {
    if (options.json) {
      console.log("{}");
    } else {
      process.stderr.write(`No config vars set for ${fmt.app(name)}.\n`);
    }
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(env, null, 2));
    return;
  }

  for (var key of keys) {
    console.log(`${fmt.key(key)}=${env[key]}`);
  }
}

export async function configSet(args, options) {
  var name, vars;
  if (args.length === 0) {
    fatal("No env vars provided.", "Usage: relight config set [name] KEY=VALUE ...");
  }
  if (args[0].includes("=")) {
    name = resolveAppName(null);
    vars = args;
  } else {
    name = args[0];
    vars = args.slice(1);
  }

  if (vars.length === 0) {
    fatal("No env vars provided.", "Usage: relight config set [name] KEY=VALUE ...");
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

  ensureKeyLists(appConfig);

  var isSecret = options && options.secret;
  var newSecrets = {};

  for (var v of vars) {
    var eq = v.indexOf("=");
    if (eq === -1) {
      fatal(`Invalid format: ${v}`, "Use KEY=VALUE format.");
    }
    var key = v.substring(0, eq);
    var value = v.substring(eq + 1);
    validateKeyName(key);

    if (isSecret) {
      appConfig.envKeys = appConfig.envKeys.filter((k) => k !== key);
      if (!appConfig.secretKeys.includes(key)) appConfig.secretKeys.push(key);
      newSecrets[key] = value;
      appConfig.env[key] = "[hidden]";
      status(`${fmt.key(key)} set ${fmt.dim("(secret)")}`);
    } else {
      appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== key);
      if (!appConfig.envKeys.includes(key)) appConfig.envKeys.push(key);
      appConfig.env[key] = value;
      status(`${fmt.key(key)} set`);
    }
  }

  await appProvider.pushAppConfig(cfg, name, appConfig, { newSecrets: Object.keys(newSecrets).length > 0 ? newSecrets : undefined });
  success("Config updated (live).");
}

export async function configGet(args, options) {
  var name, key;
  if (args.length === 2) {
    name = args[0];
    key = args[1];
  } else if (args.length === 1) {
    name = resolveAppName(null);
    key = args[0];
  } else {
    fatal("Usage: relight config get [name] <key>");
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

  var env = appConfig.env || {};

  if (!(key in env)) {
    fatal(`Key ${fmt.key(key)} is not set on ${fmt.app(name)}.`);
  }

  if ((appConfig.secretKeys || []).includes(key)) {
    console.log("[hidden]");
    hint("Secret values are write-only", "they cannot be read back after being set.");
    return;
  }

  console.log(env[key]);
}

export async function configUnset(args, options) {
  var name, keys;
  if (args.length === 0) {
    fatal("No keys provided.", "Usage: relight config unset [name] KEY ...");
  }
  if (args.length === 1) {
    name = resolveAppName(null);
    keys = args;
  } else if (/^[A-Z_][A-Z0-9_]*$/.test(args[0])) {
    name = resolveAppName(null);
    keys = args;
  } else {
    name = args[0];
    keys = args.slice(1);
  }

  if (keys.length === 0) {
    fatal("No keys provided.", "Usage: relight config unset [name] KEY ...");
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

  ensureKeyLists(appConfig);

  for (var key of keys) {
    var wasEnv = appConfig.envKeys.includes(key);
    var wasSecret = appConfig.secretKeys.includes(key);
    if (!wasEnv && !wasSecret) {
      status(`${fmt.key(key)} ${fmt.dim("(not set, skipping)")}`);
      continue;
    }
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== key);
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== key);
    delete appConfig.env[key];
    status(`${fmt.key(key)} removed`);
  }

  await appProvider.pushAppConfig(cfg, name, appConfig);
  success("Config updated (live).");
}

export async function configImport(name, options) {
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

  ensureKeyLists(appConfig);

  var input;
  if (options.file) {
    try {
      input = readFileSync(options.file, "utf-8");
    } catch (e) {
      fatal(`Could not read file: ${options.file}`, e.message);
    }
  } else if (process.stdin.isTTY) {
    fatal(
      "No input provided.",
      "Pipe a .env file: cat .env | relight config import\n  Or use: relight config import --file .env"
    );
  } else {
    var chunks = [];
    for await (var chunk of process.stdin) {
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks).toString("utf-8");
  }

  var isSecret = options && options.secret;
  var newSecrets = {};
  var count = 0;
  for (var line of input.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    var eq = line.indexOf("=");
    if (eq === -1) continue;
    var key = line.substring(0, eq).trim();
    var value = line.substring(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    validateKeyName(key);

    if (isSecret) {
      appConfig.envKeys = appConfig.envKeys.filter((k) => k !== key);
      if (!appConfig.secretKeys.includes(key)) appConfig.secretKeys.push(key);
      newSecrets[key] = value;
      appConfig.env[key] = "[hidden]";
      status(`${fmt.key(key)} set ${fmt.dim("(secret)")}`);
    } else {
      appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== key);
      if (!appConfig.envKeys.includes(key)) appConfig.envKeys.push(key);
      appConfig.env[key] = value;
      status(`${fmt.key(key)} set`);
    }
    count++;
  }

  if (count === 0) {
    fatal("No variables found in input.", "Use KEY=VALUE format, one per line.");
  }

  await appProvider.pushAppConfig(cfg, name, appConfig, { newSecrets: Object.keys(newSecrets).length > 0 ? newSecrets : undefined });
  success(`${count} variable${count !== 1 ? "s" : ""} imported (live).`);
}
