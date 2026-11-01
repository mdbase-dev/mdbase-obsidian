import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { nextVersion, releasePlugin, releaseState, releaseTarget, sameAssets } from "../../scripts/plugin-release.mjs";

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
  const manifest = JSON.stringify({ id: "mdbase-obsidian", version, minAppVersion: "1.11.4" }) + "\n";
  const calls = [];
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
      if (args[0] === "git" && args[1] === "show") return manifest.trim();
      if (command === "git merge-base --is-ancestor" && options.diverged) throw new Error("release is not an ancestor");
      if (command === "gh api --paginate") return JSON.stringify([[baseline, ...(options.published ? [{ tag_name: version, draft: false }] : []), ...(options.draft ? [{ tag_name: version, draft: true, target_commitish: options.draftTarget ?? sha }] : [])]]);
      if (command === "gh release upload" && options.uploadFailure) throw new Error("upload interrupted");
      if (command === "gh release download") {
        if (options.downloadFailure) throw new Error("asset download failed");
        const destination = args[args.indexOf("--dir") + 1];
        for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(file, join(destination, file));
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

test("existing version-bump updates all four version files in one sandbox", () => {
  fixture({ version: "0.4.2" }, () => {
    execFileSync("node", [fileURLToPath(new URL("../../version-bump.mjs", import.meta.url)), "0.4.3"]);
    for (const file of ["manifest.json", "package.json", "package-lock.json"]) assert.equal(JSON.parse(readFileSync(file, "utf8")).version, "0.4.3");
    assert.equal(JSON.parse(readFileSync("versions.json", "utf8"))["0.4.3"], "1.11.4");
  });
});

test("ordinary merges with a published manifest version do not release or bump", () => {
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
