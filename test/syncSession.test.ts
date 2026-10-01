import assert from "node:assert/strict";
import test from "node:test";
import type { MirrorStatus, MirrorSyncPlan } from "@mdbase-dev/connect-sync/mirror";
import type { SyncHistoryRun } from "../src/syncHistory";
import { previewFromPlan, type MdbaseSyncPreview } from "../src/syncPreview";
import { SyncSession } from "../src/syncSession";
import type { AutoResolution } from "../src/connectSync";

const digest = `sha256:${"4".repeat(64)}`;
const profile = { collectionId: "c1", replicaId: "r1", name: "Notes" };

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

interface HarnessOptions {
  /** Outcomes returned by successive sync() calls; defaults to applied. */
  outcomes?: Array<{ status: string; failure?: { code: string; message: string } }>;
  /** Plans the engine reports after each apply; defaults to an empty plan. */
  after?: MdbaseSyncPreview[];
  conflicts?: MirrorStatus["conflicts"];
  resolutions?: AutoResolution[];
  /** What the next inspection finds after conflicts are settled. */
  afterResolve?: MdbaseSyncPreview;
}

function harness(initial: MdbaseSyncPreview, options: HarnessOptions = {}) {
  let next = initial;
  let conflicts = options.conflicts ?? [];
  const applied: MdbaseSyncPreview[] = [];
  const runs: SyncHistoryRun[] = [];
  const outcomes = [...(options.outcomes ?? [])];
  const after = [...(options.after ?? [])];
  let resolveCalls = 0;
  const controller = {
    inspect: async () => ({ preview: next, status: status({ conflicts }) }),
    preview: async () => next,
    status: async () => status({ conflicts }),
    isSyncing: () => false,
    cancelSync: () => undefined,
    sync: async (reviewed: MdbaseSyncPreview) => {
      applied.push(reviewed);
      const outcome = outcomes.shift() ?? { status: "applied" };
      if (outcome.status === "applied") next = after.shift() ?? previewFromPlan(plan([]));
      return { applied: outcome.status === "applied" ? reviewed.plan.actions.length : 0, pending: 0, ...outcome };
    },
    autoResolveConflicts: async () => {
      resolveCalls += 1;
      conflicts = [];
      if (options.afterResolve) next = options.afterResolve;
      return options.resolutions ?? [];
    },
    reconnect: async () => { throw Object.assign(new Error("expired"), { code: "mirror_enrollment_expired" }); },
  };
  const history = {
    list: () => runs,
    append: async (run: SyncHistoryRun) => { runs.push(run); },
    acknowledge: async () => undefined,
    clear: async () => undefined,
  };
  let currentProfile: typeof profile | null = profile;
  const session = new SyncSession(controller as never, () => currentProfile as never, history);
  return {
    session, controller, applied, runs, resolveCalls: () => resolveCalls,
    setNext: (preview: MdbaseSyncPreview) => { next = preview; },
    setProfile: (next: typeof profile | null) => { currentProfile = next; },
  };
}

test("progress and unrelated updates do not rescan a large plan's consent policy", () => {
  const preview = previewFromPlan(plan(Array.from({ length: 20_000 }, (_, index) => write(`${index}.md`))));
  const { session } = harness(preview);
  let reads = 0;
  for (const action of preview.plan.actions) {
    const command = action.command;
    Object.defineProperty(action, "command", { get: () => { reads++; return command; } });
  }
  session.update({ preview });
  const safety = session.safety();
  const baselineReads = reads;
  for (let index = 0; index < 100; index++) {
    session.update({ progress: { phase: "downloading", completed: index, total: 20_000, done: false } });
    assert.deepEqual(session.safety(), safety);
  }
  assert.equal(reads, baselineReads, "the immutable preview's safety should be reused during transfers");
  const deletionPreview = previewFromPlan(plan(Array.from({ length: 21 }, (_, index) => ({
    ...remove(`${index}.md`), command: "delete_remote", expected_remote: { state: "absent" },
  } as MirrorSyncPlan["actions"][number]))));
  session.update({ preview: deletionPreview });
  assert.equal(session.safety()?.safe, false, "a replacement preview must recompute consent");
  session.update({ preview: null });
  assert.equal(session.safety(), null);
});

