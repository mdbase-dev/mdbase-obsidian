import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("release is main-only, serialized and gated by complete plugin CI", () => {
  const { jobs } = workflow("build");
  assert.equal(jobs.plugin.name, "Obsidian plugin");
  const runs = jobs.plugin.steps.map((step) => step.run).filter(Boolean);
  for (const command of ["npm run lint", "npm test", "npm run test:release", "npm run check:mobile"]) assert.ok(runs.includes(command));
  assert.equal(jobs.release.needs, "plugin");
  assert.equal(jobs.release.if, "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
  assert.equal(jobs.release.concurrency["cancel-in-progress"], false);
  assert.ok(!jobs.release.environment);
  const upload = jobs.plugin.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const download = jobs.release.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(upload.with.name, download.with.name);
  assert.deepEqual(upload.with.path.trim().split("\n"), ["main.js", "manifest.json", "styles.css"]);
  assert.ok(jobs.release.steps.some((step) => step.with?.token === "${{ steps.app.outputs.token }}"));
  for (const step of jobs.release.steps.filter((value) => value.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/);
  const target = jobs.release.steps.findIndex((step) => step.id === "target");
  assert.ok(target >= 0);
  assert.equal(download.if, "steps.target.outputs.ref == github.sha");
  const rebuild = jobs.release.steps.find((step) => step.name === "Rebuild and validate original tagged assets");
  assert.equal(rebuild.if, "steps.target.outputs.ref != '' && steps.target.outputs.ref != github.sha");
  assert.match(rebuild.run, /npm run check:mobile/);
  assert.match(jobs.release.steps.at(-1).run, /RUNNER_TEMP\/plugin-release.mjs/);
  assert.ok(!JSON.stringify(jobs.release).includes("permission-pull-requests"));
});

test("repin preserves the ops dispatch contract and verifies before lock update or PR", () => {
  const definition = workflow("sdk-repin");
  assert.deepEqual(Object.keys(definition.on.workflow_dispatch.inputs), ["connect_release"]);
  assert.deepEqual(definition.on.workflow_dispatch.inputs.connect_release, { description: "Production-verified Connect tag (v0.1.0-beta.N)", required: true, type: "string" });
  assert.equal(definition.jobs.repin.if, "github.ref == 'refs/heads/main'");
  const steps = definition.jobs.repin.steps;
  const pins = steps.findIndex((step) => step.id === "pins");
  const lock = steps.findIndex((step) => step.run?.includes("--package-lock-only"));
  const pull = steps.findIndex((step) => step.run?.includes("gh pr create"));
  const bump = steps.findIndex((step) => step.run?.includes("node version-bump.mjs"));
  assert.ok(pins < lock && lock < bump && bump < pull);
  assert.equal(steps[bump].if, "steps.pins.outputs.changed == 'true'");
  assert.match(steps[pull].run, /package-lock.json manifest.json versions.json/);
  assert.match(steps[lock].run, /node scripts\/sdk-repin.mjs verify-lock/);
  assert.equal(steps[pins].env.GH_TOKEN, "${{ steps.ops.outputs.token }}");
  assert.equal(steps[pull].env.GH_TOKEN, "${{ steps.app.outputs.token }}");
  assert.match(steps[pull].run, /gh pr merge "\$pull" --auto --squash/);
});

test("manual version dispatch creates a normal PR without a merge-time bot branch", () => {
  const definition = workflow("version-bump");
  assert.deepEqual(Object.keys(definition.on), ["workflow_dispatch"]);
  assert.equal(definition.jobs.version.if, "github.ref == 'refs/heads/main'");
  const runs = definition.jobs.version.steps.map((step) => step.run ?? "").join("\n");
  assert.match(runs, /node version-bump.mjs/);
  assert.match(runs, /gh pr create/);
  assert.ok(!runs.includes("--force"));
  assert.ok(!runs.includes("gh pr merge"));
  for (const name of ["build", "sdk-repin", "version-bump"]) assert.ok(!JSON.stringify(workflow(name)).includes("automation/plugin-release"));
});
