import { createInterface } from "readline";
import { existsSync } from "fs";
import { resolve } from "path";
import { success, fatal, hint, fmt, table } from "../lib/output.js";
import {
  PROVIDERS,
  PROVIDER_TYPES,
  tryGetConfig,
  saveConfig,
  getConfiguredProviders,
  saveProviderConfig,
  removeProviderConfig,
  tryGetProviderConfig,
  normalizeProviderConfig,
  getDefault,
  setDefault,
} from "../lib/config.js";
import { TOKEN_URL, verifyToken, listAccounts } from "../lib/clouds/cf.js";
import {
  readKeyFile,
  mintAccessToken,
  verifyProject,
} from "../lib/clouds/gcp.js";
import { verifyCredentials as awsVerify } from "../lib/clouds/aws.js";
import { verifyCredentials as azureVerify } from "../lib/clouds/azure.js";
import { verifyConnection } from "../lib/clouds/slicervm.js";
import { verifyApiKey } from "../lib/clouds/neon.js";
import { verifyApiToken as verifyTursoToken } from "../lib/clouds/turso.js";
import kleur from "kleur";

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function normalizeType(input) {
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
    slicervm: "slicervm",
    slicer: "slicervm",
    neon: "neon",
    turso: "turso",
  };
  return aliases[input.toLowerCase()] || input.toLowerCase();
}

export async function providersList() {
  var providers = getConfiguredProviders();

  if (providers.length === 0) {
    process.stderr.write("No providers configured.\n");
    process.stderr.write(
      `\n${fmt.dim("Hint:")} ${fmt.cmd("relight providers add")} to add one.\n`
    );
    return;
  }

  var defaults = {};
  for (var layer of ["app", "db", "dns", "registry"]) {
    var d = getDefault(layer);
    if (d) {
      if (!defaults[d]) defaults[d] = [];
      defaults[d].push(layer);
    }
  }

  var headers = ["NAME", "TYPE", "LAYERS", "DEFAULT"];
  var rows = providers.map((p) => [
    fmt.bold(p.name),
    PROVIDERS[p.type]?.name || p.type,
    PROVIDERS[p.type]?.layers.join(", ") || "-",
    defaults[p.name] ? defaults[p.name].join(", ") : "",
  ]);

  console.log(table(headers, rows));
}

export async function providersAdd(typeName) {
  var rl = createInterface({ input: process.stdin, output: process.stderr });

  if (!typeName) {
    process.stderr.write(`\n${kleur.bold("Add a provider")}\n\n`);
    for (var i = 0; i < PROVIDER_TYPES.length; i++) {
      var id = PROVIDER_TYPES[i];
      var p = PROVIDERS[id];
      process.stderr.write(
        `  ${kleur.bold(`[${i + 1}]`)} ${p.name} ${fmt.dim(`(${p.layers.join(", ")})`)}\n`
      );
    }
    process.stderr.write("\n");

    var choice = await prompt(rl, `Select provider [1-${PROVIDER_TYPES.length}]: `);
    var idx = parseInt(choice, 10) - 1;

    if (isNaN(idx) || idx < 0 || idx >= PROVIDER_TYPES.length) {
      rl.close();
      fatal("Invalid selection.");
    }

    typeName = PROVIDER_TYPES[idx];
  } else {
    typeName = normalizeType(typeName);
  }

  if (!PROVIDERS[typeName]) {
    rl.close();
    fatal(
      `Unknown provider type: ${typeName}`,
      `Supported: ${PROVIDER_TYPES.join(", ")}`
    );
  }

  process.stderr.write(
    `\n${kleur.bold(`Authenticate with ${PROVIDERS[typeName].name}`)}\n`
  );

  var providerConfig;

  switch (typeName) {
    case "cf":
      providerConfig = await authCloudflare(rl);
      break;
    case "gcp":
      providerConfig = await authGCP(rl);
      break;
    case "aws":
      providerConfig = await authAWS(rl);
      break;
    case "azure":
      providerConfig = await authAzure(rl);
      break;
    case "slicervm":
      providerConfig = await authSlicerVM(rl);
      break;
    case "neon":
      providerConfig = await authNeon(rl);
      break;
    case "turso":
      providerConfig = await authTurso(rl);
      break;
  }

  providerConfig.type = typeName;

  // Auto-name: first of this type uses the type as name, subsequent get type-N
  var existing = getConfiguredProviders().filter((p) => p.type === typeName);
  var defaultName;
  if (existing.length === 0) {
    defaultName = typeName;
  } else {
    defaultName = `${typeName}-${existing.length + 1}`;
  }

  var inputName = await prompt(rl, `Provider name [${defaultName}]: `);
  var name = (inputName || "").trim() || defaultName;

  if (tryGetProviderConfig(name)) {
    var overwrite = await prompt(
      rl,
      `Provider '${name}' already exists. Overwrite? [y/N] `
    );
    if (!overwrite.match(/^y(es)?$/i)) {
      rl.close();
      process.stderr.write("Cancelled.\n");
      process.exit(0);
    }
  }

  rl.close();

  saveProviderConfig(name, providerConfig);

  // Set as default for layers that don't have a default yet
  for (var layer of PROVIDERS[typeName].layers) {
    if (!getDefault(layer)) {
      setDefault(layer, name);
    }
  }

  success(`Provider ${fmt.bold(name)} (${PROVIDERS[typeName].name}) added!`);

  var defaultLayers = PROVIDERS[typeName].layers.filter((l) => getDefault(l) === name);
  if (defaultLayers.length > 0) {
    hint("Default", `${name} is the default for: ${defaultLayers.join(", ")}`);
  }
  hint("Next", `relight deploy <name> .`);
}

