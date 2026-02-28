import { awsJsonApi, ensureEcrAccessRole } from "../../clouds/aws.js";

// --- Internal helpers ---

async function findService(cfg, appName) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var svcName = `relight-${appName}`;
  var nextToken = null;

  do {
    var params = {};
    if (nextToken) params.NextToken = nextToken;
    var res = await awsJsonApi("AppRunner.ListServices", params, "apprunner", cr, cfg.region);

    var match = (res.ServiceSummaryList || []).find((s) => s.ServiceName === svcName);
    if (match) return match;

    nextToken = res.NextToken;
  } while (nextToken);

  return null;
}

async function describeService(cfg, serviceArn) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var res = await awsJsonApi(
    "AppRunner.DescribeService",
    { ServiceArn: serviceArn },
    "apprunner",
    cr,
    cfg.region
  );
  return res.Service;
}

async function waitForService(cfg, serviceArn) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  for (var i = 0; i < 120; i++) {
    var res = await awsJsonApi(
      "AppRunner.DescribeService",
      { ServiceArn: serviceArn },
      "apprunner",
      cr,
      cfg.region
    );
    var status = res.Service?.Status;
    if (status === "RUNNING") return res.Service;
    if (status === "CREATE_FAILED" || status === "DELETE_FAILED" || status === "DELETED") {
      throw new Error(`Service reached status: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out waiting for service to reach RUNNING status.");
}

function buildEnvVars(appConfig, newSecrets) {
  var envVars = {};

  // Master config (without env values)
  var configCopy = Object.assign({}, appConfig);
  delete configCopy.env;
  envVars.RELIGHT_APP_CONFIG = JSON.stringify(configCopy);

  // Individual env vars
  for (var key of (appConfig.envKeys || [])) {
    if (appConfig.env && appConfig.env[key] !== undefined && appConfig.env[key] !== "[hidden]") {
      envVars[key] = String(appConfig.env[key]);
    }
  }

  // Secret keys as plain env vars
  for (var key of (appConfig.secretKeys || [])) {
    if (newSecrets && newSecrets[key] !== undefined) {
      envVars[key] = String(newSecrets[key]);
    }
  }

  return envVars;
}

function buildServiceInput(appConfig, imageTag, newSecrets, opts) {
  var envVars = buildEnvVars(appConfig, newSecrets);
  var port = String(appConfig.port || 8080);
  var vcpu = appConfig.vcpu || "1";
  var memory = appConfig.memory ? `${appConfig.memory} MB` : "2048 MB";

  var input = {
    SourceConfiguration: {
      ImageRepository: {
        ImageIdentifier: imageTag || appConfig.image,
        ImageRepositoryType: "ECR",
        ImageConfiguration: {
          Port: port,
          RuntimeEnvironmentVariables: envVars,
        },
      },
      AutoDeploymentsEnabled: false,
    },
    InstanceConfiguration: {
      Cpu: String(vcpu) + " vCPU",
      Memory: memory,
    },
    HealthCheckConfiguration: {
      Protocol: "TCP",
      Path: "/",
      Interval: 10,
      Timeout: 5,
      HealthyThreshold: 1,
      UnhealthyThreshold: 5,
    },
  };

  if (opts?.accessRoleArn) {
    input.SourceConfiguration.AuthenticationConfiguration = {
      AccessRoleArn: opts.accessRoleArn,
    };
  }

  return input;
}

// --- App config ---

export async function getAppConfig(cfg, appName) {
  var svc = await findService(cfg, appName);
  if (!svc) return null;

  var full = await describeService(cfg, svc.ServiceArn);
  var envVars = full.SourceConfiguration?.ImageRepository?.ImageConfiguration?.RuntimeEnvironmentVariables || {};

  var configStr = envVars.RELIGHT_APP_CONFIG;
  if (!configStr) return null;

  var appConfig = JSON.parse(configStr);

  // Reconstruct env from individual env vars
  if (!appConfig.env) appConfig.env = {};
  for (var key of (appConfig.envKeys || [])) {
    if (envVars[key] !== undefined) appConfig.env[key] = envVars[key];
  }
  for (var key of (appConfig.secretKeys || [])) {
    if (envVars[key] !== undefined) appConfig.env[key] = "[hidden]";
  }

  return appConfig;
}

export async function pushAppConfig(cfg, appName, appConfig, opts) {
  var newSecrets = opts?.newSecrets || {};
  var svc = await findService(cfg, appName);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);

  // Carry forward existing secret values from the live service
  var full = await describeService(cfg, svc.ServiceArn);
  var liveEnvVars = full.SourceConfiguration?.ImageRepository?.ImageConfiguration?.RuntimeEnvironmentVariables || {};
  for (var key of (appConfig.secretKeys || [])) {
    if (!newSecrets[key] && liveEnvVars[key]) {
      newSecrets[key] = liveEnvVars[key];
    }
  }

  var envVars = buildEnvVars(appConfig, newSecrets);
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  var vcpu = appConfig.vcpu || "1";
  var memory = appConfig.memory ? `${appConfig.memory} MB` : "2048 MB";

  await awsJsonApi("AppRunner.UpdateService", {
    ServiceArn: svc.ServiceArn,
    SourceConfiguration: {
      ImageRepository: {
        ImageIdentifier: appConfig.image,
        ImageRepositoryType: "ECR",
        ImageConfiguration: {
          Port: String(appConfig.port || 8080),
          RuntimeEnvironmentVariables: envVars,
        },
      },
      AutoDeploymentsEnabled: false,
      AuthenticationConfiguration: full.SourceConfiguration?.AuthenticationConfiguration || undefined,
    },
    InstanceConfiguration: {
      Cpu: String(vcpu) + " vCPU",
      Memory: memory,
    },
  }, "apprunner", cr, cfg.region);

  await waitForService(cfg, svc.ServiceArn);
}

// --- Deploy ---

export async function deploy(cfg, appName, imageTag, opts) {
  var appConfig = opts.appConfig;
  var isFirstDeploy = opts.isFirstDeploy;
  var newSecrets = opts.newSecrets || {};
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  if (isFirstDeploy) {
    // Ensure IAM role for ECR access
    var accessRoleArn = await ensureEcrAccessRole(cr, cfg.region);

    var input = buildServiceInput(appConfig, imageTag, newSecrets, { accessRoleArn });
    input.ServiceName = `relight-${appName}`;
    input.Tags = [
      { Key: "managed-by", Value: "relight" },
      { Key: "relight-app", Value: appName },
    ];

    var res = await awsJsonApi("AppRunner.CreateService", input, "apprunner", cr, cfg.region);
    await waitForService(cfg, res.Service.ServiceArn);
  } else {
    var svc = await findService(cfg, appName);
    if (!svc) throw new Error(`Service relight-${appName} not found.`);

    // Carry forward existing secret values
    var full = await describeService(cfg, svc.ServiceArn);
    var liveEnvVars = full.SourceConfiguration?.ImageRepository?.ImageConfiguration?.RuntimeEnvironmentVariables || {};
    for (var key of (appConfig.secretKeys || [])) {
      if (!newSecrets[key] && liveEnvVars[key]) {
        newSecrets[key] = liveEnvVars[key];
      }
    }

    var envVars = buildEnvVars(appConfig, newSecrets);

    await awsJsonApi("AppRunner.UpdateService", {
      ServiceArn: svc.ServiceArn,
      SourceConfiguration: {
        ImageRepository: {
          ImageIdentifier: imageTag,
          ImageRepositoryType: "ECR",
          ImageConfiguration: {
            Port: String(appConfig.port || 8080),
            RuntimeEnvironmentVariables: envVars,
          },
        },
        AutoDeploymentsEnabled: false,
        AuthenticationConfiguration: full.SourceConfiguration?.AuthenticationConfiguration || undefined,
      },
      InstanceConfiguration: {
        Cpu: String(appConfig.vcpu || "1") + " vCPU",
        Memory: appConfig.memory ? `${appConfig.memory} MB` : "2048 MB",
      },
    }, "apprunner", cr, cfg.region);

    await waitForService(cfg, svc.ServiceArn);
  }
}

// --- List apps ---

export async function listApps(cfg) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var apps = [];
  var nextToken = null;

  do {
    var params = {};
    if (nextToken) params.NextToken = nextToken;
    var res = await awsJsonApi("AppRunner.ListServices", params, "apprunner", cr, cfg.region);

    for (var svc of (res.ServiceSummaryList || [])) {
      if (svc.ServiceName.startsWith("relight-")) {
        apps.push({
          name: svc.ServiceName.replace("relight-", ""),
          modified: svc.UpdatedAt || null,
        });
      }
    }

    nextToken = res.NextToken;
  } while (nextToken);

  return apps;
}

// --- Get app info ---

export async function getAppInfo(cfg, appName) {
  var svc = await findService(cfg, appName);
  if (!svc) return null;

  var appConfig = await getAppConfig(cfg, appName);
  var full = await describeService(cfg, svc.ServiceArn);
  var url = full.ServiceUrl ? `https://${full.ServiceUrl}` : null;

  return { appConfig, url };
}

// --- Destroy ---

export async function destroyApp(cfg, appName) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  // Delete RDS instance if attached
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig?.dbId) {
    try {
      var { awsQueryApi } = await import("../../clouds/aws.js");
      await awsQueryApi(
        "DeleteDBInstance",
        { DBInstanceIdentifier: appConfig.dbId, SkipFinalSnapshot: "true" },
        "rds",
        cr,
        cfg.region
      );
    } catch {}
  }

  var svc = await findService(cfg, appName);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);

  await awsJsonApi("AppRunner.DeleteService", {
    ServiceArn: svc.ServiceArn,
  }, "apprunner", cr, cfg.region);
}

