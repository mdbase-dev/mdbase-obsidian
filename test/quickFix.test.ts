import assert from "node:assert/strict";
import test from "node:test";
import { applyFieldQuickFix, applyQuickFixToDocument, quickFixLabel } from "../src/quickFix";
import { parseFrontmatter } from "../src/mdbaseCore";
import type { MdbaseIssue } from "../src/mdbaseCore";

function issue(code: string, pointer: string, property: string): MdbaseIssue {
  return { path: "note.md", severity: "error", message: "invalid", code, field: "nested.field", details: { instance_path: pointer, property } };
}

test("repeated document fixes preserve body bytes including whitespace and missing final newline", () => {
  for (const body of ["\nBody\n", "\n\n  Body\r\n\r\n", "Body without final newline", ""]) {
    const raw = `---\n${JSON.stringify({ address: { city: "Edinburgh", unexpected: 1 } })}\n---\n${body}`;
    const first = applyQuickFixToDocument(raw, issue("schema_additional_properties", "/address", "unexpected"));
    const second = applyQuickFixToDocument(first.content, issue("schema_required", "/address", "postcode"));
    assert.equal(parseFrontmatter(first.content).body, body);
    assert.equal(parseFrontmatter(second.content).body, body);
    assert.equal(applyQuickFixToDocument(second.content, issue("schema_required", "/address", "postcode")).content, second.content);
  }
});

test("nested removal preserves the parent and valid siblings", () => {
  const value = { address: { city: "Edinburgh", unexpected: 1 }, title: "Keep" };
  assert.equal(applyFieldQuickFix(value, issue("schema_additional_properties", "/address", "unexpected")), true);
  assert.deepEqual(value, { address: { city: "Edinburgh" }, title: "Keep" });
});

test("required fixes reach list objects and decode JSON pointer keys without flattening", () => {
  const value = { "a/b": [{ "c~d": {} }] };
  const error = issue("schema_required", "/a~1b/0/c~0d", "literal.dot");
  assert.equal(applyFieldQuickFix(value, error), true);
  assert.deepEqual(value, { "a/b": [{ "c~d": { "literal.dot": "TODO" } }] });
  assert.equal(applyFieldQuickFix(value, error), false);
});

test("stale parents and prototype paths are not mutated", () => {
  const value = {};
  assert.equal(applyFieldQuickFix(value, issue("schema_required", "/gone", "field")), false);
  assert.equal(applyFieldQuickFix(value, issue("schema_required", "/__proto__", "polluted")), false);
  assert.deepEqual(value, {});
  assert.equal(quickFixLabel({ ...issue("missing_required", "", "x"), field: "ambiguous.nested" }), null);
});
