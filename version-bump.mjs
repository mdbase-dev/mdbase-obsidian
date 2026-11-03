import { readFileSync, writeFileSync } from "fs";
import assert from "node:assert/strict";

const manifestPath = "manifest.json";
const versionsPath = "versions.json";
const packagePath = "package.json";
const lockPath = "package-lock.json";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const version = process.argv[2] ?? process.env.npm_package_version ?? pkg.version;
assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
manifest.version = version;
pkg.version = version;
lock.version = version;
lock.packages[""].version = version;

versions[manifest.version] = manifest.minAppVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
