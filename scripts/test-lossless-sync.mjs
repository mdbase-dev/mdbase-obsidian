// Candidate qualification, not live Obsidian or hosted acceptance.
// Run with the Obsidian test loader after installing immutable candidate SDK
// artifacts without changing package.json/package-lock.json. The released
// beta.91 SDK is expected to fail this stricter contract until its pin advances.
import assert from "node:assert/strict";
import { TFile } from "obsidian";
import { MemoryAuthority } from "@mdbase-dev/connect-sync";
import { DirectoryMirror, MemoryMirrorStateStore, WritableDirectoryMirror } from "@mdbase-dev/connect-sync/mirror";
import { ObsidianMirrorFileSystem } from "../.test-dist/src/connectSync.js";
import { previewFromPlan } from "../.test-dist/src/syncPreview.js";
import { syncReviewPresentation } from "../.test-dist/src/syncUx.js";

// Minimal flat-file Vault fixture. All documents and authority state are in
// memory; this harness cannot write into a user's vault or contact a daemon.
function vaultFixture() {
  const files = new Map();
  return {
    files,
    getAbstractFileByPath: (path) => files.get(path)?.file ?? null,
    getMarkdownFiles: () => [...files.values()].map(({ file }) => file),
    adapter: {
      exists: async (path) => files.has(path),
      readBinary: async (path) => {
        assert.ok(files.has(path), `Missing fixture: ${path}`);
        return new TextEncoder().encode(files.get(path).document).buffer;
      },
    },
    create: async (path, document) => {
      assert.equal(files.has(path), false);
      const file = new TFile(path);
      files.set(path, { file, document });
      return file;
    },
    modify: async (file, document) => {
      assert.ok(files.has(file.path));
      files.set(file.path, { file, document });
    },
  };
}

const documents = [
  "---\nbroken: [\n---\nBody",
  "---\na: 1\na: 2\n---\nBody",
  "---\nhello\n---\nBody",
  "---\nnull\n---\nBody",
  "---\n- one\n- two\n---\nBody",
  "\uFEFF---\r\nbroken: [\r\n---\r\nExact — bytes\r\n",
  "---\nbroken: [\n---",
  "# Valid sibling\n",
];
const hosted = new MemoryAuthority();
const writerId = hosted.registerReplica({ name: "Candidate writer", mode: "read_write" });
const readerId = hosted.registerReplica({ name: "Candidate reader", mode: "read_only" });
const source = vaultFixture();
const destination = vaultFixture();
for (const [index, document] of documents.entries()) await source.create(`${index}.md`, document);
const writer = new WritableDirectoryMirror(writerId, hosted.transport(writerId), {
  fileSystem: new ObsidianMirrorFileSystem(source), stateStore: new MemoryMirrorStateStore(),
});
const reader = new DirectoryMirror(readerId, hosted.transport(readerId), {
  fileSystem: new ObsidianMirrorFileSystem(destination), stateStore: new MemoryMirrorStateStore(),
});
const plan = await writer.inspect();
assert.equal(plan.summary.blocking_issues, 0, "Candidate SDK must not block readable malformed YAML");
assert.equal(plan.summary.uploads, documents.length);
const preview = previewFromPlan(plan);
const presentation = syncReviewPresentation(plan, preview.entries.length);
assert.equal(presentation.actionDisabled, false);
assert.match(presentation.message, /warnings do not block/);
assert.equal((await writer.apply(plan)).status, "applied");
await reader.sync();
for (const [index, document] of documents.entries()) {
  assert.equal(source.files.get(`${index}.md`)?.document, document);
  assert.equal(destination.files.get(`${index}.md`)?.document, document);
}
assert.equal((await reader.inspect()).summary.blocking_issues, 0);
assert.deepEqual((await reader.inspect()).actions, []);
console.log(JSON.stringify({ authority: "in_process_reference", vault: "mock", exact_round_trips: documents.length }));
