import { phase, status, success, fatal, hint, fmt, table } from "../lib/output.js";
import { resolveAppName, readLink, linkApp } from "../lib/link.js";
import { resolveCloudId, getCloudCfg, getProvider } from "../lib/providers/resolve.js";
import {
  getDatabaseConfig, saveDatabaseConfig, removeDatabaseConfig, listDatabases,
  tryGetServiceConfig, normalizeServiceConfig, CLOUD_IDS,
} from "../lib/config.js";
import { createInterface } from "readline";
import { readFileSync, writeFileSync } from "fs";

// --- Helpers ---

function resolveDatabase(name) {
  if (!name) {
    var linked = readLink();
    name = linked?.db;
  }
  if (!name) fatal("No database specified.");
  var entry = getDatabaseConfig(name);
  if (!entry) fatal(`Database '${name}' not found. Run ${fmt.cmd("relight db list")} to see databases.`);
  return { name, entry };
}

async function loadProvider(entry) {
  var providerId = entry.provider;

  // Check if it's a service
  var service = tryGetServiceConfig(providerId);
  if (service && service.layer === "db") {
    var provider = await import(`../lib/providers/${service.type}/db.js`);
    var cfg = { ...normalizeServiceConfig(service), serviceName: providerId };
    return { provider, cfg };
  }

  // It's a cloud
  var provider = await getProvider(providerId, "db");
  var cfg = getCloudCfg(providerId);
  return { provider, cfg };
}

function resolveProvider(options) {
  var provider = options.provider;
  if (!provider) {
    var linked = readLink();
    // Try to infer from linked cloud
    if (linked?.cloud) provider = linked.cloud;
  }
  if (!provider) {
    fatal(
      "No provider specified.",
      `Use ${fmt.cmd("--provider <cf|gcp|aws|service-name>")} to specify the database provider.`
    );
  }
  return provider;
}

// --- Commands ---

export async function dbCreate(name, options) {
  if (!name) fatal("Database name is required.", `Usage: relight db create <name> --provider <provider>`);

  // Check if already exists
  if (getDatabaseConfig(name)) {
    fatal(`Database '${name}' already exists.`);
  }

  var providerId = resolveProvider(options);

  // Determine if this is a service or cloud
  var service = tryGetServiceConfig(providerId);
  var isService = service && service.layer === "db";
  var isPostgres;
  var provider;
  var cfg;

  if (isService) {
    provider = await import(`../lib/providers/${service.type}/db.js`);
    cfg = { ...normalizeServiceConfig(service), serviceName: providerId };
    isPostgres = true;
  } else {
    if (!CLOUD_IDS.includes(providerId)) {
      fatal(
        `Unknown provider: ${providerId}`,
        `Supported: ${CLOUD_IDS.join(", ")} or a registered db service name.`
      );
    }
    provider = await getProvider(providerId, "db");
    cfg = getCloudCfg(providerId);
    isPostgres = providerId !== "cf";
  }

  phase("Creating database");
  if (options.jurisdiction) status(`${name} (jurisdiction: ${options.jurisdiction})...`);
  else if (options.location) status(`${name} (location: ${options.location})...`);
  else status(`${name}...`);

  var result;
  try {
    result = await provider.createDatabase(cfg, name, {
      location: options.location,
      jurisdiction: options.jurisdiction,
    });
  } catch (e) {
    fatal(e.message);
  }

  // Save to database registry
  saveDatabaseConfig(name, {
    provider: providerId,
    dbId: result.dbId,
    dbName: result.dbName,
    dbUser: result.dbUser || null,
    dbToken: result.dbToken,
    connectionUrl: result.connectionUrl,
    isPostgres,
    apps: [],
    createdAt: new Date().toISOString(),
  });

  if (options.json) {
    console.log(JSON.stringify({
      name,
      provider: providerId,
      dbId: result.dbId,
      dbName: result.dbName,
      dbToken: result.dbToken,
      connectionUrl: result.connectionUrl,
    }, null, 2));
    return;
  }

  success(`Database ${fmt.app(name)} created!`);
  console.log(`  ${fmt.bold("Provider:")}  ${providerId}`);
  console.log(`  ${fmt.bold("DB ID:")}     ${result.dbId}`);
  console.log(`  ${fmt.bold("DB Name:")}   ${result.dbName}`);
  if (result.connectionUrl) {
    console.log(`  ${fmt.bold("DB URL:")}    ${fmt.url(result.connectionUrl)}`);
  }
  console.log(`  ${fmt.bold("Token:")}     ${result.dbToken}`);
  hint("Next", `relight db attach ${name} <app>`);
}

