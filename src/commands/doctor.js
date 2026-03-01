import { execSync } from "child_process";
import { existsSync } from "fs";
import {
  tryGetConfig,
  CONFIG_PATH,
  CLOUD_NAMES,
  SERVICE_TYPES,
  getRegisteredServices,
  normalizeServiceConfig,
} from "../lib/config.js";
import { verifyToken as cfVerify, getWorkersSubdomain } from "../lib/clouds/cf.js";
import { mintAccessToken, verifyProject as gcpVerifyProject, listRegions as gcpListRegions, gcpApi, AR_API, SQLADMIN_API, DNS_API } from "../lib/clouds/gcp.js";
import { verifyCredentials as awsVerify, checkAppRunner, awsJsonApi, awsQueryApi, awsRestXmlApi } from "../lib/clouds/aws.js";
import { verifyConnection as slicerVerify } from "../lib/clouds/slicervm.js";
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

  var config = tryGetConfig();
  var clouds = config && config.clouds ? config.clouds : {};
  var authenticatedClouds = Object.keys(clouds).filter(
    (id) => clouds[id] && Object.keys(clouds[id]).length > 0
  );

  if (authenticatedClouds.length === 0) {
    process.stderr.write(
      `\n  ${SKIP}  No clouds configured. Run ${kleur.bold().cyan("relight auth")} to get started.\n`
    );
  }

  // --- Per-cloud checks ---

  for (var cloudId of authenticatedClouds) {
    process.stderr.write(`\n${kleur.bold(`  ${CLOUD_NAMES[cloudId] || cloudId}`)}\n`);

    switch (cloudId) {
      case "cf":
        allGood = (await checkCloudflare(clouds.cf)) && allGood;
        break;
      case "gcp":
        allGood = (await checkGCP(clouds.gcp)) && allGood;
        break;
      case "aws":
        allGood = (await checkAWS(clouds.aws)) && allGood;
        break;
    }
  }

  // --- Services ---

  var services = getRegisteredServices();
  if (services.length > 0) {
    process.stderr.write(`\n${kleur.bold("  Services")}\n`);

    for (var service of services) {
      var typeName = SERVICE_TYPES[service.type]?.name || service.type;
      var endpoint = service.socketPath || service.apiUrl || "unknown";

      allGood =
        (await asyncCheck(`${service.name} (${typeName} - ${endpoint})`, async () => {
          if (service.type === "slicervm") {
            var cfg = normalizeServiceConfig(service);
            await slicerVerify(cfg);
          }
        })) && allGood;
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
      await cfVerify(cfg.token);
    })) && ok;

  ok =
    (await asyncCheck("Account accessible", async () => {
      var { listAccounts } = await import("../lib/clouds/cf.js");
      var accounts = await listAccounts(cfg.token);
      if (!accounts.length) throw new Error("No accounts");
      var match = accounts.find((a) => a.id === cfg.accountId);
      if (!match) throw new Error(`Account ${cfg.accountId} not found`);
    })) && ok;

  ok =
    (await asyncCheck("Workers subdomain configured", async () => {
      var sub = await getWorkersSubdomain(cfg.accountId, cfg.token);
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
        await gcpListRegions(token, cfg.project);
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