// --- Scale ---

export async function scale(cfg, appName, opts) {
  var appConfig = opts.appConfig;
  await pushAppConfig(cfg, appName, appConfig);
}

// --- Container status ---

export async function getContainerStatus(cfg, appName) {
  var svc = await findService(cfg, appName);
  if (!svc) return [];

  var full = await describeService(cfg, svc.ServiceArn);
  return [
    {
      dimensions: { region: cfg.region, status: full.Status },
      avg: { cpuLoad: 0, memory: 0 },
    },
  ];
}

// --- App URL ---

export async function getAppUrl(cfg, appName) {
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig?.domains?.length > 0) {
    return `https://${appConfig.domains[0]}`;
  }

  var svc = await findService(cfg, appName);
  if (!svc) return null;

  var full = await describeService(cfg, svc.ServiceArn);
  return full.ServiceUrl ? `https://${full.ServiceUrl}` : null;
}

// --- Log streaming ---

export async function streamLogs(cfg, appName) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var svc = await findService(cfg, appName);
  if (!svc) throw new Error(`Service relight-${appName} not found.`);

  // Extract serviceId from ARN: arn:aws:apprunner:{region}:{account}:service/{name}/{id}
  var arnParts = svc.ServiceArn.split("/");
  var serviceId = arnParts[arnParts.length - 1];
  var serviceName = `relight-${appName}`;
  var logGroup = `/aws/apprunner/${serviceName}/${serviceId}/application`;

  var lastEventTime = Date.now() - 60000;
  var running = true;

  var interval = setInterval(async () => {
    if (!running) return;
    try {
      var res = await awsJsonApi(
        "Logs_20140328.FilterLogEvents",
        {
          logGroupName: logGroup,
          startTime: lastEventTime,
          interleaved: true,
          limit: 100,
        },
        "logs",
        cr,
        cfg.region
      );

      for (var event of (res.events || [])) {
        var ts = new Date(event.timestamp).toISOString();
        console.log(`${ts}  ${event.message}`);
        if (event.timestamp > lastEventTime) {
          lastEventTime = event.timestamp + 1;
        }
      }
    } catch {}
  }, 3000);

  return {
    url: null,
    id: null,
    cleanup: async () => {
      running = false;
      clearInterval(interval);
    },
  };
}

