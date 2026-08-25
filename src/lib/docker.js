import { execSync } from "child_process";

function ensureDocker() {
  try {
    execSync("docker version", { stdio: "pipe" });
  } catch {
    console.error("Docker is not running. Install and start Docker first.");
    process.exit(1);
  }
}

export function dockerBuild(contextPath, tag, opts = {}) {
  ensureDocker();
  var platform = opts.platform || "linux/amd64";
  var fileFlag = opts.dockerfile ? `-f ${opts.dockerfile}` : "";
  var secretFlags = (opts.secrets || []).map((s) => `--secret ${s}`).join(" ");
  var argFlags = (opts.buildArgs || []).map((a) => `--build-arg ${a}`).join(" ");
  execSync(
    `docker build --platform ${platform} --provenance=false ${fileFlag} ${secretFlags} ${argFlags} -t ${tag} ${contextPath}`.replace(/\s+/g, " ").trim(),
    { stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "1" } }
  );
}

export function dockerTag(source, target) {
  execSync(`docker tag ${source} ${target}`, { stdio: "pipe" });
}

export function dockerPush(tag) {
  execSync(`docker push ${tag}`, { stdio: "pipe" });
}

export function dockerLogin(registry, username, password) {
  execSync(
    `docker login --password-stdin --username ${username} ${registry}`,
    { input: password, stdio: "pipe" }
  );
}
