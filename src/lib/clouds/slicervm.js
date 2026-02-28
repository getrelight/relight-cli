// SlicerVM API client
// Supports two connection modes:
// - Unix socket: cfg.socketPath (local dev, no auth)
// - HTTP: cfg.apiUrl + cfg.apiToken (remote, bearer token auth)

import http from "node:http";

function socketRequest(socketPath, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    var opts = { socketPath, method, path, headers: headers || {} };
    var req = http.request(opts, (res) => {
      var chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: () => Promise.resolve(Buffer.concat(chunks).toString()),
          json: () => Promise.resolve(JSON.parse(Buffer.concat(chunks).toString())),
          body: null,
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function slicerFetch(cfg, method, path, body, opts = {}) {
  var headers = {};

  if (cfg.apiToken) {
    headers.Authorization = `Bearer ${cfg.apiToken}`;
  }

  var rawBody = body;
  if (opts.contentType) {
    headers["Content-Type"] = opts.contentType;
  } else if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    headers["Content-Type"] = "application/json";
    rawBody = JSON.stringify(body);
  }

  var res;
  if (cfg.socketPath) {
    res = await socketRequest(cfg.socketPath, method, path, method === "GET" ? undefined : rawBody, headers);
  } else {
    res = await fetch(`${cfg.apiUrl}${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : rawBody,
    });
  }

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Slicer API ${method} ${path}: ${res.status} ${text}`);
  }

  var ct = (res.headers instanceof Headers)
    ? res.headers.get("content-type") || ""
    : res.headers["content-type"] || "";

  if (ct.includes("application/json")) {
    return res.json();
  }
  if (opts.stream) {
    return res;
  }
  return res.text();
}

// --- Nodes ---

export async function listNodes(cfg) {
  return slicerFetch(cfg, "GET", "/nodes");
}

export async function createNode(cfg, hostGroup, opts = {}) {
  return slicerFetch(cfg, "POST", `/hostgroup/${hostGroup}/nodes`, {
    tags: opts.tags || [],
    vcpu: opts.vcpu,
    memory: opts.memory,
  });
}

export async function deleteNode(cfg, hostGroup, hostname) {
  return slicerFetch(cfg, "DELETE", `/hostgroup/${hostGroup}/nodes/${hostname}`);
}

// --- VM lifecycle ---

export async function resumeVM(cfg, hostname) {
  return slicerFetch(cfg, "POST", `/vm/${hostname}/resume`);
}

export async function pauseVM(cfg, hostname) {
  return slicerFetch(cfg, "POST", `/vm/${hostname}/pause`);
}

export async function healthCheck(cfg, hostname) {
  return slicerFetch(cfg, "GET", `/vm/${hostname}/health`);
}

// --- Exec ---

export async function execInVM(cfg, hostname, cmd, args, opts = {}) {
  var qs = new URLSearchParams();
  qs.set("cmd", cmd);
  for (var arg of (args || [])) {
    qs.append("args", arg);
  }
  if (opts.uid !== undefined) qs.set("uid", String(opts.uid));
  if (opts.gid !== undefined) qs.set("gid", String(opts.gid));
  if (opts.workdir) qs.set("cwd", opts.workdir);
  return slicerFetch(cfg, "POST", `/vm/${hostname}/exec?${qs}`, null, {
    stream: opts.stream,
  });
}

// --- File upload ---

export async function uploadToVM(cfg, hostname, path, tarBuffer, opts = {}) {
  var qs = new URLSearchParams({ path });
  if (opts.uid !== undefined) qs.set("uid", String(opts.uid));
  if (opts.gid !== undefined) qs.set("gid", String(opts.gid));
  if (opts.mode) qs.set("mode", opts.mode);
  return slicerFetch(cfg, "POST", `/vm/${hostname}/cp?${qs}`, tarBuffer, {
    contentType: "application/x-tar",
  });
}

// --- Auth verification ---

export async function verifyConnection(cfg) {
  return listNodes(cfg);
}
