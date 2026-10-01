import assert from "node:assert/strict";
import test from "node:test";
import type { MirrorPlanAction, MirrorState, MirrorStateStore } from "@mdbase-dev/connect-sync/mirror";
import {
  filterRuns,
  historyEvent,
  historyFileFromReceipt,
  historyForPath,
  parseHistory,
  pruneRuns,
  ReceiptObservingStateStore,
  summarizeRun,
  SyncHistoryStore,
  type HistoryAdapter,
  type SyncHistoryRun,
} from "../src/syncHistory";

const digest = (n: number) => `sha256:${String(n).repeat(64)}`;

function write(id: string, path: string, local: "absent" | "exact" = "absent"): MirrorPlanAction {
  const target = { entity: "record" as const, identity: `record-${id}`, path, revision: digest(1), payload_revision: digest(1) };
  return {
    command: "write_local",
    action_id: id,
    depends_on: [],
    reason: "remote_change",
    target,
    payload_revision: digest(1),
    expected_local: local === "absent" ? { state: "absent" } : { state: "exact", object: target },
    expected_path_owner: { state: "absent" },
  };
}

function move(id: string, from: string, to: string): MirrorPlanAction {
  return {
    command: "move_remote",
    action_id: id,
    depends_on: [],
    reason: "local_change",
    source: { entity: "record", identity: `record-${id}`, path: from, revision: digest(2), payload_revision: digest(2) },
    target_path: to,
    expected_source_owner: { state: "absent" },
    expected_target_owner: { state: "absent" },
    expected_local: { state: "absent" },
    idempotency_key: id,
  };
}

const checkpoint: MirrorPlanAction = {
  command: "advance_checkpoint",
  action_id: "checkpoint",
  depends_on: [],
  reason: "remote_change",
  expected: { generation: 1, cursor: 1 },
  next: { generation: 2, cursor: 2 },
};

function batchState(actions: MirrorPlanAction[], completed: number): MirrorState {
  return {
    protocol_version: 1,
    replica_id: "replica",
    scope_epoch: 1,
    cursor: 1,
    records: {},
    batch: {
      phase: "applying",
      plan: { fingerprint: "plan-a", actions } as never,
      next_action: completed,
      receipts: actions.slice(0, completed).map((action) => ({ action_id: action.action_id, status: "completed" as const })),
      payloads: { documents: {}, records: {}, resources: {}, files: {}, local_files: {}, mutations: {} },
      checkpoint_before: { generation: 1, cursor: 1 },
      checkpoint_after: { generation: 2, cursor: 2 },
    },
  };
}

class RecordingStore implements MirrorStateStore {
  writes = 0;
  async read(): Promise<MirrorState | null> { return null; }
  async write(): Promise<void> { this.writes += 1; }
}

test("the observer reports each action the engine receipts, and only those", async () => {
  const actions = [write("a", "notes/a.md"), write("b", "notes/b.md"), write("c", "notes/c.md"), checkpoint];
  const seen: string[] = [];
  const inner = new RecordingStore();
  const store = new ReceiptObservingStateStore(inner, (action) => seen.push(action.action_id));
  await store.write(batchState(actions, 0)); // prepared
  await store.write(batchState(actions, 0)); // applying
  await store.write(batchState(actions, 1));
  await store.write(batchState(actions, 2));
  // Stopped here: "c" never received a receipt.
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(inner.writes, 4, "every write still reaches the durable store");
});

test("a resumed batch does not re-report receipts from the interrupted run", async () => {
  const actions = [write("a", "notes/a.md"), write("b", "notes/b.md"), checkpoint];
  const seen: string[] = [];
  const store = new ReceiptObservingStateStore(new RecordingStore(), (action) => seen.push(action.action_id));
  await store.write(batchState(actions, 1)); // beginApplying on resume
  await store.write(batchState(actions, 2));
  assert.deepEqual(seen, ["b"]);
});

