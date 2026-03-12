import { phase, status, success, fatal, hint, fmt, table } from "../lib/output.js";
import { resolveAppName, readLink, linkApp } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";
import { createInterface } from "readline";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Helpers ---

function captureToEnvRelight(secrets) {
  var envFile = ".env.relight";
  var existing = {};
  if (existsSync(envFile)) {
    for (var line of readFileSync(envFile, "utf-8").split("\n")) {
      var trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      var eq = trimmed.indexOf("=");
      if (eq !== -1) existing[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
    }
  }
  for (var [key, value] of Object.entries(secrets)) {
    existing[key] = value;
  }
  var lines = ["# .env.relight - production secrets captured by relight", "# Add to .gitignore. Do not share.", ""];
  for (var [k, v] of Object.entries(existing)) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(envFile, lines.join("\n") + "\n");

  // Auto-add to .gitignore
  var gitignore = ".gitignore";
  if (existsSync(gitignore)) {
    var content = readFileSync(gitignore, "utf-8");
    if (!content.includes(envFile)) appendFileSync(gitignore, `\n${envFile}\n`);
  } else {
    writeFileSync(gitignore, `${envFile}\n`);
  }

  status(fmt.dim(`Secrets captured to ${envFile}`));
}

function resolveDatabase(name, options) {
  if (!name) {
    var linked = readLink();
    name = linked?.app;
  }
  if (!name) fatal("No database specified.");
  return name;
}

// --- Commands ---

export async function dbCreate(name, options) {
  if (!name) fatal("Database name is required.", `Usage: relight db create <name> --db <provider>`);

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider, name: providerName } = stack.db;

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

  // Update .relight.yaml with db provider
  var linked = readLink();
  if (linked) {
    linkApp(linked.app, linked.compute, linked.dns, providerName, linked.registry);
  }

  if (options.json) {
    console.log(JSON.stringify({
      name,
      provider: providerName,
      dbId: result.dbId,
      dbName: result.dbName,
      dbToken: result.dbToken,
      connectionUrl: result.connectionUrl,
    }, null, 2));
    return;
  }

  success(`Database ${fmt.app(name)} created!`);
  console.log(`  ${fmt.bold("Provider:")}  ${providerName}`);
  console.log(`  ${fmt.bold("DB ID:")}     ${result.dbId}`);
  console.log(`  ${fmt.bold("DB Name:")}   ${result.dbName}`);
  if (result.connectionUrl) {
    console.log(`  ${fmt.bold("DB URL:")}    ${fmt.url(result.connectionUrl)}`);
  }
  console.log(`  ${fmt.bold("Token:")}     ${result.dbToken}`);
  hint("Next", `relight db attach ${name} <app>`);
}

export async function dbDestroy(name, options) {
  name = resolveDatabase(name, options);

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

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  try {
    await provider.destroyDatabase(cfg, name);
  } catch (e) {
    fatal(e.message);
  }

  success(`Database ${fmt.app(name)} destroyed.`);
}

export async function dbList(options) {
  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  if (!provider.listManagedDatabases) {
    fatal(`Provider doesn't support listing databases.`);
  }

  var databases;
  try {
    databases = await provider.listManagedDatabases(cfg);
  } catch (e) {
    fatal(e.message);
  }

  if (options.json) {
    console.log(JSON.stringify(databases, null, 2));
    return;
  }

  if (databases.length === 0) {
    console.log(fmt.dim("\n  No databases. Create one with: relight db create <name>\n"));
    return;
  }

  var cols = ["NAME", "DB NAME", "CONNECTION URL"];
  var rows = databases.map((db) => [
    db.name,
    db.dbName || "-",
    db.connectionUrl || "-",
  ]);

  console.log(table(cols, rows));
}

