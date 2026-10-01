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
const { WritableDirectoryMirror, MemoryMirrorBlobStore } = await import(sdkRoot
  ? pathToFileURL(resolve(sdkRoot, "dist/mirror.js")).href : "@mdbase-dev/connect-sync/mirror");
import { MemoryVault } from "../.test-dist/test/memoryVault.js";
import { IndexedDbMirrorStateStore, ObsidianMirrorFileSystem } from "../.test-dist/src/connectSync.js";
import { indexedDB } from "fake-indexeddb";

Object.assign(globalThis, { indexedDB });
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(10_000, 20_000, 50_000);
assert.ok(sizes.every((size) => Number.isSafeInteger(size) && size > 0));
const emptyVault = process.env.MDBASE_PROFILE_EMPTY_VAULT === "1";
const attachmentCount = Number(process.env.MDBASE_PROFILE_ATTACHMENT_COUNT ?? 50);
const attachmentBytes = Number(process.env.MDBASE_PROFILE_ATTACHMENT_BYTES ?? 32_768);
assert.ok(Number.isSafeInteger(attachmentCount) && attachmentCount > 0);
assert.ok(Number.isSafeInteger(attachmentBytes) && attachmentBytes >= 8 && attachmentBytes <= 32 * 1024 * 1024);
assert.ok(attachmentCount * attachmentBytes <= 128 * 1024 * 1024, "Keep generated attachments within 128 MiB");
const measure = async (operation) => {
  globalThis.gc?.();
  const before = process.memoryUsage();
  const start = performance.now();
  const value = await operation();
  const after = process.memoryUsage();
  return { value, ms: +(performance.now() - start).toFixed(2), heap_delta: after.heapUsed - before.heapUsed,
    external_delta: after.external - before.external, rss_delta: after.rss - before.rss };
};
const output = ({ ms, heap_delta, external_delta, rss_delta }) => ({ ms, heap_delta, external_delta, rss_delta });

