import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { IndexedDbMirrorBlobStore, IndexedDbMirrorStateStore } from "../src/connectSync";
import type { MirrorState } from "@mdbase-dev/connect-sync/mirror";

type CheckpointStore = IndexedDbMirrorStateStore & {
  readCheckpoint(): Promise<{ cursor: number; scope_epoch: number; recovery_required: boolean } | null>;
};

test("change probes read only the tiny checkpoint summary, not 20k stored records", async () => {
  const key = crypto.randomUUID();
  const store = new IndexedDbMirrorStateStore(key) as CheckpointStore;
  const state = {
    replica_id: key, cursor: 12, scope_epoch: 7,
    records: Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [String(index), {
      path: `${index}.md`, revision: "revision", hash: "hash", record: { document: "Generated body. ".repeat(40) },
    }])),
  } as unknown as MirrorState;
  await store.write(state);
  const get = IDBObjectStore.prototype.get;
  let fullReads = 0;
  IDBObjectStore.prototype.get = function (requested) {
    if (requested === key) fullReads++;
    return get.call(this, requested);
  };
  try {
    for (let index = 0; index < 20; index++) assert.deepEqual(await store.readCheckpoint(), {
      cursor: 12, scope_epoch: 7, recovery_required: false,
    });
    assert.equal(fullReads, 0, "polling must not structured-clone the stored documents");
  } finally {
    IDBObjectStore.prototype.get = get;
  }
  await store.write({ ...state, cursor: 13, scope_epoch: 8, batch: { phase: "prepared" } } as MirrorState);
  assert.deepEqual(await store.readCheckpoint(), { cursor: 13, scope_epoch: 8, recovery_required: true });
  await store.clear();
  assert.equal(await store.readCheckpoint(), null);
  assert.equal(await store.read(), null);
  store.close();
});

test("probe summaries observe another adapter's atomic write and clear, not a cached cursor", async () => {
  const key = crypto.randomUUID();
  const reader = new IndexedDbMirrorStateStore(key) as CheckpointStore;
  const writer = new IndexedDbMirrorStateStore(key);
  await reader.write({ cursor: 1, scope_epoch: 2, records: {} } as MirrorState);
  assert.deepEqual(await reader.readCheckpoint(), { cursor: 1, scope_epoch: 2, recovery_required: false });
  await writer.write({ cursor: 3, scope_epoch: 4, records: {}, batch: { phase: "prepared" } } as MirrorState);
  assert.deepEqual(await reader.readCheckpoint(), { cursor: 3, scope_epoch: 4, recovery_required: true });
  await writer.clear();
  assert.equal(await reader.readCheckpoint(), null);
  reader.close();
  writer.close();
});

