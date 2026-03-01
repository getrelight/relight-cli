import { createInterface } from "readline";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { success, fatal, hint, fmt } from "../lib/output.js";
import {
  tryGetConfig,
  saveConfig,
  CLOUD_NAMES,
  CLOUD_IDS,
} from "../lib/config.js";
import { TOKEN_URL, verifyToken, listAccounts } from "../lib/clouds/cf.js";
import {
  readKeyFile,
  mintAccessToken,
  verifyProject,
} from "../lib/clouds/gcp.js";
import { verifyCredentials as awsVerify } from "../lib/clouds/aws.js";
import kleur from "kleur";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function auth(options) {
  var compute = options.cloud;

  var rl = createInterface({ input: process.stdin, output: process.stderr });

  if (!compute) {
    process.stderr.write(`\n${kleur.bold("Authenticate with a cloud provider")}\n\n`);
    for (var i = 0; i < CLOUD_IDS.length; i++) {
      process.stderr.write(
        `  ${kleur.bold(`[${i + 1}]`)} ${CLOUD_NAMES[CLOUD_IDS[i]]}\n`
      );
    }
    process.stderr.write("\n");

    var choice = await prompt(rl, `Select cloud [1-${CLOUD_IDS.length}]: `);
    var idx = parseInt(choice, 10) - 1;

    if (isNaN(idx) || idx < 0 || idx >= CLOUD_IDS.length) {
      rl.close();
      fatal("Invalid selection.");
    }

    compute = CLOUD_IDS[idx];
  }

  compute = normalizeCompute(compute);
  if (!CLOUD_NAMES[compute]) {
    rl.close();
    fatal(
      `Unknown cloud: ${compute}`,
      `Supported: ${CLOUD_IDS.join(", ")}`
    );
  }

  process.stderr.write(
    `\n${kleur.bold(`Authenticate with ${CLOUD_NAMES[compute]}`)}\n`
  );

  var cloudConfig;

  switch (compute) {
    case "cf":
      cloudConfig = await authCloudflare(rl);
      break;
    case "gcp":
      cloudConfig = await authGCP(rl);
      break;
    case "aws":
      cloudConfig = await authAWS(rl);
      break;
  }

  rl.close();

  // Merge into existing config
  var config = tryGetConfig() || { clouds: {} };
  if (!config.clouds) config.clouds = {};
  config.clouds[compute] = cloudConfig;

  if (!config.default_cloud) {
    config.default_cloud = compute;
  }

  saveConfig(config);

  success(`Authenticated with ${CLOUD_NAMES[compute]}!`);

  if (config.default_cloud === compute) {
    hint("Default", `${CLOUD_NAMES[compute]} is your default cloud`);
  }
  hint("Next", `relight deploy <name> .`);
}

function normalizeCompute(input) {
  var aliases = {
    cloudflare: "cf",
    cf: "cf",
    gcp: "gcp",
    "google-cloud": "gcp",
    "cloud-run": "gcp",
    aws: "aws",
    amazon: "aws",
    "app-runner": "aws",
  };
  return aliases[input.toLowerCase()] || input.toLowerCase();
}

// --- Cloudflare ---

async function authCloudflare(rl) {
  process.stderr.write(`\n  ${kleur.bold("Setup")}\n\n`);
  process.stderr.write(`  1. Log in to the Cloudflare dashboard\n`);
  process.stderr.write(`  2. Open this link to create a pre-filled API token:\n\n`);
  process.stderr.write(`     ${fmt.url(TOKEN_URL)}\n\n`);
  process.stderr.write(`  3. Click ${kleur.bold("Continue to summary")} then ${kleur.bold("Create Token")}\n`);
  process.stderr.write(`  4. Copy the token\n\n`);

  var apiToken = await prompt(rl, "Paste your API token: ");
  apiToken = (apiToken || "").trim();
  if (!apiToken) fatal("No token provided.");

  process.stderr.write("\nVerifying...\n");
  try {
    await verifyToken(apiToken);
  } catch (e) {
    fatal("Token verification failed.", e.message);
  }

  var accounts = await listAccounts(apiToken);
  if (accounts.length === 0) {
    fatal("No accounts found for this token.");
  }

  var account;
  if (accounts.length === 1) {
    account = accounts[0];
  } else {
    process.stderr.write("\nMultiple accounts found:\n\n");
    for (var i = 0; i < accounts.length; i++) {
      process.stderr.write(
        `  ${kleur.bold(`[${i + 1}]`)} ${accounts[i].name} ${fmt.dim(`(${accounts[i].id})`)}\n`
      );
    }
    process.stderr.write("\n");

    var choice = await prompt(rl, `Select account [1-${accounts.length}]: `);
    var idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
      fatal("Invalid selection.");
    }
    account = accounts[idx];
  }

  process.stderr.write(
    `  Account: ${fmt.bold(account.name)} ${fmt.dim(`(${account.id})`)}\n`
  );

  return { token: apiToken, accountId: account.id };
}

// --- GCP ---

