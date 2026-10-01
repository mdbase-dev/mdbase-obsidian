import "fake-indexeddb/auto";
import { forceCloseDatabase } from "fake-indexeddb";
import assert from "node:assert/strict";
import test from "node:test";
import { IndexedDbMirrorBlobStore, IndexedDbMirrorStateStore } from "../src/connectSync";
import type { MirrorState } from "@mdbase-dev/connect-sync/mirror";

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

test("a connection closed while the app was suspended is reopened without losing checkpoints or blobs", async () => {
  const key = crypto.randomUUID();
  const stateStore = new IndexedDbMirrorStateStore(key);
  const blobStore = new IndexedDbMirrorBlobStore(key);
  const state = { replica_id: key, generation: 7 } as MirrorState;
  const connections = new Set<IDBDatabase>();
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
    connections.add(this);
    return transaction.apply(this, args);
  };
  try {
    await stateStore.write(state);
    await blobStore.write(digest, bytes());
  } finally {
    IDBDatabase.prototype.transaction = transaction;
  }
  // fake-indexeddb's declaration incorrectly names the constructor type here;
  // the implementation accepts the live database instance.
  await Promise.all([...connections].map((database) => new Promise<void>((resolve) => {
    database.addEventListener("close", () => resolve(), { once: true });
    forceCloseDatabase(database as unknown as Parameters<typeof forceCloseDatabase>[0]);
  })));
  assert.deepEqual(await stateStore.read(), state);
  const result: number[] = [];
  for await (const chunk of blobStore.read(digest)) result.push(...chunk);
  assert.deepEqual(result, [0, 1, 255]);
  stateStore.close();
  blobStore.close();
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
