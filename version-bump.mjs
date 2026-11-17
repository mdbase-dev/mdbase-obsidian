import { readFileSync, writeFileSync } from "fs";
import assert from "node:assert/strict";

// Bumps the version being built and prereleased. manifest.json keeps the
// version Obsidian's community list serves (the newest full release); only
// promotion moves it (scripts/plugin-release.mjs). Release assets get a
// manifest stamped with this version at publication.
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
pkg.version = version;
lock.version = version;
lock.packages[""].version = version;

versions[version] = manifest.minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
