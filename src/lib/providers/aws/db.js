import { randomBytes } from "crypto";
import { awsQueryApi, awsJsonApi, xmlVal, xmlList, xmlBlock } from "../../clouds/aws.js";
import { getAppConfig, pushAppConfig } from "./app.js";

function instanceName(appName) {
  return `relight-${appName}`;
}

function dbName(appName) {
  return `relight_${appName.replace(/-/g, "_")}`;
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

// --- Get DB password from App Runner env ---

async function getDbPassword(cfg, appName) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  // Find App Runner service and extract DB_TOKEN
  var nextToken = null;
  do {
    var params = {};
    if (nextToken) params.NextToken = nextToken;
    var res = await awsJsonApi("AppRunner.ListServices", params, "apprunner", cr, cfg.region);

    var svcName = `relight-${appName}`;
    var match = (res.ServiceSummaryList || []).find((s) => s.ServiceName === svcName);
    if (match) {
      var descRes = await awsJsonApi(
        "AppRunner.DescribeService",
        { ServiceArn: match.ServiceArn },
        "apprunner",
        cr,
        cfg.region
      );
      var envVars = descRes.Service?.SourceConfiguration?.ImageRepository?.ImageConfiguration?.RuntimeEnvironmentVariables || {};
      if (envVars.DB_TOKEN) return envVars.DB_TOKEN;
      throw new Error("DB_TOKEN not found on service.");
    }

    nextToken = res.NextToken;
  } while (nextToken);

  throw new Error(`Service relight-${appName} not found.`);
}

// --- Get connection URL ---

async function getConnectionUrl(cfg, appName, password) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var instName = instanceName(appName);
  var database = dbName(appName);

  var xml = await awsQueryApi(
    "DescribeDBInstances",
    { DBInstanceIdentifier: instName },
    "rds",
    cr,
    cfg.region
  );

  var endpointBlock = xmlBlock(xml, "Endpoint");
  if (!endpointBlock) throw new Error("No endpoint found for RDS instance.");

  var host = xmlVal(endpointBlock, "Address");
  var port = xmlVal(endpointBlock, "Port") || "5432";

  return `postgresql://relight:${encodeURIComponent(password)}@${host}:${port}/${database}`;
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

// --- Public API ---

export async function createDatabase(cfg, appName, opts = {}) {
  if (!opts.skipAppConfig) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig) {
      throw new Error(`App ${appName} not found.`);
    }
    if (appConfig.dbId) {
      throw new Error(`App ${appName} already has a database: ${appConfig.dbId}`);
    }
  }

  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var instName = instanceName(appName);
  var database = dbName(appName);

  // Ensure security group for public access
  var sgId = await ensureSecurityGroup(cfg);

  // Generate password
  var password = randomBytes(24).toString("base64url");

  // Create RDS instance
  await awsQueryApi(
    "CreateDBInstance",
    {
      DBInstanceIdentifier: instName,
      DBInstanceClass: "db.t4g.micro",
      Engine: "postgres",
      EngineVersion: "15",
      MasterUsername: "relight",
      MasterUserPassword: password,
      DBName: database,
      AllocatedStorage: "20",
      PubliclyAccessible: "true",
      "VpcSecurityGroupIds.member.1": sgId,
      BackupRetentionPeriod: "0",
    },
    "rds",
    cr,
    cfg.region
  );

  // Wait for instance to become available (5-15 min)
  process.stderr.write("  Waiting for RDS instance (this takes 5-15 minutes)...\n");
  await waitForInstance(cfg, instName);

  // Get connection URL
  var connectionUrl = await getConnectionUrl(cfg, appName, password);

  if (!opts.skipAppConfig) {
    // Store in app config
    appConfig.dbId = instName;
    appConfig.dbName = database;

    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    appConfig.env["DATABASE_URL"] = connectionUrl;
    if (!appConfig.envKeys.includes("DATABASE_URL")) appConfig.envKeys.push("DATABASE_URL");

    appConfig.env["DB_TOKEN"] = "[hidden]";
    appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
    appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    var newSecrets = { DB_TOKEN: password };
    await pushAppConfig(cfg, appName, appConfig, { newSecrets });
  }

  return {
    dbId: instName,
    dbName: database,
    dbToken: password,
    connectionUrl,
  };
}