test("receipt lookup indexes a large plan once instead of scanning it per action", async () => {
  const actions = Array.from({ length: 20_000 }, (_, index) => write(String(index), `${index}.md`));
  let inspectedActions = 0;
  for (const action of actions) {
    const id = action.action_id;
    Object.defineProperty(action, "action_id", { get: () => { inspectedActions++; return id; } });
  }
  const state = batchState(actions, 0);
  const seen: string[] = [];
  const store = new ReceiptObservingStateStore(new RecordingStore(), (action) => seen.push(action.action_id));
  await store.write(state);
  for (let index = 0; index < actions.length; index++) {
    state.batch!.receipts.push({ action_id: String(index), status: "completed" });
    await store.write(state);
  }
  assert.equal(seen.length, actions.length);
  assert.ok(inspectedActions <= actions.length * 2,
    `Expected one index and one callback read per action, got ${inspectedActions} reads`);
});

test("history rows describe direction, verb, rename source and failures", () => {
  const created = historyFileFromReceipt(write("a", "notes/a.md"), { action_id: "a", status: "completed" }, "t");
  assert.deepEqual(created, { path: "notes/a.md", kind: "document", direction: "download", action: "create", status: "completed", at: "t" });
  const updated = historyFileFromReceipt(write("a", "notes/a.md", "exact"), { action_id: "a", status: "completed" }, "t");
  assert.equal(updated?.action, "update");
  const renamed = historyFileFromReceipt(move("m", "old.md", "new.md"), {
    action_id: "m",
    status: "rejected",
    failure: { code: "denied", message: "Not allowed" },
  }, "t");
  assert.deepEqual(renamed, {
    path: "new.md", fromPath: "old.md", kind: "document", direction: "upload",
    action: "rename", status: "rejected", at: "t", message: "Not allowed",
  });
  assert.equal(historyFileFromReceipt(checkpoint, { action_id: "checkpoint", status: "completed" }, "t"), null);
});

function run(id: string, finishedAt: string, paths: string[], collectionId = "c1"): SyncHistoryRun {
  return {
    id, collectionId, startedAt: finishedAt, finishedAt, outcome: "applied",
    files: paths.map((path) => ({ path, kind: "document", direction: "download", action: "update", status: "completed", at: finishedAt })),
  };
}

test("summaries, path filters and per-note history", () => {
  const first = run("1", "2026-09-20T10:00:00.000Z", ["a.md", "b.md"]);
  const second: SyncHistoryRun = {
    ...run("2", "2026-09-21T10:00:00.000Z", []),
    files: [
      { path: "new.md", fromPath: "a.md", kind: "document", direction: "upload", action: "rename", status: "completed", at: "2026-09-21T10:00:00.000Z" },
      { path: "c.md", kind: "document", direction: "attention", action: "fix", status: "conflicted", at: "2026-09-21T10:00:00.000Z" },
    ],
  };
  assert.equal(summarizeRun(first), "2 downloaded");
  assert.equal(summarizeRun(second), "1 uploaded · 1 conflicts");
  assert.deepEqual(filterRuns([first, second], "B.MD").map((r) => [r.id, r.files.length]), [["1", 1]]);
  assert.deepEqual(historyForPath([first, second], "a.md").map(({ run: r }) => r.id), ["2", "1"]);
});

test("pruning drops old runs, then the oldest runs over the file limit, but never the newest", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  const runs = [
    run("old", "2026-05-01T00:00:00.000Z", ["x.md"]),
    run("a", "2026-09-20T00:00:00.000Z", ["1", "2", "3"]),
    run("b", "2026-09-21T00:00:00.000Z", ["4", "5"]),
    run("c", "2026-09-22T00:00:00.000Z", ["6", "7", "8", "9"]),
  ];
  assert.deepEqual(pruneRuns(runs, { maxAgeDays: 90, maxFiles: 6, maxRuns: 100 }, now).map((r) => r.id), ["b", "c"]);
  assert.deepEqual(pruneRuns(runs.slice(3), { maxAgeDays: 90, maxFiles: 1, maxRuns: 100 }, now).map((r) => r.id), ["c"]);
});

test("a torn or foreign line does not lose the rest of the log", () => {
  const good = JSON.stringify(run("1", "2026-09-20T00:00:00.000Z", ["a.md"]));
  assert.deepEqual(parseHistory(`${good}\n{"id":1}\n{"id":"2","coll`).map((r) => r.id), ["1"]);
});

