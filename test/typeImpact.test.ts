import assert from "node:assert/strict";
import { test } from "node:test";
import type { MdbaseConfig } from "../src/mdbaseCore";
import { validateRecordAgainstType } from "../src/mdbaseCore";
import { fieldConstraintSummary, parseDefaultValue, parseEnumValue } from "../src/fieldSummary";
import { groupIssuesByRule } from "../src/issuePresentation";
import { analyzeTypeImpact, indexRecordTypes, typeDefFromDraft, typeStats } from "../src/typeImpact";
import { createDefaultTypeModel } from "../src/typeModel";
import { describeTypeChanges, validateTypeDraft } from "../src/typeDraft";

const config: MdbaseConfig = {
  spec_version: "0.3.0",
  settings: {
    types_folder: "_types",
    explicit_type_keys: ["type"],
    default_strict: false,
    include_subfolders: true,
    exclude: [],
  },
};

function taskModel() {
  const model = createDefaultTypeModel();
  model.name = "task";
  model.matchPathGlob = "tasks/**";
  model.fields = [
    { name: "title", definition: { type: "string", required: true } },
    { name: "priority", definition: { type: "integer" } },
  ];
  return model;
}

const records = [
  { path: "tasks/a.md", frontmatter: { title: "A", priority: 1 } },
  { path: "tasks/b.md", frontmatter: { title: "B", priority: 5 } },
  { path: "tasks/c.md", frontmatter: { priority: 2 } },
  { path: "notes/d.md", frontmatter: { title: "D" } },
  { path: "projects/e.md", frontmatter: { title: "E", priority: 9 } },
];

test("draft impact reports notes that would newly fail, without counting existing failures", async () => {
  const saved = taskModel();
  const types = new Map([["task", typeDefFromDraft(saved, "_types/task.md")]]);
  const draft = taskModel();
  draft.fields[1].definition.max = 3;
  const result = await analyzeTypeImpact({ records, config, types, draft, savedName: "task", filePath: "_types/task.md" });
  assert.ok(result && "impact" in result);
  const { impact } = result;
  assert.deepEqual(impact.matched, ["tasks/a.md", "tasks/b.md", "tasks/c.md"]);
  assert.deepEqual(impact.failing.filter((record) => record.isNew).map((record) => record.path), ["tasks/b.md"]);
  assert.equal(impact.failing.find((record) => record.path === "tasks/c.md")?.isNew, false, "c.md already lacks a title");
  assert.match(impact.failing.find((record) => record.path === "tasks/b.md")!.issues[0].message, /'priority' is 5; must be at most 3/);
});

test("draft impact reports notes gained and lost when matching rules change", async () => {
  const saved = taskModel();
  const types = new Map([["task", typeDefFromDraft(saved, "_types/task.md")]]);
  const draft = taskModel();
  draft.matchPathGlob = "[pt]*/**"; // portable v0.3 globs have classes, not braces
  draft.matchFieldsPresent = "title";
  const result = await analyzeTypeImpact({ records, config, types, draft, savedName: "task", filePath: "_types/task.md" });
  assert.ok(result && "impact" in result);
  assert.deepEqual(result.impact.added, ["projects/e.md"]);
  assert.deepEqual(result.impact.removed, ["tasks/c.md"]);
  assert.equal(result.impact.fixed, 0);
});

test("an unserializable draft reports an error instead of a misleading impact", async () => {
  const draft = taskModel();
  draft.fields.push({ name: "", definition: { type: "string" } });
  const result = await analyzeTypeImpact({ records, config, types: new Map(), draft, savedName: null, filePath: null });
  assert.ok(result && "error" in result);
});

test("type stats count notes and attribute issues to their type", () => {
  const types = new Map([["task", typeDefFromDraft(taskModel(), "_types/task.md")]]);
  const recordTypes = indexRecordTypes(records, config, types);
  const stats = typeStats(recordTypes, [
    { path: "tasks/c.md", code: "schema_required", message: "", severity: "error", type: "task" },
    { path: "tasks/b.md", code: "no_type_field", message: "", severity: "warn" },
    { path: "notes/d.md", code: "no_matching_type", message: "", severity: "warn" },
  ]);
  assert.deepEqual(stats.get("task"), { notes: 3, issues: 2 });
});

