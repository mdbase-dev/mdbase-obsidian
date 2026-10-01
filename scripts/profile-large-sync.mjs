// Isolated, generated data only: no Obsidian CLI, vault directories or network.
// Run after `npm run test:unit`:
// node --expose-gc --loader ./test/obsidian-loader.mjs scripts/profile-large-sync.mjs [10000 20000 50000]
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const sdkRoot = process.env.MDBASE_PROFILE_SDK_ROOT;
const { MemoryAuthority } = await import(sdkRoot
  ? pathToFileURL(resolve(sdkRoot, "dist/index.js")).href : "@mdbase-dev/connect-sync");
const { WritableDirectoryMirror } = await import(sdkRoot
  ? pathToFileURL(resolve(sdkRoot, "dist/mirror.js")).href : "@mdbase-dev/connect-sync/mirror");
import { MemoryVault } from "../.test-dist/test/memoryVault.js";
import { IndexedDbMirrorStateStore, ObsidianMirrorFileSystem } from "../.test-dist/src/connectSync.js";
import { indexedDB } from "fake-indexeddb";

Object.assign(globalThis, { indexedDB });
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(10_000, 20_000, 50_000);
assert.ok(sizes.every((size) => Number.isSafeInteger(size) && size > 0));
const measure = async (operation) => {
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  const start = performance.now();
  const value = await operation();
  return { value, ms: +(performance.now() - start).toFixed(2), heap_delta: process.memoryUsage().heapUsed - heap };
};
const output = ({ ms, heap_delta }) => ({ ms, heap_delta });

for (const count of sizes) {
  const authority = new MemoryAuthority({ snapshotPageSize: 200 });
  const records = Array.from({ length: count }, (_, index) => ({
    record_id: `record-${index}`, path: `notes/${String(index).padStart(5, "0")}.md`,
    frontmatter: { title: `Note ${index}`, status: "open" }, body: `${"Generated note body. ".repeat(40)}\n`, types: [],
  }));
  authority.seed(records);
  const replica = authority.registerReplica({ name: "Generated benchmark", mode: "read_write" });
  const vault = new MemoryVault();
  for (const record of authority.serialize().records) await vault.create(record.path, record.document);
  for (let index = 0; index < 50; index++) await vault.createBinary(`attachments/${index}.png`, new Uint8Array(32_768).buffer);
  const transport = authority.transport(replica);
  const calls = { snapshot: 0, changes: 0, readText: 0, writes: 0, write_bytes: 0 };
  const trackedTransport = { ...transport,
    snapshot: async (...args) => { calls.snapshot++; return transport.snapshot(...args); },
    changes: async (...args) => { calls.changes++; return transport.changes(...args); },
  };
  const fileSystem = new ObsidianMirrorFileSystem(vault);
  const readText = fileSystem.readText.bind(fileSystem);
  fileSystem.readText = async (...args) => { calls.readText++; return readText(...args); };
  let state = null;
  const stateStore = {
    read: async () => state,
    write: async (next) => { state = structuredClone(next); calls.writes++; calls.write_bytes += Buffer.byteLength(JSON.stringify(next)); },
  };
  const mirror = new WritableDirectoryMirror(replica, trackedTransport, { fileSystem, stateStore });
  const initial = await measure(() => mirror.review());
  const initialCalls = { ...calls };
  const initialApply = await measure(() => mirror.apply(initial.value.plan));
  assert.equal(initialApply.value.status, "applied");
  const reset = () => { for (const key of Object.keys(calls)) calls[key] = 0; };
  reset();
  const unchanged = await measure(() => mirror.review());
  assert.equal(unchanged.value.plan.actions.length, 0);
  const unchangedCalls = { ...calls };
  const first = vault.files.get(records[0].path);
  await vault.modify(first.file, first.content + "One local edit.\n");
  reset();
  const incremental = await measure(() => mirror.review());
  assert.equal(incremental.value.plan.summary.uploads, 1);
  const incrementalCalls = { ...calls };
  reset();
  const incrementalApply = await measure(() => mirror.apply(incremental.value.plan));
  assert.equal(incrementalApply.value.status, "applied");
  const applyCalls = { ...calls };
  reset();
  const probe = await measure(() => trackedTransport.changes(state.cursor, 1));
  const stateBytes = Buffer.byteLength(JSON.stringify(state));
  const idb = new IndexedDbMirrorStateStore(`generated-${count}`);
  const idbWrite = await measure(() => idb.write(state));
  const idbRead = await measure(() => idb.read());
  const idbProbe = await measure(async () => {
    const checkpoint = await idb.readCheckpoint();
    return trackedTransport.changes(checkpoint.cursor, 1);
  });
  // This is fake-indexeddb's structured-clone cost, not Chromium disk latency.
  assert.equal(Object.keys(idbRead.value.records).length, count);
  idb.close();
  console.log(JSON.stringify({ count, attachments: 50, generated_document_bytes: records[0].body.length,
    initial: { ...output(initial), actions: initial.value.plan.actions.length, calls: initialCalls },
    initial_apply: output(initialApply), unchanged: { ...output(unchanged), calls: unchangedCalls },
    incremental: { ...output(incremental), calls: incrementalCalls },
    incremental_apply: { ...output(incrementalApply), calls: applyCalls },
    probe: output(probe), state_bytes: stateBytes, fake_idb_write: output(idbWrite), fake_idb_read: output(idbRead),
    fake_idb_probe: output(idbProbe),
  }));
}
