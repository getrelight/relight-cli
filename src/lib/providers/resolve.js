import { readLink } from "../link.js";
import {
  PROVIDERS,
  getProviderConfig,
  getConfiguredProviders,
  getDefault,
  normalizeProviderConfig,
} from "../config.js";
import { fatal, fmt } from "../output.js";

export var LAYERS = ["app", "dns", "db", "registry"];

var FLAG_MAP = { app: "compute", dns: "dns", db: "db", registry: "registry" };

export async function resolveStack(options, requiredLayers) {
  if (!requiredLayers) requiredLayers = ["app"];
  var stack = {};

  for (var layer of requiredLayers) {
    var name = resolveProviderName(options, layer);
    var instance = getProviderConfig(name);
    var type = instance.type;

    if (!PROVIDERS[type]) {
      fatal(`Unknown provider type '${type}' for provider '${name}'.`);
    }
    if (!PROVIDERS[type].layers.includes(layer)) {
      fatal(
        `Provider '${name}' (${PROVIDERS[type].name}) doesn't support ${layer}.`,
        `Supported layers: ${PROVIDERS[type].layers.join(", ")}`
      );
    }

    var cfg = { ...normalizeProviderConfig(instance), providerName: name };
    var provider = await import(`./${type}/${layer}.js`);

    stack[layer] = { name, type, cfg, provider };
  }

  return stack;
}

function resolveProviderName(options, layer) {
  var flag = FLAG_MAP[layer];

  // 1. Explicit flag (--compute, --dns, --db, --registry)
  if (options[flag]) return options[flag];

  // 2. .relight.yaml
  var linked = readLink();
  if (layer === "app" && linked?.compute) return linked.compute;
  if (layer === "registry" && linked?.registry) return linked.registry;
  if (layer === "dns") {
    if (linked?.dns) return linked.dns;
    if (linked?.compute) return linked.compute;
  }
  if (layer === "db" && linked?.dbProvider) return linked.dbProvider;

  // 3. Config defaults
  var defaultName = getDefault(layer);
  if (defaultName) return defaultName;
  if (layer === "registry") {
    if (linked?.compute) return linked.compute;
    defaultName = getDefault("app");
    if (defaultName) return defaultName;
  }

  // 4. Auto-resolve: only one provider supports this layer
  var candidates = getConfiguredProviders().filter((p) =>
    PROVIDERS[p.type].layers.includes(layer)
  );
  if (candidates.length === 1) return candidates[0].name;

  if (candidates.length === 0) {
    fatal(
      `No provider configured for ${layer}.`,
      `Run ${fmt.cmd("relight providers add")} to add one.`
    );
  }

  fatal(
    `Multiple providers support ${layer}: ${candidates.map((c) => c.name).join(", ")}`,
    `Use ${fmt.cmd(`--${flag} <name>`)} to pick one.`
  );
}
