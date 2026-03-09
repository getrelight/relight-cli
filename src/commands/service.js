import { createInterface } from "readline";
import { success, fatal, fmt, table } from "../lib/output.js";
import {
  SERVICE_TYPES,
  getRegisteredServices,
  saveServiceConfig,
  removeServiceConfig,
  normalizeServiceConfig,
  tryGetServiceConfig,
} from "../lib/config.js";
import { verifyConnection } from "../lib/clouds/slicervm.js";
import { verifyApiKey } from "../lib/clouds/neon.js";
import { verifyApiToken as verifyTursoToken } from "../lib/clouds/turso.js";
import kleur from "kleur";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function serviceList() {
  var services = getRegisteredServices();

  if (services.length === 0) {
    process.stderr.write("No services registered.\n");
    process.stderr.write(
      `\n${fmt.dim("Hint:")} ${fmt.cmd("relight services add")} to register one.\n`
    );
    return;
  }

  var headers = ["NAME", "LAYER", "TYPE", "ENDPOINT"];
  var rows = services.map((a) => [
    fmt.bold(a.name),
    a.layer,
    SERVICE_TYPES[a.type]?.name || a.type,
    a.socketPath || a.apiUrl || (a.type === "neon" ? "console.neon.tech" : a.type === "turso" ? "turso.io" : "-"),
  ]);

  console.log(table(headers, rows));
}