export async function dbAttach(name, appName, options) {
  name = resolveDatabase(name, options);
  appName = resolveAppName(appName);

  var dbStack = await resolveStack(options, ["db"]);
  var { cfg: dbCfg, provider: dbProvider, name: dbProviderName } = dbStack.db;

  var appStack = await resolveStack(options, ["app"]);
  var { cfg: appCfg, provider: appProvider } = appStack.app;

  phase("Attaching database");
  status(`${name} -> ${appName}...`);

  // Get attach credentials from provider (per-app user for isolation)
  var creds;
  try {
    creds = await dbProvider.getAttachCredentials(dbCfg, name, appName);
  } catch (e) {
    fatal(e.message);
  }

  var appConfig = await appProvider.getAppConfig(appCfg, appName);
  if (!appConfig) {
    fatal(`App ${appName} not found.`);
  }

  if (!appConfig.envKeys) appConfig.envKeys = [];
  if (!appConfig.secretKeys) appConfig.secretKeys = [];
  if (!appConfig.env) appConfig.env = {};

  // Inject env vars - DATABASE_URL as secret (contains password)
  var newSecrets = {};
  var urlKey = creds.isPostgres ? "DATABASE_URL" : "DB_URL";

  if (creds.connectionUrl) {
    appConfig.env[urlKey] = "[hidden]";
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== urlKey);
    appConfig.secretKeys.push(urlKey);
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== urlKey);
    newSecrets[urlKey] = creds.connectionUrl;
  }

  if (creds.token) {
    appConfig.env["DB_TOKEN"] = "[hidden]";
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
    appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");
    newSecrets.DB_TOKEN = creds.token;
  }

  // Set tracking env vars (non-secret)
  appConfig.env["RELIGHT_DB"] = name;
  if (!appConfig.envKeys.includes("RELIGHT_DB")) appConfig.envKeys.push("RELIGHT_DB");
  appConfig.env["RELIGHT_DB_PROVIDER"] = dbProviderName;
  if (!appConfig.envKeys.includes("RELIGHT_DB_PROVIDER")) appConfig.envKeys.push("RELIGHT_DB_PROVIDER");

  await appProvider.pushAppConfig(appCfg, appName, appConfig, {
    newSecrets: Object.keys(newSecrets).length > 0 ? newSecrets : undefined,
  });

  // Capture secrets to .env.relight if captureSecrets is enabled
  var linked = readLink();
  if (linked && linked.captureSecrets && Object.keys(newSecrets).length > 0) {
    captureToEnvRelight(newSecrets);
  }

  // Update .relight.yaml with db provider
  if (linked && linked.app === appName) {
    linkApp(linked.app, linked.compute, linked.dns, dbProviderName, linked.registry);
  }

  success(`Database ${fmt.app(name)} attached to ${fmt.app(appName)}.`);
}

// Helper to detach a database from an app
async function detachFromApp(appName, options = {}) {
  var appStack = await resolveStack(options, ["app"]);
  var { cfg: appCfg, provider: appProvider } = appStack.app;

  var appConfig = await appProvider.getAppConfig(appCfg, appName);
  if (!appConfig) return;

  // Revoke per-app database access if provider supports it
  var dbNameVal = appConfig.env?.RELIGHT_DB;
  var dbProviderVal = appConfig.env?.RELIGHT_DB_PROVIDER;
  if (dbNameVal && dbProviderVal) {
    try {
      var dbStack = await resolveStack({ db: dbProviderVal }, ["db"]);
      var { cfg: dbCfg, provider: dbProvider } = dbStack.db;
      if (dbProvider.revokeAppAccess) {
        await dbProvider.revokeAppAccess(dbCfg, dbNameVal, appName);
      }
    } catch {
      // Non-fatal - env var cleanup still proceeds
    }
  }

  // Remove DB env vars
  delete appConfig.dbId;
  delete appConfig.dbName;
  delete appConfig.dbUser;

  if (appConfig.env) {
    delete appConfig.env["DB_URL"];
    delete appConfig.env["DB_TOKEN"];
    delete appConfig.env["DATABASE_URL"];
    delete appConfig.env["RELIGHT_DB"];
    delete appConfig.env["RELIGHT_DB_PROVIDER"];
  }
  if (appConfig.envKeys) {
    appConfig.envKeys = appConfig.envKeys.filter(
      (k) => k !== "DB_URL" && k !== "DATABASE_URL" && k !== "RELIGHT_DB" && k !== "RELIGHT_DB_PROVIDER"
    );
  }
  if (appConfig.secretKeys) {
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
  }

  await appProvider.pushAppConfig(appCfg, appName, appConfig);
}

export async function dbDetach(appName, options) {
  appName = resolveAppName(appName);

  phase("Detaching database");
  status(`from ${appName}...`);

  try {
    await detachFromApp(appName, options);
  } catch (e) {
    fatal(e.message);
  }

  success(`Database detached from ${fmt.app(appName)}.`);
}

