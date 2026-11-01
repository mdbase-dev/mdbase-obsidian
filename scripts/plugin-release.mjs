import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const assets = ["main.js", "manifest.json", "styles.css"];
const releasePaths = ["main.ts", "src", "styles.css", "esbuild.config.mjs", "scripts/check-mobile.mjs", "package.json", "package-lock.json", "manifest.json"];
const versionFiles = ["manifest.json", "versions.json", "package.json", "package-lock.json"];

export function versionParts(version) {
  assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  const parts = version.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Unsafe plugin version");
  return parts;
}

export function compareVersions(left, right) {
  const other = versionParts(right);
  return versionParts(left).map((part, index) => part - other[index]).find((part) => part !== 0) ?? 0;
}

export function releasePlan(releases, version, changed) {
  versionParts(version);
  const published = releases.filter((release) => !release.draft && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(release.tag_name));
  published.sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  assert.ok(published.length, "No existing plugin release baseline; bootstrap explicitly");
  const baseline = published[0].tag_name;
  const comparison = compareVersions(version, baseline);
  assert.ok(comparison >= 0, "Plugin version is behind the published release");
  if (!changed) return { action: "none", baseline, version };
  if (comparison > 0) return { action: "publish", baseline, version };
  const parts = versionParts(version);
  parts[2] += 1;
  return { action: "bump", baseline, version: parts.join(".") };
}

function execute(...args) {
  return execFileSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function releasePlugin(run = execute, environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY;
  const sha = environment.GITHUB_SHA;
  assert.equal(repository, "mdbase-dev/mdbase-obsidian");
  assert.equal(environment.GITHUB_REF, "refs/heads/main");
  assert.ok(["push", "workflow_dispatch"].includes(environment.GITHUB_EVENT_NAME));
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(run("git", "rev-parse", "HEAD"), sha);
  const assertCurrent = () => assert.equal(
    run("git", "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], sha,
    "Main advanced; use its successful Build, not stale assets",
  );
  assertCurrent();
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const versions = JSON.parse(readFileSync("versions.json", "utf8"));
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  for (const file of assets) assert.ok(statSync(file).size > 0, `Missing or empty release asset: ${file}`);
  assert.equal(run("git", "show", `${sha}:manifest.json`), readFileSync("manifest.json", "utf8").trim());
  const releases = JSON.parse(run("gh", "api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`)).flat();
  const baseline = releasePlan(releases, manifest.version, false).baseline;
  run("git", "merge-base", "--is-ancestor", `refs/tags/${baseline}^{}`, sha);
  const changed = run("git", "diff", "--name-only", `refs/tags/${baseline}^{}`, sha, "--", ...releasePaths) !== "";
  const plan = releasePlan(releases, manifest.version, changed);
  if (plan.action === "none") return plan;
  run("git", "config", "user.name", `${environment.APP_SLUG}[bot]`);
  run("git", "config", "user.email", `${environment.APP_SLUG}[bot]@users.noreply.github.com`);
  if (plan.action === "bump") {
    const branch = "automation/plugin-release";
    const previous = run("git", "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0];
    run("git", "switch", "--create", branch);
    run("node", "version-bump.mjs", plan.version);
    run("git", "add", "--", ...versionFiles);
    run("git", "commit", "-m", `Release Obsidian plugin ${plan.version}`);
    assertCurrent();
    run("git", "push", `--force-with-lease=refs/heads/${branch}:${previous}`, "origin", `HEAD:refs/heads/${branch}`);
    const title = `Release Obsidian plugin ${plan.version}`;
    const body = `Automated version bump after checked main ${sha}. Required Obsidian plugin CI gates auto-merge. The successful main build publishes tag ${plan.version} and the three validated plugin assets. No branch-protection bypass.`;
    let pull = run("gh", "pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "number", "--jq", ".[0].number // empty");
    if (pull) run("gh", "pr", "edit", pull, "--title", title, "--body", body);
    else pull = run("gh", "pr", "create", "--head", branch, "--base", "main", "--title", title, "--body", body);
    run("gh", "pr", "merge", pull, "--auto", "--squash");
    return plan;
  }
  const existing = releases.find((release) => release.tag_name === plan.version);
  assert.ok(!existing || existing.draft, "Refusing to modify a published release");
  const remoteTag = run("git", "ls-remote", "origin", `refs/tags/${plan.version}`, `refs/tags/${plan.version}^{}`);
  assertCurrent();
  if (remoteTag) {
    const references = new Map(remoteTag.split("\n").map((line) => {
      const [commit, ref] = line.split(/\s+/);
      return [ref, commit];
    }));
    const tagCommit = references.get(`refs/tags/${plan.version}^{}`) ?? references.get(`refs/tags/${plan.version}`);
    assert.equal(tagCommit, sha, "Existing release tag points to a different commit");
  } else {
    assert.ok(!existing, "Draft release is missing its tag");
    run("git", "tag", "--annotate", plan.version, sha, "--message", `mdbase Obsidian ${plan.version}`);
    run("git", "push", "origin", `refs/tags/${plan.version}`);
  }
  if (!existing) run("gh", "release", "create", plan.version, "--verify-tag", "--target", sha, "--draft", "--title", `mdbase Obsidian ${plan.version}`, "--notes", `Built and validated from ${sha}. Includes main.js, manifest.json and styles.css.`);
  run("gh", "release", "upload", plan.version, ...assets, "--clobber");
  const directory = mkdtempSync(join(tmpdir(), "obsidian-release-"));
  try {
    run("gh", "release", "download", plan.version, "--dir", directory);
    for (const file of assets) {
      const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
      assert.equal(digest(join(directory, file)), digest(file), `Uploaded asset mismatch: ${file}`);
    }
    assertCurrent();
    run("gh", "release", "edit", plan.version, "--draft=false", "--prerelease=false", "--latest");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(JSON.stringify(releasePlugin()));
}
