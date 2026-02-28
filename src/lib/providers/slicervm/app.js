import { execSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listNodes,
  createNode,
  deleteNode,
  resumeVM,
  healthCheck,
  execInVM,
  uploadToVM,
} from "../../clouds/slicervm.js";
import { status } from "../../output.js";

// --- Helpers ---

var APP_ROOT = "/app-root";
var CONFIG_PATH = "/home/ubuntu/.relight.json";

function findNodeByApp(nodes, appName) {
  return nodes.find(
    (n) => n.tags && n.tags.includes(appName)
  ) || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Parse NDJSON exec response - collect stdout, check exit code
function parseExecResponse(raw) {
  var text = typeof raw === "string" ? raw : JSON.stringify(raw);
  var stdout = "";
  var stderr = "";
  var exitCode = 0;
  for (var line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    try {
      var obj = JSON.parse(line);
      if (obj.stdout) stdout += obj.stdout;
      if (obj.stderr) stderr += obj.stderr;
      if (obj.exit_code !== undefined) exitCode = obj.exit_code;
    } catch {
      // Not JSON - treat as raw output
      stdout += line;
    }
  }
  return { stdout, stderr, exitCode };
}

// Run a command in VM and return stdout. Throws on non-zero exit.
async function vmExec(cfg, hostname, cmd, args, opts) {
  var raw = await execInVM(cfg, hostname, cmd, args, opts);
  var result = parseExecResponse(raw);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function waitForHealth(cfg, hostname, retries = 30) {
  for (var i = 0; i < retries; i++) {
    try {
      await healthCheck(cfg, hostname);
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`VM ${hostname} did not become healthy after ${retries}s`);
}

async function readAppConfig(cfg, hostname) {
  try {
    var stdout = await vmExec(cfg, hostname, "cat", [CONFIG_PATH]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function writeAppConfig(cfg, hostname, appConfig) {
  var json = JSON.stringify(appConfig, null, 2);
  await vmExec(cfg, hostname, "sh", [
    "-c",
    `cat > ${CONFIG_PATH} << 'RELIGHT_EOF'\n${json}\nRELIGHT_EOF`,
  ]);
}

function inspectImage(localTag) {
  var raw = execSync(
    `docker inspect --format='{{json .Config}}' ${localTag}`,
    { encoding: "utf-8", stdio: "pipe" }
  ).trim();
  // docker inspect wraps in single quotes on some versions
  if (raw.startsWith("'") && raw.endsWith("'")) {
    raw = raw.slice(1, -1);
  }
  return JSON.parse(raw);
}

function buildEntrypoint(imageConfig) {
  var entrypoint = imageConfig.Entrypoint || [];
  var cmd = imageConfig.Cmd || [];

  // Docker resolution: if ENTRYPOINT is set, CMD is appended as args.
  // If only CMD, it's used directly (with shell form handled by Docker already).
  var parts = [...entrypoint, ...cmd];
  if (parts.length === 0) {
    throw new Error(
      "Docker image has no CMD or ENTRYPOINT. Add a CMD to your Dockerfile."
    );
  }
  return parts;
}

function buildEnvMap(imageConfig, appConfig) {
  var env = {};

  // Start with image ENV directives
  for (var entry of (imageConfig.Env || [])) {
    var eq = entry.indexOf("=");
    if (eq !== -1) {
      env[entry.substring(0, eq)] = entry.substring(eq + 1);
    }
  }

  // Overlay relight app env vars
  if (appConfig.env) {
    for (var key of (appConfig.envKeys || [])) {
      if (appConfig.env[key] !== undefined) env[key] = appConfig.env[key];
    }
  }

  // Always set PORT
  env.PORT = String(appConfig.port || 8080);

  return env;
}

// --- App config ---

export async function getAppConfig(cfg, appName) {
  var nodes = await listNodes(cfg);
  var node = findNodeByApp(nodes, appName);
  if (!node) return null;
  return readAppConfig(cfg, node.hostname);
}

export async function pushAppConfig(cfg, appName, appConfig) {
  var nodes = await listNodes(cfg);
  var node = findNodeByApp(nodes, appName);
  if (!node) throw new Error(`No VM found for app ${appName}`);
  await writeAppConfig(cfg, node.hostname, appConfig);
}

// --- Deploy ---

export async function deploy(cfg, appName, imageTag, opts) {
  var appConfig = opts.appConfig;
  var isFirstDeploy = opts.isFirstDeploy;

  // 1. Inspect Docker image for CMD, ENTRYPOINT, ENV, WORKDIR
  status("Inspecting image...");
  var imageConfig = inspectImage(imageTag);
  var entrypoint = buildEntrypoint(imageConfig);
  var workdir = imageConfig.WorkingDir || "/";

  // 2. Find or create VM node
  status("Finding VM...");
  var nodes = await listNodes(cfg);
  var node = findNodeByApp(nodes, appName);

  if (!node) {
    status("Creating VM...");
    node = await createNode(cfg, cfg.hostGroup, {
      tags: [appName],
      vcpu: appConfig.vcpu,
      memory: appConfig.memory,
    });
  }

  var hostname = node.hostname;

  // 3. Resume if paused
  if (node.status === "Paused" || node.status === "paused") {
    status("Resuming VM...");
    await resumeVM(cfg, hostname);
  }

  // 4. Wait for health
  status("Waiting for VM...");
  await waitForHealth(cfg, hostname);

  // 5. Stop old app if redeploying
  if (!isFirstDeploy) {
    status("Stopping old app...");
    try {
      await vmExec(cfg, hostname, "sh", [
        "-c",
        `kill $(cat /run/relight-app.pid 2>/dev/null) 2>/dev/null; rm -f /run/relight-app.pid; sleep 1`,
      ], { uid: 0 });
    } catch {}
  }

  // 6. Export Docker image filesystem as tar
  status("Extracting image...");
  var containerId = execSync(`docker create ${imageTag}`, {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

  var tarPath = join(tmpdir(), `relight-${appName}-${Date.now()}.tar`);
  try {
    execSync(`docker export ${containerId} -o ${tarPath}`, { stdio: "pipe" });
  } finally {
    execSync(`docker rm ${containerId}`, { stdio: "pipe" });
  }

  // 7. Upload tar to VM at /app-root (the chroot target)
  status("Uploading to VM...");
  var tarBuffer = readFileSync(tarPath);
  await uploadToVM(cfg, hostname, APP_ROOT, tarBuffer, {
    mode: "tar",
  });

  try { unlinkSync(tarPath); } catch {}

  // 8. Set up chroot: mounts + busybox symlinks (requires root)
  status("Preparing chroot...");
  await vmExec(cfg, hostname, "sh", [
    "-c",
    [
      `mkdir -p ${APP_ROOT}/proc ${APP_ROOT}/sys ${APP_ROOT}/dev ${APP_ROOT}/dev/pts ${APP_ROOT}/tmp`,
      `mountpoint -q ${APP_ROOT}/proc || mount -t proc proc ${APP_ROOT}/proc`,
      `mountpoint -q ${APP_ROOT}/sys || mount -t sysfs sysfs ${APP_ROOT}/sys`,
      `mountpoint -q ${APP_ROOT}/dev || mount --bind /dev ${APP_ROOT}/dev`,
      `mountpoint -q ${APP_ROOT}/dev/pts || mount --bind /dev/pts ${APP_ROOT}/dev/pts`,
      // Copy resolv.conf so DNS works inside chroot
      `cp /etc/resolv.conf ${APP_ROOT}/etc/resolv.conf 2>/dev/null || true`,
      // docker export flattens layers and loses symlinks. Fix up:
      // 1. Alpine: busybox symlinks (sh, ls, etc.)
      `if [ -f ${APP_ROOT}/bin/busybox ] && [ ! -e ${APP_ROOT}/bin/sh ]; then chroot ${APP_ROOT} /bin/busybox --install -s /bin; fi`,
      // 2. Recreate missing .so symlinks (e.g. libstdc++.so.6 -> libstdc++.so.6.0.34)
      `find ${APP_ROOT}/usr/lib ${APP_ROOT}/lib -name '*.so.*.*' -type f 2>/dev/null | while read f; do base=$(basename "$f"); dir=$(dirname "$f"); major=$(echo "$base" | sed 's/\\(.*\\.so\\.[0-9]*\\).*/\\1/'); [ "$major" != "$base" ] && [ ! -e "$dir/$major" ] && ln -sf "$base" "$dir/$major"; done`,
    ].join(" && "),
  ], { uid: 0 });

  // 9. Write relight config outside the chroot (on the VM root)
  status("Writing config...");
  await writeAppConfig(cfg, hostname, appConfig);

  // 10. Build env and start command
  var env = buildEnvMap(imageConfig, appConfig);

  // Build env export commands for inside the chroot
  var envExport = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join("; ");

  var entrypointStr = entrypoint.map(shellQuote).join(" ");
  var innerCmd = `cd ${shellQuote(workdir)} && exec ${entrypointStr}`;

  // Full command: set env, chroot, run entrypoint, log output, track PID
  // Needs root for chroot
  var chrootCmd = [
    `${envExport}`,
    `chroot ${APP_ROOT} /bin/sh -c '${innerCmd.replace(/'/g, "'\\''")}'`,
  ].join("; ");

  status("Starting app...");
  await vmExec(cfg, hostname, "sh", [
    "-c",
    `nohup sh -c '${chrootCmd.replace(/'/g, "'\\''")}' > /var/log/relight-app.log 2>&1 & echo $! > /run/relight-app.pid`,
  ], { uid: 0 });
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// --- List apps ---

export async function listApps(cfg) {
  var nodes = await listNodes(cfg);
  var apps = [];
  for (var node of nodes) {
    if (!node.tags || node.tags.length === 0) continue;
    var appName = node.tags[0];
    var config = null;
    try {
      config = await readAppConfig(cfg, node.hostname);
    } catch {}
    apps.push({
      name: appName,
      modified: config?.deployedAt || null,
    });
  }
  return apps;
}

// --- Get app info ---

export async function getAppInfo(cfg, appName) {
  var appConfig = await getAppConfig(cfg, appName);
  if (!appConfig) return null;
  var url = `https://${appName}.${cfg.baseDomain}`;
  return { appConfig, url };
}

// --- Destroy ---

export async function destroyApp(cfg, appName) {
  var nodes = await listNodes(cfg);
  var node = findNodeByApp(nodes, appName);
  if (!node) throw new Error(`No VM found for app ${appName}`);
  await deleteNode(cfg, cfg.hostGroup, node.hostname);
}

// --- Scale ---

export async function scale(cfg, appName, opts) {
  var appConfig = opts.appConfig;
  await pushAppConfig(cfg, appName, appConfig);
}

// --- Container status ---

export async function getContainerStatus(cfg, appName) {
  var nodes = await listNodes(cfg);
  var node = findNodeByApp(nodes, appName);
  if (!node) return [];
  return [
    {
      dimensions: {
        hostname: node.hostname,
        status: node.status || "Unknown",
        region: "self-hosted",
      },
      avg: {},
    },
  ];
}

// --- App URL ---

export async function getAppUrl(cfg, appName) {
  var appConfig = await getAppConfig(cfg, appName);
  if (appConfig?.domains?.length > 0) {
    return `https://${appConfig.domains[0]}`;
  }
  return `https://${appName}.${cfg.baseDomain}`;
}

// --- Costs ---

export async function getCosts(cfg, appNames, dateRange) {
  var names = appNames || [];
  if (!appNames) {
    var apps = await listApps(cfg);
    names = apps.map((a) => a.name);
  }
  return names.map((name) => ({
    name,
    usage: {},
  }));
}

// --- Log streaming ---

export async function streamLogs(cfg, appName) {
  var nodes = await listNodes(cfg);
  var node = findNodeByApp(nodes, appName);
  if (!node) throw new Error(`No VM found for app ${appName}`);

  var res = await execInVM(cfg, node.hostname, "tail", ["-f", "/var/log/relight-app.log"], {
    stream: true,
  });

  return {
    url: null,
    id: node.hostname,
    reader: res.body,
    cleanup: async () => {},
  };
}

// --- Regions ---

export function getRegions() {
  return [
    { code: "self-hosted", name: "Self-hosted", location: "Your infrastructure" },
  ];
}
