import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { phase, status, success, hint, fatal, fmt, generateAppName } from "../lib/output.js";
import { readLink, linkApp, resolveAppName } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";
import { PROVIDERS } from "../lib/config.js";
import { dockerBuild, dockerTag, dockerPush, dockerLogin } from "../lib/docker.js";
import { getPortal, portalApi } from "../lib/portal.js";

function buildGatewayMeta(options, linked, prepGatewayConfig) {
  // Priority: --gateway flag > .relight.yaml > portal prepare response
  var isGateway = options.gateway || linked?.gateway;

  if (!isGateway && prepGatewayConfig?.enabled) {
    // Use portal's stored gateway config (no --gateway flag needed on redeploy)
    return {
      hostname: prepGatewayConfig.hostname,
      path_prefix: prepGatewayConfig.path_prefix || "/",
      groups: prepGatewayConfig.groups || [],
      match_mode: prepGatewayConfig.match_mode || "any",
    };
  }

  if (!isGateway) return null;
  var hostname = options.hostname || linked?.gateway?.hostname || null;
  var groups = options.groups
    ? options.groups.split(",").map((g) => g.trim()).filter(Boolean)
    : linked?.gateway?.groups || [];
  return {
    hostname,
    path_prefix: options.pathPrefix || linked?.gateway?.path_prefix || "/",
    groups,
    match_mode: options.matchMode || linked?.gateway?.match_mode || "any",
  };
}

function resolveDeployTarget(nameOrPath, path, mode) {
  var name;
  var dockerPath;
  if (!nameOrPath) {
    name = readLink()?.app || (mode === "portal" ? null : generateAppName());
    if (!name && mode === "portal") {
      fatal("App name required for portal deploy.", `Usage: ${fmt.cmd("relight deploy my-app")}`);
    }
    dockerPath = ".";
  } else if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/") || nameOrPath.startsWith("~")) {
    name = readLink()?.app || (mode === "portal" ? null : generateAppName());
    if (!name && mode === "portal") {
      fatal("App name required. Link this directory first or provide a name.");
    }
    dockerPath = nameOrPath;
  } else {
    name = nameOrPath;
    dockerPath = path || ".";
  }
  return { name, dockerPath };
}

function buildEnvConfig(options) {
  var env = {};
  var envKeys = [];
  if (options.env) {
    for (var v of options.env) {
      var eq = v.indexOf("=");
      if (eq !== -1) {
        var k = v.substring(0, eq);
        env[k] = v.substring(eq + 1);
        envKeys.push(k);
      }
    }
  }
  return { env, envKeys };
}

