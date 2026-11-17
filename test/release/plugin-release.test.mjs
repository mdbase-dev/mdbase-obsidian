import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { listedVersion, needsBuild, nextVersion, pointListing, promoteRelease, promotionDecision, quietCheck, quietOpen, quietUntil, releasePlugin, releaseState, releaseTarget, sameAssets, stampedManifest } from "../../scripts/plugin-release.mjs";

const sha = "a".repeat(40);
const older = "b".repeat(40);
const baseline = { tag_name: "0.4.2", draft: false, prerelease: true };
const environment = { GITHUB_REPOSITORY: "mdbase-dev/mdbase-obsidian", GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", APP_SLUG: "fixture" };
const tagsFor = (version, commit = sha) => `${"c".repeat(40)}\trefs/tags/${version}\n${commit}\trefs/tags/${version}^{}`;
const mutations = (calls) => calls.filter((args) => (args[0] === "gh" && args[1] === "release" && ["create", "upload", "edit"].includes(args[2])) || (args[0] === "git" && ["push", "tag"].includes(args[1])));

function fixture(options, callback) {
  const directory = mkdtempSync(join(tmpdir(), "obsidian-release-test-"));
  const original = process.cwd();
  const version = options.version ?? "0.4.3";
  // main's manifest names the listed full release; package.json the build version.
  const manifest = JSON.stringify({ id: "mdbase-obsidian", version: options.listed ?? "0.4.2", minAppVersion: "1.11.4" }) + "\n";
  const calls = [];
  let uploaded = [];
  let observations = 0;
  try {
    process.chdir(directory);
    writeFileSync("manifest.json", manifest);
    writeFileSync("package.json", JSON.stringify({ version }));
    writeFileSync("package-lock.json", JSON.stringify({ version, packages: { "": { version } } }));
    writeFileSync("versions.json", JSON.stringify({ [version]: "1.11.4" }));
    writeFileSync("main.js", "fixture bundle");
    writeFileSync("styles.css", "fixture styles");
    const run = (...args) => {
      calls.push(args);
      const command = args.slice(0, 3).join(" ");
      if (command === "git rev-parse HEAD") return options.head ?? sha;
      if (command === "git ls-remote --tags") return options.tags ?? (options.tag ? tagsFor(version, options.tagCommit ?? sha) : "");
      if (command === "git ls-remote origin") {
        observations += 1;
        return `${observations >= (options.staleAt ?? Infinity) ? older : sha}\trefs/heads/main`;
      }
      if (args[0] === "git" && args[1] === "show") return args[2].endsWith(":package.json") ? JSON.stringify({ version }) : manifest.trim();
      if (command === "git merge-base --is-ancestor" && options.diverged) throw new Error("release is not an ancestor");
      if (command === "gh api --paginate") return JSON.stringify([[baseline, ...(options.published ? [{ tag_name: version, draft: false }] : []), ...(options.draft ? [{ tag_name: version, draft: true, target_commitish: options.draftTarget ?? sha }] : [])]]);
      if (command === "gh release upload" && options.uploadFailure) throw new Error("upload interrupted");
      if (command === "gh release upload") uploaded = args.slice(4).filter((value) => !value.startsWith("--")).map((path) => [path.split("/").at(-1), readFileSync(path)]);
      if (command === "gh release download") {
        if (options.downloadFailure) throw new Error("asset download failed");
        const destination = args[args.indexOf("--dir") + 1];
        for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(file, join(destination, file));
        for (const [file, bytes] of uploaded) writeFileSync(join(destination, file), bytes);
        if (args[3] === "0.4.2") {
          if (!options.unchanged) writeFileSync(join(destination, "main.js"), "previous bundle");
          writeFileSync(join(destination, "manifest.json"), JSON.stringify({ minAppVersion: "1.11.4", version: "0.4.2", id: "mdbase-obsidian" }));
        } else if (options.corrupt) writeFileSync(join(destination, "main.js"), "wrong bytes");
      }
      return "";
    };
    callback({ run, calls, directory });
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("next version is selected in the repin PR, reusing an untagged version", () => {
  assert.equal(nextVersion(releaseState([baseline], "", "0.4.2"), "0.4.2"), "0.4.3");
  assert.equal(nextVersion(releaseState([baseline], "", "0.4.3"), "0.4.3"), "0.4.3");
  assert.throws(() => nextVersion(releaseState([baseline], tagsFor("0.4.3"), "0.4.3"), "0.4.3"), /stuck publication/);
  assert.throws(() => nextVersion(releaseState([baseline], "", "0.4.1"), "0.4.1"), /behind/);
  assert.throws(() => releaseState([], "", "0.4.3"), /baseline/);
  assert.throws(() => releaseState([baseline], "", "v0.4.3"));
});

test("version-bump moves the build version and leaves the listed manifest alone", () => {
  fixture({ version: "0.4.2" }, () => {
    const manifest = readFileSync("manifest.json", "utf8");
    execFileSync("node", [fileURLToPath(new URL("../../version-bump.mjs", import.meta.url)), "0.4.3"]);
    for (const file of ["package.json", "package-lock.json"]) assert.equal(JSON.parse(readFileSync(file, "utf8")).version, "0.4.3");
    assert.equal(JSON.parse(readFileSync("package-lock.json", "utf8")).packages[""].version, "0.4.3");
    assert.equal(JSON.parse(readFileSync("versions.json", "utf8"))["0.4.3"], "1.11.4");
    assert.equal(readFileSync("manifest.json", "utf8"), manifest);
  });
});

test("the published manifest is main's manifest at the build version", () => {
  fixture({}, ({ run, calls }) => {
    const before = readFileSync("manifest.json", "utf8");
    assert.equal(releasePlugin(run, environment).action, "publish");
    assert.equal(readFileSync("manifest.json", "utf8"), before);
    const upload = calls.find((args) => args.slice(0, 3).join(" ") === "gh release upload");
    const path = upload.find((value) => value.endsWith("/manifest.json"));
    assert.ok(path && path !== "manifest.json");
    assert.ok(upload.includes("main.js") && upload.includes("styles.css"));
  });
  fixture({}, ({ directory }) => {
    const staged = join(directory, "staged");
    mkdirSync(staged);
    const stamped = JSON.parse(readFileSync(stampedManifest(staged), "utf8"));
    assert.deepEqual(stamped, { ...JSON.parse(readFileSync("manifest.json", "utf8")), version: "0.4.3" });
  });
});

test("refuses to publish while main's manifest is ahead of the build version", () => {
  fixture({ listed: "0.4.3" }, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, environment), /ahead/);
    assert.equal(mutations(calls).length, 0);
  });
});

