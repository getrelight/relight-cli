import { createHmac, createHash } from "crypto";

// AWS Signature V4 signing

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  var kDate = hmac("AWS4" + secretKey, dateStamp);
  var kRegion = hmac(kDate, region);
  var kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export async function awsApi(method, service, host, path, body, credentials, region) {
  var now = new Date();
  var amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  var dateStamp = amzDate.slice(0, 8);

  var bodyStr = body ? JSON.stringify(body) : "";
  var payloadHash = sha256(bodyStr);

  var canonicalHeaders =
    `content-type:application/x-amz-json-1.0\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n`;
  var signedHeaders = "content-type;host;x-amz-date";

  var canonicalRequest = [
    method,
    path,
    "", // query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  var credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  var stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  var signingKey = getSignatureKey(
    credentials.secretAccessKey,
    dateStamp,
    region,
    service
  );
  var signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  var authHeader =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  var res = await fetch(`https://${host}${path}`, {
    method,
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Date": amzDate,
      Authorization: authHeader,
      Host: host,
    },
    body: method === "GET" ? undefined : bodyStr || undefined,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`AWS ${service} ${method} ${path}: ${res.status} ${text}`);
  }

  var ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) {
    return res.json();
  }
  return res.text();
}

// --- JSON API (App Runner, ECR, CloudWatch Logs) ---

export async function awsJsonApi(target, body, service, credentials, region, host) {
  if (!host) host = `${service}.${region}.amazonaws.com`;

  var now = new Date();
  var amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  var dateStamp = amzDate.slice(0, 8);

  var bodyStr = JSON.stringify(body || {});
  var payloadHash = sha256(bodyStr);

  var canonicalHeaders =
    `content-type:application/x-amz-json-1.0\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${target}\n`;
  var signedHeaders = "content-type;host;x-amz-date;x-amz-target";

  var canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  var credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  var stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  var signingKey = getSignatureKey(
    credentials.secretAccessKey,
    dateStamp,
    region,
    service
  );
  var signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  var authHeader =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  var res = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Date": amzDate,
      "X-Amz-Target": target,
      Authorization: authHeader,
    },
    body: bodyStr,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`AWS ${service} ${target}: ${res.status} ${text}`);
  }

  return res.json();
}

// --- Query API (RDS, EC2, IAM) ---

var QUERY_API_VERSIONS = {
  rds: "2014-10-31",
  ec2: "2016-11-15",
  iam: "2010-05-08",
};

export async function awsQueryApi(action, params, service, credentials, region, opts) {
  opts = opts || {};
  var version = opts.version || QUERY_API_VERSIONS[service] || "2012-10-17";
  var host = opts.host || `${service}.${region}.amazonaws.com`;

  var now = new Date();
  var amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  var dateStamp = amzDate.slice(0, 8);

  var formParams = new URLSearchParams();
  formParams.set("Action", action);
  formParams.set("Version", version);
  if (params) {
    for (var [k, v] of Object.entries(params)) {
      formParams.set(k, v);
    }
  }
  var bodyStr = formParams.toString();
  var payloadHash = sha256(bodyStr);

  var canonicalHeaders =
    `content-type:application/x-www-form-urlencoded\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n`;
  var signedHeaders = "content-type;host;x-amz-date";

  // Use us-east-1 for global services like IAM
  var signingRegion = service === "iam" ? "us-east-1" : region;

  var canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  var credentialScope = `${dateStamp}/${signingRegion}/${service}/aws4_request`;
  var stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  var signingKey = getSignatureKey(
    credentials.secretAccessKey,
    dateStamp,
    signingRegion,
    service
  );
  var signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  var authHeader =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  var res = await fetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Amz-Date": amzDate,
      Authorization: authHeader,
    },
    body: bodyStr,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`AWS ${service} ${action}: ${res.status} ${text}`);
  }

  return res.text();
}

// --- REST XML API (Route 53) ---

