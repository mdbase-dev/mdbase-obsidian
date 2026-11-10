import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/sync/native/failures.ts"], bundle: true, format: "esm", write: false });
const { describeFailure } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);

test("a validation reason names the field it's about", () => {
  const d = describeFailure({ code: "invalid_record", issues: [
    { code: "x", severity: "warning", message: "a warning", location: "/note" },
    { code: "schema_min_length", severity: "error", message: "shorter than 1 characters", location: "/title" },
  ] });
  assert.equal(d.title, "Doesn't match its type");
  assert.equal(d.detail, "title: is empty. Fix the note and it will sync.");
  assert.equal(describeFailure({ code: "invalid_record", issues: [
    { severity: "error", message: "bad", location: "/a~1b/0" }, { severity: "error", message: "worse", location: "/c" },
  ] }).detail, "a/b.0: bad, and 1 more problem. Fix the note and it will sync.");
  // What the SDK sends today: no location, so point at the Issues tab.
  assert.equal(describeFailure({ code: "invalid_record", issues: [
    { code: "schema_min_length", severity: "error", message: "shorter than 1 characters" }, { code: "schema_maximum", severity: "error", message: "greater than 5" },
  ] }).detail, "2 problems, such as “shorter than 1 characters”. Run Validate in the Issues tab to see which fields. Fix the note and it will sync.");
  assert.match(describeFailure({ code: "invalid_record" }).detail, /Issues tab/);
  assert.equal(describeFailure({ code: "invalid_record", issues: [{ code: "missing_required", severity: "error", message: "missing required field title" }] }).detail,
    "Missing required field title. Fix the note and it will sync.");
});

test("a definition conflict offers a choice; unknown codes stay readable", () => {
  assert.equal(describeFailure({ code: "conflict", reason: "definition_conflict" }).choose, true);
  assert.equal(describeFailure({ code: "conflict" }).choose, undefined);
  assert.match(describeFailure({ code: "weird" }).detail, /\(weird\)/);
});