// --- Cost analytics ---

export async function getCosts(cfg, appNames, dateRange) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  // Discover apps
  var apps;
  if (appNames) {
    apps = [];
    for (var n of appNames) {
      var svc = await findService(cfg, n);
      if (svc) apps.push({ name: n, serviceArn: svc.ServiceArn });
    }
  } else {
    var listed = await listApps(cfg);
    apps = [];
    for (var a of listed) {
      var svc = await findService(cfg, a.name);
      if (svc) apps.push({ name: a.name, serviceArn: svc.ServiceArn });
    }
  }

  var { sinceISO, untilISO, sinceDate, untilDate } = dateRange;
  var hours = (untilDate - sinceDate) / (1000 * 60 * 60);

  var results = [];
  for (var app of apps) {
    var full = await describeService(cfg, app.serviceArn);
    var instanceCfg = full.InstanceConfiguration || {};

    // Parse vCPU count from "1 vCPU" or "0.25 vCPU"
    var vcpuStr = instanceCfg.Cpu || "1 vCPU";
    var vcpu = parseFloat(vcpuStr);

    // Parse memory from "2048 MB" or "3 GB"
    var memStr = instanceCfg.Memory || "2048 MB";
    var memGb = memStr.includes("GB") ? parseFloat(memStr) : parseFloat(memStr) / 1024;

    // App Runner minimum 1 provisioned instance
    var activeVcpuHrs = 0; // No real metrics - estimate as 0 active
    var provisionedVcpuHrs = vcpu * hours;
    var memGbHrs = memGb * hours;

    results.push({
      name: app.name,
      usage: {
        activeVcpuHrs,
        provisionedVcpuHrs,
        memGbHrs,
        vcpu,
        memGb,
        hours,
      },
    });
  }

  return results;
}

// --- Regions ---

export function getRegions() {
  return [
    { code: "us-east-1", name: "N. Virginia", location: "US East (N. Virginia)" },
    { code: "us-east-2", name: "Ohio", location: "US East (Ohio)" },
    { code: "us-west-2", name: "Oregon", location: "US West (Oregon)" },
    { code: "eu-west-1", name: "Ireland", location: "Europe (Ireland)" },
    { code: "eu-central-1", name: "Frankfurt", location: "Europe (Frankfurt)" },
    { code: "ap-southeast-1", name: "Singapore", location: "Asia Pacific (Singapore)" },
    { code: "ap-southeast-2", name: "Sydney", location: "Asia Pacific (Sydney)" },
    { code: "ap-northeast-1", name: "Tokyo", location: "Asia Pacific (Tokyo)" },
    { code: "ap-south-1", name: "Mumbai", location: "Asia Pacific (Mumbai)" },
  ];
}