test("schema issues are plain language and keep the technical text for tooltips", () => {
  const model = taskModel();
  model.fields[1].definition.max = 3;
  model.fields.push({ name: "status", definition: { type: "enum", values: ["open", "done"] } });
  const typeDef = typeDefFromDraft(model, "_types/task.md");
  const issues = validateRecordAgainstType("tasks/x.md", { priority: 5, status: "wip" }, typeDef);
  const messages = issues.map((issue) => issue.message);
  assert.ok(messages.includes("Missing required field 'title'"), messages.join("\n"));
  assert.ok(messages.includes("'priority' is 5; must be at most 3"), messages.join("\n"));
  assert.ok(messages.includes("'status' is 'wip'; expected one of open, done"), messages.join("\n"));
  assert.ok(issues.every((issue) => typeof issue.details?.technical_message === "string"));
});

test("enum edits keep value types and never split on commas", () => {
  assert.equal(parseEnumValue("1", 1, [2, 3]), 1);
  assert.equal(parseEnumValue("4", 1, [2, 3]), 4);
  assert.equal(parseEnumValue("four", 1, [2, 3]), "four");
  assert.equal(parseEnumValue("true", "x", ["a", "b"]), "true");
  assert.equal(parseEnumValue("3", 1, [2, "mixed"]), 3, "a number stays a number in a mixed list");
  assert.equal(parseEnumValue("7", "", [1, 2]), 7, "a new value follows an all-number list");
  assert.equal(parseEnumValue("7", "x", [1, "y"]), "7");
  assert.equal(parseEnumValue("Smith, J.", "Smith", ["Doe"]), "Smith, J.");
  assert.deepEqual(parseDefaultValue("2.5", "integer"), { error: "Default must be a whole number." });
  assert.deepEqual(parseDefaultValue("3", "number"), { value: 3 });
});

test("field summaries surface constraints that were previously hidden in design mode", () => {
  assert.deepEqual(fieldConstraintSummary({ type: "integer", min: 1, max: 3 }), ["1–3"]);
  assert.deepEqual(fieldConstraintSummary({ type: "enum", values: ["a", "b", "c", "d", "e"] }), ["a, b, c, +2"]);
  assert.deepEqual(fieldConstraintSummary({ type: "string", max_length: 80, pattern: "^A" }), ["≤ 80 chars", "/^A/"]);
  assert.deepEqual(fieldConstraintSummary({ type: "link", target: "project" }), ["→ project"]);
  assert.deepEqual(fieldConstraintSummary({ type: "string" }), []);
});

test("draft validation catches inverted bounds, bad patterns, duplicate values and disallowed defaults", () => {
  const model = taskModel();
  model.fields.push(
    { name: "score", definition: { type: "integer", min: 5, max: 1 } },
    { name: "code", definition: { type: "string", pattern: "(" } },
    { name: "state", definition: { type: "enum", values: ["a", "a"], default: "z" } },
  );
  const codes = validateTypeDraft(model).map((diagnostic) => diagnostic.code);
  for (const code of ["constraint_range_inverted", "invalid_pattern", "enum_duplicate_values", "default_not_allowed"]) {
    assert.ok(codes.includes(code), `${code} in ${codes.join(", ")}`);
  }
});

test("reordering fields is described as a safe change", () => {
  const original = taskModel();
  const reordered = taskModel();
  reordered.fields.reverse();
  assert.deepEqual(describeTypeChanges(original, reordered).map((change) => [change.code, change.risk]), [["reorder_fields", "safe"]]);
});

test("issues group by type, field and rule, most frequent first", () => {
  const groups = groupIssuesByRule([
    { path: "a.md", code: "schema_required", field: "title", type: "task", message: "", severity: "error" },
    { path: "b.md", code: "schema_maximum", field: "priority", type: "task", message: "", severity: "error" },
    { path: "c.md", code: "schema_required", field: "title", type: "task", message: "", severity: "error" },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.issues.length]), [
    ["task · title · missing", 2],
    ["task · priority · above maximum", 1],
  ]);
});
