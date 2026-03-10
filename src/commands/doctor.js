import { execSync } from "child_process";
import { existsSync } from "fs";
import {
  tryGetConfig,
  CONFIG_PATH,
  PROVIDERS,
  getConfiguredProviders,
  normalizeProviderConfig,
} from "../lib/config.js";
import { verifyToken as cfVerify, getWorkersSubdomain } from "../lib/clouds/cf.js";
import { mintAccessToken, verifyProject as gcpVerifyProject, listAllServices as gcpListServices, gcpApi, AR_API, SQLADMIN_API, DNS_API } from "../lib/clouds/gcp.js";
import { verifyCredentials as awsVerify, checkAppRunner, awsJsonApi, awsQueryApi, awsRestXmlApi } from "../lib/clouds/aws.js";
import { verifyConnection as slicerVerify } from "../lib/clouds/slicervm.js";
import { verifyCredentials as ghcrVerify } from "../lib/clouds/ghcr.js";
import kleur from "kleur";

var PASS = kleur.green("[ok]");
var FAIL = kleur.red("[!!]");
var SKIP = kleur.yellow("[--]");

export async function doctor() {
  process.stderr.write(`\n${kleur.bold("relight doctor")}\n`);
  process.stderr.write(`${kleur.dim("-".repeat(50))}\n\n`);
  var allGood = true;

  // --- General checks ---

  process.stderr.write(kleur.bold("  System\n"));

  allGood =
    check("Docker installed", () => {
      execSync("docker --version", { stdio: "pipe" });
    }) && allGood;

  allGood =
    check("Docker daemon running", () => {
      execSync("docker info", { stdio: "pipe", timeout: 5000 });
    }) && allGood;

  check("Node.js >= 20", () => {
    var major = parseInt(process.version.slice(1), 10);
    if (major < 20) throw new Error(`Node ${process.version} (need >= 20)`);
  });

  allGood =
    check("Auth config exists", () => {
      if (!existsSync(CONFIG_PATH)) throw new Error("Not found");
    }) && allGood;

  var providers = getConfiguredProviders();

  if (providers.length === 0) {
    process.stderr.write(
      `\n  ${SKIP}  No providers configured. Run ${kleur.bold().cyan("relight providers add")} to get started.\n`
    );
  }

  // --- Per-provider checks ---

  for (var p of providers) {
    var typeName = PROVIDERS[p.type]?.name || p.type;
    process.stderr.write(`\n${kleur.bold(`  ${p.name} (${typeName})`)}\n`);

    var cfg = normalizeProviderConfig(p);

    switch (p.type) {
      case "cf":
        allGood = (await checkCloudflare(cfg)) && allGood;
        break;
      case "gcp":
        allGood = (await checkGCP(cfg)) && allGood;
        break;
      case "aws":
        allGood = (await checkAWS(cfg)) && allGood;
        break;
      case "azure":
        allGood = (await checkAzure(cfg)) && allGood;
        break;
      case "ghcr":
        allGood = (await checkGHCR(cfg)) && allGood;
        break;
      case "slicervm":
        allGood =
          (await asyncCheck("Connection", async () => {
            await slicerVerify(cfg);
          })) && allGood;
        break;
      case "neon":
        allGood =
          (await asyncCheck("API key valid", async () => {
            var { verifyApiKey } = await import("../lib/clouds/neon.js");
            await verifyApiKey(p.apiKey);
          })) && allGood;
        break;
      case "turso":
        allGood =
          (await asyncCheck("API token valid", async () => {
            var { verifyApiToken } = await import("../lib/clouds/turso.js");
            await verifyApiToken(p.apiToken);
          })) && allGood;
        break;
    }
  }

  // --- Summary ---

  process.stderr.write(`\n${kleur.dim("-".repeat(50))}\n`);
  if (allGood) {
    process.stderr.write(kleur.green("All checks passed.\n\n"));
  } else {
    process.stderr.write(
      kleur.yellow("Some checks failed. Fix the issues above and re-run.\n\n")
    );
  }
}

// --- Cloudflare checks ---

async function checkCloudflare(cfg) {
  var ok = true;

  ok =
    (await asyncCheck("API token valid", async () => {
      await cfVerify(cfg.apiToken);
    })) && ok;

  ok =
    (await asyncCheck("Account accessible", async () => {
      var { listAccounts } = await import("../lib/clouds/cf.js");
      var accounts = await listAccounts(cfg.apiToken);
      if (!accounts.length) throw new Error("No accounts");
      var match = accounts.find((a) => a.id === cfg.accountId);
      if (!match) throw new Error(`Account ${cfg.accountId} not found`);
    })) && ok;

  ok =
    (await asyncCheck("Workers subdomain configured", async () => {
      var sub = await getWorkersSubdomain(cfg.accountId, cfg.apiToken);
      if (!sub) throw new Error("Not configured");
    })) && ok;

  return ok;
}