export async function dbDestroy(name, options) {
  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  if (options.confirm !== name) {
    if (process.stdin.isTTY) {
      var rl = createInterface({ input: process.stdin, output: process.stderr });
      var answer = await new Promise((resolve) =>
        rl.question(`Type "${name}" to confirm database destruction: `, resolve)
      );
      rl.close();
      if (answer.trim() !== name) {
        fatal("Confirmation did not match. Aborting.");
      }
    } else {
      fatal(
        `Destroying database requires confirmation.`,
        `Run: relight db destroy ${name} --confirm ${name}`
      );
    }
  }

  // Auto-detach from all attached apps
  if (entry.apps && entry.apps.length > 0) {
    for (var appName of entry.apps) {
      process.stderr.write(`  Detaching from ${fmt.app(appName)}...\n`);
      try {
        await detachFromApp(entry, appName);
      } catch (e) {
        process.stderr.write(`  ${fmt.dim(`Warning: could not detach from ${appName}: ${e.message}`)}\n`);
      }
    }
  }

  phase("Destroying database");

  var { provider, cfg } = await loadProvider(entry);
  try {
    await provider.destroyDatabase(cfg, name, { dbId: entry.dbId });
  } catch (e) {
    fatal(e.message);
  }

  removeDatabaseConfig(name);
  success(`Database ${fmt.app(name)} destroyed.`);
}

export async function dbList(options) {
  var databases = listDatabases();

  if (options.json) {
    console.log(JSON.stringify(databases, null, 2));
    return;
  }

  if (databases.length === 0) {
    console.log(fmt.dim("\n  No databases. Create one with: relight db create <name> --provider <provider>\n"));
    return;
  }

  var cols = ["NAME", "PROVIDER", "DB NAME", "APPS", "CREATED"];
  var rows = databases.map((db) => [
    db.name,
    db.provider,
    db.dbName || "-",
    (db.apps || []).join(", ") || "-",
    db.createdAt ? db.createdAt.split("T")[0] : "-",
  ]);

  console.log(table(cols, rows));
}

export async function dbAttach(name, appName, options) {
  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  appName = resolveAppName(appName);

  // Check not already attached
  if (entry.apps && entry.apps.includes(appName)) {
    fatal(`Database '${name}' is already attached to '${appName}'.`);
  }

  // Resolve app's cloud/compute
  var appCloud = resolveCloudId(options.cloud);
  var appCfg = getCloudCfg(appCloud);
  var appProvider = await getProvider(appCloud, "app");

  // Check if compute service
  if (options.compute) {
    var computeService = tryGetServiceConfig(options.compute);
    if (computeService) {
      appProvider = await import(`../lib/providers/${computeService.type}/app.js`);
      appCfg = normalizeServiceConfig(computeService);
    }
  }

  phase("Attaching database");
  status(`${name} -> ${appName}...`);

  var appConfig = await appProvider.getAppConfig(appCfg, appName);
  if (!appConfig) {
    fatal(`App ${appName} not found.`);
  }

  if (!appConfig.envKeys) appConfig.envKeys = [];
  if (!appConfig.secretKeys) appConfig.secretKeys = [];
  if (!appConfig.env) appConfig.env = {};

  // Inject env vars
  if (entry.isPostgres) {
    if (entry.connectionUrl) {
      appConfig.env["DATABASE_URL"] = entry.connectionUrl;
      if (!appConfig.envKeys.includes("DATABASE_URL")) appConfig.envKeys.push("DATABASE_URL");
    }
  } else {
    // CF D1
    appConfig.dbId = entry.dbId;
    appConfig.dbName = entry.dbName;
    if (entry.connectionUrl) {
      appConfig.env["DB_URL"] = entry.connectionUrl;
      if (!appConfig.envKeys.includes("DB_URL")) appConfig.envKeys.push("DB_URL");
    }
  }

  appConfig.env["DB_TOKEN"] = "[hidden]";
  appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
  appConfig.secretKeys.push("DB_TOKEN");
  appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

  if (entry.dbUser) appConfig.dbUser = entry.dbUser;

  await appProvider.pushAppConfig(appCfg, appName, appConfig, {
    newSecrets: { DB_TOKEN: entry.dbToken },
  });

  // Update registry: add app to entry.apps
  if (!entry.apps) entry.apps = [];
  entry.apps.push(appName);
  saveDatabaseConfig(name, entry);

  // Update .relight.yaml: set db to database name
  var linked = readLink();
  if (linked && linked.app === appName) {
    linkApp(linked.app, linked.cloud, linked.dns, name, linked.compute);
  }

  success(`Database ${fmt.app(name)} attached to ${fmt.app(appName)}.`);
}

