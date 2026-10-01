import assert from "node:assert/strict";
import test from "node:test";
import type { MirrorSyncPlan } from "@mdbase-dev/connect-sync/mirror";
import { previewFromPlan, syncPlanSafety } from "../src/syncPreview";

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

test("nonblocking diagnostics are optional review, not mandatory repair", () => {
  const preview = previewFromPlan(plan({
    issues: [{ code: "invalid_frontmatter", path: "opaque.md", message: "Invalid YAML", blocking: false }],
  }));
  assert.equal(preview.entries[0]?.action, "review");
  assert.equal(preview.local_issues[0]?.path, "opaque.md");
  assert.equal(preview.plan.summary.blocking_issues, 0);
  assert.deepEqual(preview.plan.actions, []);
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

function ref(entity: "record" | "file", path: string, size?: number) {
  return {
    entity,
    identity: `${entity}-${path}`,
    path,
    revision: `sha256:${"4".repeat(64)}`,
    payload_revision: `sha256:${"4".repeat(64)}`,
    ...(size === undefined ? {} : { size }),
  } as const;
}

function write(path: string): MirrorSyncPlan["actions"][number] {
  return {
    command: "write_local",
    action_id: `write-${path}`,
    depends_on: [],
    target: ref("record", path),
    payload_revision: `sha256:${"4".repeat(64)}`,
    expected_local: { state: "absent" },
    expected_path_owner: { state: "absent" },
    reason: "remote_change",
  };
}

test("routine incremental note traffic is safe to apply without review", () => {
  const preview = previewFromPlan(plan({
    actions: [write("notes/a.md"), {
      command: "put_remote",
      action_id: "put-note",
      depends_on: [],
      target: ref("record", "notes/b.md"),
      payload_revision: `sha256:${"4".repeat(64)}`,
      expected_remote: { state: "absent" },
      expected_local: { state: "absent" },
      idempotency_key: "put-note",
      reason: "local_change",
    }],
  }));
  assert.deepEqual(syncPlanSafety(preview), { safe: true, reasons: [] });
});

test("deletions, conflicts, attachment uploads and first syncs need review", () => {
  const deletion = previewFromPlan(plan({
    actions: [{
      command: "delete_local",
      action_id: "delete",
      depends_on: [],
      target: ref("record", "notes/gone.md"),
      expected_local: { state: "absent" },
      expected_path_owner: { state: "absent" },
      reason: "remote_change",
    }],
  }));
  assert.deepEqual(syncPlanSafety(deletion).reasons, ["Deletions"]);

  const upload = previewFromPlan(plan({
    actions: [{
      command: "put_remote",
      action_id: "put-file",
      depends_on: [],
      target: ref("file", "Media/a.png", 10),
      payload_revision: `sha256:${"4".repeat(64)}`,
      expected_remote: { state: "absent" },
      expected_local: { state: "absent" },
      idempotency_key: "put-file",
      reason: "local_change",
    }],
  }));
  assert.deepEqual(syncPlanSafety(upload).reasons, ["Attachment uploads"]);

  const conflict = previewFromPlan(plan({
    actions: [{
      command: "record_conflict",
      action_id: "conflict",
      depends_on: [],
      entity: "record",
      identity: "record-1",
      local: { state: "absent" },
      remote: { state: "absent" },
      conflict_kind: "both_changed",
      reason: "remote_change",
    }],
  }));
  assert.deepEqual(syncPlanSafety(conflict).reasons, ["Conflicts"]);

  assert.deepEqual(syncPlanSafety(previewFromPlan(plan({ kind: "initial", actions: [write("a.md")] }))).reasons, ["First sync"]);
});

test("large plans need review even when each action is routine", () => {
  const preview = previewFromPlan(plan({ actions: [write("a.md"), write("b.md"), write("c.md")] }));
  assert.deepEqual(syncPlanSafety(preview, { maxActions: 2, maxBytes: Infinity }).reasons, ["More than 2 changes"]);
});
