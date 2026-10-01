import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { MirrorStatus, MirrorSyncPlan } from "@mdbase-dev/connect-sync/mirror";
import {
  normalizeActivity,
  syncIndicator,
  syncProblem,
  syncReviewPresentation,
  type SyncActivityEntry,
} from "../src/syncUx";

function status(overrides: Partial<MirrorStatus> = {}): MirrorStatus {
  return {
    state: "up_to_date",
    mode: "read_write",
    pending: 0,
    pending_files: 0,
    conflicts: [],
    local_issues: [],
    cursor: 1,
    last_synced_at: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function plan(overrides: Partial<MirrorSyncPlan> = {}): MirrorSyncPlan {
  return {
    plan_version: 1,
    engine_profile: "exact_document_plan_only_v1",
    protocol_profile: "exact_document_v1",
    planner_policy: "three_way_exact_document_v1",
    projection_policy: "portable_mirror_projection_v1",
    fingerprint: `sha256:${"0".repeat(64)}`,
    replica_id: "replica",
    mode: "read_write",
    kind: "incremental",
    base_cursor: 1,
    authority_cursor: 1,
    scope_epoch: 1,
    checkpoint_generation: 1,
    selective_sync: { file_classes: [], excluded_folders: [] },
    actions: [],
    issues: [],
    summary: { uploads: 0, downloads: 0, conflicts: 0, blocking_issues: 0 },
    ...overrides,
  };
}

test("blocking sync reviews use fix-first wording and disable apply", () => {
  const presentation = syncReviewPresentation(plan({
    issues: [{
      code: "file_read_failed",
      message: "Could not read broken.md.",
      path: "broken.md",
      blocking: true,
    }],
    summary: { uploads: 0, downloads: 0, conflicts: 0, blocking_issues: 1 },
  }), 1);

  assert.equal(presentation.actionLabel, "Resolve issues");
  assert.equal(presentation.actionDisabled, true);
  assert.match(presentation.message, /paused.*resolve the blocking issues/i);
  assert.doesNotMatch(`${presentation.actionLabel} ${presentation.message}`, /up to date|sync when ready/i);
});

test("nonblocking frontmatter diagnostics leave exact transfers enabled", () => {
  const reviewed = plan({
    actions: [{
      command: "put_remote", action_id: "upload", depends_on: [],
      target: { entity: "record", identity: "r", path: "opaque.md", revision: "r1", payload_revision: "r1" },
      payload_revision: "r1", expected_remote: { state: "absent" }, expected_local: { state: "absent" },
      idempotency_key: "upload", reason: "local_change",
    }],
    issues: [{ code: "invalid_frontmatter", path: "opaque.md", message: "Invalid YAML", blocking: false }],
    summary: { uploads: 1, downloads: 0, conflicts: 0, blocking_issues: 0 },
  });
  const presentation = syncReviewPresentation(reviewed, 2);
  assert.equal(presentation.actionDisabled, false);
  assert.equal(presentation.actionLabel, "Sync 1 change");
  assert.match(presentation.message, /warnings do not block.*bytes are preserved/i);
  assert.equal(syncReviewPresentation(reviewed, 2, true).actionDisabled, true);
  const blocked = syncReviewPresentation({ ...reviewed, actions: [], issues: [
    ...reviewed.issues,
    { code: "file_read_failed", path: "unreadable.md", message: "Unreadable", blocking: true },
  ], summary: { uploads: 0, downloads: 0, conflicts: 0, blocking_issues: 1 } }, 2);
  assert.equal(blocked.actionDisabled, true);
  assert.match(blocked.message, /blocking issues/);
  assert.doesNotMatch(blocked.message, /fix every|do not block/i);
});

test("sync indicator gives transfer, attention, waiting, and synced states stable priority", () => {
  const base = { connected: true, status: status(), progress: null, fileProgress: null, problem: null, validationIssues: 0, localChangeObserved: false };
  assert.equal(syncIndicator(base).state, "synced");
  assert.equal(syncIndicator({ ...base, localChangeObserved: true }).state, "waiting");
  assert.equal(syncIndicator({ ...base, status: status({ conflicts: [{ entity: "record", object_id: "r", decision_id: "d", path: "A.md", kind: "conflicted", message: "changed" }] }) }).state, "attention");
  const transferring = syncIndicator({
    ...base,
    status: status({ state: "attention" }),
    fileProgress: { direction: "upload", path: "large.bin", transferredBytes: 50, totalBytes: 100 },
  });
  assert.equal(transferring.state, "syncing");
  assert.match(transferring.label, /Uploading 50%/);
  assert.match(transferring.detail, /large\.bin/);
});

test("sync problems translate credentials, cancellation, busy work, stale decisions, and network failures", () => {
  assert.equal(syncProblem(Object.assign(new Error("missing"), { code: "mirror_credentials_missing" })).action, "reauthorize");
  assert.equal(syncProblem(new DOMException("stopped", "AbortError")).action, "resume");
  assert.equal(syncProblem(Object.assign(new Error("busy"), { code: "mirror_busy" })).title, "Synchronization is already running");
  assert.equal(syncProblem(Object.assign(new Error("stale"), { code: "mirror_plan_stale" })).action, "review");
  const offline = syncProblem(new Error("network unavailable"));
  assert.equal(offline.action, "retry");
  assert.equal(offline.message, "network unavailable");
});

test("legacy activity is validated strictly before migration", () => {
  const entries: SyncActivityEntry[] = Array.from({ length: 35 }, (_, index) => ({
    id: String(index),
    occurredAt: "2026-08-12T00:00:00.000Z",
    summary: `Entry ${index}`,
    tone: "success",
    requiresAcknowledgement: false,
  }));
  const normalized = normalizeActivity([{}, ...entries]);
  assert.equal(normalized.length, 30);
  assert.equal(normalized[0]?.id, "5");
});

test("a plan held for review is named in the status bar ahead of ordinary pending changes", () => {
  const indicator = syncIndicator({
    connected: true,
    status: status({ state: "changes_waiting", pending: 3 }),
    progress: null,
    fileProgress: null,
    problem: null,
    validationIssues: 0,
    localChangeObserved: true,
    reviewChanges: 2,
  });
  assert.equal(indicator.label, "mdbase: Review 2 changes");
  assert.equal(indicator.destination, "sync");
});