export async function serviceAdd(name) {
  var rl = createInterface({ input: process.stdin, output: process.stderr });

  // 1. Pick layer
  var layers = ["compute", "db"];
  process.stderr.write(`\n${kleur.bold("Register a service")}\n\n`);
  process.stderr.write(`  ${kleur.bold("Layer:")}\n\n`);
  for (var i = 0; i < layers.length; i++) {
    process.stderr.write(`  ${kleur.bold(`[${i + 1}]`)} ${layers[i]}\n`);
  }
  process.stderr.write("\n");

  var layerChoice = await prompt(rl, `Select layer [1-${layers.length}]: `);
  var layerIdx = parseInt(layerChoice, 10) - 1;
  if (isNaN(layerIdx) || layerIdx < 0 || layerIdx >= layers.length) {
    rl.close();
    fatal("Invalid selection.");
  }
  var layer = layers[layerIdx];

  // 2. Pick type (contextual to layer)
  var types = Object.entries(SERVICE_TYPES)
    .filter(([, v]) => v.layer === layer)
    .map(([id, v]) => ({ id, name: v.name }));

  process.stderr.write(`\n  ${kleur.bold("Type:")}\n\n`);
  for (var i = 0; i < types.length; i++) {
    process.stderr.write(
      `  ${kleur.bold(`[${i + 1}]`)} ${types[i].name}\n`
    );
  }
  process.stderr.write("\n");

  var typeChoice = await prompt(rl, `Select type [1-${types.length}]: `);
  var typeIdx = parseInt(typeChoice, 10) - 1;
  if (isNaN(typeIdx) || typeIdx < 0 || typeIdx >= types.length) {
    rl.close();
    fatal("Invalid selection.");
  }
  var serviceType = types[typeIdx].id;

  // 3. Connection details (SlicerVM-specific)
  var config = { layer, type: serviceType };

  if (serviceType === "slicervm") {
    process.stderr.write(`\n  ${kleur.bold("Connection mode")}\n\n`);
    process.stderr.write(`  ${kleur.bold("[1]")} Unix socket (local dev)\n`);
    process.stderr.write(`  ${kleur.bold("[2]")} HTTP API (remote)\n\n`);

    var modeChoice = await prompt(rl, "Select [1-2]: ");
    var useSocket = modeChoice.trim() === "1";

    if (useSocket) {
      var defaultSocket = "/var/run/slicer/slicer.sock";
      var socketPath = await prompt(rl, `Socket path [${defaultSocket}]: `);
      socketPath = (socketPath || "").trim() || defaultSocket;
      config.socketPath = socketPath;
    } else {
      var apiUrl = await prompt(
        rl,
        "Slicer API URL (e.g. https://slicer.example.com:8080): "
      );
      apiUrl = (apiUrl || "").trim().replace(/\/+$/, "");
      if (!apiUrl) {
        rl.close();
        fatal("No API URL provided.");
      }
      config.apiUrl = apiUrl;

      var token = await prompt(rl, "API token: ");
      token = (token || "").trim();
      if (!token) {
        rl.close();
        fatal("No token provided.");
      }
      config.token = token;
    }

    var hostGroup = await prompt(rl, "Host group [apps]: ");
    config.hostGroup = (hostGroup || "").trim() || "apps";

    var baseDomain = await prompt(
      rl,
      "Base domain (e.g. apps.example.com) [localhost]: "
    );
    config.baseDomain = (baseDomain || "").trim() || "localhost";

    // 4. Verify connection
    process.stderr.write("\nVerifying...\n");
    var verifyCfg = normalizeServiceConfig(config);
    try {
      await verifyConnection(verifyCfg);
    } catch (e) {
      rl.close();
      fatal("Connection failed.", e.message);
    }

    if (useSocket) {
      process.stderr.write(`  Socket: ${fmt.bold(config.socketPath)}\n`);
    } else {
      process.stderr.write(`  API: ${fmt.bold(config.apiUrl)}\n`);
    }
    process.stderr.write(`  Host group: ${fmt.dim(config.hostGroup)}\n`);
    process.stderr.write(`  Base domain: ${fmt.dim(config.baseDomain)}\n`);
  } else if (serviceType === "neon") {
    process.stderr.write(`\n  ${kleur.bold("Neon API key")}\n\n`);
    process.stderr.write(
      `  ${fmt.dim("Get your API key at https://console.neon.tech/app/settings/api-keys")}\n\n`
    );

    var apiKey = await prompt(rl, "API key: ");
    apiKey = (apiKey || "").trim();
    if (!apiKey) {
      rl.close();
      fatal("No API key provided.");
    }
    config.apiKey = apiKey;

    // Verify connection
    process.stderr.write("\nVerifying...\n");
    try {
      var projects = await verifyApiKey(apiKey);
      process.stderr.write(
        `  Authenticated. ${projects.length} existing project${projects.length === 1 ? "" : "s"}.\n`
      );
    } catch (e) {
      rl.close();
      fatal("Authentication failed.", e.message);
    }
  } else if (serviceType === "turso") {
    process.stderr.write(`\n  ${kleur.bold("Turso API token")}\n\n`);
    process.stderr.write(
      `  ${fmt.dim("Get your API token at https://turso.tech/app/settings/api-tokens")}\n\n`
    );

    var apiToken = await prompt(rl, "API token: ");
    apiToken = (apiToken || "").trim();
    if (!apiToken) {
      rl.close();
      fatal("No API token provided.");
    }
    config.apiToken = apiToken;

    // Verify connection and get orgs
    process.stderr.write("\nVerifying...\n");
    var orgs;
    try {
      orgs = await verifyTursoToken(apiToken);
    } catch (e) {
      rl.close();
      fatal("Authentication failed.", e.message);
    }

    if (orgs.length === 0) {
      rl.close();
      fatal("No organizations found for this API token.");
    }

    var orgSlug;
    if (orgs.length === 1) {
      orgSlug = orgs[0].slug || orgs[0].name;
      process.stderr.write(`  Organization: ${fmt.bold(orgSlug)}\n`);
    } else {
      process.stderr.write(`\n  ${kleur.bold("Select organization:")}\n\n`);
      for (var i = 0; i < orgs.length; i++) {
        var slug = orgs[i].slug || orgs[i].name;
        process.stderr.write(`  ${kleur.bold(`[${i + 1}]`)} ${slug}\n`);
      }
      process.stderr.write("\n");
      var orgChoice = await prompt(rl, `Select [1-${orgs.length}]: `);
      var orgIdx = parseInt(orgChoice, 10) - 1;
      if (isNaN(orgIdx) || orgIdx < 0 || orgIdx >= orgs.length) {
        rl.close();
        fatal("Invalid selection.");
      }
      orgSlug = orgs[orgIdx].slug || orgs[orgIdx].name;
    }

    config.orgSlug = orgSlug;
    process.stderr.write(`  Authenticated with ${fmt.bold(orgSlug)}.\n`);
  }

  // 5. Auto-name if not provided
  if (!name) {
    var existing = getRegisteredServices().filter((a) => a.type === serviceType);
    if (existing.length === 0) {
      name = serviceType;
    } else {
      name = `${serviceType}-${existing.length + 1}`;
    }
    var inputName = await prompt(rl, `Service name [${name}]: `);
    name = (inputName || "").trim() || name;
  }

  // Check for existing
  if (tryGetServiceConfig(name)) {
    var overwrite = await prompt(
      rl,
      `Service '${name}' already exists. Overwrite? [y/N] `
    );
    if (!overwrite.match(/^y(es)?$/i)) {
      rl.close();
      process.stderr.write("Cancelled.\n");
      process.exit(0);
    }
  }

  rl.close();

  // 6. Save
  saveServiceConfig(name, config);

  success(`Service ${fmt.bold(name)} registered!`);
}

export async function serviceRemove(name) {
  if (!name) {
    fatal("Usage: relight services remove <name>");
  }

  if (!tryGetServiceConfig(name)) {
    fatal(`Service '${name}' not found.`);
  }

  var rl = createInterface({ input: process.stdin, output: process.stderr });
  var answer = await new Promise((resolve) =>
    rl.question(`Remove service '${name}'? [y/N] `, resolve)
  );
  rl.close();

  if (!answer.match(/^y(es)?$/i)) {
    process.stderr.write("Cancelled.\n");
    return;
  }

  removeServiceConfig(name);
  success(`Service ${fmt.bold(name)} removed.`);
}
