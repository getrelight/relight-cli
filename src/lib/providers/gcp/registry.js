import {
  mintAccessToken,
  getRepository,
  createRepository,
} from "../../clouds/gcp.js";

var AR_LOCATION = "us";
var AR_HOST = "us-docker.pkg.dev";
var REPO_NAME = "relight";

export async function getCredentials(cfg) {
  var token = await mintAccessToken(cfg.clientEmail, cfg.privateKey);

  // Ensure repository exists (idempotent)
  try {
    await getRepository(token, cfg.project, AR_LOCATION, REPO_NAME);
  } catch {
    await createRepository(token, cfg.project, AR_LOCATION, REPO_NAME);
  }

  return {
    registry: `https://${AR_HOST}`,
    username: "oauth2accesstoken",
    password: token,
  };
}

export function getImageTag(cfg, appName, tag) {
  return `${AR_HOST}/${cfg.project}/${REPO_NAME}/relight-${appName}:${tag}`;
}
