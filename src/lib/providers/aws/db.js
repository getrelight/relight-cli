import { randomBytes } from "crypto";
import { awsQueryApi, awsJsonApi, xmlVal, xmlList, xmlBlock } from "../../clouds/aws.js";
import { getProviderMeta, setProviderMeta } from "../../config.js";

export var IS_POSTGRES = true;

var SHARED_INSTANCE = "relight-shared";

function userName(name) {
  return `app_${name.replace(/-/g, "_")}`;
}

function appUserName(dbAppName, appName) {
  return `app_${dbAppName.replace(/-/g, "_")}_${appName.replace(/-/g, "_")}`;
}

function dbName(name) {
  return `relight_${name.replace(/-/g, "_")}`;
}

function isSharedInstance(dbId) {
  return dbId === SHARED_INSTANCE;
}

async function connectPg(connectionUrl) {
  var pg = await import("pg");
  var Client = pg.default?.Client || pg.Client;
  var client = new Client({ connectionString: connectionUrl });
  await client.connect();
  return client;
}

// --- Security group for RDS public access ---

async function ensureSecurityGroup(cfg) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var sgName = "relight-rds-public";

  // Check if security group exists
  var descXml = await awsQueryApi(
    "DescribeSecurityGroups",
    { "Filter.1.Name": "group-name", "Filter.1.Value.1": sgName },
    "ec2",
    cr,
    cfg.region
  );

  var sgBlock = xmlBlock(descXml, "securityGroupInfo");
  var existing = sgBlock ? xmlBlock(sgBlock, "item") : null;
  if (existing) {
    var sgId = xmlVal(existing, "groupId");
    if (sgId) return sgId;
  }

  // Get default VPC
  var vpcXml = await awsQueryApi(
    "DescribeVpcs",
    { "Filter.1.Name": "isDefault", "Filter.1.Value.1": "true" },
    "ec2",
    cr,
    cfg.region
  );
  var vpcId = xmlVal(vpcXml, "vpcId");
  if (!vpcId) throw new Error("No default VPC found. Create one or specify a VPC.");

  // Create security group
  var createXml = await awsQueryApi(
    "CreateSecurityGroup",
    {
      GroupName: sgName,
      GroupDescription: "Relight RDS public access on port 5432",
      VpcId: vpcId,
    },
    "ec2",
    cr,
    cfg.region
  );
  var newSgId = xmlVal(createXml, "groupId");
  if (!newSgId) throw new Error("Failed to create security group.");

  // Authorize inbound on port 5432
  await awsQueryApi(
    "AuthorizeSecurityGroupIngress",
    {
      GroupId: newSgId,
      "IpPermissions.1.IpProtocol": "tcp",
      "IpPermissions.1.FromPort": "5432",
      "IpPermissions.1.ToPort": "5432",
      "IpPermissions.1.IpRanges.1.CidrIp": "0.0.0.0/0",
    },
    "ec2",
    cr,
    cfg.region
  );

  return newSgId;
}

// --- Poll for RDS instance to become available ---

async function waitForInstance(cfg, instName) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  for (var i = 0; i < 180; i++) {
    var xml = await awsQueryApi(
      "DescribeDBInstances",
      { DBInstanceIdentifier: instName },
      "rds",
      cr,
      cfg.region
    );

    var status = xmlVal(xml, "DBInstanceStatus");
    if (status === "available") return;
    if (status === "failed" || status === "incompatible-parameters") {
      throw new Error(`RDS instance reached status: ${status}`);
    }

    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error("Timed out waiting for RDS instance to become available.");
}

// --- Get RDS endpoint ---

function getRdsEndpoint(xml) {
  var endpointBlock = xmlBlock(xml, "Endpoint");
  if (!endpointBlock) return null;
  var host = xmlVal(endpointBlock, "Address");
  var port = xmlVal(endpointBlock, "Port") || "5432";
  return { host, port };
}

// --- Shared instance management ---

