import { GHCR_REGISTRY, getPullToken } from "../../clouds/ghcr.js";

export async function getCredentials(cfg) {
  return {
    registry: GHCR_REGISTRY,
    username: cfg.username,
    password: cfg.token,
  };
}

export function getImageTag(cfg, appName, tag) {
  return `ghcr.io/${cfg.owner}/relight-${appName}:${tag}`;
}

export async function ensureRepository() {
  // GHCR creates the package on first push.
}

// Parse "ghcr.io/owner/repo:tag" into { path: "owner/repo", tag: "tag" }.
function parseImageTag(imageTag) {
  var rest = imageTag.replace(/^https?:\/\//, "").replace(/^ghcr\.io\/?/i, "");
  var colon = rest.lastIndexOf(":");
  if (colon === -1) return null;
  return { path: rest.slice(0, colon), tag: rest.slice(colon + 1) };
}

/**
 * Poll the registry until the image manifest is available (200) or max attempts.
 * Avoids race where deploy runs before GHCR has made the newly pushed tag pullable.
 * Uses Bearer token from GHCR token service (Basic auth often returns 401 for manifest).
 */
export async function waitUntilPullable(cfg, imageTag, opts) {
  var parsed = parseImageTag(imageTag);
  if (!parsed) return;
  var maxAttempts = opts?.maxAttempts ?? 24;
  var delayMs = opts?.delayMs ?? 5000;
  var username = cfg.username;
  var token = cfg.token;
  if (!username || !token) return;

  var base = GHCR_REGISTRY.replace(/\/$/, "");
  var url = `${base}/v2/${parsed.path}/manifests/${parsed.tag}`;
  var bearerToken = null;

  for (var i = 0; i < maxAttempts; i++) {
    if (bearerToken === null) {
      bearerToken = await getPullToken(username, token, parsed.path);
    }
    var res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (res.ok) return;
    if (res.status === 401) {
      bearerToken = null;
      continue;
    }
    if (res.status === 404) {
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    throw new Error(`GHCR manifest check failed: ${res.status} ${await res.text()}`);
  }
  throw new Error(`Image ${imageTag} not yet available in GHCR after ${maxAttempts} attempts (possible race after push).`);
}