// Helper to detach a database from an app (used by dbDetach and dbDestroy)
async function detachFromApp(entry, appName, options = {}) {
  var appCloud = options.cloud ? resolveCloudId(options.cloud) : null;
  if (!appCloud) {
    var linked = readLink();
    appCloud = linked?.cloud;
  }
  if (!appCloud) {
    // Try to infer from entry.provider if it's a cloud
    if (CLOUD_IDS.includes(entry.provider)) {
      appCloud = entry.provider;
    }
  }
  if (!appCloud) {
    throw new Error("Cannot determine app cloud. Use --cloud to specify.");
  }

  var appCfg = getCloudCfg(appCloud);
  var appProvider = await getProvider(appCloud, "app");

  if (options.compute) {
    var computeService = tryGetServiceConfig(options.compute);
    if (computeService) {
      appProvider = await import(`../lib/providers/${computeService.type}/app.js`);
      appCfg = normalizeServiceConfig(computeService);
    }
  }

  var appConfig = await appProvider.getAppConfig(appCfg, appName);
  if (!appConfig) return;

  // Remove DB env vars
  delete appConfig.dbId;
  delete appConfig.dbName;
  delete appConfig.dbUser;

  if (appConfig.env) {
    delete appConfig.env["DB_URL"];
    delete appConfig.env["DB_TOKEN"];
    delete appConfig.env["DATABASE_URL"];
  }
  if (appConfig.envKeys) {
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_URL" && k !== "DATABASE_URL");
  }
  if (appConfig.secretKeys) {
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
  }

  await appProvider.pushAppConfig(appCfg, appName, appConfig);
}

export async function dbDetach(appName, options) {
  appName = resolveAppName(appName);

  // Find which database is attached to this app
  var databases = listDatabases();
  var attached = null;
  var attachedName = null;

  // Check .relight.yaml first
  var linked = readLink();
  if (linked?.db) {
    var entry = getDatabaseConfig(linked.db);
    if (entry && entry.apps && entry.apps.includes(appName)) {
      attached = entry;
      attachedName = linked.db;
    }
  }

  // Search registry
  if (!attached) {
    for (var db of databases) {
      if (db.apps && db.apps.includes(appName)) {
        attached = db;
        attachedName = db.name;
        break;
      }
    }
  }

  if (!attached) {
    fatal(`No database found attached to '${appName}'.`);
  }

  phase("Detaching database");
  status(`${attachedName} from ${appName}...`);

  try {
    await detachFromApp(attached, appName, options);
  } catch (e) {
    fatal(e.message);
  }

  // Update registry: remove app from entry.apps
  attached.apps = (attached.apps || []).filter((a) => a !== appName);
  // Remove extra fields added by listDatabases() (like 'name')
  var cleanEntry = getDatabaseConfig(attachedName);
  cleanEntry.apps = attached.apps;
  saveDatabaseConfig(attachedName, cleanEntry);

  success(`Database ${fmt.app(attachedName)} detached from ${fmt.app(appName)}.`);
}

export async function dbInfo(name, options) {
  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  var { provider, cfg } = await loadProvider(entry);

  var info;
  try {
    info = await provider.getDatabaseInfo(cfg, name, {
      dbId: entry.dbId,
      connectionUrl: entry.connectionUrl,
    });
  } catch (e) {
    fatal(e.message);
  }

  if (options.json) {
    console.log(JSON.stringify({
      name,
      provider: entry.provider,
      dbId: info.dbId,
      dbName: info.dbName,
      connectionUrl: info.connectionUrl,
      size: info.size,
      numTables: info.numTables,
      apps: entry.apps || [],
      createdAt: info.createdAt || entry.createdAt,
    }, null, 2));
    return;
  }

  console.log("");
  console.log(`${fmt.bold("Database:")}   ${fmt.app(name)}`);
  console.log(`${fmt.bold("Provider:")}   ${entry.provider}`);
  console.log(`${fmt.bold("DB ID:")}      ${info.dbId}`);
  console.log(`${fmt.bold("DB Name:")}    ${info.dbName}`);
  if (info.size != null) {
    var sizeKb = (info.size / 1024).toFixed(1);
    console.log(`${fmt.bold("Size:")}       ${sizeKb} KB`);
  }
  if (info.numTables != null) {
    console.log(`${fmt.bold("Tables:")}     ${info.numTables}`);
  }
  if (info.connectionUrl) {
    console.log(`${fmt.bold("DB URL:")}     ${fmt.url(info.connectionUrl)}`);
  }
  console.log(`${fmt.bold("Token:")}      ${fmt.dim("[hidden]")}`);
  if (entry.apps && entry.apps.length > 0) {
    console.log(`${fmt.bold("Apps:")}       ${entry.apps.join(", ")}`);
  }
  if (info.createdAt || entry.createdAt) {
    console.log(`${fmt.bold("Created:")}    ${info.createdAt || entry.createdAt}`);
  }
  console.log("");
}

