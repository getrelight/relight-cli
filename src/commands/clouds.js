import { createInterface } from "readline";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { success, fatal, hint, fmt, table } from "../lib/output.js";
import {
  tryGetConfig,
  saveConfig,
  getAuthenticatedClouds,
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
import {
  verifyCredentials as azureVerify,
  parseResourceGroupInput,
} from "../lib/clouds/azure.js";
import kleur from "kleur";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function cloudsList() {
  var clouds = getAuthenticatedClouds();

  if (clouds.length === 0) {
    process.stderr.write("No clouds configured.\n");
    process.stderr.write(
      `\n${fmt.dim("Hint:")} ${fmt.cmd("relight clouds add")} to add one.\n`
    );
    return;
  }

  var headers = ["ID", "CLOUD"];
  var rows = clouds.map((id) => [fmt.bold(id), CLOUD_NAMES[id] || id]);

  console.log(table(headers, rows));
}

export async function cloudsAdd(name) {
  var rl = createInterface({ input: process.stdin, output: process.stderr });

  if (!name) {
    process.stderr.write(`\n${kleur.bold("Add a cloud provider")}\n\n`);
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

    name = CLOUD_IDS[idx];
  }

  name = normalizeCloud(name);
  if (!CLOUD_NAMES[name]) {
    rl.close();
    fatal(
      `Unknown cloud: ${name}`,
      `Supported: ${CLOUD_IDS.join(", ")}`
    );
  }

  process.stderr.write(
    `\n${kleur.bold(`Authenticate with ${CLOUD_NAMES[name]}`)}\n`
  );

  var cloudConfig;

  switch (name) {
    case "cf":
      cloudConfig = await authCloudflare(rl);
      break;
    case "gcp":
      cloudConfig = await authGCP(rl);
      break;
    case "aws":
      cloudConfig = await authAWS(rl);
      break;
    case "azure":
      cloudConfig = await authAzure(rl);
      break;
  }

  rl.close();

  // Merge into existing config
  var config = tryGetConfig() || { clouds: {} };
  if (!config.clouds) config.clouds = {};
  config.clouds[name] = cloudConfig;

  if (!config.default_cloud) {
    config.default_cloud = name;
  }

  saveConfig(config);

  success(`Authenticated with ${CLOUD_NAMES[name]}!`);

  if (config.default_cloud === name) {
    hint("Default", `${CLOUD_NAMES[name]} is your default cloud`);
  }
  hint("Next", `relight deploy <name> .`);
}

export async function cloudsRemove(name) {
  if (!name) {
    fatal("Usage: relight clouds remove <name>");
  }

  name = normalizeCloud(name);

  var config = tryGetConfig();
  if (!config || !config.clouds || !config.clouds[name]) {
    fatal(`Cloud '${name}' not found.`);
  }

  var rl = createInterface({ input: process.stdin, output: process.stderr });
  var answer = await new Promise((resolve) =>
    rl.question(`Remove cloud '${CLOUD_NAMES[name] || name}'? [y/N] `, resolve)
  );
  rl.close();

  if (!answer.match(/^y(es)?$/i)) {
    process.stderr.write("Cancelled.\n");
    return;
  }

  delete config.clouds[name];
  if (config.default_cloud === name) {
    var remaining = Object.keys(config.clouds).filter(
      (id) => config.clouds[id] && Object.keys(config.clouds[id]).length > 0
    );
    config.default_cloud = remaining[0] || null;
  }
  saveConfig(config);

  success(`Cloud ${fmt.bold(CLOUD_NAMES[name] || name)} removed.`);
}

function normalizeCloud(input) {
  var aliases = {
    cloudflare: "cf",
    cf: "cf",
    gcp: "gcp",
    "google-cloud": "gcp",
    "cloud-run": "gcp",
    aws: "aws",
    amazon: "aws",
    "app-runner": "aws",
    azure: "azure",
    microsoft: "azure",
    "container-apps": "azure",
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
    "https://console.cloud.google.com/apis/enableflow?apiid=run.googleapis.com,artifactregistry.googleapis.com,sqladmin.googleapis.com,dns.googleapis.com,logging.googleapis.com,monitoring.googleapis.com,firebase.googleapis.com,firebasehosting.googleapis.com";

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
  process.stderr.write(`       ${fmt.val("Firebase Admin")}\n`);
  process.stderr.write(`       ${fmt.val("Firebase Hosting Admin")}\n`);
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

// --- Azure ---

async function authAzure(rl) {
  var PORTAL_URL = "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";

  process.stderr.write(`\n  ${kleur.bold("Setup")}\n\n`);
  process.stderr.write(`  1. Open the Azure portal:\n`);
  process.stderr.write(`     ${fmt.url(PORTAL_URL)}\n\n`);
  process.stderr.write(`  2. Register an app (or use an existing one)\n`);
  process.stderr.write(`  3. Go to ${kleur.bold("Certificates & secrets")} → create a client secret\n`);
  process.stderr.write(`  4. Note the ${kleur.bold("Application (client) ID")} and ${kleur.bold("Directory (tenant) ID")}\n`);
  process.stderr.write(`  5. In your subscription, assign the app these roles:\n`);
  process.stderr.write(`     ${fmt.val("Contributor")}\n`);
  process.stderr.write(`     ${fmt.val("AcrPush")}\n\n`);

  // Detect from env vars
  var detectedTenant = process.env.AZURE_TENANT_ID || null;
  var detectedClient = process.env.AZURE_CLIENT_ID || null;
  var detectedSecret = process.env.AZURE_CLIENT_SECRET || null;
  var detectedSubscription = process.env.AZURE_SUBSCRIPTION_ID || null;

  var tenantId;
  if (detectedTenant) {
    var input = await prompt(rl, `Tenant ID [${detectedTenant.slice(0, 8)}...]: `);
    tenantId = (input || "").trim() || detectedTenant;
  } else {
    tenantId = await prompt(rl, "Tenant ID: ");
    tenantId = (tenantId || "").trim();
    if (!tenantId) fatal("No tenant ID provided.");
  }

  var clientId;
  if (detectedClient) {
    var input = await prompt(rl, `Client ID [${detectedClient.slice(0, 8)}...]: `);
    clientId = (input || "").trim() || detectedClient;
  } else {
    clientId = await prompt(rl, "Client ID: ");
    clientId = (clientId || "").trim();
    if (!clientId) fatal("No client ID provided.");
  }

  var clientSecret;
  if (detectedSecret && clientId === detectedClient) {
    var input = await prompt(rl, "Client secret [detected]: ");
    clientSecret = (input || "").trim() || detectedSecret;
  } else {
    clientSecret = await prompt(rl, "Client secret: ");
    clientSecret = (clientSecret || "").trim();
    if (!clientSecret) fatal("No client secret provided.");
  }

  var subscriptionId;
  if (detectedSubscription) {
    var input = await prompt(rl, `Subscription ID [${detectedSubscription.slice(0, 8)}...]: `);
    subscriptionId = (input || "").trim() || detectedSubscription;
  } else {
    subscriptionId = await prompt(rl, "Subscription ID: ");
    subscriptionId = (subscriptionId || "").trim();
    if (!subscriptionId) fatal("No subscription ID provided.");
  }

  var resourceGroupInput = await prompt(rl, "Resource group name or ID [relight]: ");
  var resourceGroupRef;
  try {
    resourceGroupRef = parseResourceGroupInput(subscriptionId, resourceGroupInput);
  } catch (e) {
    fatal(e.message);
  }
  subscriptionId = resourceGroupRef.subscriptionId;

  var useExistingResourceGroup = resourceGroupRef.isFullId;
  if (!resourceGroupRef.isFullId) {
    var existingOnly = await prompt(rl, "Use existing resource group only? [y/N]: ");
    useExistingResourceGroup = !!existingOnly.match(/^y(es)?$/i);
  }

  var location = await prompt(rl, "Default location [eastus]: ");
  location = (location || "").trim() || "eastus";

  process.stderr.write("\nVerifying...\n");
  try {
    await azureVerify(tenantId, clientId, clientSecret, subscriptionId, {
      resourceGroupId: resourceGroupRef.resourceGroupId,
      existingOnly: useExistingResourceGroup,
    });
  } catch (e) {
    fatal("Credential verification failed.", e.message);
  }

  if (!useExistingResourceGroup) {
    try {
      var { azureApi, mintAccessToken } = await import("../lib/clouds/azure.js");
      var token = await mintAccessToken(tenantId, clientId, clientSecret);
      await azureApi("PUT", resourceGroupRef.resourceGroupId, {
        location,
      }, token);
    } catch (e) {
      if (!e.message.includes("already exists") && !e.message.includes("200")) {
        process.stderr.write(`  ${fmt.dim(`Note: Could not create resource group: ${e.message}`)}\n`);
      }
    }
  }

  process.stderr.write(`  Subscription: ${fmt.bold(subscriptionId)}\n`);
  process.stderr.write(`  Resource group: ${fmt.bold(resourceGroupRef.resourceGroup)}\n`);
  if (useExistingResourceGroup) {
    process.stderr.write(`  ${fmt.dim("Using existing resource group (no create attempt)")}\n`);
  }
  process.stderr.write(`  Location: ${fmt.bold(location)}\n`);

  return {
    tenantId,
    clientId,
    clientSecret,
    subscriptionId,
    resourceGroup: resourceGroupRef.resourceGroup,
    resourceGroupId: resourceGroupRef.isFullId ? resourceGroupRef.resourceGroupId : undefined,
    location,
  };
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
