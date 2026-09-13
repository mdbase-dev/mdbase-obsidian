import type {
  MirrorInitializationPreview,
  MirrorLocalIssue,
  MirrorPlanAction,
  MirrorSyncPlan,
} from "@mdbase-dev/connect-sync/mirror";

export type SyncPreviewDirection = "download" | "upload" | "attention";
export type SyncPreviewAction = "create" | "update" | "rename" | "delete" | "replace" | "fix";

export interface SyncPreviewEntry {
  kind: "document" | "file";
  path: string;
  direction: SyncPreviewDirection;
  action: SyncPreviewAction;
  detail: string;
  estimatedBytes?: number;
  recordId?: string;
  fileId?: string;
}

/** UI projection of the engine-owned plan. It contains no independent diff logic. */
export interface MdbaseSyncPreview extends MirrorInitializationPreview {
  plan: MirrorSyncPlan;
  phase: MirrorSyncPlan["kind"];
  entries: SyncPreviewEntry[];
  cursor: number | null;
  remoteHead: number;
}

export function previewFromPlan(plan: MirrorSyncPlan): MdbaseSyncPreview {
  const entries = [
    ...plan.actions.flatMap((action) => action.command === "advance_checkpoint" ? [] : [actionEntry(action)]),
    ...plan.issues.map((issue): SyncPreviewEntry => ({
      kind: "document",
      path: issue.path ?? "Sync engine",
      direction: "attention",
      action: "fix",
      detail: issue.message,
    })),
  ];
  return {
    plan,
    phase: plan.kind,
    entries,
    cursor: plan.base_cursor,
    remoteHead: plan.authority_cursor,
    already_initialized: plan.kind === "incremental",
    download_documents: plan.actions.filter((action) =>
      ["write_local", "move_local", "delete_local"].includes(action.command)
      && ("target" in action ? action.target.entity !== "file" : "source" in action && action.source.entity !== "file")).length,
    upload_documents: plan.actions.filter((action) =>
      ["put_remote", "move_remote", "delete_remote"].includes(action.command)
      && ("target" in action ? action.target.entity === "record" : "source" in action && action.source.entity === "record")).length,
    unchanged_documents: 0,
    download_files: plan.actions.filter((action) =>
      ["write_local", "move_local", "delete_local"].includes(action.command)
      && ("target" in action ? action.target.entity === "file" : "source" in action && action.source.entity === "file")).length,
    upload_files: plan.actions.filter((action) =>
      ["put_remote", "move_remote", "delete_remote"].includes(action.command)
      && ("target" in action ? action.target.entity === "file" : "source" in action && action.source.entity === "file")).length,
    unchanged_files: 0,
    collisions: plan.issues
      .filter((issue): issue is typeof issue & { path: string } =>
        issue.blocking && issue.code === "local_collision" && issue.path !== undefined)
      .map((issue) => issue.path),
    local_issues: plan.issues
      .filter((issue): issue is typeof issue & { path: string; code: MirrorLocalIssue["code"] } =>
        ["invalid_frontmatter", "file_read_failed"].includes(issue.code)
        && issue.path !== undefined)
      .map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
      })),
  };
}

function actionEntry(action: MirrorPlanAction): SyncPreviewEntry {
  if (action.command === "advance_checkpoint") {
    throw new Error("Checkpoint actions are not preview entries.");
  }
  if (action.command === "record_conflict") {
    const object = action.local.state === "exact"
      ? action.local.object
      : action.remote.state === "exact"
        ? action.remote.object
        : undefined;
    return {
      kind: action.entity === "file" ? "file" : "document",
      path: object?.path ?? action.identity,
      direction: "attention",
      action: "fix",
      detail: `Local and hosted ${action.entity} changes conflict (${action.conflict_kind.replace(/_/g, " ")}).`,
      ...(object?.entity === "file" && object.size !== undefined ? { estimatedBytes: object.size } : {}),
      ...(action.entity === "record" ? { recordId: action.identity } : { fileId: action.identity }),
    };
  }
  if (action.command === "clear_conflict") {
    const object = action.expected_local.state === "exact"
      ? action.expected_local.object
      : action.expected_remote.state === "exact"
        ? action.expected_remote.object
        : undefined;
    return {
      kind: action.entity === "file" ? "file" : "document",
      path: object?.path ?? action.identity,
      direction: "attention",
      action: "fix",
      detail: `Local and hosted ${action.entity} content now matches; clear the resolved conflict.`,
      ...(object?.entity === "file" && object.size !== undefined ? { estimatedBytes: object.size } : {}),
      ...(action.entity === "record" ? { recordId: action.identity } : { fileId: action.identity }),
    };
  }
  const localCommand = action.command.endsWith("_local");
  const object = "target" in action ? action.target : action.source;
  const path = action.command === "move_local" || action.command === "move_remote"
    ? action.target_path
    : object.path;
  const creates = (action.command === "write_local" && action.expected_local.state === "absent")
    || (action.command === "put_remote" && action.expected_remote.state === "absent");
  const verb = action.command.startsWith("move_")
    ? "rename"
    : action.command.startsWith("delete_")
      ? "delete"
      : creates
        ? "create"
        : "update";
  const operation = action.command.split("_")[0];
  const movement = action.command.startsWith("move_") ? ` from ${object.path}` : "";
  return {
    kind: object.entity === "file" ? "file" : "document",
    path,
    direction: localCommand ? "download" : "upload",
    action: verb,
    detail: `${localCommand ? "Hosted" : "Local"} ${object.entity} will ${operation}${movement}.`,
    ...(object.entity === "file" && object.size !== undefined ? { estimatedBytes: object.size } : {}),
    ...(object.entity === "record" ? { recordId: object.identity } : {}),
    ...(object.entity === "file" ? { fileId: object.identity } : {}),
  };
}