export async function providersRemove(name) {
  if (!name) {
    fatal("Usage: relight providers remove <name>");
  }

  var instance = tryGetProviderConfig(name);
  if (!instance) {
    fatal(`Provider '${name}' not found.`);
  }

  var typeName = PROVIDERS[instance.type]?.name || instance.type;

  var rl = createInterface({ input: process.stdin, output: process.stderr });
  var answer = await new Promise((resolve) =>
    rl.question(`Remove provider '${name}' (${typeName})? [y/N] `, resolve)
  );
  rl.close();

  if (!answer.match(/^y(es)?$/i)) {
    process.stderr.write("Cancelled.\n");
    return;
  }

  removeProviderConfig(name);
  success(`Provider ${fmt.bold(name)} removed.`);
}

export async function providersDefaultCmd(args) {
  if (!args || args.length < 2) {
    fatal(
      "Usage: relight providers default <layer> <name>",
      "Layers: app, db, dns, registry"
    );
  }

  var layer = args[0];
  var name = args[1];

  if (!["app", "db", "dns", "registry"].includes(layer)) {
    fatal(
      `Unknown layer: ${layer}`,
      "Layers: app, db, dns, registry"
    );
  }

  var instance = tryGetProviderConfig(name);
  if (!instance) {
    fatal(`Provider '${name}' not found.`);
  }

  if (!PROVIDERS[instance.type].layers.includes(layer)) {
    fatal(
      `Provider '${name}' (${PROVIDERS[instance.type].name}) doesn't support ${layer}.`,
      `Supported layers: ${PROVIDERS[instance.type].layers.join(", ")}`
    );
  }

  setDefault(layer, name);
  success(`Default ${layer} provider set to ${fmt.bold(name)}.`);
}

// --- Auth flows ---

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

  var resourceGroup = await prompt(rl, "Resource group [relight]: ");
  resourceGroup = (resourceGroup || "").trim() || "relight";

  var location = await prompt(rl, "Default location [eastus]: ");
  location = (location || "").trim() || "eastus";

  process.stderr.write("\nVerifying...\n");
  try {
    await azureVerify(tenantId, clientId, clientSecret, subscriptionId);
  } catch (e) {
    fatal("Credential verification failed.", e.message);
  }

  try {
    var { azureApi, mintAccessToken } = await import("../lib/clouds/azure.js");
    var token = await mintAccessToken(tenantId, clientId, clientSecret);
    await azureApi("PUT", `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`, {
      location,
    }, token);
  } catch (e) {
    if (!e.message.includes("already exists") && !e.message.includes("200")) {
      process.stderr.write(`  ${fmt.dim(`Note: Could not create resource group: ${e.message}`)}\n`);
    }
  }

  process.stderr.write(`  Subscription: ${fmt.bold(subscriptionId)}\n`);
  process.stderr.write(`  Resource group: ${fmt.bold(resourceGroup)}\n`);
  process.stderr.write(`  Location: ${fmt.bold(location)}\n`);

  return { tenantId, clientId, clientSecret, subscriptionId, resourceGroup, location };
}

