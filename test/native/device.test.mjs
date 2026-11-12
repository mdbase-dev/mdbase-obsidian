import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({
  stdin: { contents: `export * from './src/sync/native/device.ts'; export { readyText } from './src/sync/words.ts';`, resolveDir: process.cwd() },
  bundle: true, format: "esm", write: false, platform: "node",
  plugins: [{ name: "mocks", setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, args => ({ path: args.path, namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export class Notice {}", loader: "js" }));
  } }],
});
const { mediaClass, skippedHere, collectionExcludes, recordActivity, ACTIVITY_LIMIT, validFilter, normalizeFolder, readyText } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);

test("media classes follow Connect's extension list", () => {
  assert.equal(mediaClass("a/Photo.JPG"), "image");
  assert.equal(mediaClass("talk.m4a"), "audio");
  assert.equal(mediaClass("clip.webm"), "video");
  assert.equal(mediaClass("paper.pdf"), "pdf");
  assert.equal(mediaClass("board.canvas"), "other");
  assert.equal(mediaClass("no-extension"), "other");
});

test("a device skips attachment kinds and folders, never definitions", () => {
  const filter = { skip: ["image"], folders: ["Archive/Old"] };
  assert.equal(skippedHere("files/a.png", "file", filter), true);
  assert.equal(skippedHere("files/a.pdf", "file", filter), false);
  assert.equal(skippedHere("notes/a.png.md", "record", filter), false, "file kinds don't apply to notes");
  assert.equal(skippedHere("Archive/Old/a.md", "record", filter), true);
  assert.equal(skippedHere("archive/old/b.pdf", "file", filter), true, "folders compare like Connect's path keys");
  assert.equal(skippedHere("Archive/Older/a.md", "record", filter), false);
  assert.equal(skippedHere("Archive/Old", "record", filter), false);
  assert.equal(skippedHere("Archive/Old/x.md", "resource", filter), false);
  assert.equal(skippedHere("files/a.png", "file", undefined), false);
});

test("device choices are checked and folders tidied", () => {
  assert.equal(validFilter({ skip: ["image", "pdf"], folders: ["a"] }), true);
  assert.equal(validFilter({ skip: ["images"], folders: [] }), false);
  assert.equal(validFilter({ skip: [], folders: [1] }), false);
  assert.equal(normalizeFolder(" /Archive//Old/ "), "Archive/Old");
});

test("activity keeps the most recent entries first, up to the limit", () => {
  let log = [];
  for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) log = recordActivity(log, { at: i, kind: "uploaded", path: `${i}.md` });
  assert.equal(log.length, ACTIVITY_LIMIT);
  assert.equal(log[0].path, `${ACTIVITY_LIMIT + 4}.md`);
});

test("the ready state is described in words, not log positions", () => {
  assert.equal(readyText({ state: "saved", connection: "online", health: null, pending: 0 }), "Everything is up to date.");
  assert.equal(readyText({ state: "saving", connection: "online", health: null, pending: 3 }), "3 changes waiting to send.");
  assert.match(readyText({ state: "saved_on_device", connection: "reconnecting", health: "unreachable", pending: 1 }), /^Offline\. .* 1 change waiting to send\.$/);
  assert.equal(readyText({ state: "catching_up", connection: "online", health: null, pending: 0 }), "Getting the latest changes from your other devices.");
  assert.equal(readyText({ state: "reconnecting", connection: "reconnecting", health: "server_busy", pending: 0 }), "mdbase is busy. Sync carries on shortly.", "a busy service is not offline");
});

test("the collection's file policy leaves out attachments only, as Connect does", () => {
  const policy = { include: ["image", "pdf", "other"], exclude: ["Big/"], maxSize: 1000 };
  assert.equal(collectionExcludes("clip.mp4", "file", policy), true, "a kind the collection doesn't sync");
  assert.equal(collectionExcludes("a.png", "file", policy), false);
  assert.equal(collectionExcludes("a.png", "file", policy, 1001), true, "over the size limit");
  assert.equal(collectionExcludes("a.png", "file", policy, 1000), false);
  assert.equal(collectionExcludes("big/a.png", "file", policy), true, "excluded folder, case-folded");
  assert.equal(collectionExcludes("Big/note.md", "record", policy), false, "notes are never affected");
  assert.equal(collectionExcludes("clip.mp4", "file", null), false, "no policy, nothing left out");
});
