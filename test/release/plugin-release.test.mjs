import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { releasePlan, releasePlugin } from "../../scripts/plugin-release.mjs";

const sha = "a".repeat(40);
const baseline = { tag_name: "0.4.2", draft: false, prerelease: true };
const environment = { GITHUB_REPOSITORY: "mdbase-dev/mdbase-obsidian", GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", APP_SLUG: "fixture" };

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
    copyFileSync(fileURLToPath(new URL("../../version-bump.mjs", import.meta.url)), "version-bump.mjs");
    const run = (...args) => {
      calls.push(args);
      const command = args.slice(0, 3).join(" ");
      if (args[0] === "node") return execFileSync(args[0], args.slice(1), { encoding: "utf8" });
      if (command === "git rev-parse HEAD") return sha;
      if (args[0] === "git" && args[1] === "rev-parse") return options.tagCommit ?? sha;
      if (command === "git ls-remote origin") {
        if (args[3] === "refs/heads/main") {
          observations += 1;
          return `${options.stale && observations > 1 ? "b".repeat(40) : sha}\trefs/heads/main`;
        }
        if (args[3] === "refs/heads/automation/plugin-release") return "";
        return options.tag ? `${"c".repeat(40)}\trefs/tags/${version}\n${options.tagCommit ?? sha}\trefs/tags/${version}^{}` : "";
      }
      if (args[0] === "git" && args[1] === "show") return manifest.trim();
      if (command === "git merge-base --is-ancestor" && options.diverged) throw new Error("release is not an ancestor");
      if (command === "git diff --name-only") return options.changed === false ? "" : "src/example.ts";
      if (command === "gh api --paginate") return JSON.stringify([[baseline, ...(options.draft ? [{ tag_name: version, draft: true }] : [])]]);
      if (command === "gh pr list") return options.existingPull ? "99" : "";
      if (command === "gh pr create") return "https://github.com/fixture/pull/99";
      if (command === "gh release upload" && options.uploadFailure) throw new Error("upload interrupted");
      if (command === "gh release download") {
        const destination = args[args.indexOf("--dir") + 1];
        for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(file, join(destination, file));
        if (options.corrupt) writeFileSync(join(destination, "main.js"), "wrong bytes");
      }
      return "";
    };
    callback({ run, calls, directory });
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}

test("plans patch bump, publication, rerun and docs-only no-op from actual released tag", () => {
  assert.equal(releasePlan([baseline], "0.4.2", true).version, "0.4.3");
  assert.equal(releasePlan([baseline], "0.4.2", true).action, "bump");
  assert.equal(releasePlan([baseline], "0.4.3", true).action, "publish");
  assert.equal(releasePlan([baseline], "0.4.2", false).action, "none");
  assert.equal(releasePlan([baseline, { tag_name: "0.4.3", draft: false }], "0.4.3", false).action, "none");
  assert.equal(releasePlan([baseline, { tag_name: "0.4.3", draft: true }], "0.4.3", true).baseline, "0.4.2");
  assert.throws(() => releasePlan([], "0.4.3", true), /baseline/);
  assert.throws(() => releasePlan([baseline], "0.4.1", true), /behind/);
  assert.throws(() => releasePlan([baseline], "v0.4.3", true));
});

test("bumps all version files through existing version-bump and opens one protected PR", () => {
  fixture({ version: "0.4.2" }, ({ run, calls }) => {
    assert.equal(releasePlugin(run, environment).action, "bump");
    for (const file of ["manifest.json", "package.json", "package-lock.json"]) assert.equal(JSON.parse(readFileSync(file, "utf8")).version, "0.4.3");
    assert.equal(JSON.parse(readFileSync("versions.json", "utf8"))["0.4.3"], "1.11.4");
    assert.ok(calls.some((args) => args[0] === "git" && args[1] === "push" && args.some((arg) => arg.startsWith("--force-with-lease="))));
    assert.ok(calls.some((args) => args.join(" ").includes("--auto --squash")));
    assert.ok(!calls.some((args) => args[1] === "release"));
  });
  fixture({ version: "0.4.2", existingPull: true }, ({ run, calls }) => {
    releasePlugin(run, environment);
    assert.ok(calls.some((args) => args.slice(0, 3).join(" ") === "gh pr edit"));
    assert.ok(!calls.some((args) => args.slice(0, 3).join(" ") === "gh pr create"));
  });
});

test("draft is made public only after all three asset downloads match", () => {
  fixture({}, ({ run, calls }) => {
    assert.equal(releasePlugin(run, environment).action, "publish");
    const tag = calls.find((args) => args.slice(0, 3).join(" ") === "git tag --annotate");
    assert.equal(tag[3], "0.4.3");
    assert.equal(tag[4], sha);
    const upload = calls.findIndex((args) => args.slice(0, 3).join(" ") === "gh release upload");
    const download = calls.findIndex((args) => args.slice(0, 3).join(" ") === "gh release download");
    const publish = calls.findIndex((args) => args.slice(0, 3).join(" ") === "gh release edit");
    assert.ok(upload < download && download < publish);
    assert.ok(calls[publish].includes("--prerelease=false"));
  });
});

test("reuses exact tag and draft after interruption without recreating either", () => {
  for (const draft of [true, false]) fixture({ tag: true, draft }, ({ run, calls }) => {
    releasePlugin(run, environment);
    assert.ok(!calls.some((args) => args[0] === "git" && args[1] === "tag"));
    assert.equal(calls.some((args) => args.slice(0, 3).join(" ") === "gh release create"), !draft);
  });
});

test("no tag or release writes for unchanged content", () => {
  fixture({ version: "0.4.2", changed: false }, ({ run, calls }) => {
    assert.equal(releasePlugin(run, environment).action, "none");
    assert.ok(!calls.some((args) => args[0] === "gh" && args[1] === "release"));
  });
});

test("refuses divergent baseline, mismatched tag and unsafe event", () => {
  fixture({ diverged: true }, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, environment), /ancestor/);
    assert.ok(!calls.some((args) => args[1] === "release"));
  });
  fixture({ tag: true, tagCommit: "b".repeat(40) }, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, environment), /different commit/);
    assert.ok(!calls.some((args) => args[1] === "release"));
  });
  fixture({}, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, { ...environment, GITHUB_EVENT_NAME: "pull_request" }));
    assert.equal(calls.length, 0);
  });
});

test("failed upload, corrupt download or advanced main never publishes", () => {
  for (const options of [{ uploadFailure: true }, { corrupt: true }, { stale: true }]) fixture(options, ({ run, calls }) => {
    assert.throws(() => releasePlugin(run, environment));
    assert.ok(!calls.some((args) => args.slice(0, 3).join(" ") === "gh release edit"));
  });
});