async function authGCP(rl) {
  var SA_URL =
    "https://console.cloud.google.com/iam-admin/serviceaccounts/create";
  var ENABLE_APIS =
    "https://console.cloud.google.com/apis/enableflow?apiid=run.googleapis.com,artifactregistry.googleapis.com,sqladmin.googleapis.com,dns.googleapis.com,logging.googleapis.com,monitoring.googleapis.com";

  process.stderr.write(`\n  ${kleur.bold("Setup")}\n\n`);
  process.stderr.write(`  1. Enable the required APIs:\n`);
  process.stderr.write(`     ${fmt.url(ENABLE_APIS)}\n\n`);
  process.stderr.write(`  2. Create a service account:\n`);
  process.stderr.write(`     ${fmt.url(SA_URL)}\n\n`);
  process.stderr.write(`     Name it ${fmt.val("relight")} and grant these roles:\n`);
  process.stderr.write(`       ${fmt.val("Cloud Run Admin")}\n`);
  process.stderr.write(`       ${fmt.val("Artifact Registry Admin")}\n`);
  process.stderr.write(`       ${fmt.val("Service Account User")}\n`);
  process.stderr.write(`       ${fmt.val("Cloud SQL Admin")}\n`);
  process.stderr.write(`       ${fmt.val("DNS Administrator")}\n`);
  process.stderr.write(`       ${fmt.val("Logs Viewer")}\n`);
  process.stderr.write(`       ${fmt.val("Monitoring Viewer")}\n\n`);
  process.stderr.write(`  3. Go to the service account → ${kleur.bold("Keys")} tab\n`);
  process.stderr.write(`  4. ${kleur.bold("Add Key")} → ${kleur.bold("Create new key")} → ${kleur.bold("JSON")}\n`);
  process.stderr.write(`  5. Save the downloaded file\n\n`);

  var keyPath = await prompt(rl, "Path to service account key JSON: ");
  keyPath = (keyPath || "").trim();
  if (!keyPath) fatal("No key file provided.");

  keyPath = resolve(keyPath.replace(/^~\//, process.env.HOME + "/"));
  if (!existsSync(keyPath)) {
    fatal(`File not found: ${keyPath}`);
  }

  var key;
  try {
    key = readKeyFile(keyPath);
  } catch (e) {
    fatal("Failed to read key file.", e.message);
  }

  var project = key.project;
  if (!project) {
    project = await prompt(rl, "GCP project ID: ");
    project = (project || "").trim();
    if (!project) fatal("No project provided.");
  }

  process.stderr.write("\nVerifying...\n");

  var token;
  try {
    token = await mintAccessToken(key.clientEmail, key.privateKey);
  } catch (e) {
    fatal("Failed to mint access token.", e.message);
  }

  try {
    await verifyProject(token, project);
  } catch (e) {
    fatal("Project verification failed.", e.message);
  }

  process.stderr.write(`  Project: ${fmt.bold(project)}\n`);
  process.stderr.write(`  Service account: ${fmt.dim(key.clientEmail)}\n`);

  return { clientEmail: key.clientEmail, privateKey: key.privateKey, project };
}

// --- AWS ---

async function authAWS(rl) {
  var IAM_CONSOLE = "https://console.aws.amazon.com/iam/home#/users";

  process.stderr.write(`\n  ${kleur.bold("Setup")}\n\n`);
  process.stderr.write(`  1. Open the IAM console:\n`);
  process.stderr.write(`     ${fmt.url(IAM_CONSOLE)}\n\n`);
  process.stderr.write(`  2. Create a user and attach these policies:\n`);
  process.stderr.write(`     ${fmt.val("AWSAppRunnerFullAccess")}\n`);
  process.stderr.write(`     ${fmt.val("AmazonEC2ContainerRegistryFullAccess")}\n`);
  process.stderr.write(`     ${fmt.val("AmazonRDSFullAccess")}\n`);
  process.stderr.write(`     ${fmt.val("AmazonRoute53FullAccess")}\n`);
  process.stderr.write(`     ${fmt.val("AmazonEC2ReadOnlyAccess")}\n`);
  process.stderr.write(`     ${fmt.val("CloudWatchLogsReadOnlyAccess")}\n`);
  process.stderr.write(`     ${fmt.val("IAMFullAccess")}\n\n`);
  process.stderr.write(`  3. Go to the user's ${kleur.bold("Security credentials")} tab\n`);
  process.stderr.write(`  4. Click ${kleur.bold("Create access key")} → choose ${kleur.bold("Command Line Interface")}\n`);
  process.stderr.write(`  5. Copy the Access Key ID and Secret Access Key\n\n`);

  // Detect from env vars as fallback
  var detectedKeyId = process.env.AWS_ACCESS_KEY_ID || null;
  var detectedSecret = process.env.AWS_SECRET_ACCESS_KEY || null;
  var detectedRegion =
    process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || null;

  var accessKeyId;
  if (detectedKeyId) {
    var input = await prompt(
      rl,
      `AWS Access Key ID [${detectedKeyId.slice(0, 8)}...]: `
    );
    accessKeyId = (input || "").trim() || detectedKeyId;
  } else {
    accessKeyId = await prompt(rl, "AWS Access Key ID: ");
    accessKeyId = (accessKeyId || "").trim();
    if (!accessKeyId) fatal("No access key provided.");
  }

  var secretAccessKey;
  if (detectedSecret && accessKeyId === detectedKeyId) {
    var input = await prompt(rl, "AWS Secret Access Key [detected]: ");
    secretAccessKey = (input || "").trim() || detectedSecret;
  } else {
    secretAccessKey = await prompt(rl, "AWS Secret Access Key: ");
    secretAccessKey = (secretAccessKey || "").trim();
    if (!secretAccessKey) fatal("No secret key provided.");
  }

  var defaultRegion = detectedRegion || "us-east-1";
  var region = await prompt(rl, `AWS Region [${defaultRegion}]: `);
  region = (region || "").trim() || defaultRegion;

  process.stderr.write("\nVerifying...\n");
  try {
    await awsVerify({ accessKeyId, secretAccessKey }, region);
  } catch (e) {
    fatal("Credential verification failed.", e.message);
  }

  process.stderr.write(`  Region: ${fmt.bold(region)}\n`);

  return { accessKeyId, secretAccessKey, region };
}

// --- Helpers ---

function tryExec(cmd) {
  try {
    return execSync(cmd + " 2>/dev/null", {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}
