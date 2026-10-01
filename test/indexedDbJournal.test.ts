import "fake-indexeddb/auto";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryAuthority } from "@mdbase-dev/connect-sync";
import { WritableDirectoryMirror, type MirrorState } from "@mdbase-dev/connect-sync/mirror";
import { IndexedDbMirrorStateStore, ObsidianMirrorFileSystem } from "../src/connectSync";
import { ReceiptObservingStateStore } from "../src/syncHistory";
import { MemoryVault } from "./memoryVault";

function seeded(count: number): MemoryAuthority {
  const hosted = new MemoryAuthority();
  hosted.seed(Array.from({ length: count }, (_, index) => ({
    record_id: `r${String(index).padStart(5, "0")}`,
    path: `notes/${String(index).padStart(5, "0")}.md`,
    frontmatter: { title: `Note ${index}` },
    body: `${"Body text for a realistic note. ".repeat(20)}\n`,
    types: [],
  })));
  return hosted;
}

/** Counts full-state writes and total serialized bytes the store sends to IndexedDB. */
function measurePuts(stateKey: string) {
  const put = IDBObjectStore.prototype.put;
  const counts = { fullWrites: 0, journalWrites: 0, bytes: 0 };
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    if (key === stateKey) counts.fullWrites++;
    else if (Array.isArray(key) && key[0] === stateKey && key[1] === "journal") counts.journalWrites++;
    counts.bytes += JSON.stringify(value)?.length ?? 0;
    return put.call(this, value, key);
  };
  return { counts, restore: () => { IDBObjectStore.prototype.put = put; } };
}

async function firstSync(count: number) {
  const hosted = seeded(count);
  const replica = hosted.registerReplica({ name: "Journal", mode: "read_write" });
  const key = crypto.randomUUID();
  const store = new IndexedDbMirrorStateStore(key);
  const vault = new MemoryVault();
  const mirror = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: store,
  });
  const meter = measurePuts(key);
  try {
    const outcome = await mirror.sync();
    assert.equal(outcome.status, "applied");
  } finally {
    meter.restore();
  }
  assert.equal(vault.getFiles().length, count);
  return meter.counts;
}

test("a first sync appends one small journal event per note instead of rewriting the whole batch", async () => {
  const small = await firstSync(50);
  const large = await firstSync(200);
  // Full-state writes no longer grow with the vault (prepare + completion).
  assert.ok(large.fullWrites <= 4, `full-state writes: ${large.fullWrites}`);
  assert.equal(large.fullWrites, small.fullWrites);
  assert.ok(large.journalWrites >= 200, "each applied note is journaled");
  // Bytes grow linearly: 4x the notes may cost ~4x the bytes, never ~16x.
  const ratio = large.bytes / small.bytes;
  assert.ok(ratio < 6, `bytes grew ${ratio.toFixed(1)}x for 4x the notes`);
});

test("a sync interrupted mid-batch resumes from state plus journal in a fresh adapter", async () => {
  const count = 30;
  const hosted = seeded(count);
  const replica = hosted.registerReplica({ name: "Crash", mode: "read_write" });
  const key = crypto.randomUUID();
  const vault = new MemoryVault();
  let created = 0;
  const create = vault.create.bind(vault);
  vault.create = async (path: string, content: string) => {
    if (path.startsWith("notes/") && ++created === 12) throw new Error("disk went away");
    return create(path, content);
  };
  const first = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new IndexedDbMirrorStateStore(key),
  });
  const interrupted = await first.sync();
  assert.notEqual(interrupted.status, "applied");

  // A new adapter (as after an app restart) sees the base state with every journaled receipt.
  const reopened = await new IndexedDbMirrorStateStore(key).read();
  assert.ok(reopened?.batch, "the interrupted batch is still durable");
  assert.equal(reopened.batch.receipts.length, 11, "the eleven completed notes are recorded");

  vault.create = create;
  const resumed = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new IndexedDbMirrorStateStore(key),
  });
  assert.equal((await resumed.sync()).status, "applied");
  assert.equal(vault.getFiles().filter((file) => file.path.startsWith("notes/")).length, count);
  const settled = await new IndexedDbMirrorStateStore(key).read();
  assert.equal(settled?.batch, undefined);
  assert.equal(Object.keys(settled?.records ?? {}).length, count);
});

test("a full write or clear drops journal events atomically", async () => {
  const key = crypto.randomUUID();
  const store = new IndexedDbMirrorStateStore(key);
  const base = { replica_id: key, cursor: 1, scope_epoch: 1, records: {}, batch: { phase: "prepared", plan: { fingerprint: "f" }, receipts: [], next_action: 0 } } as unknown as MirrorState;
  await store.write(base);
  await store.appendJournal({ type: "phase", plan_fingerprint: "f", phase: "applying" });
  assert.equal((await store.read())?.batch?.phase, "applying");
  await store.write({ ...base, cursor: 2, batch: undefined } as MirrorState);
  const after = await new IndexedDbMirrorStateStore(key).read();
  assert.equal(after?.cursor, 2);
  assert.equal(after?.batch, undefined, "stale journal events are not replayed onto newer state");
  await store.clear();
  assert.equal(await new IndexedDbMirrorStateStore(key).read(), null);
});

test("journal events without a base state, or with out-of-order receipts, are reported as corrupt", async () => {
  const key = crypto.randomUUID();
  const store = new IndexedDbMirrorStateStore(key);
  await assert.rejects(
    store.appendJournal({ type: "phase", plan_fingerprint: "f", phase: "applying" }),
    (error: unknown) => (error as { code?: string }).code === "invalid_mirror_state",
  );
  await store.write({
    replica_id: key, cursor: 1, scope_epoch: 1, records: {},
    batch: { phase: "applying", plan: { fingerprint: "f", actions: [{ action_id: "a1" }, { action_id: "a2" }] }, receipts: [], next_action: 0 },
  } as unknown as MirrorState);
  // Events for another batch are stale and ignored, exactly as the SDK's file journal does.
  await store.appendJournal({ type: "phase", plan_fingerprint: "other", phase: "blocked" });
  assert.equal((await new IndexedDbMirrorStateStore(key).read())?.batch?.phase, "applying");
  await store.appendJournal({ type: "receipt", plan_fingerprint: "f", receipt: { action_id: "a2", status: "completed" }, delta: {} } as never);
  await assert.rejects(
    new IndexedDbMirrorStateStore(key).read(),
    (error: unknown) => (error as { code?: string }).code === "invalid_mirror_state",
  );
});

test("sync history still records every file when receipts are journaled, including after a restart", async () => {
  const count = 20;
  const hosted = seeded(count);
  const replica = hosted.registerReplica({ name: "History", mode: "read_write" });
  const key = crypto.randomUUID();
  const vault = new MemoryVault();
  const reported: string[] = [];
  let created = 0;
  const create = vault.create.bind(vault);
  vault.create = async (path: string, content: string) => {
    if (path.startsWith("notes/") && ++created === 8) throw new Error("interrupted");
    return create(path, content);
  };
  const observed = () => new ReceiptObservingStateStore(new IndexedDbMirrorStateStore(key), (action) => {
    reported.push(action.action_id);
  });
  const first = observed();
  assert.ok(first.appendJournal, "the wrapper exposes journaling so the SDK uses it");
  await new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never), stateStore: first,
  }).sync();
  assert.equal(reported.length, 7);

  vault.create = create;
  await new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never), stateStore: observed(),
  }).sync();
  assert.equal(new Set(reported).size, count, "every note is reported exactly once across the restart");
  assert.equal(reported.length, count);
});