export async function deploy(nameOrPath, path, options) {
  // --- Portal mode: delegate to portal for credentials & deploy ---
  var portal = getPortal();
  if (portal) {
    return deployViaPortal(nameOrPath, path, options);
  }

  var stack = await resolveStack(options);
  var { cfg, provider: appProvider, name: providerName, type: providerType } = stack.app;

  // Smart arg parsing: if first arg looks like a path, shift args
  var name;
  var dockerPath;
  if (!nameOrPath) {
    name = readLink()?.app || generateAppName();
    dockerPath = ".";
  } else if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/") || nameOrPath.startsWith("~")) {
    name = readLink()?.app || generateAppName();
    dockerPath = nameOrPath;
  } else {
    name = nameOrPath;
    dockerPath = path || ".";
  }

  var tag = options.tag || `${Date.now()}`;
  var hasRegistry = PROVIDERS[providerType].layers.includes("registry");

  // Get registry credentials and image tag (only for providers with registry)
  var registry, registryName, registryCfg, registryCreds, remoteTag;
  var localTag = `relight-${name}:${tag}`;

  if (hasRegistry) {
    var registryStack = await resolveStack(options, ["registry"]);
    registryName = registryStack.registry.name;
    registryCfg = registryStack.registry.cfg;
    registry = registryStack.registry.provider;
    remoteTag = await registry.getImageTag(registryCfg, name, tag);
  }

  // Load existing config from deployed worker (null on first deploy)
  var appConfig;
  try {
    appConfig = await appProvider.getAppConfig(cfg, name);
  } catch {
    appConfig = null;
  }

  var isFirstDeploy = !appConfig;

  // Get valid regions for this provider
  var validRegions = appProvider.getRegions();
  var validCodes = validRegions.map((r) => r.code);

  if (appConfig) {
    // Existing app - update image, merge any flags
    appConfig.image = hasRegistry ? remoteTag : localTag;
    appConfig.deployedAt = new Date().toISOString();

    if (options.env) {
      if (!appConfig.envKeys) appConfig.envKeys = [];
      if (!appConfig.secretKeys) appConfig.secretKeys = [];
      if (!appConfig.env) appConfig.env = {};
      for (var v of options.env) {
        var eq = v.indexOf("=");
        if (eq !== -1) {
          var k = v.substring(0, eq);
          appConfig.env[k] = v.substring(eq + 1);
          appConfig.secretKeys = appConfig.secretKeys.filter((s) => s !== k);
          if (!appConfig.envKeys.includes(k)) appConfig.envKeys.push(k);
        }
      }
    }
    if (options.regions)
      appConfig.regions = options.regions.split(",").map((r) => r.trim());
    if (options.instances) appConfig.instances = options.instances;
    if (options.port) appConfig.port = options.port;
    if (options.sleep) appConfig.sleepAfter = options.sleep;
    if (options.instanceType) appConfig.instanceType = options.instanceType;
    if (options.vcpu) appConfig.vcpu = options.vcpu;
    if (options.memory) appConfig.memory = options.memory;
    if (options.disk) appConfig.disk = options.disk;
    if (options.observability === false) appConfig.observability = false;
  } else {
    // First deploy - build config from flags + defaults
    var env = {};
    var envKeys = [];
    if (options.env) {
      for (var v of options.env) {
        var eq = v.indexOf("=");
        if (eq !== -1) {
          var k = v.substring(0, eq);
          env[k] = v.substring(eq + 1);
          envKeys.push(k);
        }
      }
    }

    var noRegistry = !hasRegistry;
    var defaultRegion = noRegistry ? "self-hosted" : providerType === "gcp" ? "us-central1" : providerType === "aws" ? "us-east-1" : providerType === "azure" ? "eastus" : "enam";
    var regions;

    if (options.regions) {
      regions = options.regions.split(",").map((r) => r.trim());
    } else if (!noRegistry && (providerType === "gcp" || providerType === "aws" || providerType === "azure") && process.stdin.isTTY) {
      // Interactive region picker for GCP/AWS/Azure first deploy
      var { createInterface: createRL } = await import("readline");
      var rl = createRL({ input: process.stdin, output: process.stderr });
      process.stderr.write(`\n${fmt.bold("Select a region:")}\n\n`);
      for (var i = 0; i < validRegions.length; i++) {
        process.stderr.write(
          `  ${fmt.bold(`[${i + 1}]`)} ${validRegions[i].code} ${fmt.dim(`(${validRegions[i].name})`)}\n`
        );
      }
      process.stderr.write("\n");
      var choice = await new Promise((resolve) =>
        rl.question(`Region [1-${validRegions.length}] (default: 1): `, resolve)
      );
      rl.close();
      var idx = choice.trim() ? parseInt(choice, 10) - 1 : 0;
      if (isNaN(idx) || idx < 0 || idx >= validRegions.length) {
        fatal("Invalid region selection.");
      }
      regions = [validRegions[idx].code];
    } else {
      regions = [defaultRegion];
    }

    for (var r of regions) {
      if (!validCodes.includes(r)) {
        fatal(
          `Invalid region '${r}'.`,
          `Valid regions: ${validCodes.join(", ")}`
        );
      }
    }

    appConfig = {
      name,
      regions,
      instances: options.instances || (noRegistry ? 1 : 2),
      port: options.port || 8080,
      sleepAfter: options.sleep || "30s",
      instanceType: options.instanceType || (noRegistry || providerType === "gcp" || providerType === "aws" || providerType === "azure" ? undefined : "lite"),
      vcpu: options.vcpu || undefined,
      memory: options.memory || undefined,
      disk: options.disk || undefined,
      env,
      envKeys,
      secretKeys: [],
      domains: [],
      image: hasRegistry ? remoteTag : localTag,
      createdAt: new Date().toISOString(),
      deployedAt: new Date().toISOString(),
    };
  }

  var newSecrets = {};

  // --- Summary & confirmation ---
  var instanceDesc = appConfig.vcpu
    ? `${appConfig.vcpu} vCPU, ${appConfig.memory || "default"} MiB`
    : appConfig.instanceType || "lite";

  process.stderr.write(`\n${fmt.bold("Deploy summary")}\n`);
  process.stderr.write(`${fmt.dim("-".repeat(40))}\n`);
  process.stderr.write(`  ${fmt.bold("App:")}        ${fmt.app(name)}${isFirstDeploy ? fmt.dim(" (new)") : ""}\n`);
  process.stderr.write(`  ${fmt.bold("Provider:")}   ${fmt.cloud(providerName)} ${fmt.dim(`(${PROVIDERS[providerType].name})`)}\n`);
  process.stderr.write(`  ${fmt.bold("Path:")}       ${dockerPath}\n`);
  process.stderr.write(`  ${fmt.bold("Image:")}      ${hasRegistry ? remoteTag : localTag}\n`);
  process.stderr.write(`  ${fmt.bold("Regions:")}    ${appConfig.regions.join(", ")}\n`);
  process.stderr.write(`  ${fmt.bold("Instances:")}  ${appConfig.instances || 2} per region\n`);
  process.stderr.write(`  ${fmt.bold("Type:")}       ${instanceDesc}\n`);
  process.stderr.write(`  ${fmt.bold("Port:")}       ${appConfig.port || 8080}\n`);
  process.stderr.write(`  ${fmt.bold("Sleep:")}      ${appConfig.sleepAfter || "30s"}\n`);
  if (appConfig.dbId) {
    process.stderr.write(`  ${fmt.bold("Database:")}   ${appConfig.dbName}\n`);
  }
  process.stderr.write(`${fmt.dim("-".repeat(40))}\n`);

  if (!options.yes) {
    var rl = createInterface({ input: process.stdin, output: process.stderr });
    var answer = await new Promise((resolve) =>
      rl.question("\nProceed? [Y/n] ", resolve)
    );
    rl.close();
    if (answer && !answer.match(/^y(es)?$/i)) {
      process.stderr.write("Deploy cancelled.\n");
      process.exit(0);
    }
  }

  // 1. Build Docker image
  var platform = "linux/amd64";
  if (providerType === "slicervm") {
    var { listNodes } = await import("../lib/clouds/slicervm.js");
    var nodes = await listNodes(cfg);
    var vmArch = nodes[0]?.arch;
    if (vmArch === "arm64" || vmArch === "aarch64") platform = "linux/arm64";
  }
  phase("Building image");
  status(`${localTag} for ${platform}`);
  dockerBuild(dockerPath, localTag, { platform, dockerfile: options.dockerfile, secrets: options.buildSecret });

  // --- Pre-deploy hook ---
  var linked = readLink();
  var preDeployCmd = options.preDeploy || linked?.preDeploy;

  if (options.backupDb) {
    var { dbBackup } = await import("./db.js");
    await dbBackup(linked?.app || null, { db: options.db });
  }

  if (preDeployCmd) {
    await runPreDeploy(preDeployCmd, localTag, appConfig, linked);
  }

  var byocGateway = buildGatewayMeta(options, readLink());

  // 2. Push image to registry
  var deployImageTag;
  if (providerType === "cf") {
    // CF Containers only pulls from CF Registry / Docker Hub / ECR.
    // Push directly to CF Registry regardless of --registry flag.
    var { CF_REGISTRY, getRegistryCredentials } = await import("../lib/clouds/cf.js");
    var cfTag = `${CF_REGISTRY}/${cfg.accountId}/relight-${name}:${Date.now()}`;
    phase("Pushing to CF Registry");
    var cfCreds = await getRegistryCredentials(cfg.accountId, cfg.apiToken);
    dockerLogin(CF_REGISTRY, cfCreds.username, cfCreds.password);
    dockerTag(localTag, cfTag);
    status(`Pushing ${cfTag}...`);
    dockerPush(cfTag);
    deployImageTag = cfTag;
  } else if (hasRegistry) {
    phase("Pushing to registry");
    status("Authenticating...");
    registryCreds = await registry.getCredentials(registryCfg);
    dockerLogin(registryCreds.registry, registryCreds.username, registryCreds.password);
    if (registry.ensureRepository) await registry.ensureRepository(registryCfg, name);
    status(`Pushing ${remoteTag}...`);
    dockerTag(localTag, remoteTag);
    dockerPush(remoteTag);
    deployImageTag = remoteTag;
  } else {
    deployImageTag = localTag;
  }

  // 3. Deploy
  phase("Deploying");
  appConfig.image = deployImageTag;
  await appProvider.deploy(cfg, name, deployImageTag, {
    appConfig,
    isFirstDeploy,
    newSecrets,
    registryName,
    registryCredentials: registryCreds,
  });

  // 4. Resolve URL and report
  var url = await appProvider.getAppUrl(cfg, name);
  var gatewayUrl = byocGateway ? `https://${byocGateway.hostname}${byocGateway.path_prefix}` : null;

  if (options.json) {
    var result = {
      name,
      image: hasRegistry ? remoteTag : localTag,
      url: gatewayUrl || url,
      gateway: !!byocGateway,
      regions: appConfig.regions,
      instances: appConfig.instances,
      firstDeploy: isFirstDeploy,
      provider: providerName,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    success(`App ${fmt.app(name)} deployed!`);
    process.stderr.write(`  ${fmt.bold("Name:")}  ${fmt.app(name)}\n`);
    process.stderr.write(`  ${fmt.bold("Image:")} ${hasRegistry ? remoteTag : localTag}\n`);
    if (byocGateway) {
      process.stderr.write(`  ${fmt.bold("Access:")} ${fmt.dim("private (via gateway + secret)")}\n`);
      process.stderr.write(`  ${fmt.bold("Gateway:")} ${gatewayUrl ? fmt.url(gatewayUrl) : fmt.dim("(configure gateway domain)")}\n`);
      process.stderr.write(`  ${fmt.bold("Direct:")} ${url ? fmt.dim(url + " (blocked by secret)") : fmt.dim("n/a")}\n`);
    } else {
      process.stderr.write(
        `  ${fmt.bold("URL:")}   ${url ? fmt.url(url) : fmt.dim("(configure workers.dev subdomain to see URL)")}\n`
      );
    }
    hint("Next", byocDispatchNamespace ? `curl ${gatewayUrl}` : `relight open ${name}`);
  }

  // Link this directory to the app
  var linked = readLink();
  linkApp(
    name,
    providerName,
    options.dns || linked?.dns,
    linked?.dbProvider,
    registryName || linked?.registry
  );
}