class MemoryAdapter implements HistoryAdapter {
  files = new Map<string, string>();
  appends = 0;
  async exists(path: string) { return this.files.has(path); }
  async read(path: string) { return this.files.get(path) ?? ""; }
  async write(path: string, data: string) { this.files.set(path, data); }
  async append(path: string, data: string) {
    this.appends += 1;
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
}

test("the store appends one line per run, filters by collection and survives a reload", async () => {
  const adapter = new MemoryAdapter();
  const recent = new Date().toISOString();
  const store = new SyncHistoryStore(adapter, "history.jsonl");
  await store.load();
  await store.append(run("1", recent, ["a.md"]));
  await store.append(run("2", recent, ["b.md"], "c2"));
  assert.equal(adapter.appends, 1, "the first run creates the file; later runs append");
  assert.equal(adapter.files.get("history.jsonl")?.trim().split("\n").length, 2);
  const reloaded = new SyncHistoryStore(adapter, "history.jsonl");
  await reloaded.load();
  assert.deepEqual(reloaded.list("c1").map((r) => r.id), ["1"]);
  await reloaded.clear();
  assert.equal(adapter.files.get("history.jsonl"), "");
});

test("concurrent history appends never duplicate entries on disk", async () => {
  const adapter = new MemoryAdapter();
  const now = new Date().toISOString();
  const store = new SyncHistoryStore(adapter, "history.jsonl");
  await store.load();
  await Promise.all(Array.from({ length: 5 }, (_, index) => store.append(run(String(index), now, [`${index}.md`]))));
  const reloaded = new SyncHistoryStore(adapter, "history.jsonl");
  await reloaded.load();
  assert.deepEqual(reloaded.list().map((entry) => entry.id), ["0", "1", "2", "3", "4"]);
});

test("history repairs a torn tail before appending the next run", async () => {
  const adapter = new MemoryAdapter();
  const now = new Date().toISOString();
  adapter.files.set("history.jsonl", `${JSON.stringify(run("first", now, ["a.md"]))}\n{"id":"torn`);
  const store = new SyncHistoryStore(adapter, "history.jsonl");
  await store.load();
  await store.append(run("next", now, ["b.md"]));
  const reloaded = new SyncHistoryStore(adapter, "history.jsonl");
  await reloaded.load();
  assert.deepEqual(reloaded.list().map((entry) => entry.id), ["first", "next"]);
});

test("events share the log: they filter by path, appear in note history, and pinned ones survive clearing", async () => {
  const adapter = new MemoryAdapter();
  const store = new SyncHistoryStore(adapter, "history.jsonl");
  await store.load();
  const now = new Date().toISOString();
  const pinned = historyEvent("c1", { summary: "Synchronization needs attention", tone: "attention", needsAcknowledgement: true }, now);
  const decision = historyEvent("c1", { summary: "Conflict resolved with local version", tone: "info", path: "notes/a.md" }, now);
  await store.append(run("1", now, ["notes/b.md"]));
  await store.append(pinned);
  await store.append(decision);
  assert.equal(summarizeRun(decision), "Conflict resolved with local version");
  assert.deepEqual(filterRuns(store.list("c1"), "notes/a").map((r) => r.id), [decision.id]);
  assert.deepEqual(historyForPath(store.list("c1"), "notes/a.md").map(({ run }) => run.id), [decision.id]);
  await store.clear();
  assert.deepEqual(store.list("c1").map((r) => r.id), [pinned.id]);
  await store.acknowledge(pinned.id);
  assert.deepEqual(store.list("c1").map((r) => [r.id, r.needsAcknowledgement]), [[pinned.id, false]]);
  const reloaded = new SyncHistoryStore(adapter, "history.jsonl");
  await reloaded.load();
  assert.deepEqual(reloaded.list("c1").map((r) => [r.id, r.needsAcknowledgement]), [[pinned.id, false]]);
  await reloaded.clear();
  assert.deepEqual(reloaded.list("c1"), []);
});

test("pruning bounds the number of entries as well as their files", () => {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const runs = Array.from({ length: 5 }, (_, index) => historyEvent("c1", { summary: String(index), tone: "info" }, at));
  assert.equal(pruneRuns(runs, { maxAgeDays: 90, maxFiles: 100, maxRuns: 3 }, now).length, 3);
});
