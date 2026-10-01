import type { MirrorProgress, MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import type { SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import type {
  ConnectSyncController,
  DisconnectMirrorResult,
  EnrollMirrorCallbacks,
  MirrorProfile,
} from "./connectSync";
import { resolveConflictAndRefresh } from "./syncConflict";
import {
  historyEvent,
  historyFileFromReceipt,
  type SyncEventInput,
  type SyncHistoryFile,
  type SyncHistoryRun,
} from "./syncHistory";
import { syncPlanSafety, type MdbaseSyncPreview, type SyncPlanSafety } from "./syncPreview";
import { syncFailureProblem, syncProblem, type FileTransferProgress, type SyncProblem } from "./syncUx";
import type { AutoResolution } from "./connectSync";

export interface SyncSessionState {
  status: MirrorStatus | null;
  /** The reviewed plan currently on screen, if any. */
  preview: MdbaseSyncPreview | null;
  progress: MirrorProgress | null;
  fileProgress: FileTransferProgress | null;
  problem: SyncProblem | null;
  /** Outcome of the last operation, shown until replaced or dismissed. */
  message: string;
  /** A local edit happened since the last status the engine reported. */
  localChangeObserved: boolean;
  /** A review, sync or connection operation is running. */
  busy: boolean;
  /** The person stopped sync; automatic sync waits until they resume it. */
  paused: boolean;
  /** When the next automatic attempt is due after a failure, if one is scheduled. */
  retryAt: number | null;
}

export type SyncNowResult = "applied" | "up_to_date" | "needs_review" | "failed" | "busy" | "paused";

/** Rounds of inspect, apply and settle conflicts one Sync now may take before it stops. */
const MAX_SYNC_ROUNDS = 4;

type SyncController = Pick<
  ConnectSyncController,
  | "inspect"
  | "preview"
  | "status"
  | "autoResolveConflicts"
  | "sync"
  | "cancelSync"
  | "isSyncing"
  | "reconnect"
  | "reauthorize"
  | "disconnect"
  | "configureSelectiveSync"
  | "resolveConflict"
  | "preserveConflictCopy"
>;

export interface SyncHistoryLog {
  list(collectionId?: string): SyncHistoryRun[];
  append(run: SyncHistoryRun): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

const EMPTY_STATE: SyncSessionState = {
  status: null,
  preview: null,
  progress: null,
  fileProgress: null,
  problem: null,
  message: "",
  localChangeObserved: false,
  busy: false,
  paused: false,
  retryAt: null,
};

/**
 * The one owner of mirror state. The status bar, commands, automatic sync and
 * the workspace view all read from here and subscribe to changes, so no view
 * keeps its own copy of status, progress or the reviewed plan.
 */
export class SyncSession {
  private current: SyncSessionState = { ...EMPTY_STATE };
  private readonly listeners = new Set<() => void>();
  private safetyPreview: MdbaseSyncPreview | null = null;
  private previewSafety: SyncPlanSafety | null = null;

  /** The last failure pinned to history, so automatic retries do not pin it again. */
  private pinnedFailure: string | null = null;

  constructor(
    private readonly controller: SyncController,
    private readonly getProfile: () => MirrorProfile | null,
    private readonly history: SyncHistoryLog | null,
    /** Brief, dismissible notices for things the person should know happened. */
    private readonly notify: (message: string) => void = () => undefined,
  ) {}

  get state(): Readonly<SyncSessionState> {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test and presentation hook; operations use it internally. */
  update(patch: Partial<SyncSessionState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Forget everything about the previous mirror, e.g. after disconnecting. */
  reset(): void {
    this.update({ ...EMPTY_STATE });
  }

  isSyncing(): boolean {
    return this.controller.isSyncing();
  }

  clearMessage(): void {
    if (this.current.message) this.update({ message: "" });
  }

  observeLocalChange(): void {
    if (!this.current.localChangeObserved) this.update({ localChangeObserved: true });
  }

  /** Runs, events and pinned failures for the connected collection. */
  historyRuns(): SyncHistoryRun[] {
    const collectionId = this.getProfile()?.collectionId;
    return collectionId ? this.history?.list(collectionId) ?? [] : [];
  }

  async recordEvent(input: SyncEventInput, collectionId = this.getProfile()?.collectionId): Promise<void> {
    if (!collectionId || !this.history) return;
    try {
      await this.history.append(historyEvent(collectionId, input));
    } catch (error) {
      console.error("mdbase: could not save sync history", error);
    }
    this.update({});
  }

  async dismissEvent(id: string): Promise<void> {
    await this.history?.remove(id);
    this.update({});
  }

  async clearHistory(): Promise<void> {
    await this.history?.clear();
    this.update({});
  }

  async refreshStatus(): Promise<MirrorStatus | null> {
    const profile = this.getProfile();
    if (!profile) {
      this.reset();
      return null;
    }
    if (this.controller.isSyncing()) return this.current.status;
    try {
      const status = await this.controller.status();
      if (!sameProfile(profile, this.getProfile())) return null;
      this.update({ status, problem: null });
      return status;
    } catch (error) {
      if (!sameProfile(profile, this.getProfile())) return null;
      this.update({ problem: syncProblem(error) });
      return null;
    }
  }

  /** Load the engine's plan for review. Problems are reported in state, not thrown. */
  async review(): Promise<MdbaseSyncPreview | null> {
    if (!this.getProfile()) return null;
    return await this.exclusive(async () => {
      await this.loadPreview();
      return this.current.preview;
    }) ?? null;
  }

  /** Apply the plan that is currently on screen. */
  async apply(): Promise<void> {
    if (!this.current.preview) {
      await this.review();
      return;
    }
    await this.exclusive(() => this.applyReviewed());
  }

  /**
   * Inspect, apply and settle conflicts until local and hosted agree. Routine
   * plans apply at once; a plan that changed underneath is inspected again;
   * conflicts are merged or kept as two files and their results synced. Only
   * a plan that needs consent stops, and stays on screen for review.
   */
  async syncNow(options: { quiet?: boolean; automatic?: boolean } = {}): Promise<SyncNowResult> {
    if (!this.getProfile()) return "failed";
    if (this.current.busy || this.controller.isSyncing()) return "busy";
    if (options.automatic && this.current.paused) return "paused";
    if (!options.automatic && this.current.paused) this.update({ paused: false });
    const result = await this.exclusive(async (): Promise<SyncNowResult> => {
      let applied = false;
      for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
        const preview = await this.loadPreview();
        if (!preview) return "failed";
        if (!preview.plan.actions.length) {
          if (await this.settleConflicts()) continue;
          if (!applied && !options.quiet) this.update({ message: "Already up to date." });
          return applied ? "applied" : "up_to_date";
        }
        // A prepared batch was approved when it was prepared; finishing it needs no new consent.
        const resuming = this.current.status?.recovery_required === true
          && this.current.status.plan_fingerprint === preview.plan.fingerprint;
        if (!resuming && !this.safety()?.safe) return "needs_review";
        const outcome = await this.applyReviewed();
        if (outcome === "stale") continue;
        if (outcome === "cancelled") return "paused";
        if (outcome === "failed") return "failed";
        applied = true;
        if (await this.settleConflicts()) continue;
        if (!this.current.preview) return "applied";
      }
      return applied ? "applied" : "up_to_date";
    }, options.quiet);
    return result ?? "failed";
  }

  /** Background sync: waits while the person has paused it or must decide something. */
  async autoSync(): Promise<SyncNowResult> {
    const { problem, paused } = this.current;
    if (paused) return "paused";
    if (problem && ["auth", "device"].includes(problem.kind)) return "needs_review";
    return this.syncNow({ quiet: true, automatic: true });
  }

  /** The scheduler's next automatic attempt, shown beside an offline problem. */
  setRetryAt(retryAt: number | null): void {
    if (this.current.retryAt !== retryAt) this.update({ retryAt });
  }

  /** Settle open conflicts; true when that changed files that now need syncing. */
  private async settleConflicts(): Promise<boolean> {
    if (!this.current.status?.conflicts.length) return false;
    let resolutions: AutoResolution[];
    try {
      resolutions = await this.controller.autoResolveConflicts();
    } catch (error) {
      this.update({ problem: syncProblem(error) });
      return false;
    }
    for (const resolution of resolutions) {
      await this.recordEvent(conflictEvent(resolution));
      if (resolution.outcome === "kept_both") {
        this.notify(`${resolution.path} was edited on two devices. Both versions were kept; this device's is ${resolution.copyPath ?? "a copy beside it"}.`);
      } else if (resolution.outcome === "unresolved") {
        this.notify(`Couldn't sync ${resolution.path}: ${resolution.reason ?? "it needs a decision"}.`);
      }
    }
    return resolutions.some((resolution) => resolution.outcome !== "unresolved");
  }

  safety(): SyncPlanSafety | null {
    const preview = this.current.preview;
    // Engine previews are replaced, not mutated. Transfer progress can notify
    // several surfaces per file; none needs to rescan the same consent policy.
    if (preview !== this.safetyPreview) {
      this.safetyPreview = preview;
      this.previewSafety = preview ? syncPlanSafety(preview) : null;
    }
    return this.previewSafety;
  }

  /** Stop now and keep automatic sync off until the person resumes it. */
  cancel(): void {
    this.update({ paused: true });
    if (!this.controller.isSyncing()) return;
    this.controller.cancelSync();
    this.update({ message: "Stopping…" });
  }

  /** Renew credentials. Returns "reauthorize" when Connect needs a fresh approval. */
  async reconnect(): Promise<"connected" | "reauthorize" | "failed"> {
    const result = await this.exclusive(async () => {
      try {
        const status = await this.controller.reconnect();
        this.update({ status, problem: null, message: "Connection restored." });
        await this.recordEvent({
          summary: "Collection reconnected",
          message: "Connect credentials were renewed and the mirror checkpoint was preserved.",
          tone: "success",
        });
        return "connected" as const;
      } catch (error) {
        const problem = syncProblem(error);
        this.update({ problem, message: problem.action === "reauthorize" ? "" : problem.message });
        return problem.action === "reauthorize" ? "reauthorize" as const : "failed" as const;
      }
    });
    return result ?? "failed";
  }

  async reauthorize(callbacks: EnrollMirrorCallbacks): Promise<void> {
    const status = await this.controller.reauthorize(callbacks);
    this.update({ status, problem: null, message: "Approval restored. The mirror checkpoint was preserved." });
    await this.recordEvent({
      summary: "Connect approval restored",
      message: "The existing mirror checkpoint and local files were preserved.",
      tone: "success",
    });
  }

  async disconnect(profile: MirrorProfile, removeSyncedFiles: boolean): Promise<DisconnectMirrorResult> {
    const result = await this.controller.disconnect(removeSyncedFiles);
    const detail = removeSyncedFiles
      ? `${result.removed.length} unchanged synced ${result.removed.length === 1 ? "file was" : "files were"} removed. ${result.preserved.length} locally changed ${result.preserved.length === 1 ? "file was" : "files were"} preserved.`
      : "All local files were retained as an unsynced copy.";
    this.reset();
    this.update({ message: `Disconnected from ${profile.name}. ${detail}` });
    return result;
  }

  async configureSelectiveSync(policy: SelectiveSyncPolicy): Promise<void> {
    await this.controller.configureSelectiveSync(policy);
    this.update({ preview: null, message: "Sync settings updated." });
  }

  async resolveConflict(
    conflict: MirrorStatus["conflicts"][number],
    resolution: "local" | "remote",
    keepBoth: boolean,
  ): Promise<boolean> {
    let copiedPath: string | null = null;
    try {
      if (keepBoth) copiedPath = await this.controller.preserveConflictCopy(conflict.path ?? "");
      this.update({ preview: null });
      const resolved = await resolveConflictAndRefresh(
        this.controller,
        conflict.object_id,
        conflict.decision_id,
        resolution,
      );
      const message = copiedPath
        ? `Local copy saved to ${copiedPath}. Sync to apply the hosted version.`
        : "Conflict resolved. Sync to continue.";
      this.update({ status: resolved.status, preview: resolved.preview, problem: null, message });
      await this.recordEvent({
        summary: copiedPath ? "Conflict kept as two files" : `Conflict resolved with ${resolution === "local" ? "local" : "hosted"} version`,
        message,
        ...(conflict.path ? { path: conflict.path } : {}),
        tone: "info",
      });
      return true;
    } catch (error) {
      const problem = syncProblem(error);
      if (copiedPath) {
        problem.message = `The local copy at ${copiedPath} is safe, but the original changed again. Review the newest versions before deciding.`;
      }
      this.update({ problem, message: problem.message });
      if (problem.code === "conflict_decision_stale") {
        this.update({ preview: null });
        await this.refreshStatus();
      }
      await this.recordEvent({
        summary: problem.title,
        message: problem.message,
        ...(conflict.path ? { path: conflict.path } : {}),
        tone: "attention",
        needsAcknowledgement: true,
      });
      return false;
    }
  }

  /** Report a problem raised outside the session, e.g. loading a comparison. */
  reportProblem(error: unknown): SyncProblem {
    const problem = syncProblem(error);
    this.update({ problem, message: problem.message });
    return problem;
  }

  private async exclusive<T>(operation: () => Promise<T>, keepMessage = false): Promise<T | undefined> {
    if (this.current.busy) return undefined;
    this.update({ busy: true, ...(keepMessage ? {} : { message: "" }) });
    try {
      return await operation();
    } finally {
      this.update({ busy: false });
    }
  }

  /** One inspection gives both the plan and the status. Null when it failed. */
  private async loadPreview(): Promise<MdbaseSyncPreview | null> {
    try {
      const { preview, status } = await this.controller.inspect();
      this.update({ preview, status, problem: null });
      return preview;
    } catch (error) {
      const problem = syncProblem(error);
      this.update({ problem, message: problem.message });
      return null;
    }
  }

  private async applyReviewed(): Promise<"applied" | "attention" | "cancelled" | "stale" | "failed"> {
    const reviewed = this.current.preview;
    if (!reviewed) return "failed";
    const collectionId = this.getProfile()?.collectionId;
    const startedAt = new Date().toISOString();
    const files: SyncHistoryFile[] = [];
    let runOutcome = "failed";
    let runMessage: string | undefined;
    try {
      const outcome = await this.controller.sync(
        reviewed,
        (progress) => this.update({ progress }),
        (fileProgress) => this.update({ fileProgress }),
        (action, receipt) => {
          const file = historyFileFromReceipt(action, receipt, new Date().toISOString());
          if (file) files.push(file);
        },
      );
      runOutcome = outcome.status;
      runMessage = outcome.failure?.message;
      const { preview, status } = await this.controller.inspect();
      // A stale plan is inspected again by the caller; it is not a problem to show.
      const problem = outcome.status === "cancelled"
        ? syncProblem(new DOMException("Synchronization stopped.", "AbortError"))
        : outcome.status === "failed" || outcome.status === "blocked"
          ? syncFailureProblem(outcome.failure ?? { code: "sync_failed", message: "Synchronization stopped." })
          : null;
      const message = outcome.status === "applied"
        ? "Sync complete."
        : outcome.status === "attention"
          ? outcome.applied > 0 ? "Available changes synced. Remaining items need attention." : "No available changes. Resolve the listed items and review again."
          : outcome.status === "cancelled"
            ? `Sync paused after ${outcome.applied} ${outcome.applied === 1 ? "change" : "changes"}. Resume to finish the rest.`
            : outcome.status === "stale"
              ? "Files changed during sync; checking again."
              : problem?.message ?? `Sync stopped: ${outcome.failure?.message ?? outcome.status}.`;
      this.update({
        status,
        // A finished run leaves nothing to review; keep the plan only when work remains.
        preview: preview.plan.actions.length || preview.entries.length ? preview : null,
        problem,
        message,
        ...(outcome.status === "applied" && outcome.pending === 0 ? { localChangeObserved: false } : {}),
      });
      // A completed run with file rows is already its own history entry; a stale
      // plan is retried at once and offline failures retry by themselves.
      // Conflicts get their own entries once settled; a failure already pinned
      // is not pinned again by each automatic retry.
      const failureKey = problem ? `${problem.kind}:${problem.code}` : null;
      const quietFailure = outcome.status === "stale"
        || problem?.kind === "offline"
        || (outcome.status === "attention" && status.conflicts.length > 0)
        || (failureKey !== null && failureKey === this.pinnedFailure);
      if (outcome.status === "applied") this.pinnedFailure = null;
      else if (failureKey && !quietFailure) this.pinnedFailure = failureKey;
      if (!quietFailure && (outcome.status !== "applied" || !files.length)) await this.recordEvent({
        summary: outcome.status === "applied"
          ? `Synchronized ${outcome.applied} ${outcome.applied === 1 ? "change" : "changes"}`
          : outcome.status === "cancelled"
            ? "Synchronization paused safely"
            : outcome.applied > 0 ? "Synced available changes" : "Synchronization needs attention",
        message,
        tone: outcome.status === "applied" ? "success" : "attention",
        needsAcknowledgement: outcome.status !== "applied" && outcome.status !== "attention",
      }, collectionId);
      return outcome.status === "blocked" ? "failed" : outcome.status;
    } catch (error) {
      const problem = syncProblem(error);
      runOutcome = problem.kind === "paused" ? "cancelled" : "failed";
      runMessage = problem.message;
      this.update({ problem, message: problem.message });
      const failureKey = `${problem.kind}:${problem.code}`;
      if (problem.kind !== "offline" && failureKey !== this.pinnedFailure) {
        this.pinnedFailure = failureKey;
        await this.recordEvent({
          summary: problem.title,
          message: problem.message,
          tone: problem.kind === "paused" ? "attention" : "error",
          needsAcknowledgement: problem.kind !== "paused",
        }, collectionId);
      }
      return problem.kind === "paused" ? "cancelled" : "failed";
    } finally {
      this.update({ progress: null, fileProgress: null });
      if (collectionId && files.length && this.history) {
        try {
          await this.history.append({
            id: crypto.randomUUID(),
            collectionId,
            startedAt,
            finishedAt: new Date().toISOString(),
            outcome: runOutcome,
            files,
            ...(runMessage ? { message: runMessage } : {}),
          });
        } catch (error) {
          console.error("mdbase: could not save sync history", error);
        }
        this.update({});
      }
    }
  }
}

function sameProfile(a: MirrorProfile | null, b: MirrorProfile | null): boolean {
  return a?.collectionId === b?.collectionId;
}

function conflictEvent(resolution: AutoResolution): SyncEventInput {
  const name = resolution.path.split("/").pop() ?? resolution.path;
  switch (resolution.outcome) {
    case "merged":
      return { summary: `Merged edits to ${name}`, message: "Changes made here and on another device were combined.", path: resolution.path, tone: "success" };
    case "kept_both":
      return {
        summary: `Kept both versions of ${name}`,
        message: `The same part was edited on two devices. The other device's version is in place and this device's version was saved as ${resolution.copyPath ?? "a copy"}.`,
        path: resolution.path,
        tone: "attention",
        needsAcknowledgement: true,
      };
    case "restored":
      return { summary: `Restored ${name}`, message: "It was deleted here but edited on another device, so the edited version was kept.", path: resolution.path, tone: "info" };
    case "kept_local":
      return { summary: `Kept ${name}`, message: "It was deleted on another device but edited here, so this version was uploaded again.", path: resolution.path, tone: "info" };
    case "took_hosted":
      return { summary: `Settled ${name}`, message: "The hosted version was kept.", path: resolution.path, tone: "info" };
    case "unresolved":
      return {
        summary: `Couldn't sync ${name}`,
        message: resolution.reason ?? "This change needs a decision.",
        path: resolution.path,
        tone: "attention",
        needsAcknowledgement: true,
      };
  }
}