test("Sync now applies a routine plan in one step and records the outcome", async () => {
  const { session, applied, runs } = harness(previewFromPlan(plan([write("a.md"), write("b.md")])));
  assert.equal(await session.syncNow(), "applied");
  assert.equal(applied.length, 1);
  assert.equal(session.state.message, "Sync complete.");
  assert.equal(session.state.preview, null, "nothing is left to review");
  assert.equal(session.state.busy, false);
  assert.equal(runs.length, 1, "a run without receipts is still recorded as an event");
});

test("ordinary deletions sync at once; a burst of deletions stops for review", async () => {
  const few = harness(previewFromPlan(plan([write("a.md"), remove("b.md")])));
  assert.equal(await few.session.syncNow(), "applied");
  assert.equal(few.applied.length, 1);

  const removeRemote = (path: string): MirrorSyncPlan["actions"][number] => ({
    command: "delete_remote",
    action_id: `delete-remote-${path}`,
    depends_on: [],
    reason: "local_change",
    target: target(path),
    expected_remote: { state: "absent" },
    expected_local: { state: "absent" },
    idempotency_key: `delete-remote-${path}`,
  });
  const many = harness(previewFromPlan(plan(Array.from({ length: 25 }, (_, index) => removeRemote(`n${index}.md`)))));
  assert.equal(await many.session.syncNow(), "needs_review");
  assert.equal(many.applied.length, 0);
  assert.deepEqual(many.session.safety()?.reasons, ["25 deletions"]);
  await many.session.apply();
  assert.equal(many.applied.length, 1);
});

test("a first sync that only downloads applies without review", async () => {
  const { session, applied } = harness(previewFromPlan(plan([write("a.md")], "initial")));
  assert.equal(await session.syncNow(), "applied");
  assert.equal(applied.length, 1);
});

test("a plan that changed underneath is inspected again and applied, not shown as a problem", async () => {
  const { session, applied } = harness(previewFromPlan(plan([write("a.md")])), {
    outcomes: [{ status: "stale", failure: { code: "sync_plan_stale", message: "changed" } }, { status: "applied" }],
  });
  assert.equal(await session.syncNow({ automatic: true, quiet: true }), "applied");
  assert.equal(applied.length, 2);
  assert.equal(session.state.problem, null);
});

test("continually stale plans request a follow-up instead of claiming the vault is up to date", async () => {
  const h = harness(previewFromPlan(plan([write("a.md")])), {
    outcomes: Array.from({ length: 4 }, () => ({ status: "stale" })),
  });
  assert.equal(await h.session.autoSync(), "pending");
  assert.equal(h.applied.length, 4, "one attempt remains bounded so the vault stays responsive");
  assert.equal(h.session.state.problem, null, "a changing plan is routine, not a defect");
  assert.ok(h.session.state.preview?.plan.actions.length);
  assert.equal(await h.session.autoSync(), "applied", "a later attempt can finish");
});

test("a failure recorded by the engine is a problem, and an offline one is retried quietly", async () => {
  const offline = harness(previewFromPlan(plan([write("a.md")])), {
    outcomes: [{ status: "failed", failure: { code: "network_unreachable", message: "offline" } }],
  });
  assert.equal(await offline.session.syncNow({ automatic: true, quiet: true }), "failed");
  assert.equal(offline.session.state.problem?.kind, "offline");
  assert.equal(offline.runs.filter((run) => run.needsAcknowledgement).length, 0, "offline does not pin history");

  const defect = harness(previewFromPlan(plan([write("a.md")])), {
    outcomes: [{ status: "failed", failure: { code: "invalid_mirror_state", message: "bad" } }],
  });
  assert.equal(await defect.session.syncNow(), "failed");
  assert.equal(defect.session.state.problem?.kind, "internal");
});

