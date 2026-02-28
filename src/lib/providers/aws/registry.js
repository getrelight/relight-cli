import { awsJsonApi, getAccountId } from "../../clouds/aws.js";

export async function getCredentials(cfg) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };

  var res = await awsJsonApi(
    "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
    {},
    "ecr",
    cr,
    cfg.region,
    `api.ecr.${cfg.region}.amazonaws.com`
  );

  var authData = res.authorizationData?.[0];
  if (!authData) throw new Error("No ECR authorization data returned.");

  var decoded = Buffer.from(authData.authorizationToken, "base64").toString();
  var [username, password] = decoded.split(":");
  var registry = authData.proxyEndpoint; // https://{accountId}.dkr.ecr.{region}.amazonaws.com

  return { registry, username, password };
}

export async function getImageTag(cfg, appName, tag) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var accountId = await getAccountId(cr, cfg.region);
  return `${accountId}.dkr.ecr.${cfg.region}.amazonaws.com/relight-${appName}:${tag}`;
}

export async function ensureRepository(cfg, appName) {
  var cr = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  var repoName = `relight-${appName}`;
  var host = `api.ecr.${cfg.region}.amazonaws.com`;

  // Check if repository exists
  try {
    await awsJsonApi(
      "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories",
      { repositoryNames: [repoName] },
      "ecr",
      cr,
      cfg.region,
      host
    );
    return; // Already exists
  } catch {
    // Repository doesn't exist, create it
  }

  await awsJsonApi(
    "AmazonEC2ContainerRegistry_V20150921.CreateRepository",
    { repositoryName: repoName },
    "ecr",
    cr,
    cfg.region,
    host
  );
}