test("ordinary merges with a published build version do not release or bump", () => {
  fixture({ version: "0.4.2" }, ({ run, calls }) => {
    assert.equal(releaseTarget(run, environment).reason, "published");
    assert.equal(releasePlugin(run, environment).reason, "published");
    assert.equal(mutations(calls).length, 0);
    assert.ok(!calls.some((args) => args[1] === "pr"));
  });
});

test("asset equality ignores only manifest version, not source paths", () => {
  fixture({ unchanged: true }, ({ run, calls }) => {
    assert.equal(releasePlugin(run, environment).reason, "unchanged-assets");
    assert.equal(mutations(calls).length, 0);
  });
  fixture({}, ({ directory }) => {
    const previous = join(directory, "previous");
    mkdirSync(previous);
    for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(file, join(previous, file));
    assert.ok(sameAssets(previous));
    writeFileSync("styles.css", "changed styles");
    assert.ok(!sameAssets(previous));
    copyFileSync(join(previous, "styles.css"), "styles.css");
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    manifest.minAppVersion = "1.12.0";
    writeFileSync("manifest.json", JSON.stringify(manifest));
    assert.ok(!sameAssets(previous));
  });
});

test("publishes once as a prerelease only after all asset downloads match", () => {
  fixture({}, ({ run, calls }) => {
    assert.equal(releaseTarget(run, environment).sha, sha);
    assert.equal(releasePlugin(run, environment).action, "publish");
    const tag = calls.find((args) => args.slice(0, 3).join(" ") === "git tag --annotate");
    assert.deepEqual(tag.slice(3, 5), ["0.4.3", sha]);
    const upload = calls.findIndex((args) => args.slice(0, 3).join(" ") === "gh release upload");
    const publish = calls.findIndex((args) => args.slice(0, 3).join(" ") === "gh release edit");
    assert.ok(upload < publish);
    assert.ok(calls[publish].includes("--prerelease=true"));
    assert.ok(calls[publish].includes("--latest=false"));
  });
  fixture({ published: true }, ({ run, calls }) => {
    assert.equal(releasePlugin(run, environment).reason, "published");
    assert.equal(mutations(calls).length, 0);
  });
});

