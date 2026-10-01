import type { MirrorProgress, MirrorStatus, MirrorSyncPlan } from "@mdbase-dev/connect-sync/mirror";
import { isTransientError } from "./syncHttp";

export interface FileTransferProgress {
  direction: "upload" | "download";
  path: string;
  transferredBytes: number;
  totalBytes: number;
}

export type SyncActivityTone = "success" | "info" | "attention" | "error";

/** The pre-0.4 activity log entry, kept only to migrate stored data. */
export interface SyncActivityEntry {
  id: string;
  occurredAt: string;
  summary: string;
  detail?: string;
  path?: string;
  tone: SyncActivityTone;
  requiresAcknowledgement: boolean;
}

/**
 * What kind of trouble sync is in decides who acts: `offline` clears up by
 * itself and is retried automatically; `auth` and `device` need the person to
 * approve this device; `decision` and `recovery` need a look at the plan;
 * `paused` waits for the person to resume; `internal` is a defect to report.
 */
export type SyncProblemKind = "offline" | "auth" | "device" | "decision" | "recovery" | "paused" | "busy" | "internal";

export interface SyncProblem {
  code: string;
  kind: SyncProblemKind;
  title: string;
  message: string;
  action: "retry" | "reauthorize" | "review" | "resume";
  actionLabel: string;
}

export interface SyncIndicator {
  state: "local" | "synced" | "syncing" | "waiting" | "offline" | "attention" | "paused";
  label: string;
  detail: string;
  destination: "sync" | "issues";
}

const MAX_ACTIVITY = 30;

export interface SyncReviewPresentation {
  actionLabel: string;
  actionDisabled: boolean;
  message: string;
}