// --- GCP checks ---

async function checkGCP(cfg) {
  var ok = true;

  var token;
  ok =
    (await asyncCheck("Service account key valid", async () => {
      token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);
    })) && ok;

  if (token) {
    ok =
      (await asyncCheck("Project accessible", async () => {
        await gcpVerifyProject(token, cfg.project);
      })) && ok;

    ok =
      (await asyncCheck("Cloud Run API reachable", async () => {
        await gcpListServices(token, cfg.project);
      })) && ok;

    ok =
      (await asyncCheck("Artifact Registry API reachable", async () => {
        await gcpApi("GET", `${AR_API}/projects/${cfg.project}/locations/us/repositories`, null, token);
      })) && ok;

    ok =
      (await asyncCheck("Cloud SQL Admin API reachable", async () => {
        await gcpApi("GET", `${SQLADMIN_API}/projects/${cfg.project}/instances`, null, token);
      })) && ok;

    ok =
      (await asyncCheck("Cloud DNS API reachable", async () => {
        await gcpApi("GET", `${DNS_API}/projects/${cfg.project}/managedZones`, null, token);
      })) && ok;
  }

  return ok;
}

// --- AWS checks ---

async function checkAWS(cfg) {
  var ok = true;
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  ok =
    (await asyncCheck("Credentials valid (STS)", async () => {
      await awsVerify(cr, cfg.region);
    })) && ok;

  ok =
    (await asyncCheck("App Runner accessible", async () => {
      await checkAppRunner(cr, cfg.region);
    })) && ok;

  ok =
    (await asyncCheck("ECR accessible", async () => {
      await awsJsonApi(
        "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories",
        {},
        "ecr",
        cr,
        cfg.region,
        `api.ecr.${cfg.region}.amazonaws.com`
      );
    })) && ok;

  ok =
    (await asyncCheck("RDS accessible", async () => {
      await awsQueryApi("DescribeDBInstances", {}, "rds", cr, cfg.region);
    })) && ok;

  ok =
    (await asyncCheck("Route 53 accessible", async () => {
      await awsRestXmlApi("GET", "/2013-04-01/hostedzone", null, cr);
    })) && ok;

  return ok;
}

// --- Azure checks ---

async function checkAzure(cfg) {
  var ok = true;

  var token;
  ok =
    (await asyncCheck("Service principal valid", async () => {
      var { mintAccessToken } = await import("../lib/clouds/azure.js");
      token = await mintAccessToken(cfg.tenantId, cfg.clientId, cfg.clientSecret);
    })) && ok;

  if (token) {
    ok =
      (await asyncCheck("Subscription accessible", async () => {
        var { azureApi } = await import("../lib/clouds/azure.js");
        await azureApi("GET", `/subscriptions/${cfg.subscriptionId}/resourcegroups`, null, token);
      })) && ok;

    ok =
      (await asyncCheck("Container Apps accessible", async () => {
        var { azureApi } = await import("../lib/clouds/azure.js");
        await azureApi("GET",
          `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps`,
          null, token, { apiVersion: "2024-03-01" });
      })) && ok;

    ok =
      (await asyncCheck("Container Registry accessible", async () => {
        var { azureApi } = await import("../lib/clouds/azure.js");
        await azureApi("GET",
          `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.ContainerRegistry/registries`,
          null, token, { apiVersion: "2023-07-01" });
      })) && ok;
  }

  return ok;
}

async function checkGHCR(cfg) {
  var ok = true;

  ok =
    (await asyncCheck("Registry credentials valid", async () => {
      await ghcrVerify(cfg.username, cfg.token);
    })) && ok;

  return ok;
}

// --- Check helpers ---

function check(label, fn) {
  try {
    fn();
    process.stderr.write(`  ${PASS}  ${label}\n`);
    return true;
  } catch (e) {
    process.stderr.write(`  ${FAIL}  ${label}`);
    if (e.message) process.stderr.write(kleur.dim(` - ${e.message}`));
    process.stderr.write("\n");
    return false;
  }
}

async function asyncCheck(label, fn) {
  try {
    await fn();
    process.stderr.write(`  ${PASS}  ${label}\n`);
    return true;
  } catch (e) {
    process.stderr.write(`  ${FAIL}  ${label}`);
    if (e.message) process.stderr.write(kleur.dim(` - ${truncate(e.message, 80)}`));
    process.stderr.write("\n");
    return false;
  }
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}
