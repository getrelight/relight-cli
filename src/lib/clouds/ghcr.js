var GHCR_REGISTRY = "https://ghcr.io";

export { GHCR_REGISTRY };

function buildBasicAuth(username, token) {
  return Buffer.from(`${username}:${token}`).toString("base64");
}

function parseAuthHeader(header) {
  if (!header) return null;

  var match = header.match(/^Bearer\s+(.*)$/i);
  if (!match) return null;

  var attrs = {};
  for (var part of match[1].split(",")) {
    var eq = part.indexOf("=");
    if (eq === -1) continue;
    var key = part.slice(0, eq).trim();
    var value = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
    attrs[key] = value;
  }
  return attrs.realm ? attrs : null;
}

export async function verifyCredentials(username, token, scopePrefix) {
  var auth = Buffer.from(`${username}:${token}`).toString("base64");
  var res = await fetch(`${GHCR_REGISTRY}/v2/`, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });

  if (res.ok) return;

  var challenge = parseAuthHeader(res.headers.get("www-authenticate"));
  if (!challenge) {
    var text = await res.text();
    throw new Error(`GHCR auth failed: ${res.status} ${text}`.trim());
  }

  var url = new URL(challenge.realm);
  url.searchParams.set("service", challenge.service || "ghcr.io");
  if (scopePrefix) {
    url.searchParams.set("scope", `repository:${scopePrefix}/relight-probe:pull`);
  }

  var tokenRes = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${buildBasicAuth(username, token)}`,
    },
  });

  if (tokenRes.ok) {
    var data = await tokenRes.json();
    if (data.token || data.access_token) return;
  }

  var text = await tokenRes.text();
  if (text) {
    throw new Error(`GHCR auth failed: ${tokenRes.status} ${text}`.trim());
  }

  text = await res.text();
  throw new Error(`GHCR auth failed: ${res.status} ${text}`.trim());
}
