import { createInterface } from "readline";
import { phase, status, success, hint, fatal, fmt, generateAppName } from "../lib/output.js";
import { readLink, linkApp, resolveAppName } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";
import { PROVIDERS } from "../lib/config.js";
import { dockerBuild, dockerTag, dockerPush, dockerLogin } from "../lib/docker.js";

export async function deploy(nameOrPath, path, options) {
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
  dockerBuild(dockerPath, localTag, { platform });

  if (!hasRegistry) {
    // No registry: deploy extracts and uploads the image directly
    phase("Deploying");
    await appProvider.deploy(cfg, name, localTag, {
      appConfig,
      isFirstDeploy,
      newSecrets,
    });
  } else {
    // 2. Push to registry
    phase("Pushing to registry");
    status("Authenticating...");
    registryCreds = await registry.getCredentials(registryCfg);
    dockerLogin(registryCreds.registry, registryCreds.username, registryCreds.password);
    if (registry.ensureRepository) await registry.ensureRepository(registryCfg, name);
    status(`Pushing ${remoteTag}...`);
    dockerTag(localTag, remoteTag);
    dockerPush(remoteTag);

    // 3. Deploy via provider
    phase("Deploying");
    await appProvider.deploy(cfg, name, remoteTag, {
      appConfig,
      isFirstDeploy,
      newSecrets,
      registryName,
      registryCredentials: registryCreds,
    });
  }

  // 4. Resolve URL and report
  var url = await appProvider.getAppUrl(cfg, name);

  if (options.json) {
    var result = {
      name,
      image: hasRegistry ? remoteTag : localTag,
      url,
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
    process.stderr.write(
      `  ${fmt.bold("URL:")}   ${url ? fmt.url(url) : fmt.dim("(configure workers.dev subdomain to see URL)")}\n`
    );
    hint("Next", `relight open ${name}`);
  }

  // Link this directory to the app
  var linked = readLink();
  linkApp(
    name,
    providerName,
    options.dns || linked?.dns,
    linked?.db,
    linked?.dbProvider,
    registryName || linked?.registry
  );
}