test("tag-only and draft retries resume without recreating or moving the tag", () => {
  for (const draft of [true, false]) fixture({ tag: true, draft }, ({ run, calls }) => {
    releasePlugin(run, environment);
    assert.ok(!calls.some((args) => args[0] === "git" && ["tag", "push"].includes(args[1])));
    assert.equal(calls.some((args) => args.slice(0, 3).join(" ") === "gh release create"), !draft);
  });
});

test("same version on newer main selects and rebuilds the original tagged commit", () => {
  fixture({ tag: true, tagCommit: older }, ({ run }) => {
    assert.deepEqual(releaseTarget(run, environment), { action: "publish", version: "0.4.3", sha: older });
  });
  fixture({ tag: true, tagCommit: older, head: older, draft: true }, ({ run, calls }) => {
    assert.equal(releasePlugin(run, { ...environment, RELEASE_SHA: older }).sha, older);
    assert.ok(!calls.some((args) => args[0] === "git" && args[1] === "tag"));
  });
});

test("draft-only recovery restores its recorded commit, not newer main", () => {
  fixture({ draft: true, draftTarget: older }, ({ run }) => {
    assert.equal(releaseTarget(run, environment).sha, older);
  });
  fixture({ draft: true, draftTarget: older, head: older }, ({ run, calls }) => {
    assert.equal(releasePlugin(run, { ...environment, RELEASE_SHA: older }).sha, older);
    assert.ok(calls.some((args) => args[0] === "git" && args[1] === "tag" && args[4] === older));
    assert.ok(!calls.some((args) => args.slice(0, 3).join(" ") === "gh release create"));
  });
});

test("stuck tag or draft blocks later release versions and version bumps", () => {
  for (const tags of [tagsFor("0.4.3"), ""]) {
    const releases = [baseline, ...(tags ? [] : [{ tag_name: "0.4.3", draft: true }])];
    assert.throws(() => releaseState(releases, tags, "0.4.4"), /Stuck publication/);
  }
  fixture({ version: "0.4.4", tags: tagsFor("0.4.3") }, ({ run, calls }) => {
    assert.throws(() => releaseTarget(run, environment), /Stuck publication/);
    assert.equal(mutations(calls).length, 0);
  });
  assert.throws(() => releaseState([baseline], tagsFor("0.4.1"), "0.4.4"), /Stuck publication/);
});

test("refuses ambiguous draft target, wrong tag SHA, divergent history and PR events", () => {
  for (const options of [{ draft: true, draftTarget: "main" }, { tag: true, tagCommit: older }, { diverged: true }]) fixture(options, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, environment));
    assert.equal(mutations(calls).length, 0);
  });
  fixture({}, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, { ...environment, GITHUB_EVENT_NAME: "pull_request" }));
    assert.equal(calls.length, 0);
  });
});

test("stale jobs are successful no-ops at every mutation boundary", () => {
  fixture({ staleAt: 1 }, ({ run, calls }) => {
    assert.equal(releaseTarget(run, environment).reason, "stale");
    assert.equal(mutations(calls).length, 0);
  });
  for (const staleAt of [1, 2, 3, 4]) fixture({ staleAt }, ({ run, calls }) => {
    assert.equal(releasePlugin(run, environment).reason, "stale");
    assert.ok(!calls.some((args) => args.slice(0, 3).join(" ") === "gh release edit"));
    if (staleAt <= 2) assert.equal(mutations(calls).length, 0);
  });
});

test("failed downloads, uploads and corrupt bytes never make a draft public", () => {
  for (const options of [{ uploadFailure: true }, { corrupt: true }, { downloadFailure: true }]) fixture(options, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, environment));
    assert.ok(!calls.some((args) => args.slice(0, 3).join(" ") === "gh release edit"));
  });
});

