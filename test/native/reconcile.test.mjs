import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/sync/native/reconcile.ts"], bundle: true, format: "esm", write: false });
const { reconcileDecision: decide, remoteMoveDecision: move, localMovePairs: pairs, conflictPath } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
for (const kind of ["record", "file"]) {
  const known = { kind, id: "id", revision: "r1", hash: "h1" };
  const remote = { kind, id: "id", revision: "r1", hash: "h1" };
  const changed = { ...remote, revision: "r2", hash: "h2" };
  test(`${kind}: same identity at a new path chooses rename before path reconcile`, () => {
    assert.equal(move(known, "h1", remote, false), "rename");
    assert.equal(move(known, "h1", remote, true), "blocked");
    assert.equal(move(known, "h1", { ...remote, id: "other" }, false), "blocked");
    assert.equal(move(known, undefined, remote, false), "restore");
  });
  const cases = [
    ["both unchanged", known, "h1", remote, "none"],
    ["unchanged revision without supplied remote bytes", known, "h1", { ...remote, hash: undefined }, "none"],
    ["remote changed", known, "h1", changed, "pull"],
    ["local changed", known, "local", remote, "push"],
    ["both changed", known, "local", changed, "conflict"],
    ["same concurrent content", known, "h2", changed, "remember"],
    ["local-only", undefined, "local", undefined, "push"],
    ["remote-only", undefined, undefined, remote, "pull"],
    ["offline local delete", known, undefined, remote, "deleteRemote"],
    ["offline delete vs remote edit", known, undefined, changed, "pull"],
    ["remote delete vs unchanged local", known, "h1", undefined, "deleteLocal"],
    ["remote delete vs local edit", known, "local", undefined, "conflict"],
    ["both deleted", known, undefined, undefined, "forget"],
    ["nothing", undefined, undefined, undefined, "none"],
    ["initial matching bytes", undefined, "h1", remote, "remember"],
    ["initial differing bytes", undefined, "local", remote, "conflict"],
    ["replacement ID is remote change", known, "h1", { ...remote, id: "different" }, "remember"],
    ["replacement ID plus local change", known, "local", { ...remote, id: "different" }, "conflict"],
  ];
  for (const [name, k, local, r, expected] of cases) test(`${kind}: ${name}`, () => assert.equal(decide(k, local, r), expected));
}
test("conflict filename preserves extension and directories", () => {
  const date = new Date(2026, 9, 26, 9, 7);
  assert.equal(conflictPath("assets/a.png", date), "assets/a (conflict 2026-10-26 0907).png");
  assert.equal(conflictPath("a.md", date, " 2"), "a (conflict 2026-10-26 0907 2).md");
  assert.equal(conflictPath("README", date), "README (conflict 2026-10-26 0907)");
});

const k = { id: "id", kind: "record", revision: "r1", hash: "h1", disk: { dev: 1, ino: 2, birthtimeMs: 1000 } };
const a = { path: "old.md", known: k, remote: { ...k } };
const b = { path: "new.md", kind: "record", hash: "h1", disk: { dev: 1, ino: 2, birthtimeMs: 1000 } };
for (const edited of [false, true]) test(`external inode move${edited ? " plus edit" : ""}`, () => {
  assert.deepEqual(pairs([a], [{ ...b, hash: edited ? "edited" : "h1" }]), [{ from: a.path, to: b.path, via: "inode" }]);
});
test("reused inode with different birth time cannot pair unrelated bytes", () => {
  assert.deepEqual(pairs([a], [{ ...b, hash: "unrelated", disk: { ...b.disk, birthtimeMs: 2000 } }]), []);
});
for (const birthtimeMs of [undefined, 0, NaN, -1]) test(`inode without reliable birthtime (${birthtimeMs}) requires matching bytes`, () => {
  for (const oldMissing of [true, false]) {
    const missing = [{ ...a, known: { ...k, disk: { ...k.disk, birthtimeMs: oldMissing ? birthtimeMs : 1000 } } }];
    const added = [{ ...b, hash: "unrelated", disk: { ...b.disk, birthtimeMs: oldMissing ? 1000 : birthtimeMs } }];
    assert.deepEqual(pairs(missing, added), []);
    assert.deepEqual(pairs(missing, [{ ...added[0], hash: "h1" }]), [{ from: a.path, to: b.path, via: "inode" }]);
  }
});
test("external unique hash fallback without inode", () => {
  assert.deepEqual(pairs([a], [{ ...b, disk: undefined }]), [{ from: a.path, to: b.path, via: "hash" }]);
});
test("external ambiguous duplicates do not hash-pair", () => {
  assert.deepEqual(pairs([a], [{ ...b, disk: undefined }, { ...b, path: "other.md", disk: undefined }]), []);
  assert.deepEqual(pairs([a, { ...a, path: "other.md" }], [{ ...b, disk: undefined }]), []);
});
test("external inode wins despite duplicate content", () => {
  assert.deepEqual(pairs([a, { ...a, path: "other.md", known: { ...k, disk: { dev: 1, ino: 3 } } }], [b]), [{ from: a.path, to: b.path, via: "inode" }]);
});
test("external remote change refuses pairing", () => {
  for (const remote of [undefined, { ...k, revision: "r2" }, { ...k, id: "other" }]) assert.deepEqual(pairs([{ ...a, remote }], [b]), []);
});
test("external different kinds never pair", () => assert.deepEqual(pairs([a], [{ ...b, kind: "file" }]), []));
test("external no identity or hash match", () => assert.deepEqual(pairs([a], [{ ...b, hash: "other", disk: { dev: 2, ino: 2 } }]), []));
test("external hardlink inode ambiguity fails closed", () => assert.deepEqual(pairs([a], [b, { ...b, path: "hardlink.md" }]), []));
