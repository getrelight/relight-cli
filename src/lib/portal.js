// Portal client - connects CLI to a self-hosted relight-portal instance.
// Stored in ~/.relight/config.json as: { portal: { url, token } }

import { tryGetConfig, saveConfig } from "./config.js";

export function getPortal() {
  var config = tryGetConfig();
  if (!config || !config.portal) return null;
  return config.portal;
}

export function savePortal(url, token) {
  var config = tryGetConfig() || {};
  config.portal = { url: url.replace(/\/$/, ""), token };
  saveConfig(config);
}

export function removePortal() {
  var config = tryGetConfig();
  if (!config) return;
  delete config.portal;
  saveConfig(config);
}

export async function portalApi(method, path, body) {
  var portal = getPortal();
  if (!portal) throw new Error("Not connected to a portal. Run `relight portals add` first.");

  var headers = { Authorization: `Bearer ${portal.token}` };
  var opts = { method, headers };

  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  var res = await fetch(`${portal.url}/api${path}`, opts);
  var data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Portal API error: ${res.status}`);
  }

  return data;
}
