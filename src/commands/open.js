import { execSync } from "child_process";
import { platform } from "os";
import { fatal, fmt } from "../lib/output.js";
import { resolveAppName } from "../lib/link.js";
import { resolveStack } from "../lib/providers/resolve.js";

export async function open(name, options) {
  name = resolveAppName(name);
  var stack = await resolveStack(options);
  var { cfg, provider: appProvider } = stack.app;

  var url = await appProvider.getAppUrl(cfg, name);

  if (!url) {
    fatal(
      "Could not resolve app URL.",
      "Ensure your app is deployed and has a URL configured."
    );
  }

  process.stderr.write(`Opening ${fmt.url(url)}...\n`);

  var cmd;
  switch (platform()) {
    case "darwin":
      cmd = "open";
      break;
    case "win32":
      cmd = "start";
      break;
    default:
      cmd = "xdg-open";
      break;
  }

  try {
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    console.log(url);
  }
}