export async function destroyDatabase(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }

  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  await awsQueryApi(
    "DeleteDBInstance",
    { DBInstanceIdentifier: dbId, SkipFinalSnapshot: "true" },
    "rds",
    cr,
    cfg.region
  );

  if (!opts.dbId) {
    delete appConfig.dbId;
    delete appConfig.dbName;

    if (appConfig.env) {
      delete appConfig.env["DATABASE_URL"];
      delete appConfig.env["DB_TOKEN"];
    }
    if (appConfig.envKeys) appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DATABASE_URL");
    if (appConfig.secretKeys) appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");

    await pushAppConfig(cfg, appName, appConfig);
  }
}

export async function getDatabaseInfo(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  var dbNameVal;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
    dbNameVal = appConfig.dbName;
  } else {
    dbNameVal = dbName(appName);
  }

  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var xml = await awsQueryApi(
    "DescribeDBInstances",
    { DBInstanceIdentifier: dbId },
    "rds",
    cr,
    cfg.region
  );

  var endpointBlock = xmlBlock(xml, "Endpoint");
  var host = endpointBlock ? xmlVal(endpointBlock, "Address") : null;
  var port = endpointBlock ? (xmlVal(endpointBlock, "Port") || "5432") : "5432";

  var connectionUrl = host
    ? `postgresql://relight:****@${host}:${port}/${dbNameVal}`
    : null;

  return {
    dbId,
    dbName: dbNameVal,
    connectionUrl,
    size: null,
    numTables: null,
    createdAt: xmlVal(xml, "InstanceCreateTime") || null,
  };
}

export async function queryDatabase(cfg, appName, sql, params, opts = {}) {
  if (!opts.dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
  }

  var password = await getDbPassword(cfg, appName);
  var connectionUrl = await getConnectionUrl(cfg, appName, password);
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

export async function importDatabase(cfg, appName, sqlContent, opts = {}) {
  if (!opts.dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
  }

  var password = await getDbPassword(cfg, appName);
  var connectionUrl = await getConnectionUrl(cfg, appName, password);
  var client = await connectPg(connectionUrl);

  try {
    await client.query(sqlContent);
  } finally {
    await client.end();
  }
}

export async function exportDatabase(cfg, appName, opts = {}) {
  var database;
  if (!opts.dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    database = appConfig.dbName;
  } else {
    database = dbName(appName);
  }

  var password = await getDbPassword(cfg, appName);
  var connectionUrl = await getConnectionUrl(cfg, appName, password);
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

export async function rotateToken(cfg, appName, opts = {}) {
  var dbId = opts.dbId;
  if (!dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
    dbId = appConfig.dbId;
  }

  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var newPassword = randomBytes(24).toString("base64url");

  // Update RDS master password
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

  // Get connection URL with new password
  var connectionUrl = await getConnectionUrl(cfg, appName, newPassword);

  if (!opts.skipAppConfig) {
    if (!appConfig) {
      appConfig = await getAppConfig(cfg, appName);
    }

    // Update app config
    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    appConfig.env["DB_TOKEN"] = "[hidden]";
    if (!appConfig.secretKeys.includes("DB_TOKEN")) appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    appConfig.env["DATABASE_URL"] = connectionUrl;
    if (!appConfig.envKeys.includes("DATABASE_URL")) appConfig.envKeys.push("DATABASE_URL");

    await pushAppConfig(cfg, appName, appConfig, { newSecrets: { DB_TOKEN: newPassword } });
  }

  return { dbToken: newPassword, connectionUrl };
}

export async function resetDatabase(cfg, appName, opts = {}) {
  if (!opts.dbId) {
    var appConfig = await getAppConfig(cfg, appName);
    if (!appConfig || !appConfig.dbId) {
      throw new Error(`App ${appName} does not have a database.`);
    }
  }

  var password = await getDbPassword(cfg, appName);
  var connectionUrl = await getConnectionUrl(cfg, appName, password);
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
