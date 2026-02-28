export async function getCredentials() {
  throw new Error("SlicerVM deploys bundles directly - no container registry needed.");
}

export function getImageTag(cfg, appName, tag) {
  return `relight-${appName}:${tag}`;
}