test("promotion by hand picks the newest prerelease, never during publication", () => {
  const full = { tag_name: "0.4.28", draft: false, prerelease: false };
  const newest = { tag_name: "0.4.32", draft: false, prerelease: true };
  const releases = [full, { tag_name: "0.4.31", draft: false, prerelease: true }, newest];
  assert.deepEqual(promotionDecision(releases, tagsFor("0.4.32")), { action: "promote", version: "0.4.32" });
  assert.equal(promotionDecision([full, { ...newest, prerelease: false }], "").reason, "current");
  assert.equal(promotionDecision([...releases, { tag_name: "0.4.33", draft: true }], "").reason, "publishing");
  assert.equal(promotionDecision(releases, tagsFor("0.4.33")).reason, "publishing");
});

// main's manifest lists 0.4.2; 0.4.3 is the newest prerelease unless `promoted`.
function listing(options, callback) {
  const directory = mkdtempSync(join(tmpdir(), "obsidian-listing-test-"));
  const original = process.cwd();
  const calls = [];
  let promoted = options.promoted ?? false;
  try {
    process.chdir(directory);
    writeFileSync("manifest.json", JSON.stringify({ id: "mdbase-sync", version: options.listed ?? "0.4.2", minAppVersion: "1.11.4" }, null, "\t") + "\n");
    const run = (...args) => {
      calls.push(args);
      const command = args.slice(0, 3).join(" ");
      if (command === "gh api --paginate") return JSON.stringify([[{ tag_name: "0.4.3", draft: false, prerelease: !promoted }, { ...baseline, prerelease: false }]]);
      if (command === "gh release edit") promoted = true;
      if (command === "gh pr list") return JSON.stringify(options.pulls ?? []);
      if (command === "git ls-remote --heads") return options.held ? `${sha}\t${args[4]}` : "";
      if (command === "git rev-parse HEAD") return sha;
      if (command === "git ls-remote origin") return `${sha}\trefs/heads/main`;
      if (command === "gh pr create") return "https://github.com/mdbase-dev/mdbase-obsidian/pull/201";
      return "";
    };
    callback({ run, calls });
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}
const listingChanges = (calls) => calls.filter((args) => (args[0] === "git" && ["switch", "add", "commit", "push"].includes(args[1])) || (args[0] === "gh" && ["pr", "release"].includes(args[1]) && args[2] !== "list"));

test("promotion turns the release full before pointing the listing at it", () => {
  listing({}, ({ run, calls }) => {
    const decision = promoteRelease(run, environment);
    assert.equal(decision.action, "promote");
    assert.deepEqual(decision.listing, { action: "open", version: "0.4.3", url: "https://github.com/mdbase-dev/mdbase-obsidian/pull/201" });
    assert.deepEqual(listingChanges(calls).map((args) => args.slice(0, 4)), [
      ["gh", "release", "edit", "0.4.3"],
      ["git", "switch", "--create", "listing/0.4.3"],
      ["git", "add", "manifest.json"],
      ["git", "commit", "--message", "List Obsidian plugin 0.4.3 in the community directory"],
      ["git", "push", "origin", "HEAD:refs/heads/listing/0.4.3"],
      ["gh", "pr", "create", "--repo"],
      ["gh", "pr", "merge", "https://github.com/mdbase-dev/mdbase-obsidian/pull/201"],
    ]);
    assert.ok(calls.find((args) => args[2] === "edit").includes("--latest"));
    assert.ok(calls.at(-1).includes("--auto") && !calls.some((args) => args.includes("--force")));
    assert.deepEqual(JSON.parse(readFileSync("manifest.json", "utf8")), { id: "mdbase-sync", version: "0.4.3", minAppVersion: "1.11.4" });
  });
});

test("a rerun finishes the listing without promoting again", () => {
  listing({ promoted: true }, ({ run, calls }) => {
    const decision = promoteRelease(run, environment);
    assert.equal(decision.reason, "current");
    assert.equal(decision.listing.action, "open");
    assert.ok(!calls.some((args) => args.slice(0, 3).join(" ") === "gh release edit"));
  });
  listing({ promoted: true, pulls: [{ number: 9, url: "u" }] }, ({ run, calls }) => {
    assert.deepEqual(promoteRelease(run, environment).listing, { action: "pending", version: "0.4.3", url: "u" });
    assert.deepEqual(listingChanges(calls).map((args) => args.slice(0, 4)), [["gh", "pr", "merge", "9"]]);
  });
  listing({ promoted: true, held: true }, ({ run, calls }) => {
    assert.equal(promoteRelease(run, environment).listing.reason, "held");
    assert.equal(listingChanges(calls).length, 0);
  });
  listing({ promoted: true, listed: "0.4.3" }, ({ run, calls }) => {
    assert.deepEqual(promoteRelease(run, environment).listing, { action: "none", reason: "listed", version: "0.4.3" });
    assert.equal(listingChanges(calls).length, 0);
  });
});

test("the listing never names a prerelease or moves backwards", () => {
  const releases = [{ tag_name: "0.4.9", draft: false, prerelease: true }, { tag_name: "0.4.10", draft: true }, { tag_name: "0.4.8", draft: false, prerelease: false }, { tag_name: "0.4.7", draft: false, prerelease: false }];
  assert.equal(listedVersion(releases), "0.4.8");
  assert.equal(listedVersion([{ tag_name: "0.4.9", draft: false, prerelease: true }]), undefined);
  listing({ listed: "0.4.4" }, ({ run, calls }) => {
    assert.equal(pointListing(run, environment, [{ tag_name: "0.4.3", draft: false, prerelease: false }]).reason, "listed");
    assert.equal(listingChanges(calls).length, 0);
  });
});

const hour = 60 * 60 * 1000;
const now = Date.parse("2026-11-16T12:00:00Z");
const hoursAgo = (hours) => new Date(now - hours * hour).toISOString();

// main at `sha`, version 0.4.2 released from `older`; the diff and PRs are options.
function quiet(options, callback) {
  const directory = mkdtempSync(join(tmpdir(), "obsidian-quiet-test-"));
  const original = process.cwd();
  const version = options.version ?? "0.4.2";
  const calls = [];
  try {
    process.chdir(directory);
    writeFileSync("manifest.json", JSON.stringify({ id: "mdbase-sync", version: "0.4.2", minAppVersion: "1.11.4" }));
    writeFileSync("package.json", JSON.stringify({ version }));
    writeFileSync("main.js", "current bundle");
    writeFileSync("styles.css", "styles");
    const run = (...args) => {
      calls.push(args);
      const command = args.slice(0, 3).join(" ");
      if (command === `gh api repos/${environment.GITHUB_REPOSITORY}/commits/main`) return options.committedAt ?? hoursAgo(4);
      if (command === "gh pr list") return JSON.stringify(options.pulls ?? []);
      if (command === "git rev-parse HEAD") return sha;
      if (command === "git ls-remote origin") return `${sha}\trefs/heads/main`;
      if (command === "git ls-remote --tags") return tagsFor("0.4.2", older) + (options.tags ?? "");
      if (command === "git ls-remote --heads") return options.held ? `${sha}\t${args[4]}` : "";
      if (command === "gh api --paginate") return JSON.stringify([[{ tag_name: "0.4.2", draft: false, prerelease: true }, ...(options.releases ?? [])]]);
      if (command === "git diff --name-only") return (options.changed ?? ["src/main.ts"]).join("\n");
      if (command === "gh release download") {
        const destination = args[args.indexOf("--dir") + 1];
        writeFileSync(join(destination, "main.js"), options.sameBytes ? "current bundle" : "previous bundle");
        writeFileSync(join(destination, "styles.css"), "styles");
        writeFileSync(join(destination, "manifest.json"), JSON.stringify({ id: "mdbase-sync", version: "0.4.2", minAppVersion: "1.11.4" }));
      }
      if (command === "gh pr create") return "https://github.com/mdbase-dev/mdbase-obsidian/pull/200";
      return "";
    };
    callback({ run, calls });
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}
const changes = (calls) => calls.filter((args) => ["push", "commit", "switch", "tag"].includes(args[1]) || (args[0] === "node") || (args[0] === "gh" && ["pr", "release"].includes(args[1]) && !["list", "download"].includes(args[2])));

test("main is quiet three hours after its last commit", () => {
  assert.equal(quietUntil(hoursAgo(1), now), new Date(now + 2 * hour).toISOString());
  assert.equal(quietUntil(hoursAgo(3), now), null);
  assert.throws(() => quietUntil("not a date", now));
  assert.ok(!needsBuild(["README.md", "docs/sdk-sync.md", "test/sync.test.ts", ".github/workflows/build.yml"]));
  assert.ok(needsBuild(["README.md", "src/main.ts"]));
  assert.ok(needsBuild(["package-lock.json"]));
});

test("a busy main opens nothing and leaves an open release PR alone", () => {
  quiet({ committedAt: hoursAgo(1), pulls: [{ number: 7, headRefName: "release/0.4.3", mergeStateStatus: "BEHIND", url: "u" }] }, ({ run, calls }) => {
    const decision = quietCheck(run, environment, now);
    assert.equal(decision.reason, "recent");
    assert.equal(decision.readyAt, new Date(now + 2 * hour).toISOString());
    assert.equal(changes(calls).length, 0);
  });
});

test("a quiet main brings an open release PR up to date and asks it to merge", () => {
  quiet({ pulls: [{ number: 7, headRefName: "feat/x", url: "x" }, { number: 8, headRefName: "release/0.4.3", mergeStateStatus: "BEHIND", url: "u" }] }, ({ run, calls }) => {
    assert.deepEqual(quietCheck(run, environment, now), { action: "pending", url: "u" });
    assert.deepEqual(changes(calls).map((args) => args.slice(0, 4)), [["gh", "pr", "update-branch", "8"], ["gh", "pr", "merge", "8"]]);
    assert.ok(calls.at(-1).includes("--auto"));
  });
  quiet({ pulls: [{ number: 8, headRefName: "release/0.4.3", mergeStateStatus: "BLOCKED", autoMergeRequest: { mergeMethod: "MERGE" }, url: "u" }] }, ({ run, calls }) => {
    assert.equal(quietCheck(run, environment, now).action, "pending");
    assert.equal(changes(calls).length, 0);
  });
  quiet({ pulls: [{ number: 8, headRefName: "release/0.4.3", url: "u" }, { number: 9, headRefName: "release/0.4.4", url: "v" }] }, ({ run }) => {
    assert.throws(() => quietCheck(run, environment, now), /More than one/);
  });
});

test("a quiet main builds only when something that ships changed since the newest release", () => {
  quiet({ changed: ["README.md", "docs/weekly-release.md"] }, ({ run }) => assert.equal(quietCheck(run, environment, now).reason, "unchanged"));
  quiet({}, ({ run, calls }) => {
    assert.deepEqual(quietCheck(run, environment, now), { action: "build", head: sha, baseline: "0.4.2" });
    assert.deepEqual(calls.find((args) => args[1] === "diff").slice(3), [older, sha]);
    assert.equal(changes(calls).length, 0);
  });
  quiet({ version: "0.4.3" }, ({ run }) => assert.equal(quietCheck(run, environment, now).reason, "version-unpublished"));
  quiet({ version: "0.4.3", tags: "\n" + tagsFor("0.4.3") }, ({ run }) => assert.equal(quietCheck(run, environment, now).reason, "publishing"));
});

test("the version PR opens only when the built bytes differ, and is set to merge itself", () => {
  quiet({ sameBytes: true }, ({ run, calls }) => {
    assert.equal(quietOpen(run, environment, now).reason, "unchanged-assets");
    assert.equal(changes(calls).length, 0);
  });
  quiet({ held: true }, ({ run, calls }) => {
    assert.deepEqual(quietOpen(run, environment, now), { action: "none", reason: "held", branch: "release/0.4.3" });
    assert.equal(changes(calls).length, 0);
  });
  quiet({}, ({ run, calls }) => {
    assert.deepEqual(quietOpen(run, environment, now), { action: "open", version: "0.4.3", url: "https://github.com/mdbase-dev/mdbase-obsidian/pull/200" });
    assert.deepEqual(changes(calls).map((args) => args.slice(0, 3)), [
      ["node", "version-bump.mjs", "0.4.3"],
      ["git", "switch", "--create"],
      ["git", "commit", "--message"],
      ["git", "push", "origin"],
      ["gh", "pr", "create"],
      ["gh", "pr", "merge"],
    ]);
    assert.ok(calls.find((args) => args[1] === "switch").includes("release/0.4.3"));
    assert.deepEqual(calls.find((args) => args[1] === "add").slice(2), ["versions.json", "package.json", "package-lock.json"]);
    assert.ok(calls.at(-1).includes("--auto") && !calls.some((args) => args.includes("--force")));
    assert.ok(!calls.some((args) => args[1] === "release" && args[2] !== "download"));
  });
});