test("conflicts are settled after a sync and the settled files synced in the same run", async () => {
  const conflict = { entity: "record", object_id: "r1", decision_id: "d1", path: "a.md", kind: "conflicted", message: "c" } as const;
  const { session, applied, runs, resolveCalls } = harness(previewFromPlan(plan([write("b.md")])), {
    conflicts: [conflict],
    afterResolve: previewFromPlan(plan([write("a.md")])),
    resolutions: [{ path: "a.md", outcome: "merged" }],
  });
  assert.equal(await session.syncNow(), "applied");
  assert.equal(resolveCalls(), 1);
  // The first apply recorded the conflict; after settling, the merged file is uploaded.
  assert.equal(applied.length, 2);
  assert.ok(runs.some((run) => run.summary === "Merged edits to a.md"));
});

test("a failed conflict settlement remains a failed sync eligible for retry", async () => {
  const conflict = { entity: "record", object_id: "r1", decision_id: "d1", path: "a.md", kind: "conflicted", message: "c" } as const;
  const h = harness(previewFromPlan(plan([])), { conflicts: [conflict] });
  h.controller.autoResolveConflicts = async () => {
    throw Object.assign(new Error("offline while loading conflict versions"), { code: "network_unreachable" });
  };
  assert.equal(await h.session.syncNow(), "failed");
  assert.equal(h.session.state.problem?.kind, "offline");
  assert.notEqual(h.session.state.message, "Already up to date.");
});

test("an unresolved conflict never reports Already up to date", async () => {
  const conflict = { entity: "record", object_id: "r1", decision_id: "d1", path: "a.md", kind: "conflicted", message: "refused" } as const;
  const h = harness(previewFromPlan(plan([])), {
    conflicts: [conflict], resolutions: [{ path: "a.md", outcome: "unresolved", reason: "Connect refused this change." }],
  });
  assert.equal(await h.session.syncNow(), "needs_review");
  assert.notEqual(h.session.state.message, "Already up to date.");
});

test("automatic sync waits while paused or while Connect needs approval", async () => {
  const { session, applied } = harness(previewFromPlan(plan([write("a.md")])));
  session.cancel();
  assert.equal(await session.autoSync(), "paused");
  assert.equal(applied.length, 0);
  assert.equal(await session.syncNow(), "applied", "a manual sync resumes");
  assert.equal(session.state.paused, false);

  session.update({ problem: { code: "x", kind: "auth", title: "t", message: "m", action: "reauthorize", actionLabel: "a" } });
  assert.equal(await session.autoSync(), "needs_review");
});

test("Stop sync during inspection never starts the reviewed transfer", async () => {
  const h = harness(previewFromPlan(plan([write("a.md")])));
  const inspect = h.controller.inspect;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.controller.inspect = async () => {
    await gate;
    return inspect();
  };
  const running = h.session.syncNow();
  assert.equal(h.session.state.busy, true);
  h.session.cancel();
  release();
  assert.equal(await running, "paused");
  assert.equal(h.applied.length, 0, "stopping an inspection must not upload or delete files afterward");
  assert.equal(h.session.state.paused, true);
  assert.equal(await h.session.syncNow(), "applied", "manual retry resumes the paused plan");
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

test("a status request from a retired replica cannot overwrite the reauthorized session", async () => {
  const h = harness(previewFromPlan(plan([])));
  let release!: () => void;
  h.controller.status = () => new Promise((resolve) => { release = () => resolve(status({ cursor: 99 })); });
  const refreshing = h.session.refreshStatus();
  h.setProfile({ ...profile, replicaId: "r2" });
  h.session.update({ status: status({ cursor: 4 }) });
  release();
  assert.equal(await refreshing, null);
  assert.equal(h.session.state.status?.cursor, 4);
});

test("inspection finishing after disconnect cannot restore the old preview or problems", async () => {
  const h = harness(previewFromPlan(plan([write("a.md")])));
  const inspect = h.controller.inspect;
  let release!: () => void;
  h.controller.inspect = async () => {
    h.controller.inspect = inspect;
    await new Promise<void>((resolve) => { release = resolve; });
    return inspect();
  };
  const running = h.session.syncNow();
  h.setProfile(null);
  h.session.reset();
  release();
  await running;
  assert.equal(h.session.state.status, null);
  assert.equal(h.session.state.preview, null);
  assert.equal(h.session.state.problem, null);
  assert.equal(h.applied.length, 0);
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
