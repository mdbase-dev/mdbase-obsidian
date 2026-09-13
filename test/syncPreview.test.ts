import assert from "node:assert/strict";
import test from "node:test";
import type { MirrorSyncPlan } from "@mdbase-dev/connect-sync/mirror";
import { previewFromPlan } from "../src/syncPreview";

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
    base_cursor: 4,
    authority_cursor: 6,
    scope_epoch: 1,
    checkpoint_generation: 2,
    selective_sync: { file_classes: [], excluded_folders: [] },
    actions: [],
    issues: [],
    summary: { uploads: 0, downloads: 0, conflicts: 0, blocking_issues: 0 },
    ...overrides,
  };
}

test("sync preview is a direct projection of the engine-owned plan", () => {
  const preview = previewFromPlan(plan({
    actions: [
      {
        command: "move_local",
        action_id: "move-record",
        depends_on: [],
        source: {
          entity: "record",
          identity: "record-1",
          path: "notes/old.md",
          revision: `sha256:${"1".repeat(64)}`,
          payload_revision: `sha256:${"1".repeat(64)}`,
        },
        target_path: "notes/new.md",
        expected_source_owner: { state: "absent" },
        expected_target_owner: { state: "absent" },
        reason: "remote_change",
      },
      {
        command: "put_remote",
        action_id: "put-file",
        depends_on: [],
        target: {
          entity: "file",
          identity: "file-1",
          path: "Media/local.png",
          revision: `sha256:${"2".repeat(64)}`,
          payload_revision: `sha256:${"2".repeat(64)}`,
          size: 12,
        },
        payload_revision: `sha256:${"2".repeat(64)}`,
        expected_remote: { state: "absent" },
        expected_local: { state: "absent" },
        idempotency_key: "put-file",
        reason: "local_change",
      },
    ],
    summary: { uploads: 1, downloads: 1, conflicts: 0, blocking_issues: 0 },
  }));

  assert.equal(preview.plan.fingerprint, `sha256:${"0".repeat(64)}`);
  assert.deepEqual(preview.entries.map((entry) => [entry.direction, entry.action, entry.path]), [
    ["download", "rename", "notes/new.md"],
    ["upload", "create", "Media/local.png"],
  ]);
  assert.equal(preview.download_documents, 1);
  assert.equal(preview.upload_files, 1);
});

test("an exact idle plan remains an explicit zero-action preview", () => {
  const preview = previewFromPlan(plan({
    base_cursor: 6,
    authority_cursor: 6,
  }));

  assert.deepEqual(preview.plan.actions, []);
  assert.deepEqual(preview.entries, []);
  assert.equal(preview.cursor, 6);
  assert.equal(preview.remoteHead, 6);
});

test("plan conflicts and blocking issues are shown as attention without inventing transfers", () => {
  const preview = previewFromPlan(plan({
    actions: [{
      command: "record_conflict",
      action_id: "conflict-record",
      depends_on: [],
      entity: "record",
      identity: "record-1",
      local: { state: "exact", object: {
        entity: "record",
        identity: "record-1",
        path: "notes/conflict.md",
        revision: `sha256:${"3".repeat(64)}`,
        payload_revision: `sha256:${"3".repeat(64)}`,
      } },
      remote: { state: "absent" },
      conflict_kind: "delete_vs_change",
      reason: "remote_change",
    }],
    issues: [{
      code: "local_collision",
      message: "Different local bytes occupy this path.",
      path: "notes/collision.md",
      blocking: true,
    }],
    summary: { uploads: 1, downloads: 0, conflicts: 1, blocking_issues: 1 },
  }));

  assert.deepEqual(preview.entries.map((entry) => entry.direction), ["attention", "attention"]);
  assert.deepEqual(preview.collisions, ["notes/collision.md"]);
});

test("preview retains malformed-frontmatter and file-read local issues", () => {
  const preview = previewFromPlan(plan({
    issues: [
      {
        code: "invalid_frontmatter",
        message: "Frontmatter is invalid YAML.",
        path: "notes/malformed.md",
        blocking: true,
      },
      {
        code: "file_read_failed",
        message: "Could not read notes/unreadable.md.",
        path: "notes/unreadable.md",
        blocking: true,
      },
    ],
    summary: { uploads: 0, downloads: 0, conflicts: 0, blocking_issues: 2 },
  }));

  assert.deepEqual(preview.local_issues, [
    {
      code: "invalid_frontmatter",
      message: "Frontmatter is invalid YAML.",
      path: "notes/malformed.md",
    },
    {
      code: "file_read_failed",
      message: "Could not read notes/unreadable.md.",
      path: "notes/unreadable.md",
    },
  ]);
});

test("resolved conflict cleanup is projected without inventing a transfer", () => {
  const exact = {
    state: "exact" as const,
    object: {
      entity: "file" as const,
      identity: "file-1",
      path: "images/resolved.png",
      revision: "file:resolved",
      payload_revision: `sha256:${"4".repeat(64)}`,
      size: 12,
    },
  };
  const preview = previewFromPlan(plan({
    actions: [{
      command: "clear_conflict",
      action_id: "clear-file-conflict",
      depends_on: [],
      entity: "file",
      identity: "file-1",
      expected_local: exact,
      expected_remote: exact,
      reason: "pending",
    }],
    summary: { uploads: 0, downloads: 0, conflicts: 0, blocking_issues: 0 },
  }));

  assert.deepEqual(preview.entries, [{
    kind: "file",
    path: "images/resolved.png",
    direction: "attention",
    action: "fix",
      detail: "Local and hosted file content now matches; clear the resolved conflict.",
      estimatedBytes: 12,
      fileId: "file-1",
  }]);
  assert.equal(preview.download_files, 0);
  assert.equal(preview.upload_files, 0);
});
