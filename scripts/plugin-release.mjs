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

// ---- Quiet prereleases ------------------------------------------------------
// A merge to main does not publish by itself. Once no commit has landed on main
// for three hours and main's plugin bytes differ from the newest release, the
// scheduled job opens a version PR set to merge when required CI passes; that
// merge publishes the prerelease (releasePlugin). A burst of merges ships once.
export const quietMs = 3 * 60 * 60 * 1000;
const versionFiles = ["manifest.json", "versions.json", "package.json", "package-lock.json"];
const releaseBranch = /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
// Paths that cannot change main.js, styles.css or the manifest. A diff touching
// only these skips the build; otherwise the built bytes decide.
const inert = [/\.md$/, /^docs\//, /^test\//, /^\.github\//, /^LICENSE$/];

/** When main becomes quiet, or null if it already is. */
export function quietUntil(mainCommittedAt, now) {
  const committed = Date.parse(mainCommittedAt);
  assert.ok(Number.isFinite(committed), "Unreadable main commit time");
  return now - committed < quietMs ? new Date(committed + quietMs).toISOString() : null;
}

export function needsBuild(changedPaths) {
  return changedPaths.some((path) => !inert.some((pattern) => pattern.test(path)));
}

/**
 * Decide whether quiet main needs a prerelease. Moves an open release PR along
 * instead (bring it up to date, ask it to merge) when one exists.
 */
export function quietCheck(run = execute, environment = process.env, now = Date.now()) {
  const repository = environment.GITHUB_REPOSITORY;
  assert.equal(repository, "mdbase-dev/mdbase-obsidian");
  const none = (reason, extra = {}) => ({ action: "none", reason, ...extra });
  const readyAt = quietUntil(run("gh", "api", `repos/${repository}/commits/main`, "--jq", ".commit.committer.date"), now);
  if (readyAt) return none("recent", { readyAt });
  const open = JSON.parse(run("gh", "pr", "list", "--repo", repository, "--base", "main", "--state", "open", "--json", "number,headRefName,mergeStateStatus,autoMergeRequest,url"))
    .filter((pull) => releaseBranch.test(pull.headRefName));
  assert.ok(open.length <= 1, `More than one open release PR: ${open.map((pull) => pull.url).join(", ")}`);
  if (open.length) {
    const [pull] = open;
    if (pull.mergeStateStatus === "BEHIND") run("gh", "pr", "update-branch", String(pull.number), "--repo", repository);
    if (!pull.autoMergeRequest) run("gh", "pr", "merge", String(pull.number), "--repo", repository, "--auto", "--merge");
    return { action: "pending", url: pull.url };
  }
  const head = run("git", "rev-parse", "HEAD");
  assert.equal(run("git", "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], head, "Checkout is not current main");
  const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
  const state = stateFor(run, repository, version);
  if (state.pending.size) return none("publishing", { version });
  // A bumped version still unpublished is the Build's to publish, not a new bump.
  if (compareVersions(version, state.baseline) > 0) return none("version-unpublished", { version });
  const released = state.tags.get(state.baseline);
  assert.match(released ?? "", /^[0-9a-f]{40}$/, `Newest release ${state.baseline} has no tag`);
  if (!needsBuild(run("git", "diff", "--name-only", released, head).split("\n").filter(Boolean))) {
    return none("unchanged", { baseline: state.baseline });
  }
  return { action: "build", head, baseline: state.baseline };
}

/** With main built, open the version PR if its bytes differ from the newest release. */
export function quietOpen(run = execute, environment = process.env, now = Date.now()) {
  const decision = quietCheck(run, environment, now);
  if (decision.action !== "build") return decision;
  const repository = environment.GITHUB_REPOSITORY;
  const directory = mkdtempSync(join(tmpdir(), "obsidian-quiet-"));
  try {
    run("gh", "release", "download", decision.baseline, "--repo", repository, "--dir", directory, ...assets.flatMap((file) => ["--pattern", file]));
    if (sameAssets(directory)) return { action: "none", reason: "unchanged-assets", baseline: decision.baseline };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
  const next = nextVersion(stateFor(run, repository, version), version);
  const branch = `release/${next}`;
  // A leftover branch means its PR was closed without merging: someone held this
  // release back. Deleting the branch lets it be opened again.
  if (run("git", "ls-remote", "--heads", "origin", `refs/heads/${branch}`)) return { action: "none", reason: "held", branch };
  run("node", "version-bump.mjs", next);
  run("git", "config", "user.name", `${environment.APP_SLUG}[bot]`);
  run("git", "config", "user.email", `${environment.APP_SLUG}[bot]@users.noreply.github.com`);
  run("git", "switch", "--create", branch);
  run("git", "add", ...versionFiles);
  run("git", "commit", "--message", `Release Obsidian plugin ${next}`);
  run("git", "push", "origin", `HEAD:refs/heads/${branch}`);
  const url = run("gh", "pr", "create", "--repo", repository, "--base", "main", "--head", branch, "--title", `Release Obsidian plugin ${next}`, "--body",
    `Main has been quiet for three hours and its plugin bytes differ from ${decision.baseline}. ` +
    `This PR merges itself when required CI passes, and the merge publishes ${next} as a prerelease. ` +
    "To hold the release, close this PR and keep its branch; delete the branch to let it be opened again.");
  run("gh", "pr", "merge", url, "--repo", repository, "--auto", "--merge");
  return { action: "open", version: next, url };
}

// ---- Full releases -----------------------------------------------------------
// Only by hand (promote.yml, workflow_dispatch): the newest published prerelease
// becomes the full release marked Latest, which Obsidian's community list serves.
export function promotionDecision(releases, tagOutput) {
  const numeric = releases.filter((release) => numericVersion.test(release.tag_name));
  const published = numeric.filter((release) => !release.draft);
  published.sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  const candidate = published[0];
  if (!candidate) return { action: "none", reason: "no-release" };
  if (!candidate.prerelease) return { action: "none", reason: "current", version: candidate.tag_name };
  const tags = tagOutput.split("\n").map((line) => line.split(/\s+/)[1]?.replace(/^refs\/tags\//, "")).filter((name) => numericVersion.test(name ?? ""));
  if (numeric.some((release) => release.draft) || tags.some((name) => !published.some((release) => release.tag_name === name))) {
    return { action: "none", reason: "publishing" };
  }
  return { action: "promote", version: candidate.tag_name };
}

export function promoteRelease(run = execute, environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY;
  assert.equal(repository, "mdbase-dev/mdbase-obsidian");
  const releases = JSON.parse(run("gh", "api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`)).flat();
  const decision = promotionDecision(releases, run("git", "ls-remote", "--tags", "origin"));
  if (decision.action === "promote") {
    run("gh", "release", "edit", decision.version, "--repo", repository, "--prerelease=false", "--latest");
  }
  return decision;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "next-version") {
    const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
    console.log(nextVersion(stateFor(execute, "mdbase-dev/mdbase-obsidian", version), version));
  } else if (process.argv[2] === "promote") {
    console.log(JSON.stringify(promoteRelease()));
  } else if (process.argv[2] === "quiet") {
    const decision = quietCheck();
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${decision.action === "build"}\n`);
    console.log(JSON.stringify(decision));
  } else if (process.argv[2] === "quiet-open") {
    console.log(JSON.stringify(quietOpen()));
  } else if (process.argv[2] === "target") {
    const target = releaseTarget();
    appendFileSync(process.env.GITHUB_OUTPUT, `ref=${target.sha ?? ""}\n`);
    console.log(JSON.stringify(target));
  } else {
    console.log(JSON.stringify(releasePlugin()));
  }
}
