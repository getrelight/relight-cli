import { readFileSync, writeFileSync, unlinkSync } from "fs";
import YAML from "yaml";
import { fatal, fmt } from "./output.js";

var LINK_FILE = ".relight.yaml";

export function readLink() {
  try {
    var raw = readFileSync(LINK_FILE, "utf-8");
    // Support both YAML and legacy JSON
    return YAML.parse(raw);
  } catch {
    return null;
  }
}

export function linkApp(name, cloud, dns, db) {
  var data = { app: name, cloud };
  if (dns && dns !== cloud) data.dns = dns;
  if (db && db !== cloud) data.db = db;
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

export function resolveCloud(cloud) {
  if (cloud) return cloud;
  var linked = readLink();
  if (linked && linked.cloud) return linked.cloud;
  return null;
}

export function resolveDns() {
  var linked = readLink();
  return linked?.dns || null;
}

export function resolveDb() {
  var linked = readLink();
  return linked?.db || null;
}
