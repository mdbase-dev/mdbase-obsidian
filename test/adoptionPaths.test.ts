import assert from "node:assert/strict";
import { test } from "node:test";
import { findAdoptionPathConflicts, portablePathKey, proposeAdoptionRenames } from "../src/adoptionPaths";

test("rename proposals keep one original and avoid occupied aliases and folders", () => {
  const paths = ["Tasks/TEST.md", "Tasks/test.md", "Tasks/Test.md", "tasks/TEST (2).MD", "Tasks/test (3).md"];
  const result = proposeAdoptionRenames([paths.slice(0, 3)], paths, new Set());
  assert.deepEqual(result.renames, [
    { from: "Tasks/Test.md", to: "Tasks/Test (4).md" },
    { from: "Tasks/test.md", to: "Tasks/test (5).md" },
  ]);
  assert.deepEqual(result.manual, []);
  assert.deepEqual(proposeAdoptionRenames([[...paths.slice(0, 3)].reverse()], [...paths].reverse(), new Set()), result);
});

test("rename proposals preserve extensions and Unicode while reserving all generated names", () => {
  const paths = ["CAFÉ.PNG", "cafe\u0301.png", "file", "FILE"];
  const { renames } = proposeAdoptionRenames(findAdoptionPathConflicts(paths), paths, new Set());
  assert.equal(renames.length, 2);
  assert.ok(renames.some(change => change.to === "cafe\u0301 (2).png"));
  assert.ok(renames.some(change => change.to === "file (2)"));
  const final = paths.map(path => renames.find(change => change.from === path)?.to ?? path);
  assert.equal(new Set(final.map(portablePathKey)).size, final.length);
});

test("collection resources and duplicate enumeration require manual review", () => {
  const conflicts = [["_types/A.md", "_TYPES/a.md"], ["note.md", "note.md"]];
  const result = proposeAdoptionRenames(conflicts, conflicts.flat(), new Set(["_types/A.md"]));
  assert.equal(result.renames.length, 0);
  assert.equal(result.manual.length, 2);
});