export async function dbInfo(name, options) {
  name = resolveDatabase(name, options);

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider, name: providerName } = stack.db;

  var info;
  try {
    info = await provider.getDatabaseInfo(cfg, name);
  } catch (e) {
    fatal(e.message);
  }

  if (options.json) {
    console.log(JSON.stringify({
      name,
      provider: providerName,
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
  console.log(`${fmt.bold("Database:")}   ${fmt.app(name)}`);
  console.log(`${fmt.bold("Provider:")}   ${providerName}`);
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
  if (info.createdAt) {
    console.log(`${fmt.bold("Created:")}    ${info.createdAt}`);
  }
  console.log("");
}

export async function dbShell(name, options) {
  name = resolveDatabase(name, options);

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  // Verify database exists
  try {
    await provider.getDatabaseInfo(cfg, name);
  } catch (e) {
    fatal(e.message);
  }

  var isPostgres = provider.IS_POSTGRES;

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

      var results = await provider.queryDatabase(cfg, name, sql);
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

  name = resolveDatabase(name, options);

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  var results;
  try {
    results = await provider.queryDatabase(cfg, name, sql);
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

  name = resolveDatabase(name, options);

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  var sqlContent;
  try {
    sqlContent = readFileSync(filepath, "utf-8");
  } catch (e) {
    fatal(`Could not read file: ${filepath}`, e.message);
  }

  phase("Importing SQL");
  status(`File: ${filepath} (${(sqlContent.length / 1024).toFixed(1)} KB)`);

  try {
    await provider.importDatabase(cfg, name, sqlContent);
  } catch (e) {
    fatal(e.message);
  }

  success(`Imported ${filepath} into ${fmt.app(name)}`);
}

export async function dbExport(name, options) {
  name = resolveDatabase(name, options);

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  phase("Exporting database");
  status("Initiating export...");

  var dump;
  try {
    dump = await provider.exportDatabase(cfg, name);
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
  name = resolveDatabase(name, options);

  if (options.rotate) {
    var stack = await resolveStack(options, ["db"]);
    var { cfg, provider } = stack.db;

    var result;
    try {
      result = await provider.rotateToken(cfg, name);
    } catch (e) {
      fatal(e.message);
    }

    success("Token rotated.");
    console.log(`${fmt.bold("Token:")}    ${result.dbToken}`);
    if (result.connectionUrl) {
      console.log(`${fmt.bold("DB URL:")}   ${fmt.url(result.connectionUrl)}`);
    }
  } else {
    console.log(`${fmt.bold("Token:")}    ${fmt.dim("[hidden] - use --rotate to generate a new token")}`);
  }
}

export async function dbReset(name, options) {
  name = resolveDatabase(name, options);

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

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  phase("Resetting database");
  status("Listing tables...");

  var tables;
  try {
    tables = await provider.resetDatabase(cfg, name);
  } catch (e) {
    fatal(e.message);
  }

  if (tables.length === 0) {
    process.stderr.write("No user tables found.\n");
    return;
  }

  success(`Dropped ${tables.length} table${tables.length === 1 ? "" : "s"}.`);
}

// --- Backup helpers ---

var BACKUPS_DIR = join(homedir(), ".relight", "backups");

function backupDir(dbNameStr) {
  return join(BACKUPS_DIR, dbNameStr);
}

function formatTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function parseTimestamp(backupId) {
  // 20260311T143022Z -> Date
  var m = backupId.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function formatAge(date) {
  var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  var days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  var kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  var mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function listLocalBackups(name) {
  var dir = backupDir(name);
  if (!existsSync(dir)) return [];

  var files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().reverse();
  return files.map((f) => {
    var backupId = f.replace(/\.sql$/, "");
    var filePath = join(dir, f);
    var stat = statSync(filePath);
    var ts = parseTimestamp(backupId);
    return {
      backupId,
      path: filePath,
      size: stat.size,
      timestamp: ts ? ts.toISOString() : null,
      date: ts,
    };
  });
}

// --- Backup commands ---

export async function dbBackup(name, options) {
  name = resolveDatabase(name, options);

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider, name: providerName } = stack.db;

  phase("Backing up database");
  status(`${name} (${providerName})...`);

  var dump;
  try {
    dump = await provider.exportDatabase(cfg, name);
  } catch (e) {
    fatal(e.message);
  }

  var dir = backupDir(name);
  mkdirSync(dir, { recursive: true });

  var backupId = formatTimestamp();
  var filePath = join(dir, `${backupId}.sql`);
  writeFileSync(filePath, dump);

  // Prune old backups if --keep specified
  if (options.keep) {
    var all = listLocalBackups(name);
    var toDelete = all.slice(options.keep);
    for (var b of toDelete) {
      unlinkSync(b.path);
    }
  }

  var backups = listLocalBackups(name);
  var totalSize = backups.reduce((sum, b) => sum + b.size, 0);

  if (options.json) {
    console.log(JSON.stringify({
      backupId,
      database: name,
      provider: providerName,
      size: dump.length,
      path: filePath,
      totalBackups: backups.length,
      totalSize,
    }, null, 2));
    return;
  }

  success(`Backup saved: ${fmt.bold(backupId)} (${formatSize(dump.length)})`);
  status(`Location: ${filePath}`);
  status(`Backups: ${backups.length} total (${formatSize(totalSize)})`);
}

export async function dbBackups(name, options) {
  name = resolveDatabase(name, options);

  var backups = listLocalBackups(name);

  if (options.json) {
    console.log(JSON.stringify(backups.map((b) => ({
      backupId: b.backupId,
      size: b.size,
      timestamp: b.timestamp,
    })), null, 2));
    return;
  }

  if (backups.length === 0) {
    console.log(fmt.dim(`\n  No backups for ${name}. Create one with: relight db backup ${name}\n`));
    return;
  }

  var cols = ["BACKUP ID", "SIZE", "AGE"];
  var rows = backups.map((b) => [
    b.backupId,
    formatSize(b.size),
    b.date ? formatAge(b.date) : "-",
  ]);

  console.log(table(cols, rows));
}

export async function dbRestore(name, backupId, options) {
  // Handle positional args: restore [name] [backupId]
  // If only one arg and it looks like a timestamp, treat as backupId
  if (name && /^\d{8}T\d{6}Z$/.test(name) && !backupId) {
    backupId = name;
    name = undefined;
  }

  name = resolveDatabase(name, options);

  // If no backupId, use most recent
  if (!backupId) {
    var backups = listLocalBackups(name);
    if (backups.length === 0) {
      fatal(`No backups found for ${name}.`, `Create one with: relight db backup ${name}`);
    }
    backupId = backups[0].backupId;
    status(`Using most recent backup: ${backupId}`);
  }

  var filePath = join(backupDir(name), `${backupId}.sql`);
  if (!existsSync(filePath)) {
    fatal(`Backup ${backupId} not found for ${name}.`, `Run: relight db backups ${name}`);
  }

  var sqlContent = readFileSync(filePath, "utf-8");

  // Confirm
  if (options.confirm !== name) {
    if (process.stdin.isTTY) {
      process.stderr.write(`\n  This will drop all tables in ${fmt.app(name)} and restore from ${fmt.bold(backupId)} (${formatSize(sqlContent.length)}).\n\n`);
      var rl = createInterface({ input: process.stdin, output: process.stderr });
      var answer = await new Promise((resolve) =>
        rl.question(`  Type "${name}" to confirm: `, resolve)
      );
      rl.close();
      if (answer.trim() !== name) {
        fatal("Confirmation did not match. Aborting.");
      }
    } else {
      fatal(
        `Restoring database requires confirmation.`,
        `Run: relight db restore ${name} ${backupId} --confirm ${name}`
      );
    }
  }

  var stack = await resolveStack(options, ["db"]);
  var { cfg, provider } = stack.db;

  phase("Restoring database");
  status(`${name} from ${backupId}...`);

  // Drop all tables first
  status("Dropping existing tables...");
  try {
    var tables = await provider.resetDatabase(cfg, name);
    if (tables.length > 0) {
      status(`Dropped ${tables.length} table${tables.length === 1 ? "" : "s"}.`);
    }
  } catch (e) {
    fatal(`Failed to reset database: ${e.message}`);
  }

  // Import backup
  status("Importing backup...");
  try {
    await provider.importDatabase(cfg, name, sqlContent);
  } catch (e) {
    fatal(`Failed to import backup: ${e.message}`);
  }

  success(`Database ${fmt.app(name)} restored from ${fmt.bold(backupId)}.`);
}
