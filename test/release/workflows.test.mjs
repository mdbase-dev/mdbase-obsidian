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
  assert.ok(pins < lock && lock < pull);
  assert.match(steps[lock].run, /node scripts\/sdk-repin.mjs verify-lock/);
  assert.equal(steps[pins].env.GH_TOKEN, "${{ steps.ops.outputs.token }}");
  assert.equal(steps[pull].env.GH_TOKEN, "${{ steps.app.outputs.token }}");
  assert.match(steps[pull].run, /gh pr merge "\$pull" --auto --squash/);
});
