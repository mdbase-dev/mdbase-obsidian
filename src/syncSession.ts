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
import { syncProblem, type FileTransferProgress, type SyncProblem } from "./syncUx";

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
}

export type SyncNowResult = "applied" | "up_to_date" | "needs_review" | "failed" | "busy";

type SyncController = Pick<
  ConnectSyncController,
  | "preview"
  | "status"
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
};

/**
 * The one owner of mirror state. The status bar, commands, automatic sync and
 * the workspace view all read from here and subscribe to changes, so no view
 * keeps its own copy of status, progress or the reviewed plan.
 */
export class SyncSession {
  private current: SyncSessionState = { ...EMPTY_STATE };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly controller: SyncController,
    private readonly getProfile: () => MirrorProfile | null,
    private readonly history: SyncHistoryLog | null,
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
   * Review, then apply immediately when the plan is routine. Plans with
   * deletions, conflicts, attachment uploads or other consent boundaries stay
   * on screen for review instead.
   */
  async syncNow(options: { quiet?: boolean } = {}): Promise<SyncNowResult> {
    if (!this.getProfile()) return "failed";
    if (this.current.busy || this.controller.isSyncing()) return "busy";
    const result = await this.exclusive(async (): Promise<SyncNowResult> => {
      await this.loadPreview();
      const preview = this.current.preview;
      if (!preview) return "failed";
      if (!preview.plan.actions.length) {
        if (!options.quiet) this.update({ message: "Already up to date." });
        return "up_to_date";
      }
      if (!this.safety()?.safe) return "needs_review";
      await this.applyReviewed();
      return this.current.problem ? "failed" : "applied";
    }, options.quiet);
    return result ?? "failed";
  }

  /** Background sync: never acts while a person needs to decide something. */
  async autoSync(): Promise<SyncNowResult> {
    const { problem, status, preview } = this.current;
    if (problem && problem.action !== "retry") return "needs_review";
    if (preview?.plan.actions.length && !this.safety()?.safe) return "needs_review";
    if (status?.conflicts.length || status?.recovery_required) return "needs_review";
    return this.syncNow({ quiet: true });
  }

  safety(): SyncPlanSafety | null {
    return this.current.preview ? syncPlanSafety(this.current.preview) : null;
  }

  cancel(): void {
    if (!this.controller.isSyncing()) return;
    this.controller.cancelSync();
    this.update({ message: "Stopping after the current network request…" });
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

  private async loadPreview(): Promise<void> {
    try {
      const preview = await this.controller.preview();
      const status = await this.controller.status();
      this.update({ preview, status, problem: null });
    } catch (error) {
      const problem = syncProblem(error);
      this.update({ problem, message: problem.message });
    }
  }

  private async applyReviewed(): Promise<void> {
    const reviewed = this.current.preview;
    if (!reviewed) return;
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
      const status = await this.controller.status();
      const preview = await this.controller.preview();
      const problem = outcome.status === "cancelled"
        ? syncProblem(new DOMException("Synchronization stopped.", "AbortError"))
        : outcome.status === "stale"
          ? syncProblem(Object.assign(new Error("The reviewed plan changed."), { code: "mirror_plan_stale" }))
          : null;
      const message = outcome.status === "applied"
        ? "Sync complete."
        : outcome.status === "attention"
          ? "Some items still need attention."
          : outcome.status === "cancelled"
            ? `Sync paused safely after ${outcome.applied} actions; ${outcome.pending} remain.`
            : outcome.status === "stale"
              ? "Changes detected. Review the newest changes."
              : `Sync stopped at a durable boundary: ${outcome.failure?.message ?? outcome.status}.`;
      this.update({
        status,
        // A finished run leaves nothing to review; keep the plan only when work remains.
        preview: preview.plan.actions.length || preview.entries.length ? preview : null,
        problem,
        message,
        ...(outcome.status === "applied" && outcome.pending === 0 ? { localChangeObserved: false } : {}),
      });
      // A completed run with file rows is already its own history entry.
      if (outcome.status !== "applied" || !files.length) await this.recordEvent({
        summary: outcome.status === "applied"
          ? `Synchronized ${outcome.applied} ${outcome.applied === 1 ? "change" : "changes"}`
          : outcome.status === "cancelled"
            ? "Synchronization paused safely"
            : "Synchronization needs attention",
        message,
        tone: outcome.status === "applied" ? "success" : "attention",
        needsAcknowledgement: outcome.status !== "applied",
      }, collectionId);
    } catch (error) {
      const problem = syncProblem(error);
      runOutcome = problem.code === "AbortError" ? "cancelled" : "failed";
      runMessage = problem.message;
      this.update({ problem, message: problem.message });
      await this.recordEvent({
        summary: problem.title,
        message: problem.message,
        tone: problem.action === "resume" ? "attention" : "error",
        needsAcknowledgement: true,
      }, collectionId);
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
