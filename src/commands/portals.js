import { phase, status, success, hint, fatal, fmt } from "../lib/output.js";
import { getPortal, savePortal, removePortal, portalApi } from "../lib/portal.js";

export async function portalsAdd(url) {
  if (!url) fatal("Portal URL required.", `Usage: ${fmt.cmd("relight portals add https://portal.example.com")}`);

  // Verify connectivity
  phase("Connecting to portal");
  status(url);
  try {
    var statusRes = await fetch(`${url.replace(/\/$/, "")}/api/status`);
    var data = await statusRes.json();
    if (data.status !== "ok") throw new Error("Unexpected response");
    status(`Portal v${data.version} reachable`);
  } catch (err) {
    fatal(`Cannot reach portal at ${url}`, err.message);
  }

  // Authenticate - open browser for OIDC or prompt for token
  phase("Authenticating");
  var { createInterface } = await import("readline");
  var rl = createInterface({ input: process.stdin, output: process.stderr });

  process.stderr.write(`\n  Paste an API token from the portal UI,\n`);
  process.stderr.write(`  or create one at ${fmt.url(`${url}/settings/tokens`)}\n\n`);

  var token = await new Promise((resolve) =>
    rl.question("  API token: ", resolve)
  );
  rl.close();
  token = token.trim();
  if (!token) fatal("No token provided.");

  // Verify token works
  try {
    var headers = { Authorization: `Bearer ${token}` };
    var meRes = await fetch(`${url.replace(/\/$/, "")}/api/auth/me`, { headers });
    if (!meRes.ok) throw new Error("Invalid token");
    var me = await meRes.json();
    status(`Authenticated as ${fmt.val(me.user.email)}`);
  } catch (err) {
    fatal("Authentication failed.", err.message);
  }

  savePortal(url, token);
  success("Portal connected!");
  hint("Deploy", `relight deploy my-app`);
}

export async function portalsList() {
  var portal = getPortal();
  if (!portal) {
    process.stderr.write("No portal connected.\n");
    process.stderr.write(`Run ${fmt.cmd("relight portals add <url>")} to connect.\n`);
    return;
  }

  process.stderr.write(`${fmt.bold("Connected portal:")}\n`);
  process.stderr.write(`  ${fmt.bold("URL:")}   ${fmt.url(portal.url)}\n`);

  try {
    var data = await portalApi("GET", "/auth/me");
    process.stderr.write(`  ${fmt.bold("User:")}  ${data.user.email}\n`);
  } catch {
    process.stderr.write(`  ${fmt.bold("User:")}  ${fmt.dim("(token may be expired)")}\n`);
  }
}

export async function portalsRemove() {
  var portal = getPortal();
  if (!portal) {
    process.stderr.write("No portal connected.\n");
    return;
  }
  removePortal();
  success("Portal disconnected.");
}

export async function portalsDefaults(args) {
  if (!args || args.length === 0) {
    var data = await portalApi("GET", "/settings/defaults");
    process.stderr.write(`${fmt.bold("Portal defaults:")}\n`);
    process.stderr.write(`  ${fmt.bold("compute:")}           ${data.compute || fmt.dim("(none)")}\n`);
    process.stderr.write(`  ${fmt.bold("db:")}                ${data.db || fmt.dim("(none)")}\n`);
    process.stderr.write(`  ${fmt.bold("registry:")}          ${data.registry || fmt.dim("(none)")}\n`);
    process.stderr.write(`  ${fmt.bold("gateway_enabled:")}   ${data.gateway_enabled}\n`);
    process.stderr.write(`  ${fmt.bold("sm_connection:")}     ${data.sm_connection_label || fmt.dim("(none)")}\n`);
    return;
  }

  // relight portals defaults set KEY=VAL ...
  if (args[0] === "set") {
    var pairs = args.slice(1);
    if (pairs.length === 0) {
      fatal("Usage: relight portals defaults set KEY=VALUE ...");
    }

    var update = {};
    var VALID = { compute: 1, db: 1, registry: 1, gateway_enabled: 1, sm_connection_label: 1, gateway: 1 };
    for (var pair of pairs) {
      var eq = pair.indexOf("=");
      if (eq === -1) fatal(`Invalid format: ${pair}. Expected KEY=VALUE.`);
      var k = pair.substring(0, eq);
      var v = pair.substring(eq + 1);
      if (k === "gateway") k = "gateway_enabled";
      if (!VALID[k]) fatal(`Unknown key: ${k}. Valid keys: compute, db, registry, gateway_enabled, sm_connection_label`);
      if (k === "gateway_enabled") {
        update[k] = v === "true" || v === "1" || v === "yes";
      } else {
        update[k] = v || null;
      }
    }

    var result = await portalApi("PATCH", "/settings/defaults", update);
    success("Portal defaults updated.");
    process.stderr.write(`  ${fmt.bold("compute:")}           ${result.compute || fmt.dim("(none)")}\n`);
    process.stderr.write(`  ${fmt.bold("db:")}                ${result.db || fmt.dim("(none)")}\n`);
    process.stderr.write(`  ${fmt.bold("registry:")}          ${result.registry || fmt.dim("(none)")}\n`);
    process.stderr.write(`  ${fmt.bold("gateway_enabled:")}   ${result.gateway_enabled}\n`);
    process.stderr.write(`  ${fmt.bold("sm_connection:")}     ${result.sm_connection_label || fmt.dim("(none)")}\n`);
  } else {
    fatal("Usage: relight portals defaults [set KEY=VALUE ...]");
  }
}