// --- Portal mode deploy ---
// CLI builds image, pushes to registry, then tells portal to deploy.
// App must already exist — create it first with: relight apps create <name>
async function deployViaPortal(nameOrPath, path, options) {
  var { name, dockerPath } = resolveDeployTarget(nameOrPath, path, "portal");

  var tag = options.tag || `${Date.now()}`;
  var localTag = `relight-${name}:${tag}`;

  // 1. Fetch app config + credentials from portal
  phase("Preparing deploy via portal");
  var prep;
  try {
    prep = await portalApi("POST", `/deploy/${name}/prepare`);
  } catch (err) {
    if (err.message.includes(`App '${name}' not found`)) {
      fatal(
        `App '${name}' not found in portal.`,
        `Create it first: ${fmt.cmd(`relight apps create ${name} --compute <label>`)}`
      );
    }
    fatal(`Portal prepare failed: ${err.message}`);
  }

  var portal = getPortal();
  var portalHost = new URL(portal.url).host;
  var remoteTag = `${portalHost}/${name}:${tag}`;

  // 2. Show summary
  process.stderr.write(`\n${fmt.bold("Deploy summary")}\n`);
  process.stderr.write(`${fmt.dim("-".repeat(40))}\n`);
  process.stderr.write(`  ${fmt.bold("App:")}      ${fmt.app(name)}\n`);
  process.stderr.write(`  ${fmt.bold("Provider:")} ${fmt.cloud(prep.provider)}\n`);
  process.stderr.write(`  ${fmt.bold("Path:")}     ${dockerPath}\n`);
  process.stderr.write(`  ${fmt.bold("Image:")}    ${remoteTag}\n`);
  if (prep.appConfig?.regions) {
    process.stderr.write(`  ${fmt.bold("Regions:")}  ${prep.appConfig.regions.join(", ")}\n`);
  }
  if (prep.appConfig?.sleepAfter) {
    process.stderr.write(`  ${fmt.bold("Sleep:")}    ${prep.appConfig.sleepAfter}\n`);
  }
  if (prep.gatewayConfig?.enabled) {
    process.stderr.write(`  ${fmt.bold("Gateway:")}  ${prep.gatewayConfig.hostname || fmt.dim("(no hostname)")}\n`);
  }
  process.stderr.write(`${fmt.dim("-".repeat(40))}\n`);

  if (!options.yes) {
    var rl = createInterface({ input: process.stdin, output: process.stderr });
    var answer = await new Promise((resolve) =>
      rl.question("\nProceed? [Y/n] ", resolve)
    );
    rl.close();
    if (answer && !answer.match(/^y(es)?$/i)) {
      process.stderr.write("Deploy cancelled.\n");
      process.exit(0);
    }
  }

  // 3. Build Docker image locally
  phase("Building image");
  status(`${localTag} for linux/amd64`);
  dockerBuild(dockerPath, localTag, { platform: "linux/amd64", dockerfile: options.dockerfile, secrets: options.buildSecret });

  // 4. Push image to registry
  var imageTag;
  if (prep.cfRegistry) {
    // CF compute: push directly to CF Registry
    phase("Pushing to CF Registry");
    var cfr = prep.cfRegistry;
    var cfTag = cfr.imageTag.replace(/:latest$/, `:${tag}`);
    dockerLogin(cfr.registry, cfr.username, cfr.password);
    dockerTag(localTag, cfTag);
    status(`Pushing ${cfTag}...`);
    dockerPush(cfTag);
    imageTag = cfTag;
  } else {
    // Non-CF compute: push via portal OCI proxy
    phase("Pushing image via portal");
    status("Authenticating with portal registry...");
    dockerLogin(portalHost, "user", portal.token);
    status(`Pushing ${remoteTag}...`);
    dockerTag(localTag, remoteTag);
    dockerPush(remoteTag);
    imageTag = remoteTag;
  }

  // 5. Trigger deployment
  phase("Deploying via portal");
  var result;
  try {
    result = await portalApi("POST", `/deploy/${name}`, { imageTag, tag });
  } catch (err) {
    fatal(`Portal deploy failed: ${err.message}`);
  }

  // 6. Report
  if (options.json) {
    console.log(JSON.stringify({ name, imageTag, deploymentId: result.deployment?.id, status: result.deployment?.status }, null, 2));
  } else {
    success(`App ${fmt.app(name)} deploy triggered!`);
    process.stderr.write(`  ${fmt.bold("Deployment:")} #${result.deployment?.id}\n`);
    process.stderr.write(`  ${fmt.bold("Status:")}     ${result.deployment?.status}\n`);
    process.stderr.write(`  ${fmt.bold("Image:")}      ${imageTag}\n`);
    hint("Check status", `relight deploy status ${name}`);
  }

  linkApp(name, null, null, undefined, null);
}