export function syncReviewPresentation(
  plan: MirrorSyncPlan | null,
  entryCount: number,
  busy = false,
): SyncReviewPresentation {
  if (!plan) {
    return {
      actionLabel: "Review changes",
      actionDisabled: true,
      message: "Review local and hosted changes before syncing.",
    };
  }
  if (plan.summary.blocking_issues > 0 && !plan.actions.some(action => action.command !== "advance_checkpoint")) {
    return {
      actionLabel: "Resolve issues",
      actionDisabled: true,
      message: "Synchronization is paused. Resolve the blocking issues, then refresh the review.",
    };
  }
  const outcomes = plan.actions.filter((action) => action.command !== "advance_checkpoint").length;
  const hasCheckpoint = plan.actions.some((action) => action.command === "advance_checkpoint");
  const frontmatterWarning = plan.issues.some((issue) => issue.code === "invalid_frontmatter" && !issue.blocking);
  return {
    actionLabel: outcomes
      ? `Sync ${outcomes}${plan.summary.blocking_issues ? " available" : ""} ${outcomes === 1 ? "change" : "changes"}`
      : hasCheckpoint
        ? "Confirm sync"
        : "Up to date",
    actionDisabled: busy || plan.actions.length === 0,
    message: plan.summary.blocking_issues > 0
      ? "Sync available changes. Unresolved items are isolated and remain for the next review; they do not stop independent transfers."
      : frontmatterWarning
      ? "Frontmatter warnings do not block this sync. Document bytes are preserved; synchronization does not repair YAML."
      : entryCount
        ? "Review each transfer below, then sync when ready."
        : "This vault and the hosted collection are already aligned.",
  };
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function syncIndicator(input: {
  connected: boolean;
  status: MirrorStatus | null;
  progress: MirrorProgress | null;
  fileProgress: FileTransferProgress | null;
  problem: SyncProblem | null;
  validationIssues: number;
  localChangeObserved: boolean;
  /** Changes in a plan that stopped for review instead of applying automatically. */
  reviewChanges?: number;
}): SyncIndicator {
  const { connected, status, progress, fileProgress, problem, validationIssues, localChangeObserved } = input;
  const reviewChanges = input.reviewChanges ?? 0;
  if (!connected) {
    return validationIssues
      ? {
          state: "attention",
          label: `mdbase: ${validationIssues} ${validationIssues === 1 ? "issue" : "issues"}`,
          detail: "Open validation issues",
          destination: "issues",
        }
      : { state: "local", label: "mdbase: Local", detail: "This vault is not connected", destination: "sync" };
  }
  if (fileProgress) {
    const percent = fileProgress.totalBytes > 0
      ? Math.min(100, Math.round(fileProgress.transferredBytes / fileProgress.totalBytes * 100))
      : 100;
    return {
      state: "syncing",
      label: `mdbase: ${fileProgress.direction === "upload" ? "Uploading" : "Downloading"} ${percent}%`,
      detail: `${fileProgress.path} · ${formatBytes(fileProgress.transferredBytes)} of ${formatBytes(fileProgress.totalBytes)}`,
      destination: "sync",
    };
  }
  if (progress) {
    return {
      state: "syncing",
      label: `mdbase: Syncing${progress.total == null ? "" : ` ${progress.completed}/${progress.total}`}`,
      detail: "Open synchronization progress",
      destination: "sync",
    };
  }
  if (problem && problem.kind !== "busy") {
    return {
      state: problem.kind === "paused" ? "paused" : problem.kind === "offline" ? "offline" : "attention",
      label: problem.kind === "paused"
        ? "mdbase: Paused"
        : problem.kind === "offline"
          ? "mdbase: Offline"
          : problem.kind === "device"
            ? "mdbase: Set up sync"
            : "mdbase: Needs attention",
      detail: problem.kind === "offline" ? `${problem.title}. Changes will sync when it's back.` : problem.title,
      destination: "sync",
    };
  }
  if (reviewChanges > 0) {
    return {
      state: "attention",
      label: `mdbase: Review ${reviewChanges} ${reviewChanges === 1 ? "change" : "changes"}`,
      detail: "Some changes need review before syncing",
      destination: "sync",
    };
  }
  if (status?.recovery_required || status?.conflicts.length || status?.local_issues.length || ["attention", "blocked", "failed", "stale"].includes(status?.state ?? "")) {
    return { state: "attention", label: "mdbase: Needs attention", detail: "Review synchronization", destination: "sync" };
  }
  if (status?.state === "cancelled") {
    return { state: "paused", label: "mdbase: Paused", detail: "Review and resume synchronization", destination: "sync" };
  }
  const pending = status?.pending ?? 0;
  if (localChangeObserved || pending > 0 || status?.state === "changes_waiting" || status?.state === "planned") {
    return {
      state: "waiting",
      label: pending > 0 ? `mdbase: ${pending} ${pending === 1 ? "change" : "changes"}` : "mdbase: Changes waiting",
      detail: "Review local and hosted changes",
      destination: "sync",
    };
  }
  if (status?.state === "up_to_date") {
    return { state: "synced", label: "mdbase: Synced", detail: "Local and hosted collections are aligned", destination: "sync" };
  }
  return { state: "waiting", label: "mdbase: Ready to sync", detail: "Review the first synchronization", destination: "sync" };
}

const AUTH_CODES = new Set([
  "mirror_credentials_missing",
  "invalid_mirror_enrollment",
  "mirror_enrollment_expired",
  "mirror_pairing_not_found",
  "invalid_mirror_pairing",
  "mirror_access_rejected",
  "replica_revoked",
]);

export function syncProblem(error: unknown): SyncProblem {
  const code = errorCode(error);
  if (code === "mirror_busy") {
    return {
      code,
      kind: "busy",
      title: "Synchronization is already running",
      message: "The active transfer is still using this vault. Its progress is shown below.",
      action: "resume",
      actionLabel: "Show progress",
    };
  }
  if (code === "mirror_other_device") {
    return {
      code,
      kind: "device",
      title: "Set up sync on this device",
      message: "This vault's sync settings came from another device or another copy of the vault, probably through a different sync service. Approve this copy to give it its own connection. Your files stay as they are.",
      action: "reauthorize",
      actionLabel: "Set up this device",
    };
  }
  if (AUTH_CODES.has(code)) {
    return {
      code,
      kind: "auth",
      title: "Connect approval is required again",
      message: "Your local files and mirror checkpoint are safe. Approve this vault again to restore access.",
      action: "reauthorize",
      actionLabel: "Sign in again",
    };
  }
  if (["operation_cancelled", "cancelled", "sync_cancelled", "AbortError"].includes(code)) {
    return {
      code,
      kind: "paused",
      title: "Synchronization paused",
      message: "Completed changes are saved. Sync resumes from the same point when you continue.",
      action: "resume",
      actionLabel: "Resume sync",
    };
  }
  if (["stale", "stale_mirror_plan", "mirror_plan_stale", "sync_plan_stale", "conflict_decision_stale"].includes(code)) {
    return {
      code,
      kind: "decision",
      title: "The collection changed again",
      message: "No stale decision was applied. Review the newest local and hosted versions.",
      action: "review",
      actionLabel: "Review newest changes",
    };
  }
  if (["enrollment_recovery_required", "mirror_recovery_required", "pending_mirror_recovery"].includes(code)) {
    return {
      code,
      kind: "recovery",
      title: "Synchronization needs recovery",
      message: "Your original files are safe. Resume from the durable checkpoint before disconnecting this vault.",
      action: "resume",
      actionLabel: "Resume recovery",
    };
  }
  if (isTransientError(error)) {
    return {
      code,
      kind: "offline",
      title: "Can't reach mdbase Connect",
      message: "Your changes are saved on this device and sync automatically when the connection returns.",
      action: "retry",
      actionLabel: "Retry now",
    };
  }
  return {
    code,
    kind: "internal",
    title: "Sync stopped unexpectedly",
    message: `${errorMessage(error, "An unexpected error stopped synchronization.")} Your files are safe. Sync tries again automatically; if this keeps happening, copy the diagnostics and report it.`,
    action: "retry",
    actionLabel: "Try again",
  };
}

/** A failure recorded by the engine (an outcome, not a thrown error) as a problem. */
export function syncFailureProblem(failure: { code: string; message: string }): SyncProblem {
  return syncProblem(Object.assign(new Error(failure.message), { code: failure.code }));
}

/** Reads the pre-0.4 activity log so it can be migrated into sync history. */
export function normalizeActivity(value: unknown): SyncActivityEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityEntry).slice(-MAX_ACTIVITY);
}

function isActivityEntry(value: unknown): value is SyncActivityEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<SyncActivityEntry>;
  return typeof entry.id === "string"
    && typeof entry.occurredAt === "string"
    && typeof entry.summary === "string"
    && (entry.detail === undefined || typeof entry.detail === "string")
    && (entry.path === undefined || typeof entry.path === "string")
    && ["success", "info", "attention", "error"].includes(entry.tone ?? "")
    && typeof entry.requiresAcknowledgement === "boolean";
}

function errorCode(error: unknown): string {
  if (error instanceof DOMException) return error.name;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "sync_failed";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