export async function awsRestXmlApi(method, path, body, credentials) {
  var host = "route53.amazonaws.com";
  var signingRegion = "us-east-1";
  var service = "route53";

  var now = new Date();
  var amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  var dateStamp = amzDate.slice(0, 8);

  var bodyStr = body || "";
  var payloadHash = sha256(bodyStr);

  var canonicalHeaders;
  var signedHeaders;
  if (method === "GET") {
    canonicalHeaders =
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n`;
    signedHeaders = "host;x-amz-date";
  } else {
    canonicalHeaders =
      `content-type:application/xml\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n`;
    signedHeaders = "content-type;host;x-amz-date";
  }

  var canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  var credentialScope = `${dateStamp}/${signingRegion}/${service}/aws4_request`;
  var stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  var signingKey = getSignatureKey(
    credentials.secretAccessKey,
    dateStamp,
    signingRegion,
    service
  );
  var signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  var authHeader =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  var headers = {
    "X-Amz-Date": amzDate,
    Authorization: authHeader,
  };
  if (method !== "GET") {
    headers["Content-Type"] = "application/xml";
  }

  var res = await fetch(`https://${host}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : bodyStr,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`AWS Route 53 ${method} ${path}: ${res.status} ${text}`);
  }

  return res.text();
}

// --- XML helpers ---

export function xmlVal(xml, tag) {
  var match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : null;
}

export function xmlList(xml, tag) {
  var results = [];
  var re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
  var match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[0]);
  }
  return results;
}

export function xmlBlock(xml, tag) {
  var match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

// --- STS / Credential verification ---

export async function verifyCredentials(credentials, region) {
  // Use STS GetCallerIdentity to verify credentials
  var host = "sts.amazonaws.com";
  var now = new Date();
  var amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  var dateStamp = amzDate.slice(0, 8);

  var queryParams = new URLSearchParams({
    Action: "GetCallerIdentity",
    Version: "2011-06-15",
  });
  var queryString = queryParams.toString();

  var payloadHash = sha256("");
  var canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  var signedHeaders = "host;x-amz-date";

  var canonicalRequest = [
    "GET",
    "/",
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  var credentialScope = `${dateStamp}/us-east-1/sts/aws4_request`;
  var stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  var signingKey = getSignatureKey(
    credentials.secretAccessKey,
    dateStamp,
    "us-east-1",
    "sts"
  );
  var signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  var authHeader =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  var res = await fetch(`https://${host}/?${queryString}`, {
    method: "GET",
    headers: {
      "X-Amz-Date": amzDate,
      Authorization: authHeader,
    },
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`STS GetCallerIdentity failed: ${res.status} ${text}`);
  }

  return res.text();
}

// --- Account ID ---

export async function getAccountId(credentials, region) {
  var xml = await verifyCredentials(credentials, region);
  return xmlVal(xml, "Account");
}

// --- IAM: ensure ECR access role for App Runner ---

export async function ensureEcrAccessRole(credentials, region) {
  var roleName = "relight-apprunner-ecr";
  var cr = { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey };

  // Check if role exists
  try {
    var xml = await awsQueryApi("GetRole", { RoleName: roleName }, "iam", cr, region, {
      host: "iam.amazonaws.com",
    });
    var arn = xmlVal(xml, "Arn");
    if (arn) return arn;
  } catch {
    // Role doesn't exist, create it
  }

  // Trust policy for App Runner build service
  var trustPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "build.apprunner.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });

  var createXml = await awsQueryApi(
    "CreateRole",
    {
      RoleName: roleName,
      AssumeRolePolicyDocument: trustPolicy,
      Description: "Allows App Runner to pull images from ECR",
    },
    "iam",
    cr,
    region,
    { host: "iam.amazonaws.com" }
  );

  var arn = xmlVal(createXml, "Arn");

  // Attach ECR access policy
  await awsQueryApi(
    "AttachRolePolicy",
    {
      RoleName: roleName,
      PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
    },
    "iam",
    cr,
    region,
    { host: "iam.amazonaws.com" }
  );

  // Wait a moment for IAM propagation
  await new Promise((r) => setTimeout(r, 5000));

  return arn;
}

// --- App Runner check (refactored to use awsJsonApi) ---

export async function checkAppRunner(credentials, region) {
  return awsJsonApi("AppRunner.ListServices", {}, "apprunner", credentials, region);
}