async function getOrCreateSharedInstance(cfg) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var meta = getProviderMeta(cfg.providerName, "sharedDb");

  if (meta && meta.instance) {
    // Verify instance still exists
    try {
      var xml = await awsQueryApi(
        "DescribeDBInstances",
        { DBInstanceIdentifier: SHARED_INSTANCE },
        "rds",
        cr,
        cfg.region
      );
      var endpoint = getRdsEndpoint(xml);
      if (endpoint && endpoint.host !== meta.host) {
        meta.host = endpoint.host;
        meta.port = endpoint.port;
        setProviderMeta(cfg.providerName, "sharedDb", meta);
      }
      return meta;
    } catch (e) {
      // Instance gone, recreate
    }
  }

  // Create shared RDS instance
  var sgId = await ensureSecurityGroup(cfg);
  var masterPassword = randomBytes(24).toString("base64url");

  process.stderr.write("  Creating shared RDS instance (one-time, takes 5-15 minutes)...\n");
  await awsQueryApi(
    "CreateDBInstance",
    {
      DBInstanceIdentifier: SHARED_INSTANCE,
      DBInstanceClass: "db.t4g.micro",
      Engine: "postgres",
      EngineVersion: "15",
      MasterUsername: "relight_admin",
      MasterUserPassword: masterPassword,
      DBName: "postgres",
      AllocatedStorage: "20",
      PubliclyAccessible: "true",
      "VpcSecurityGroupIds.member.1": sgId,
      BackupRetentionPeriod: "0",
    },
    "rds",
    cr,
    cfg.region
  );

  await waitForInstance(cfg, SHARED_INSTANCE);

  // Get endpoint
  var xml = await awsQueryApi(
    "DescribeDBInstances",
    { DBInstanceIdentifier: SHARED_INSTANCE },
    "rds",
    cr,
    cfg.region
  );
  var endpoint = getRdsEndpoint(xml);
  if (!endpoint || !endpoint.host) throw new Error("No endpoint found for shared RDS instance.");

  meta = {
    instance: SHARED_INSTANCE,
    host: endpoint.host,
    port: endpoint.port,
    masterPassword,
  };
  setProviderMeta(cfg.providerName, "sharedDb", meta);

  return meta;
}

async function connectAsAdmin(cfg) {
  var meta = getProviderMeta(cfg.providerName, "sharedDb");
  if (!meta || !meta.masterPassword) {
    throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
  }
  var url = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/postgres`;
  var client = await connectPg(url);
  return { client, meta };
}

function buildConnectionUrl(user, password, meta, database) {
  return `postgresql://${user}:${encodeURIComponent(password)}@${meta.host}:${meta.port}/${database}`;
}

async function destroySharedInstanceIfEmpty(cfg) {
  var { client } = await connectAsAdmin(cfg);
  try {
    var res = await client.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'relight_%'"
    );
    if (res.rows.length > 0) return false;
  } finally {
    await client.end();
  }

  // No relight databases remain - destroy the shared instance
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  await awsQueryApi(
    "DeleteDBInstance",
    { DBInstanceIdentifier: SHARED_INSTANCE, SkipFinalSnapshot: "true" },
    "rds",
    cr,
    cfg.region
  );
  setProviderMeta(cfg.providerName, "sharedDb", undefined);
  return true;
}

// --- Public API ---

