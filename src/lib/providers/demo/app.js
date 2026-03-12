// Demo provider - app layer.
// Talks to relight-demo server, which runs Docker containers locally.

async function api(cfg, method, path, body) {
  var opts = {
    method,
    headers: { "Authorization": `Bearer ${cfg.token}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(`${cfg.url}${path}`, opts);
  if (!res.ok) {
    var err = await res.text();
    throw new Error(`demo API ${method} ${path}: ${res.status} ${err}`);
  }
  return res.json();
}

export async function deploy(cfg, appName, imageTag, opts) {
  var result = await api(cfg, "POST", `/api/apps/${appName}/deploy`, {
    imageTag,
    appConfig: opts?.appConfig,
  });
  return result;
}

export async function listApps(cfg) {
  var apps = await api(cfg, "GET", "/api/apps");
  return apps.map(a => ({ name: a.name, modified: a.lastDeployAt }));
}

export async function getAppInfo(cfg, appName) {
  try {
    var app = await api(cfg, "GET", `/api/apps/${appName}`);
    return {
      appConfig: {
        name: appName,
        image: app.imageTag,
        port: 8080,
        env: {},
        envKeys: [],
        secretKeys: [],
        deployedAt: app.lastDeployAt,
      },
      url: app.url,
    };
  } catch {
    return null;
  }
}

export async function getAppConfig(cfg, appName) {
  var info = await getAppInfo(cfg, appName);
  return info?.appConfig || null;
}

export async function pushAppConfig(cfg, appName, appConfig) {
  // Demo provider doesn't persist config separately - it's part of deploy
}

export async function destroyApp(cfg, appName) {
  await api(cfg, "DELETE", `/api/apps/${appName}`);
}

export async function getAppUrl(cfg, appName) {
  try {
    var app = await api(cfg, "GET", `/api/apps/${appName}`);
    return app.url;
  } catch {
    return null;
  }
}

export async function scale(cfg, appName, opts) {
  // Demo provider doesn't support scaling
}

export async function getContainerStatus(cfg, appName) {
  return [];
}

export async function streamLogs(cfg, appName) {
  throw new Error("Demo provider does not support log streaming. Check relight-demo dashboard.");
}

export async function getCosts(cfg, appNames, dateRange) {
  var costs = await api(cfg, "GET", "/api/costs");
  return costs;
}

export function getRegions() {
  return [{ code: "local", name: "Local", location: "localhost" }];
}
