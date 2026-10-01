import assert from "node:assert/strict";
import test from "node:test";
import { portableGlobMatch } from "../src/pathGlob";

test("wildcard matching does not recursively copy exponentially many suffixes", () => {
  const slice = Array.prototype.slice;
  let copies = 0;
  Array.prototype.slice = function(start?: number, end?: number) {
    copies++;
    return slice.call(this, start, end);
  };
  try {
    assert.equal(portableGlobMatch("*a".repeat(8) + "b", "a".repeat(14)), false);
    assert.equal(portableGlobMatch("**/".repeat(8) + "missing", "a/".repeat(14) + "last"), false);
  } finally {
    Array.prototype.slice = slice;
  }
  assert.ok(copies < 1_000, `Expected bounded matching, not ${copies} copied suffixes`);
});

test("long literal patterns do not consume the JavaScript call stack", () => {
  const path = "🙂".repeat(20_000);
  assert.equal(portableGlobMatch("?".repeat(20_000), path), true);
  assert.equal(portableGlobMatch("*".repeat(20_000) + "b", path), false);
});

test("portable wildcards retain Unicode, class and whole-component semantics", () => {
  for (const [pattern, path, matches] of [
    ["notes/**/*.md", "notes/a.md", true],
    ["notes/**/*.md", "notes/a/b.md", true],
    ["notes/*.md", "notes/a/b.md", false],
    ["*.md", "note.MD", false],
    ["a?", "a🙂", true],
    ["a?", "aé", false],
    ["[😀-🙏]", "🙁", true],
    ["[!a-c]", "b", false],
    ["[!a-c]", "🙂", true],
    ["[z-a]", "m", false],
    ["[!z-a]", "m", true],
    ["[]a]", "]", true],
    ["[a", "[a", true],
    ["[]", "[]", true],
    ["[!]", "[!]", true],
    ["**/**/a/**", "a", true],
    ["ab**cd", "ab/x/cd", false],
    ["ab**cd", "abXXXcd", true],
    ["", "", true],
  ] as const) assert.equal(portableGlobMatch(pattern, path), matches, `${pattern} against ${path}`);
});