export async function dbShell(name, options) {
  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  var { provider, cfg } = await loadProvider(entry);

  // Verify database exists
  try {
    await provider.getDatabaseInfo(cfg, name, {
      dbId: entry.dbId,
      connectionUrl: entry.connectionUrl,
    });
  } catch (e) {
    fatal(e.message);
  }

  var isPostgres = entry.isPostgres;

  var rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "sql> ",
  });

  process.stderr.write(`Connected to ${fmt.app(name)}. Type .exit to quit.\n\n`);
  rl.prompt();

  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    if (line === ".exit" || line === ".quit") {
      rl.close();
      return;
    }

    try {
      var sql;
      if (line === ".tables") {
        if (isPostgres) {
          sql = "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename";
        } else {
          sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
        }
      } else if (line.startsWith(".schema")) {
        var tableName = line.split(/\s+/)[1];
        if (!tableName) {
          process.stderr.write("Usage: .schema <table>\n");
          rl.prompt();
          return;
        }
        if (isPostgres) {
          sql = `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'public' ORDER BY ordinal_position`;
        } else {
          sql = `SELECT sql FROM sqlite_master WHERE name='${tableName}'`;
        }
      } else {
        sql = line;
      }

      var results = await provider.queryDatabase(cfg, name, sql, undefined, {
        dbId: entry.dbId,
        connectionUrl: entry.connectionUrl,
      });
      var result = Array.isArray(results) ? results[0] : results;

      if (result && result.results && result.results.length > 0) {
        var cols = Object.keys(result.results[0]);
        var rows = result.results.map((r) => cols.map((c) => String(r[c] ?? "")));
        console.log(table(cols, rows));
      } else if (result && result.meta) {
        process.stderr.write(
          fmt.dim(`OK. ${result.meta.changes || 0} changes, ${result.meta.rows_read || 0} rows read.\n`)
        );
      }
    } catch (e) {
      process.stderr.write(`${fmt.dim("Error:")} ${e.message}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.stderr.write("\n");
  });

  await new Promise((resolve) => rl.on("close", resolve));
}

export async function dbQuery(args, options) {
  var name;
  var sql;
  var joined = args.join(" ");

  var sqlKeywords = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|WITH|EXPLAIN|BEGIN|COMMIT|ROLLBACK|REPLACE|VACUUM|REINDEX|ATTACH|DETACH)\b/i;
  if (args.length >= 2 && !args[0].includes(" ") && !sqlKeywords.test(args[0])) {
    name = args[0];
    sql = args.slice(1).join(" ");
  } else {
    sql = joined;
  }

  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  var { provider, cfg } = await loadProvider(entry);

  var results;
  try {
    results = await provider.queryDatabase(cfg, name, sql, undefined, {
      dbId: entry.dbId,
      connectionUrl: entry.connectionUrl,
    });
  } catch (e) {
    fatal(e.message);
  }
  var result = Array.isArray(results) ? results[0] : results;

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result && result.results && result.results.length > 0) {
    var cols = Object.keys(result.results[0]);
    var rows = result.results.map((r) => cols.map((c) => String(r[c] ?? "")));
    console.log(table(cols, rows));
  } else if (result && result.meta) {
    process.stderr.write(
      fmt.dim(`OK. ${result.meta.changes || 0} changes, ${result.meta.rows_read || 0} rows read.\n`)
    );
  }
}

export async function dbImport(args, options) {
  var name;
  var filepath;
  if (args.length >= 2) {
    name = args[0];
    filepath = args[1];
  } else if (args.length === 1) {
    filepath = args[0];
  } else {
    fatal("Usage: relight db import <name> <path>");
  }

  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  var { provider, cfg } = await loadProvider(entry);

  var sqlContent;
  try {
    sqlContent = readFileSync(filepath, "utf-8");
  } catch (e) {
    fatal(`Could not read file: ${filepath}`, e.message);
  }

  phase("Importing SQL");
  status(`File: ${filepath} (${(sqlContent.length / 1024).toFixed(1)} KB)`);

  try {
    await provider.importDatabase(cfg, name, sqlContent, {
      dbId: entry.dbId,
      connectionUrl: entry.connectionUrl,
    });
  } catch (e) {
    fatal(e.message);
  }

  success(`Imported ${filepath} into ${fmt.app(name)}`);
}

export async function dbExport(name, options) {
  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  var { provider, cfg } = await loadProvider(entry);

  phase("Exporting database");
  status("Initiating export...");

  var dump;
  try {
    dump = await provider.exportDatabase(cfg, name, {
      dbId: entry.dbId,
      connectionUrl: entry.connectionUrl,
    });
  } catch (e) {
    fatal(e.message);
  }

  if (options.output) {
    writeFileSync(options.output, dump);
    success(`Exported to ${options.output}`);
  } else {
    process.stdout.write(dump);
  }
}

export async function dbToken(name, options) {
  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  if (options.rotate) {
    var { provider, cfg } = await loadProvider(entry);

    var result;
    try {
      result = await provider.rotateToken(cfg, name, { dbId: entry.dbId });
    } catch (e) {
      fatal(e.message);
    }

    // Update registry with new token and connection URL
    entry.dbToken = result.dbToken;
    if (result.connectionUrl) entry.connectionUrl = result.connectionUrl;
    saveDatabaseConfig(name, entry);

    // Update all attached apps
    if (entry.apps && entry.apps.length > 0) {
      for (var appName of entry.apps) {
        status(`Updating ${appName}...`);
        try {
          // Re-attach to update the token in the app
          var appCloud = resolveCloudId(null);
          var appCfg = getCloudCfg(appCloud);
          var appProvider = await getProvider(appCloud, "app");
          var appConfig = await appProvider.getAppConfig(appCfg, appName);

          if (appConfig) {
            if (!appConfig.envKeys) appConfig.envKeys = [];
            if (!appConfig.secretKeys) appConfig.secretKeys = [];
            if (!appConfig.env) appConfig.env = {};

            appConfig.env["DB_TOKEN"] = "[hidden]";
            if (!appConfig.secretKeys.includes("DB_TOKEN")) appConfig.secretKeys.push("DB_TOKEN");
            appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

            if (result.connectionUrl) {
              var urlKey = entry.isPostgres ? "DATABASE_URL" : "DB_URL";
              appConfig.env[urlKey] = result.connectionUrl;
              if (!appConfig.envKeys.includes(urlKey)) appConfig.envKeys.push(urlKey);
            }

            await appProvider.pushAppConfig(appCfg, appName, appConfig, {
              newSecrets: { DB_TOKEN: result.dbToken },
            });
          }
        } catch (e) {
          process.stderr.write(`  ${fmt.dim(`Warning: could not update ${appName}: ${e.message}`)}\n`);
        }
      }
    }

    success("Token rotated.");
    console.log(`${fmt.bold("Token:")}    ${result.dbToken}`);
    if (result.connectionUrl) {
      console.log(`${fmt.bold("DB URL:")}   ${fmt.url(result.connectionUrl)}`);
    }
  } else {
    console.log(`${fmt.bold("Token:")}    ${fmt.dim("[hidden] - use --rotate to generate a new token")}`);
    if (entry.connectionUrl) {
      console.log(`${fmt.bold("DB URL:")}   ${fmt.url(entry.connectionUrl)}`);
    }
  }
}

export async function dbReset(name, options) {
  var resolved = resolveDatabase(name);
  name = resolved.name;
  var entry = resolved.entry;

  if (options.confirm !== name) {
    if (process.stdin.isTTY) {
      var rl = createInterface({ input: process.stdin, output: process.stderr });
      var answer = await new Promise((resolve) =>
        rl.question(`Type "${name}" to confirm database reset: `, resolve)
      );
      rl.close();
      if (answer.trim() !== name) {
        fatal("Confirmation did not match. Aborting.");
      }
    } else {
      fatal(
        `Resetting database requires confirmation.`,
        `Run: relight db reset ${name} --confirm ${name}`
      );
    }
  }

  var { provider, cfg } = await loadProvider(entry);

  phase("Resetting database");
  status("Listing tables...");

  var tables;
  try {
    tables = await provider.resetDatabase(cfg, name, {
      dbId: entry.dbId,
      connectionUrl: entry.connectionUrl,
    });
  } catch (e) {
    fatal(e.message);
  }

  if (tables.length === 0) {
    process.stderr.write("No user tables found.\n");
    return;
  }

  success(`Dropped ${tables.length} table${tables.length === 1 ? "" : "s"}.`);
}