async function authSlicerVM(rl) {
  process.stderr.write(`\n  ${kleur.bold("Connection mode")}\n\n`);
  process.stderr.write(`  ${kleur.bold("[1]")} Unix socket (local dev)\n`);
  process.stderr.write(`  ${kleur.bold("[2]")} HTTP API (remote)\n\n`);

  var modeChoice = await prompt(rl, "Select [1-2]: ");
  var useSocket = modeChoice.trim() === "1";

  var config = {};

  if (useSocket) {
    var defaultSocket = "/var/run/slicer/slicer.sock";
    var socketPath = await prompt(rl, `Socket path [${defaultSocket}]: `);
    socketPath = (socketPath || "").trim() || defaultSocket;
    config.socketPath = socketPath;
  } else {
    var apiUrl = await prompt(
      rl,
      "Slicer API URL (e.g. https://slicer.example.com:8080): "
    );
    apiUrl = (apiUrl || "").trim().replace(/\/+$/, "");
    if (!apiUrl) {
      rl.close();
      fatal("No API URL provided.");
    }
    config.apiUrl = apiUrl;

    var token = await prompt(rl, "API token: ");
    token = (token || "").trim();
    if (!token) {
      rl.close();
      fatal("No token provided.");
    }
    config.token = token;
  }

  var hostGroup = await prompt(rl, "Host group [apps]: ");
  config.hostGroup = (hostGroup || "").trim() || "apps";

  var baseDomain = await prompt(
    rl,
    "Base domain (e.g. apps.example.com) [localhost]: "
  );
  config.baseDomain = (baseDomain || "").trim() || "localhost";

  process.stderr.write("\nVerifying...\n");
  var verifyCfg = normalizeProviderConfig({ type: "slicervm", ...config });
  try {
    await verifyConnection(verifyCfg);
  } catch (e) {
    rl.close();
    fatal("Connection failed.", e.message);
  }

  if (useSocket) {
    process.stderr.write(`  Socket: ${fmt.bold(config.socketPath)}\n`);
  } else {
    process.stderr.write(`  API: ${fmt.bold(config.apiUrl)}\n`);
  }
  process.stderr.write(`  Host group: ${fmt.dim(config.hostGroup)}\n`);
  process.stderr.write(`  Base domain: ${fmt.dim(config.baseDomain)}\n`);

  return config;
}

async function authNeon(rl) {
  process.stderr.write(`\n  ${kleur.bold("Neon API key")}\n\n`);
  process.stderr.write(
    `  ${fmt.dim("Get your API key at https://console.neon.tech/app/settings/api-keys")}\n\n`
  );

  var apiKey = await prompt(rl, "API key: ");
  apiKey = (apiKey || "").trim();
  if (!apiKey) {
    rl.close();
    fatal("No API key provided.");
  }

  process.stderr.write("\nVerifying...\n");
  try {
    var projects = await verifyApiKey(apiKey);
    process.stderr.write(
      `  Authenticated. ${projects.length} existing project${projects.length === 1 ? "" : "s"}.\n`
    );
  } catch (e) {
    rl.close();
    fatal("Authentication failed.", e.message);
  }

  return { apiKey };
}

async function authTurso(rl) {
  process.stderr.write(`\n  ${kleur.bold("Turso API token")}\n\n`);
  process.stderr.write(
    `  ${fmt.dim("Get your API token at https://turso.tech/app/settings/api-tokens")}\n\n`
  );

  var apiToken = await prompt(rl, "API token: ");
  apiToken = (apiToken || "").trim();
  if (!apiToken) {
    rl.close();
    fatal("No API token provided.");
  }

  process.stderr.write("\nVerifying...\n");
  var orgs;
  try {
    orgs = await verifyTursoToken(apiToken);
  } catch (e) {
    rl.close();
    fatal("Authentication failed.", e.message);
  }

  if (orgs.length === 0) {
    rl.close();
    fatal("No organizations found for this API token.");
  }

  var orgSlug;
  if (orgs.length === 1) {
    orgSlug = orgs[0].slug || orgs[0].name;
    process.stderr.write(`  Organization: ${fmt.bold(orgSlug)}\n`);
  } else {
    process.stderr.write(`\n  ${kleur.bold("Select organization:")}\n\n`);
    for (var i = 0; i < orgs.length; i++) {
      var slug = orgs[i].slug || orgs[i].name;
      process.stderr.write(`  ${kleur.bold(`[${i + 1}]`)} ${slug}\n`);
    }
    process.stderr.write("\n");
    var orgChoice = await prompt(rl, `Select [1-${orgs.length}]: `);
    var orgIdx = parseInt(orgChoice, 10) - 1;
    if (isNaN(orgIdx) || orgIdx < 0 || orgIdx >= orgs.length) {
      rl.close();
      fatal("Invalid selection.");
    }
    orgSlug = orgs[orgIdx].slug || orgs[orgIdx].name;
  }

  process.stderr.write(`  Authenticated with ${fmt.bold(orgSlug)}.\n`);

  return { apiToken, orgSlug };
}
