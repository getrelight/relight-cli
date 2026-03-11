import { readFileSync, writeFileSync, unlinkSync } from "fs";
import YAML from "yaml";
import { fatal, fmt } from "./output.js";

var LINK_FILE = ".relight.yaml";

export function readLink() {
  try {
    var raw = readFileSync(LINK_FILE, "utf-8");
    return YAML.parse(raw);
  } catch {
    return null;
  }
}

export function linkApp(name, compute, dns, db, dbProvider, registry) {
  var data = { app: name };
  if (compute) data.compute = compute;
  if (dns && dns !== compute) data.dns = dns;
  if (db) data.db = db;
  if (dbProvider) data.dbProvider = dbProvider;
  if (registry && registry !== compute) data.registry = registry;
  writeFileSync(LINK_FILE, YAML.stringify(data));
}

export function unlinkApp() {
  try {
    unlinkSync(LINK_FILE);
  } catch {}
}

export function resolveAppName(name) {
  if (name) return name;
  var linked = readLink();
  if (linked && linked.app) return linked.app;
  fatal(
    "No app specified.",
    `Provide an app name or run ${fmt.cmd("relight deploy")} in this directory first.`
  );
}
