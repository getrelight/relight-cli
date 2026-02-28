import {
  CF_REGISTRY,
  getRegistryCredentials,
} from "../../clouds/cf.js";

export async function getCredentials(cfg) {
  var creds = await getRegistryCredentials(cfg.accountId, cfg.apiToken);
  return {
    registry: CF_REGISTRY,
    username: creds.username,
    password: creds.password,
  };
}

export function getImageTag(cfg, appName, tag) {
  return `${CF_REGISTRY}/${cfg.accountId}/relight-${appName}:${tag}`;
}