for (const count of sizes) {
  const authority = new MemoryAuthority({ snapshotPageSize: 200 });
  const records = Array.from({ length: count }, (_, index) => ({
    record_id: `record-${index}`, path: `notes/${String(index).padStart(5, "0")}.md`,
    frontmatter: { title: `Note ${index}`, status: "open" }, body: `${"Generated note body. ".repeat(40)}\n`, types: [],
  }));
  authority.seed(records);
  const replica = authority.registerReplica({ name: "Generated benchmark", mode: "read_write" });
  const vault = new MemoryVault();
  if (!emptyVault) for (const record of authority.serialize().records) await vault.create(record.path, record.document);
  for (let index = 0; index < attachmentCount; index++) {
    const bytes = new Uint8Array(attachmentBytes);
    // Distinct payloads must not accidentally share one content-addressed blob.
    new DataView(bytes.buffer).setUint32(0, index, true);
    await vault.createBinary(`attachments/${index}.png`, bytes.buffer);
  }
  const transport = authority.transport(replica);
  const calls = { snapshot: 0, changes: 0, readText: 0, writes: 0, write_bytes: 0,
    inspectBinary: 0, inspect_binary_bytes: 0, readBinary: 0, read_binary_bytes: 0,
    vault_file_lists: 0, vault_list_entries: 0 };
  const getFiles = vault.getFiles.bind(vault);
  vault.getFiles = () => {
    const files = getFiles();
    calls.vault_file_lists++;
    calls.vault_list_entries += files.length;
    return files;
  };
  const trackedTransport = { ...transport,
    snapshot: async (...args) => { calls.snapshot++; return transport.snapshot(...args); },
    changes: async (...args) => { calls.changes++; return transport.changes(...args); },
  };
  const fileSystem = new ObsidianMirrorFileSystem(vault);
  const readText = fileSystem.readText.bind(fileSystem);
  fileSystem.readText = async (...args) => { calls.readText++; return readText(...args); };
  const inspectBinary = fileSystem.inspectBinary.bind(fileSystem);
  fileSystem.inspectBinary = async (...args) => {
    calls.inspectBinary++;
    const info = await inspectBinary(...args);
    calls.inspect_binary_bytes += info?.size ?? 0;
    return info;
  };
  const readBinary = fileSystem.readBinary.bind(fileSystem);
  fileSystem.readBinary = async (...args) => {
    calls.readBinary++;
    const source = await readBinary(...args);
    return source && (async function* () {
      for await (const bytes of source) { calls.read_binary_bytes += bytes.byteLength; yield bytes; }
    })();
  };
  let state = null;
  const stateStore = {
    read: async () => state,
    write: async (next) => { state = structuredClone(next); calls.writes++; calls.write_bytes += Buffer.byteLength(JSON.stringify(next)); },
  };
  const mirror = new WritableDirectoryMirror(replica, trackedTransport, { fileSystem, stateStore });
  const reset = () => { for (const key of Object.keys(calls)) calls[key] = 0; };
  const initial = await measure(() => mirror.review());
  const initialCalls = { ...calls };
  const initialActions = initial.value.plan.actions.length;
  reset();
  const initialApply = await measure(() => mirror.apply(initial.value.plan));
  assert.equal(initialApply.value.status, "applied");
  initial.value = null;
  const initialApplyCalls = { ...calls };
  reset();
  const unchanged = await measure(() => mirror.review());
  assert.equal(unchanged.value.plan.actions.length, 0);
  unchanged.value = null;
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
  incremental.value = null;
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
  idbRead.value = null;
  idb.close();
  // Selected pending attachments: review hashes fresh exact bytes and stages
  // revision-bound payloads, but never calls a hosted file service or applies.
  const withFiles = new WritableDirectoryMirror(replica, trackedTransport, {
    fileSystem, stateStore, blobStore: new MemoryMirrorBlobStore(),
    selectiveSync: { excluded_folders: [], file_classes: ["image"] },
  });
  reset();
  const fileCold = await measure(() => withFiles.review());
  assert.equal(fileCold.value.plan.summary.uploads, attachmentCount);
  assert.equal(calls.inspect_binary_bytes, attachmentCount * attachmentBytes);
  assert.equal(calls.readBinary, attachmentCount);
  const fileColdCalls = { ...calls };
  const fileFingerprint = fileCold.value.plan.fingerprint;
  fileCold.value = null;
  reset();
  const fileWarm = await measure(() => withFiles.review());
  assert.equal(fileWarm.value.plan.fingerprint, fileFingerprint);
  fileWarm.value = null;
  assert.equal(calls.readBinary, 0, "intact revision-bound blob snapshots are reusable");
  const fileWarmCalls = { ...calls };
  const binary = vault.binaryFiles.get("attachments/0.png");
  const edited = binary.content.slice(0);
  new Uint8Array(edited)[edited.byteLength - 1] ^= 1;
  await vault.modifyBinary(binary.file, edited);
  reset();
  const fileEdit = await measure(() => withFiles.review());
  assert.notEqual(fileEdit.value.plan.fingerprint, fileFingerprint, "same-size binary edits stay detectable");
  assert.equal(calls.readBinary, 1, "only the edited attachment needs a new payload snapshot");
  console.log(JSON.stringify({ count, empty_vault: emptyVault, attachments: attachmentCount, attachment_bytes: attachmentBytes, generated_document_bytes: records[0].body.length,
    initial: { ...output(initial), actions: initialActions, calls: initialCalls },
    initial_apply: { ...output(initialApply), calls: initialApplyCalls }, unchanged: { ...output(unchanged), calls: unchangedCalls },
    incremental: { ...output(incremental), calls: incrementalCalls },
    incremental_apply: { ...output(incrementalApply), calls: applyCalls },
    probe: output(probe), state_bytes: stateBytes, fake_idb_write: output(idbWrite), fake_idb_read: output(idbRead),
    fake_idb_probe: output(idbProbe),
    selected_pending_files_cold: { ...output(fileCold), calls: fileColdCalls },
    selected_pending_files_warm: { ...output(fileWarm), calls: fileWarmCalls },
    selected_pending_files_same_size_edit: { ...output(fileEdit), calls: { ...calls } },
  }));
}