// --- Pre-deploy: run command inside built image with production env vars ---

function buildPreDeployEnv(appConfig) {
  var env = {};

  // 1. Non-secret env vars from app config
  if (appConfig.env) {
    for (var key of (appConfig.envKeys || [])) {
      if (appConfig.env[key] && appConfig.env[key] !== "[hidden]") {
        env[key] = appConfig.env[key];
      }
    }
  }

  // 2. All secrets from .env.relight (DATABASE_URL, ENCRYPTION_KEY, etc.)
  if (existsSync(".env.relight")) {
    for (var line of readFileSync(".env.relight", "utf-8").split("\n")) {
      var trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      var eq = trimmed.indexOf("=");
      if (eq !== -1) {
        env[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
      }
    }
  }

  return env;
}

function detectMissingSecrets(appConfig) {
  var secretKeys = appConfig.secretKeys || [];
  if (secretKeys.length === 0) return [];

  var available = new Set();
  if (existsSync(".env.relight")) {
    for (var line of readFileSync(".env.relight", "utf-8").split("\n")) {
      var trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      var eq = trimmed.indexOf("=");
      if (eq !== -1) available.add(trimmed.substring(0, eq));
    }
  }

  return secretKeys.filter((k) => !available.has(k));
}

async function runPreDeploy(cmd, imageTag, appConfig, linked) {
  phase("Running pre-deploy");
  status(cmd);

  // Check for missing secrets
  var missing = detectMissingSecrets(appConfig);
  if (missing.length > 0) {
    process.stderr.write(`\n${fmt.dim("Warning:")} ${missing.length} secret${missing.length > 1 ? "s" : ""} in cloud not available for pre-deploy:\n`);
    process.stderr.write(`  ${missing.join(", ")}\n\n`);
    process.stderr.write(`${fmt.dim("To fix: enable captureSecrets and re-set these secrets:")}\n`);
    process.stderr.write(`  1. Add ${fmt.bold("captureSecrets: true")} to .relight.yaml\n`);
    for (var k of missing) {
      process.stderr.write(`  2. relight config set --secret ${k}=<value>\n`);
    }
    process.stderr.write(`\n${fmt.dim("Or ignore if your pre-deploy command doesn't need them.")}\n`);

    if (process.stdin.isTTY) {
      var rl = createInterface({ input: process.stdin, output: process.stderr });
      var answer = await new Promise((resolve) =>
        rl.question("Proceed anyway? [Y/n] ", resolve)
      );
      rl.close();
      if (answer && !answer.match(/^y(es)?$/i)) {
        fatal("Pre-deploy aborted.");
      }
    }
  }

  // Build env vars and write to temp file (avoids leaking secrets in ps output)
  var env = buildPreDeployEnv(appConfig);
  var tmpDir = mkdtempSync(join(tmpdir(), "relight-"));
  var envFile = join(tmpDir, "env");
  var envContent = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(envFile, envContent);

  // Run inside the built image
  try {
    execSync(`docker run --rm --env-file "${envFile}" ${imageTag} ${cmd}`, {
      stdio: "inherit",
    });
  } catch (e) {
    fatal(`Pre-deploy command failed (exit code ${e.status}).`, "Deploy aborted. No changes were pushed.");
  } finally {
    try { unlinkSync(envFile); } catch {}
  }

  status("Pre-deploy completed successfully.");
}