test("a reopened adapter repairs summaries left stale or missing by older plugins once", async () => {
  const key = crypto.randomUUID();
  const original = new IndexedDbMirrorStateStore(key);
  await original.write({ cursor: 1, scope_epoch: 2, records: {} } as MirrorState);
  original.close();
  // Older versions write only the string-keyed full state, leaving a stale summary.
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("mdbase-obsidian-connect", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("mirrors", "readwrite");
    transaction.objectStore("mirrors").put({ cursor: 9, scope_epoch: 10, records: {} }, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
  const store = new IndexedDbMirrorStateStore(key) as CheckpointStore;
  const get = IDBObjectStore.prototype.get;
  let fullReads = 0;
  IDBObjectStore.prototype.get = function (requested) {
    if (requested === key) fullReads++;
    return get.call(this, requested);
  };
  try {
    assert.deepEqual(await store.readCheckpoint(), { cursor: 9, scope_epoch: 10, recovery_required: false });
    assert.deepEqual(await store.readCheckpoint(), { cursor: 9, scope_epoch: 10, recovery_required: false });
    assert.equal(fullReads, 1, "legacy reconciliation happens once, not on every poll");
  } finally {
    IDBObjectStore.prototype.get = get;
    store.close();
  }
});

test("a summary write failure rolls back both state and its probe checkpoint", async () => {
  const store = new IndexedDbMirrorStateStore(crypto.randomUUID()) as CheckpointStore;
  const before = { cursor: 1, scope_epoch: 2, records: {} } as MirrorState;
  await store.write(before);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    const request = put.apply(this, args);
    if (Array.isArray(args[1])) this.transaction.abort();
    return request;
  };
  try {
    await assert.rejects(store.write({ ...before, cursor: 3, scope_epoch: 4 }));
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(await store.readCheckpoint(), { cursor: 1, scope_epoch: 2, recovery_required: false });
  store.close();
});

test("a summary clear failure cannot leave state and probe metadata disagreeing", async () => {
  const store = new IndexedDbMirrorStateStore(crypto.randomUUID()) as CheckpointStore;
  const before = { cursor: 1, scope_epoch: 2, records: {} } as MirrorState;
  await store.write(before);
  const remove = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (key) {
    const request = remove.call(this, key);
    if (Array.isArray(key)) this.transaction.abort();
    return request;
  };
  try {
    await assert.rejects(store.clear());
  } finally {
    IDBObjectStore.prototype.delete = remove;
  }
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(await store.readCheckpoint(), { cursor: 1, scope_epoch: 2, recovery_required: false });
  store.close();
});

test("aborted IndexedDB writes reject without replacing the last durable checkpoint", async () => {
  const key = crypto.randomUUID();
  const store = new IndexedDbMirrorStateStore(key);
  const original = { replica_id: key, generation: 1 } as MirrorState;
  await store.write(original);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    const request = put.apply(this, args);
    this.transaction.abort();
    return request;
  };
  try {
    await assert.rejects(store.write({ ...original, generation: 2 }));
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  store.close();
  assert.deepEqual(await new IndexedDbMirrorStateStore(key).read(), original);
});

test("a transient IndexedDB open failure does not poison either adapter forever", async () => {
  const adapters = [
    { store: new IndexedDbMirrorStateStore(crypto.randomUUID()), read: function () { return this.store.read(); } },
    { store: new IndexedDbMirrorBlobStore(crypto.randomUUID()), read: function () { return this.store.has(digest); } },
  ];
  for (const adapter of adapters) {
    const open = indexedDB.open;
    let opens = 0;
    indexedDB.open = function (...args: Parameters<typeof open>) {
      opens++;
      if (opens > 1) return open.apply(this, args);
      const request = { error: new DOMException("temporary storage error", "UnknownError") } as IDBOpenDBRequest;
      queueMicrotask(() => request.onerror?.call(request, new Event("error")));
      return request;
    };
    try {
      await assert.rejects(adapter.read(), /temporary storage error/);
      await adapter.read();
      assert.equal(opens, 2, "the next retry must really reopen storage");
    } finally {
      indexedDB.open = open;
      adapter.store.close();
    }
  }
});

test("old binary-stage cleanup failure cannot corrupt a published replacement", async () => {
  const store = new IndexedDbMirrorBlobStore(crypto.randomUUID());
  await store.write(digest, bytes());
  const remove = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (key) {
    const request = remove.call(this, key);
    if (this.name === "chunks") this.transaction.abort();
    return request;
  };
  try {
    await store.write(digest, bytes());
  } finally {
    IDBObjectStore.prototype.delete = remove;
  }
  const result = [];
  for await (const chunk of store.read(digest)) result.push(...chunk);
  assert.deepEqual(result, [0, 1, 255]);
  await store.prune(new Set([digest]));
  assert.equal(await store.has(digest), true);
});

const digest = `sha256:${"a".repeat(64)}` as const;
async function* bytes() { yield Uint8Array.of(0, 1, 255); }

test("IndexedDB checkpoint survives adapter recreation and isolates replicas", async () => {
  const key = crypto.randomUUID();
  const state = { replica_id: key, batch: { pending: true } } as unknown as MirrorState;
  await new IndexedDbMirrorStateStore(key).write(state);
  assert.deepEqual(await new IndexedDbMirrorStateStore(key).read(), state);
  assert.equal(await new IndexedDbMirrorStateStore(`${key}-other`).read(), null);
  await new IndexedDbMirrorStateStore(key).clear();
  assert.equal(await new IndexedDbMirrorStateStore(key).read(), null);
});

test("IndexedDB binary snapshot survives restart and an interrupted replacement", async () => {
  const key = crypto.randomUUID();
  const store = new IndexedDbMirrorBlobStore(key);
  await store.write(digest, bytes());
  await assert.rejects(store.write(digest, (async function* () {
    yield Uint8Array.of(9);
    throw new Error("interrupted source");
  })()), /interrupted/);
  const restarted = new IndexedDbMirrorBlobStore(key);
  const result = [];
  for await (const chunk of restarted.read(digest)) result.push(...chunk);
  assert.deepEqual(result, [0, 1, 255]);
  assert.equal(await new IndexedDbMirrorBlobStore(`${key}-other`).has(digest), false);
  await restarted.prune(new Set([digest]));
  assert.equal(await restarted.has(digest), true);
  await restarted.prune(new Set());
  assert.equal(await restarted.has(digest), false);
});