export async function createDatabase(cfg, name, opts = {}) {
  var meta = await getOrCreateSharedInstance(cfg);
  var database = dbName(name);
  var user = userName(name);
  var password = randomBytes(24).toString("base64url");

  // Connect as admin to create database and user
  var adminUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/postgres`;
  var client = await connectPg(adminUrl);
  try {
    await client.query(`CREATE USER ${user} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    await client.query(`CREATE DATABASE ${database} OWNER ${user}`);
  } finally {
    await client.end();
  }

  var connectionUrl = buildConnectionUrl(user, password, meta, database);

  return {
    dbId: SHARED_INSTANCE,
    dbName: database,
    dbUser: user,
    dbToken: password,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, name, opts = {}) {
  var dbId = opts.dbId || SHARED_INSTANCE;

  // Legacy per-app instance: delete the whole instance
  if (!isSharedInstance(dbId)) {
    var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
    await awsQueryApi(
      "DeleteDBInstance",
      { DBInstanceIdentifier: dbId, SkipFinalSnapshot: "true" },
      "rds",
      cr,
      cfg.region
    );
    return;
  }

  // Shared instance: drop database, owner user, and all per-app users
  var database = dbName(name);
  var user = userName(name);
  var appUserPrefix = `app_${name.replace(/-/g, "_")}_`;

  var { client } = await connectAsAdmin(cfg);
  try {
    // Terminate active connections to the database
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`
    );
    await client.query(`DROP DATABASE IF EXISTS ${database}`);

    // Drop all per-app users (app_<dbName>_<appName>)
    var rolesRes = await client.query(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE $1", [appUserPrefix + "%"]
    );
    for (var row of rolesRes.rows) {
      await client.query(`DROP USER IF EXISTS ${row.rolname}`);
    }

    // Drop the owner user
    await client.query(`DROP USER IF EXISTS ${user}`);
  } finally {
    await client.end();
  }

  // Check if shared instance should be destroyed
  await destroySharedInstanceIfEmpty(cfg);
}

export async function getDatabaseInfo(cfg, name, opts = {}) {
  var dbId = opts.dbId || SHARED_INSTANCE;

  var database = dbName(name);
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var xml = await awsQueryApi(
    "DescribeDBInstances",
    { DBInstanceIdentifier: dbId },
    "rds",
    cr,
    cfg.region
  );

  var endpoint = getRdsEndpoint(xml);
  var displayUser = isSharedInstance(dbId) ? userName(name) : "relight";

  var connectionUrl = endpoint
    ? `postgresql://${displayUser}:****@${endpoint.host}:${endpoint.port}/${database}`
    : null;

  return {
    dbId,
    dbName: database,
    connectionUrl,
    size: null,
    numTables: null,
    createdAt: xmlVal(xml, "InstanceCreateTime") || null,
  };
}

export async function queryDatabase(cfg, name, sql, params, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    // Build admin connection to the app's database
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}`;
  }

  var client = await connectPg(connectionUrl);

  try {
    var result = await client.query(sql, params || []);
    return {
      results: result.rows,
      meta: { changes: result.rowCount, rows_read: result.rows.length },
    };
  } finally {
    await client.end();
  }
}

export async function importDatabase(cfg, name, sqlContent, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}`;
  }

  var client = await connectPg(connectionUrl);

  try {
    await client.query(sqlContent);
  } finally {
    await client.end();
  }
}

export async function exportDatabase(cfg, name, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}`;
  }

  var database = dbName(name);
  var client = await connectPg(connectionUrl);

  try {
    var tablesRes = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    var tables = tablesRes.rows.map((r) => r.tablename);

    var dump = [];
    dump.push("-- PostgreSQL dump generated by relight");
    dump.push(`-- Database: ${database}`);
    dump.push(`-- Date: ${new Date().toISOString()}`);
    dump.push("");

    for (var t of tables) {
      var colsRes = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`,
        [t]
      );

      var cols = colsRes.rows.map((c) => {
        var def = `  "${c.column_name}" ${c.data_type}`;
        if (c.column_default) def += ` DEFAULT ${c.column_default}`;
        if (c.is_nullable === "NO") def += " NOT NULL";
        return def;
      });

      dump.push(`CREATE TABLE IF NOT EXISTS "${t}" (`);
      dump.push(cols.join(",\n"));
      dump.push(");");
      dump.push("");

      var dataRes = await client.query(`SELECT * FROM "${t}"`);
      for (var row of dataRes.rows) {
        var values = Object.values(row).map((v) => {
          if (v === null) return "NULL";
          if (typeof v === "number") return String(v);
          if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
          return "'" + String(v).replace(/'/g, "''") + "'";
        });
        var colNames = Object.keys(row).map((c) => `"${c}"`).join(", ");
        dump.push(`INSERT INTO "${t}" (${colNames}) VALUES (${values.join(", ")});`);
      }
      dump.push("");
    }

    return dump.join("\n");
  } finally {
    await client.end();
  }
}

export async function rotateToken(cfg, name, opts = {}) {
  var dbId = opts.dbId || SHARED_INSTANCE;

  var newPassword = randomBytes(24).toString("base64url");
  var connectionUrl;
  var database = dbName(name);

  if (isSharedInstance(dbId)) {
    // Update via admin connection
    var user = userName(name);
    var { client, meta } = await connectAsAdmin(cfg);
    try {
      await client.query(`ALTER USER ${user} WITH PASSWORD '${newPassword.replace(/'/g, "''")}'`);
    } finally {
      await client.end();
    }
    connectionUrl = buildConnectionUrl(user, newPassword, meta, database);
  } else {
    // Legacy: update RDS master password
    var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
    await awsQueryApi(
      "ModifyDBInstance",
      {
        DBInstanceIdentifier: dbId,
        MasterUserPassword: newPassword,
      },
      "rds",
      cr,
      cfg.region
    );

    var xml = await awsQueryApi(
      "DescribeDBInstances",
      { DBInstanceIdentifier: dbId },
      "rds",
      cr,
      cfg.region
    );
    var endpoint = getRdsEndpoint(xml);
    connectionUrl = endpoint
      ? `postgresql://relight:${encodeURIComponent(newPassword)}@${endpoint.host}:${endpoint.port}/${database}`
      : null;
  }

  return { dbToken: newPassword, connectionUrl };
}

