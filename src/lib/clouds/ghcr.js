var GHCR_REGISTRY = "https://ghcr.io";

export { GHCR_REGISTRY };

export async function verifyCredentials(username, token) {
  var auth = Buffer.from(`${username}:${token}`).toString("base64");
  var res = await fetch(`${GHCR_REGISTRY}/v2/`, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });

  if (res.ok) return;

  var text = await res.text();
  throw new Error(`GHCR auth failed: ${res.status} ${text}`.trim());
}
