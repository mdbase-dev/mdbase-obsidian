#!/usr/bin/env node

import { copyFile, mkdir, access, constants, readFile, writeFile } from "fs/promises";
import { isAbsolute, join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_OVERRIDE_FILE = ".copy-files.local";
const TASKNOTES_OVERRIDE_FILE = join(__dirname, "..", "tasknotes", ".copy-files.local");

const defaultPaths = [
  join(__dirname, "..", "tasknotes", "tasknotes-e2e-vault", ".obsidian", "plugins", "mdbase-sync"),
];

const expandTilde = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function toPluginPath(pathValue) {
  if (pathValue.endsWith("/tasknotes")) return `${pathValue.slice(0, -"/tasknotes".length)}/mdbase-sync`;
  return pathValue;
}

async function readOverrideFile(pathValue, baseDir) {
  try {
    const raw = await readFile(pathValue, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map(expandTilde)
      .map((line) => (isAbsolute(line) ? line : resolve(baseDir, line)));
    return lines;
  } catch {
    return [];
  }
}

let copyPaths = defaultPaths;
if (process.env.OBSIDIAN_PLUGIN_PATH) {
  copyPaths = [expandTilde(process.env.OBSIDIAN_PLUGIN_PATH)];
} else {
  const localPaths = await readOverrideFile(join(__dirname, LOCAL_OVERRIDE_FILE), __dirname);
  if (localPaths.length > 0) {
    copyPaths = localPaths;
  } else {
    const tasknotesPaths = await readOverrideFile(TASKNOTES_OVERRIDE_FILE, join(__dirname, "..", "tasknotes"));
    if (tasknotesPaths.length > 0) {
      copyPaths = tasknotesPaths.map(toPluginPath);
    }
  }
}

const files = ["main.js", "styles.css", "manifest.json"];

async function copyToDestination(destPath) {
  const resolvedPath = resolve(destPath);
  await mkdir(resolvedPath, { recursive: true });

  await Promise.all(
    files.map(async (file) => {
      await access(file, constants.F_OK);
      if (file === "manifest.json") {
        // manifest.json in the repo carries the community list's version; a
        // local build is the version in package.json, as release assets are.
        const manifest = JSON.parse(await readFile(file, "utf8"));
        manifest.version = JSON.parse(await readFile("package.json", "utf8")).version;
        await writeFile(join(resolvedPath, file), JSON.stringify(manifest, null, "\t") + "\n");
        return;
      }
      await copyFile(file, join(resolvedPath, file));
    }),
  );

  console.log(`Copied files to: ${resolvedPath}`);
}

try {
  for (const pathValue of copyPaths) {
    await copyToDestination(pathValue);
  }
  console.log(`Copied ${files.length} files to ${copyPaths.length} destination(s)`);
} catch (error) {
  console.error("Failed to copy files:", error.message);
  process.exit(1);
}