export async function resetDatabase(cfg, name, opts = {}) {
  var connectionUrl = opts.connectionUrl;
  if (!connectionUrl) {
    var meta = getProviderMeta(cfg.providerName, "sharedDb");
    if (!meta || !meta.masterPassword) {
      throw new Error("Shared DB master credentials not found. Run `relight db create` first.");
    }
    var database = dbName(name);
    connectionUrl = `postgresql://relight_admin:${encodeURIComponent(meta.masterPassword)}@${meta.host}:${meta.port}/${database}`;
  }

  var client = await connectPg(connectionUrl);

  try {
    var tablesRes = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    var tables = tablesRes.rows.map((r) => r.tablename);

    for (var t of tables) {
      await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }

    return tables;
  } finally {
    await client.end();
  }
}

// --- Stateless API ---

export async function listManagedDatabases(cfg) {
  var { client, meta } = await connectAsAdmin(cfg);
  try {
    var res = await client.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'relight_%' ORDER BY datname"
    );
    return res.rows.map((r) => ({
      name: r.datname.replace(/^relight_/, "").replace(/_/g, "-"),
      dbName: r.datname,
      dbId: SHARED_INSTANCE,
      connectionUrl: `postgresql://${userName(r.datname.replace(/^relight_/, ""))}:****@${meta.host}:${meta.port}/${r.datname}`,
    }));
  } finally {
    await client.end();
  }
}

export async function getAttachCredentials(cfg, dbAppName, appName) {
  var { client, meta } = await connectAsAdmin(cfg);
  var database = dbName(dbAppName);
  var user = appUserName(dbAppName, appName);
  var password = randomBytes(24).toString("base64url");

  try {
    // Create per-app user (or reset password if exists)
    var exists = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1", [user]
    );
    if (exists.rows.length > 0) {
      await client.query(`ALTER USER ${user} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    } else {
      await client.query(`CREATE USER ${user} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    }

    // Grant access to the database and its objects
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
  } finally {
    await client.end();
  }

  // Grant schema-level privileges (must connect to the target database)
  var dbUrl = buildConnectionUrl("relight_admin", meta.masterPassword, meta, database);
  var dbClient = await connectPg(dbUrl);
  try {
    await dbClient.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
    await dbClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${user}`);
    await dbClient.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO ${user}`);
  } finally {
    await dbClient.end();
  }

  var connectionUrl = buildConnectionUrl(user, password, meta, database);
  return { connectionUrl, token: password, isPostgres: true };
}

export async function revokeAppAccess(cfg, dbAppName, appName) {
  var { client, meta } = await connectAsAdmin(cfg);
  var database = dbName(dbAppName);
  var user = appUserName(dbAppName, appName);

  try {
    // Check if user exists
    var exists = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1", [user]
    );
    if (exists.rows.length === 0) return;

    // Revoke and drop
    await client.query(`REVOKE CONNECT ON DATABASE ${database} FROM ${user}`);
  } finally {
    await client.end();
  }

  // Revoke schema-level privileges (must connect to target database)
  var dbUrl = buildConnectionUrl("relight_admin", meta.masterPassword, meta, database);
  var dbClient = await connectPg(dbUrl);
  try {
    await dbClient.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${user}`);
    await dbClient.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${user}`);
    await dbClient.query(`REVOKE USAGE ON SCHEMA public FROM ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${user}`);
    await dbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${user}`);
  } finally {
    await dbClient.end();
  }

  // Drop user (reconnect to postgres db)
  var adminClient = await connectPg(
    buildConnectionUrl("relight_admin", meta.masterPassword, meta, "postgres")
  );
  try {
    await adminClient.query(`DROP USER IF EXISTS ${user}`);
  } finally {
    await adminClient.end();
  }
}
