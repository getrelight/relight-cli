import { phase, status, success, fatal, hint, fmt, table } from "../lib/output.js";
import { resolveAppName, resolveDb, readLink, linkApp } from "../lib/link.js";
import { resolveCloudId, getCloudCfg, getProvider } from "../lib/providers/resolve.js";
import { createInterface } from "readline";
import { readFileSync, writeFileSync } from "fs";

// Resolve app cloud and db cloud from options + .relight.yaml
function resolveDbClouds(options) {
  var appCloud = resolveCloudId(options.cloud);
  var dbFlag = options.db || resolveDb();
  var crossCloud = dbFlag && resolveCloudId(dbFlag) !== appCloud;
  var dbCloud = crossCloud ? resolveCloudId(dbFlag) : appCloud;
  return { appCloud, dbCloud, crossCloud };
}

export async function dbCreate(name, options) {
  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

  phase("Creating database");
  if (options.jurisdiction) status(`relight-${name} (jurisdiction: ${options.jurisdiction})...`);
  else if (options.location) status(`relight-${name} (location: ${options.location})...`);
  else status(`relight-${name}...`);

  var result;
  try {
    result = await dbProvider.createDatabase(dbCfg, name, {
      location: options.location,
      jurisdiction: options.jurisdiction,
      skipAppConfig: crossCloud,
    });
  } catch (e) {
    fatal(e.message);
  }

  // Cross-cloud: inject DB env vars into the app cloud's config
  if (crossCloud) {
    var appCfg = getCloudCfg(appCloud);
    var appProvider = await getProvider(appCloud, "app");
    status(`Injecting DB config into ${appCloud} app...`);

    var appConfig = await appProvider.getAppConfig(appCfg, name);
    if (!appConfig) {
      fatal(`App ${name} not found on ${appCloud}.`);
    }

    appConfig.dbId = result.dbId;
    appConfig.dbName = result.dbName;

    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    if (result.connectionUrl) {
      // CF uses DB_URL, GCP/AWS use DATABASE_URL
      var urlKey = dbCloud === "cf" ? "DB_URL" : "DATABASE_URL";
      appConfig.env[urlKey] = result.connectionUrl;
      if (!appConfig.envKeys.includes(urlKey)) appConfig.envKeys.push(urlKey);
    }

    appConfig.env["DB_TOKEN"] = "[hidden]";
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
    appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    await appProvider.pushAppConfig(appCfg, name, appConfig, {
      newSecrets: { DB_TOKEN: result.dbToken },
    });

    // Persist db cloud in .relight.yaml
    var linked = readLink();
    if (linked && !linked.db) {
      linkApp(linked.app, linked.cloud, linked.dns, dbCloud);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      name,
      dbId: result.dbId,
      dbName: result.dbName,
      dbToken: result.dbToken,
      connectionUrl: result.connectionUrl,
    }, null, 2));
    return;
  }

  success(`Database ${fmt.app(result.dbName)} created!`);
  console.log(`  ${fmt.bold("DB ID:")}     ${result.dbId}`);
  console.log(`  ${fmt.bold("DB Name:")}   ${result.dbName}`);
  if (result.connectionUrl) {
    console.log(`  ${fmt.bold("DB URL:")}    ${fmt.url(result.connectionUrl)}`);
  }
  console.log(`  ${fmt.bold("Token:")}     ${result.dbToken}`);
  if (crossCloud) {
    console.log(`  ${fmt.bold("DB Cloud:")}  ${fmt.cloud(dbCloud)}`);
  }
  hint("Next", `relight db shell ${name}`);
}

export async function dbDestroy(name, options) {
  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);

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

  phase("Destroying database");

  if (crossCloud) {
    // Read dbId from app cloud config
    var appCfg = getCloudCfg(appCloud);
    var appProvider = await getProvider(appCloud, "app");
    var appConfig = await appProvider.getAppConfig(appCfg, name);
    if (!appConfig || !appConfig.dbId) {
      fatal(`App ${name} does not have a database.`);
    }

    var dbId = appConfig.dbId;
    var dbCfg = getCloudCfg(dbCloud);
    var dbProvider = await getProvider(dbCloud, "db");

    // Destroy DB on db cloud
    try {
      await dbProvider.destroyDatabase(dbCfg, name, { dbId });
    } catch (e) {
      fatal(e.message);
    }

    // Clean up app config on app cloud
    status(`Cleaning up app config on ${appCloud}...`);
    delete appConfig.dbId;
    delete appConfig.dbName;

    if (appConfig.env) {
      delete appConfig.env["DB_URL"];
      delete appConfig.env["DB_TOKEN"];
      delete appConfig.env["DATABASE_URL"];
    }
    if (appConfig.envKeys) appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_URL" && k !== "DATABASE_URL");
    if (appConfig.secretKeys) appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");

    await appProvider.pushAppConfig(appCfg, name, appConfig);
  } else {
    var dbCfg = getCloudCfg(dbCloud);
    var dbProvider = await getProvider(dbCloud, "db");
    try {
      await dbProvider.destroyDatabase(dbCfg, name);
    } catch (e) {
      fatal(e.message);
    }
  }

  success(`Database for ${fmt.app(name)} destroyed.`);
}

// In cross-cloud mode, read dbId from app cloud config
async function getDbIdFromAppCloud(appCloud, name) {
  var appCfg = getCloudCfg(appCloud);
  var appProvider = await getProvider(appCloud, "app");
  var appConfig = await appProvider.getAppConfig(appCfg, name);
  if (!appConfig || !appConfig.dbId) {
    throw new Error(`App ${name} does not have a database.`);
  }
  return appConfig.dbId;
}

