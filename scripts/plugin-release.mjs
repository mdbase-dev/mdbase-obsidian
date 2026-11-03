import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const assets = ["main.js", "manifest.json", "styles.css"];
const numericVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function versionParts(version) {
  assert.match(version, numericVersion);
  const parts = version.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Unsafe plugin version");
  return parts;
}

export function compareVersions(left, right) {
  const other = versionParts(right);
  return versionParts(left).map((part, index) => part - other[index]).find((part) => part !== 0) ?? 0;
}

export function releaseState(releases, tagOutput, version) {
  versionParts(version);
  const published = releases.filter((release) => !release.draft && numericVersion.test(release.tag_name));
  published.sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  assert.ok(published.length, "No existing plugin release baseline; bootstrap explicitly");
  const baseline = published[0].tag_name;
  const tags = new Map();
  const references = new Map(tagOutput.split("\n").filter(Boolean).map((line) => {
    const [commit, ref] = line.split(/\s+/);
    return [ref, commit];
  }));
  for (const [ref, commit] of references) {
    const name = ref.replace(/^refs\/tags\//, "");
    if (numericVersion.test(name)) tags.set(name, references.get(`${ref}^{}`) ?? commit);
  }
  const pending = new Set(releases.filter((release) => release.draft && numericVersion.test(release.tag_name)).map((release) => release.tag_name));
  for (const name of tags.keys()) {
    if (!published.some((release) => release.tag_name === name)) pending.add(name);
  }
  assert.ok([...pending].every((name) => name === version), `Stuck publication blocks later releases: ${[...pending].join(", ")}`);
  return { baseline, tags, pending, published: published.some((release) => release.tag_name === version), draft: releases.find((release) => release.draft && release.tag_name === version) };
}

export function nextVersion(state, version) {
  assert.equal(state.pending.size, 0, "Finish the stuck publication before bumping again");
  const comparison = compareVersions(version, state.baseline);
  assert.ok(comparison >= 0, "Plugin version is behind the published release");
  if (comparison > 0) return version;
  const parts = versionParts(version);
  parts[2] += 1;
  const next = parts.join(".");
  versionParts(next);
  return next;
}

export function sameAssets(previous, current = ".") {
  for (const file of ["main.js", "styles.css"]) {
    if (!readFileSync(join(previous, file)).equals(readFileSync(join(current, file)))) return false;
  }
  const manifest = (directory) => {
    const value = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    delete value.version;
    return value;
  };
  return isDeepStrictEqual(manifest(previous), manifest(current));
}

function execute(...args) {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function stateFor(run, repository, version) {
  const releases = JSON.parse(run("gh", "api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`)).flat();
  return releaseState(releases, run("git", "ls-remote", "--tags", "origin"), version);
}

function isCurrent(run, environment) {
  assert.equal(environment.GITHUB_REPOSITORY, "mdbase-dev/mdbase-obsidian");
  assert.equal(environment.GITHUB_REF, "refs/heads/main");
  assert.ok(["push", "workflow_dispatch"].includes(environment.GITHUB_EVENT_NAME));
  assert.match(environment.GITHUB_SHA, /^[0-9a-f]{40}$/);
  return run("git", "ls-remote", "origin", "refs/heads/main").split(/\s/)[0] === environment.GITHUB_SHA;
}

export function releaseTarget(run = execute, environment = process.env) {
  if (!isCurrent(run, environment)) return { action: "none", reason: "stale" };
  assert.equal(run("git", "rev-parse", "HEAD"), environment.GITHUB_SHA);
  const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
  const state = stateFor(run, environment.GITHUB_REPOSITORY, version);
  if (state.published) return { action: "none", reason: "published" };
  assert.ok(compareVersions(version, state.baseline) > 0, "Plugin version is behind the published release");
  const sha = state.tags.get(version) ?? state.draft?.target_commitish ?? environment.GITHUB_SHA;
  assert.match(sha, /^[0-9a-f]{40}$/);
  run("git", "merge-base", "--is-ancestor", sha, environment.GITHUB_SHA);
  assert.equal(JSON.parse(run("git", "show", `${sha}:manifest.json`)).version, version);
  return { action: "publish", version, sha };
}

export function releasePlugin(run = execute, environment = process.env) {
  const none = (reason) => ({ action: "none", reason });
  if (!isCurrent(run, environment)) return none("stale");
  const sha = environment.RELEASE_SHA ?? environment.GITHUB_SHA;
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(run("git", "rev-parse", "HEAD"), sha);
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const version = manifest.version;
  const state = stateFor(run, environment.GITHUB_REPOSITORY, version);
  if (state.published) return none("published");
  assert.ok(compareVersions(version, state.baseline) > 0, "Plugin version is behind the published release");
  assert.ok(!state.tags.has(version) || state.tags.get(version) === sha, "Existing release tag points to a different commit");
  assert.ok(!state.draft || state.tags.has(version) || state.draft.target_commitish === sha, "Draft has no verifiable original commit");
  run("git", "merge-base", "--is-ancestor", sha, environment.GITHUB_SHA);
  run("git", "merge-base", "--is-ancestor", `refs/tags/${state.baseline}^{}`, sha);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(pkg.version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);
  assert.equal(JSON.parse(readFileSync("versions.json", "utf8"))[version], manifest.minAppVersion);
  for (const file of assets) assert.ok(statSync(file).size > 0, `Missing or empty release asset: ${file}`);
  assert.equal(run("git", "show", `${sha}:manifest.json`), readFileSync("manifest.json", "utf8").trim());
  const directory = mkdtempSync(join(tmpdir(), "obsidian-release-"));
  try {
    run("gh", "release", "download", state.baseline, "--dir", directory, ...assets.flatMap((file) => ["--pattern", file]));
    if (sameAssets(directory)) return none("unchanged-assets");
    if (!isCurrent(run, environment)) return none("stale");
    if (!state.tags.has(version)) {
      run("git", "config", "user.name", `${environment.APP_SLUG}[bot]`);
      run("git", "config", "user.email", `${environment.APP_SLUG}[bot]@users.noreply.github.com`);
      run("git", "tag", "--annotate", version, sha, "--message", `mdbase Obsidian ${version}`);
      run("git", "push", "origin", `refs/tags/${version}`);
    }
    if (!isCurrent(run, environment)) return none("stale");
    if (!state.draft) run("gh", "release", "create", version, "--verify-tag", "--target", sha, "--draft", "--prerelease", "--title", `mdbase Obsidian ${version}`, "--notes", `Built and validated from ${sha}. Includes main.js, manifest.json and styles.css.`);
    run("gh", "release", "upload", version, ...assets, "--clobber");
    run("gh", "release", "download", version, "--dir", directory, "--clobber", ...assets.flatMap((file) => ["--pattern", file]));
    for (const file of assets) {
      const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
      assert.equal(digest(join(directory, file)), digest(file), `Uploaded asset mismatch: ${file}`);
    }
    if (!isCurrent(run, environment)) return none("stale");
    run("gh", "release", "edit", version, "--draft=false", "--prerelease=true", "--latest=false");
    return { action: "publish", version, sha };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "next-version") {
    const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
    console.log(nextVersion(stateFor(execute, "mdbase-dev/mdbase-obsidian", version), version));
  } else if (process.argv[2] === "target") {
    const target = releaseTarget();
    appendFileSync(process.env.GITHUB_OUTPUT, `ref=${target.sha ?? ""}\n`);
    console.log(JSON.stringify(target));
  } else {
    console.log(JSON.stringify(releasePlugin()));
  }
}
