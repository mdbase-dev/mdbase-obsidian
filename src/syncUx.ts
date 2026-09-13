import type { MirrorProgress, MirrorStatus, MirrorSyncPlan } from "@mdbase-dev/connect-sync/mirror";

export interface FileTransferProgress {
  direction: "upload" | "download";
  path: string;
  transferredBytes: number;
  totalBytes: number;
}

export type SyncActivityTone = "success" | "info" | "attention" | "error";

export interface SyncActivityEntry {
  id: string;
  occurredAt: string;
  summary: string;
  detail?: string;
  path?: string;
  tone: SyncActivityTone;
  requiresAcknowledgement: boolean;
}

export interface SyncProblem {
  code: string;
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
      actionLabel: "Review before syncing",
      actionDisabled: true,
      message: "Review local and hosted changes before syncing.",
    };
  }
  if (plan.summary.blocking_issues > 0) {
    return {
      actionLabel: "Fix local files before syncing",
      actionDisabled: true,
      message: "Synchronization is paused. Fix every listed local file, then refresh the review.",
    };
  }
  const outcomes = plan.actions.filter((action) => action.command !== "advance_checkpoint").length;
  const hasCheckpoint = plan.actions.some((action) => action.command === "advance_checkpoint");
  return {
    actionLabel: outcomes
      ? `Sync ${outcomes} ${outcomes === 1 ? "outcome" : "outcomes"}`
      : hasCheckpoint
        ? "Confirm sync checkpoint"
        : "Already up to date",
    actionDisabled: busy || plan.actions.length === 0,
    message: entryCount
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
}): SyncIndicator {
  const { connected, status, progress, fileProgress, problem, validationIssues, localChangeObserved } = input;
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
  if (problem) {
    return {
      state: problem.action === "resume" ? "paused" : problem.action === "retry" ? "offline" : "attention",
      label: problem.action === "resume" ? "mdbase: Paused" : problem.action === "retry" ? "mdbase: Offline" : "mdbase: Needs attention",
      detail: problem.title,
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

export function syncProblem(error: unknown): SyncProblem {
  const code = errorCode(error);
  if (code === "mirror_busy") {
    return {
      code,
      title: "Synchronization is already running",
      message: "The active transfer is still using this vault. Its progress is shown below.",
      action: "resume",
      actionLabel: "Show progress",
    };
  }
  if (["mirror_credentials_missing", "invalid_mirror_enrollment", "mirror_enrollment_expired"].includes(code)) {
    return {
      code,
      title: "Connect approval is required again",
      message: "Your local files and mirror checkpoint are safe. Approve this vault again to restore access.",
      action: "reauthorize",
      actionLabel: "Sign in again",
    };
  }
  if (["operation_cancelled", "cancelled", "AbortError"].includes(code)) {
    return {
      code,
      title: "Synchronization paused safely",
      message: "Completed changes remain checkpointed. Review the current plan before resuming.",
      action: "resume",
      actionLabel: "Review and resume",
    };
  }
  if (["stale", "stale_mirror_plan", "mirror_plan_stale", "conflict_decision_stale"].includes(code)) {
    return {
      code,
      title: "The collection changed again",
      message: "No stale decision was applied. Review the newest local and hosted versions.",
      action: "review",
      actionLabel: "Review newest changes",
    };
  }
  if (["enrollment_recovery_required", "mirror_recovery_required", "pending_mirror_recovery"].includes(code)) {
    return {
      code,
      title: "Synchronization needs recovery",
      message: "Your original files are safe. Resume from the durable checkpoint before disconnecting this vault.",
      action: "resume",
      actionLabel: "Resume recovery",
    };
  }
  return {
    code,
    title: "Connect could not be reached",
    message: errorMessage(error, "Your local files are safe. Check the connection and try again."),
    action: "retry",
    actionLabel: "Retry connection",
  };
}

export function normalizeActivity(value: unknown): SyncActivityEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityEntry).slice(-MAX_ACTIVITY);
}

export function appendActivity(
  current: readonly SyncActivityEntry[],
  entry: SyncActivityEntry,
): SyncActivityEntry[] {
  return [...current.filter((candidate) => candidate.id !== entry.id), entry].slice(-MAX_ACTIVITY);
}

export function activityEntry(input: Omit<SyncActivityEntry, "id" | "occurredAt">): SyncActivityEntry {
  return {
    ...input,
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
  };
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
