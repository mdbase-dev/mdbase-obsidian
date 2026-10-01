import assert from "node:assert/strict";
import test from "node:test";
import type { MirrorStatus, MirrorSyncPlan } from "@mdbase-dev/connect-sync/mirror";
import type { SyncHistoryRun } from "../src/syncHistory";
import { previewFromPlan, type MdbaseSyncPreview } from "../src/syncPreview";
import { SyncSession } from "../src/syncSession";

const digest = `sha256:${"4".repeat(64)}`;
const profile = { collectionId: "c1", name: "Notes" };

function status(overrides: Partial<MirrorStatus> = {}): MirrorStatus {
  return {
    state: "up_to_date",
    mode: "read_write",
    pending: 0,
    pending_files: 0,
    conflicts: [],
    local_issues: [],
    cursor: 1,
    last_synced_at: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

function plan(actions: MirrorSyncPlan["actions"], kind: MirrorSyncPlan["kind"] = "incremental"): MirrorSyncPlan {
  return {
    plan_version: 1,
    engine_profile: "exact_document_plan_only_v1",
    protocol_profile: "exact_document_v1",
    planner_policy: "three_way_exact_document_v1",
    projection_policy: "portable_mirror_projection_v1",
    fingerprint: digest,
    replica_id: "replica",
    mode: "read_write",
    kind,
    base_cursor: 1,
    authority_cursor: 2,
    scope_epoch: 1,
    checkpoint_generation: 1,
    selective_sync: { file_classes: [], excluded_folders: [] },
    actions,
    issues: [],
    summary: { uploads: 0, downloads: actions.length, conflicts: 0, blocking_issues: 0 },
  } as MirrorSyncPlan;
}

const target = (path: string) => ({ entity: "record", identity: path, path, revision: digest, payload_revision: digest }) as const;

const write = (path: string): MirrorSyncPlan["actions"][number] => ({
  command: "write_local",
  action_id: `write-${path}`,
  depends_on: [],
  reason: "remote_change",
  target: target(path),
  payload_revision: digest,
  expected_local: { state: "absent" },
  expected_path_owner: { state: "absent" },
});

const remove = (path: string): MirrorSyncPlan["actions"][number] => ({
  command: "delete_local",
  action_id: `delete-${path}`,
  depends_on: [],
  reason: "remote_change",
  target: target(path),
  expected_local: { state: "absent" },
  expected_path_owner: { state: "absent" },
});

function harness(initial: MdbaseSyncPreview) {
  let next = initial;
  const applied: MdbaseSyncPreview[] = [];
  const runs: SyncHistoryRun[] = [];
  const controller = {
    preview: async () => next,
    status: async () => status(),
    isSyncing: () => false,
    cancelSync: () => undefined,
    sync: async (reviewed: MdbaseSyncPreview) => {
      applied.push(reviewed);
      next = previewFromPlan(plan([]));
      return { status: "applied", applied: reviewed.plan.actions.length, pending: 0 };
    },
    reconnect: async () => { throw Object.assign(new Error("expired"), { code: "mirror_enrollment_expired" }); },
  };
  const history = {
    list: () => runs,
    append: async (run: SyncHistoryRun) => { runs.push(run); },
    remove: async () => undefined,
    clear: async () => undefined,
  };
  const session = new SyncSession(controller as never, () => profile as never, history);
  return { session, applied, runs };
}

test("Sync now applies a routine plan in one step and records the outcome", async () => {
  const { session, applied, runs } = harness(previewFromPlan(plan([write("a.md"), write("b.md")])));
  assert.equal(await session.syncNow(), "applied");
  assert.equal(applied.length, 1);
  assert.equal(session.state.message, "Sync complete.");
  assert.equal(session.state.preview, null, "nothing is left to review");
  assert.equal(session.state.busy, false);
  assert.equal(runs.length, 1, "a run without receipts is still recorded as an event");
});

test("Sync now stops for review when the plan deletes files, and applies only after confirmation", async () => {
  const { session, applied } = harness(previewFromPlan(plan([write("a.md"), remove("b.md")])));
  assert.equal(await session.syncNow(), "needs_review");
  assert.equal(applied.length, 0);
  assert.deepEqual(session.safety()?.reasons, ["Deletions"]);
  await session.apply();
  assert.equal(applied.length, 1);
});

test("the first sync always stops for review", async () => {
  const { session, applied } = harness(previewFromPlan(plan([write("a.md")], "initial")));
  assert.equal(await session.syncNow(), "needs_review");
  assert.equal(applied.length, 0);
});

test("automatic sync does nothing while a plan or problem waits for a person", async () => {
  const { session, applied } = harness(previewFromPlan(plan([remove("b.md")])));
  assert.equal(await session.autoSync(), "needs_review");
  assert.equal(await session.autoSync(), "needs_review", "the held plan is not re-reviewed or applied");
  assert.equal(applied.length, 0);
  session.update({ preview: null, problem: { code: "x", title: "t", message: "m", action: "reauthorize", actionLabel: "a" } });
  assert.equal(await session.autoSync(), "needs_review");
});

test("automatic sync keeps the last message instead of clearing it", async () => {
  const { session } = harness(previewFromPlan(plan([])));
  session.update({ message: "Disconnected elsewhere." });
  assert.equal(await session.autoSync(), "up_to_date");
  assert.equal(session.state.message, "Disconnected elsewhere.");
});

test("reconnect reports when Connect needs a fresh approval instead of failing", async () => {
  const { session } = harness(previewFromPlan(plan([])));
  assert.equal(await session.reconnect(), "reauthorize");
  assert.equal(session.state.problem?.action, "reauthorize");
  assert.equal(session.state.busy, false);
});

test("listeners hear every state change", async () => {
  const { session } = harness(previewFromPlan(plan([write("a.md")])));
  let calls = 0;
  const unsubscribe = session.subscribe(() => { calls++; });
  await session.syncNow();
  assert.ok(calls > 2);
  unsubscribe();
  const before = calls;
  session.update({ message: "" });
  assert.equal(calls, before);
});
