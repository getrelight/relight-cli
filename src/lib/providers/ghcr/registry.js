import { GHCR_REGISTRY } from "../../clouds/ghcr.js";

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