export async function dbInfo(name, options) {
  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

  var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;

  var info;
  try {
    info = await dbProvider.getDatabaseInfo(dbCfg, name, { dbId });
  } catch (e) {
    fatal(e.message);
  }

  if (options.json) {
    console.log(JSON.stringify({
      name,
      dbId: info.dbId,
      dbName: info.dbName,
      connectionUrl: info.connectionUrl,
      size: info.size,
      numTables: info.numTables,
      createdAt: info.createdAt,
    }, null, 2));
    return;
  }

  console.log("");
  console.log(`${fmt.bold("Database:")}   ${fmt.app(info.dbName)}`);
  console.log(`${fmt.bold("DB ID:")}      ${info.dbId}`);
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
  if (info.createdAt) {
    console.log(`${fmt.bold("Created:")}    ${info.createdAt}`);
  }
  console.log("");
}

export async function dbShell(name, options) {
  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

  var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;

  // Verify database exists
  try {
    await dbProvider.getDatabaseInfo(dbCfg, name, { dbId });
  } catch (e) {
    fatal(e.message);
  }

  var rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "sql> ",
  });

  process.stderr.write(`Connected to ${fmt.app(`relight-${name}`)}. Type .exit to quit.\n\n`);
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
        if (dbCloud === "gcp" || dbCloud === "aws") {
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
        if (dbCloud === "gcp" || dbCloud === "aws") {
          sql = `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'public' ORDER BY ordinal_position`;
        } else {
          sql = `SELECT sql FROM sqlite_master WHERE name='${tableName}'`;
        }
      } else {
        sql = line;
      }

      var results = await dbProvider.queryDatabase(dbCfg, name, sql, undefined, { dbId });
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

  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

  var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;

  var results;
  try {
    results = await dbProvider.queryDatabase(dbCfg, name, sql, undefined, { dbId });
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
    fatal("Usage: relight db import [name] <path>");
  }

  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

  var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;

  var sqlContent;
  try {
    sqlContent = readFileSync(filepath, "utf-8");
  } catch (e) {
    fatal(`Could not read file: ${filepath}`, e.message);
  }

  phase("Importing SQL");
  status(`File: ${filepath} (${(sqlContent.length / 1024).toFixed(1)} KB)`);

  try {
    await dbProvider.importDatabase(dbCfg, name, sqlContent, { dbId });
  } catch (e) {
    fatal(e.message);
  }

  success(`Imported ${filepath} into ${fmt.app(`relight-${name}`)}`);
}

export async function dbExport(name, options) {
  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

  var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;

  phase("Exporting database");
  status("Initiating export...");

  var dump;
  try {
    dump = await dbProvider.exportDatabase(dbCfg, name, { dbId });
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
  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

  if (options.rotate) {
    var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;

    var result;
    try {
      result = await dbProvider.rotateToken(dbCfg, name, {
        dbId,
        skipAppConfig: crossCloud,
      });
    } catch (e) {
      fatal(e.message);
    }

    // Cross-cloud: update env vars on app cloud
    if (crossCloud) {
      var appCfg = getCloudCfg(appCloud);
      var appProvider = await getProvider(appCloud, "app");
      var appConfig = await appProvider.getAppConfig(appCfg, name);

      if (!appConfig.envKeys) appConfig.envKeys = [];
      if (!appConfig.secretKeys) appConfig.secretKeys = [];
      if (!appConfig.env) appConfig.env = {};

      appConfig.env["DB_TOKEN"] = "[hidden]";
      if (!appConfig.secretKeys.includes("DB_TOKEN")) appConfig.secretKeys.push("DB_TOKEN");
      appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

      if (result.connectionUrl) {
        var urlKey = dbCloud === "cf" ? "DB_URL" : "DATABASE_URL";
        appConfig.env[urlKey] = result.connectionUrl;
        if (!appConfig.envKeys.includes(urlKey)) appConfig.envKeys.push(urlKey);
      }

      await appProvider.pushAppConfig(appCfg, name, appConfig, {
        newSecrets: { DB_TOKEN: result.dbToken },
      });
    }

    success("Token rotated.");
    console.log(`${fmt.bold("Token:")}    ${result.dbToken}`);
    if (result.connectionUrl) {
      console.log(`${fmt.bold("DB URL:")}   ${fmt.url(result.connectionUrl)}`);
    }
  } else {
    console.log(`${fmt.bold("Token:")}    ${fmt.dim("[hidden] - use --rotate to generate a new token")}`);
    // Try to show connection URL
    try {
      var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;
      var info = await dbProvider.getDatabaseInfo(dbCfg, name, { dbId });
      if (info.connectionUrl) {
        console.log(`${fmt.bold("DB URL:")}   ${fmt.url(info.connectionUrl)}`);
      }
    } catch {}
  }
}

export async function dbReset(name, options) {
  name = resolveAppName(name);
  var { appCloud, dbCloud, crossCloud } = resolveDbClouds(options);
  var dbCfg = getCloudCfg(dbCloud);
  var dbProvider = await getProvider(dbCloud, "db");

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

  var dbId = crossCloud ? await getDbIdFromAppCloud(appCloud, name) : undefined;

  phase("Resetting database");
  status("Listing tables...");

  var tables;
  try {
    tables = await dbProvider.resetDatabase(dbCfg, name, { dbId });
  } catch (e) {
    fatal(e.message);
  }

  if (tables.length === 0) {
    process.stderr.write("No user tables found.\n");
    return;
  }

  success(`Dropped ${tables.length} table${tables.length === 1 ? "" : "s"}.`);
}
