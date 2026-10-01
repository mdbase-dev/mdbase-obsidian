import { ATTACHMENT_SCOPE_DESCRIPTION, renderFolderExclusions } from "../folderExclusions";
import type { SyncSession } from "../syncSession";
import { isHistoryEvent } from "../syncHistory";
import { setIcon } from "obsidian";
import type { MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import type { AuthorityAdoptionStatus } from "@mdbase-dev/connect-sync/adoption";
import type { AdoptionRenamePlan } from "../adoptionPaths";
import type {
  AdoptionPreview,
  AdoptLocalCollectionCallbacks,
  MirrorConflictComparison,
  MirrorProfile,
} from "../connectSync";
import type { FileMediaClass, SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import type { MdbaseSyncPreview, SyncPreviewDirection } from "../syncPreview";
import {
  filterRuns,
  formatHistoryTime,
  summarizeRun,
  type SyncHistoryRun,
} from "../syncHistory";
import { boundedLineDiff } from "../conflictPresentation";
import {
  formatBytes,
  syncProblem,
  syncReviewPresentation,
  type SyncProblem,
} from "../syncUx";

import {
  DEFAULT_CONNECT_CONTROL_URL,
  WorkspaceContext,
  defaultDeviceName,
  inputRow,
  renderStatus,
  HISTORY_PAGE,
  HISTORY_OUTCOMES,
  capitalize,
  relativeTime,
  syncStateLabel,
  isAbortError,
} from "./shared";

export class SyncPane {
  private readonly conflictComparisons = new Map<string, MirrorConflictComparison>();
  private readonly loadingConflictComparisons = new Set<string>();
  private pendingSyncFocus: "activity" | "conflicts" | null = null;
  private historyQuery = "";
  private transferQuery = "";
  private transferFilter = "all";
  private readonly transferPages = new Map<SyncPreviewDirection, number>();
  private historyLimit = HISTORY_PAGE;
  private readonly previewComparisons = new Map<string, MirrorConflictComparison>();
  private comparedPreview: MdbaseSyncPreview | null = null;
  private readonly loadingPreviewComparisons = new Set<string>();
  private enrollmentVerification = "";
  private enrollmentAbort: AbortController | null = null;
  private enrollmentControlUrl = DEFAULT_CONNECT_CONTROL_URL;
  // Connect lists devices by this name; the vault and platform tell them apart.
  private enrollmentMirrorName = defaultDeviceName(this.ctx.app.vault.getName());
  private enrollmentCollectionId = "";
  private enrollmentMode: "read_only" | "read_write" = "read_write";
  private filePolicyDraft: SelectiveSyncPolicy | null = null;
  private adoptionFileProgress = "";
  private adoptionPreview: AdoptionPreview | null = null;
  private adoptionRenamePlan: AdoptionRenamePlan | null = null;
  private adoptionStage = "";
  private adoptionFailed = false;

  constructor(private readonly ctx: WorkspaceContext) {}

  getState(): Record<string, unknown> { return { historyQuery: this.historyQuery }; }

  setState(state: Record<string, unknown>): void {
    if (typeof state.historyQuery === "string") this.historyQuery = state.historyQuery.slice(0, 2000);
  }

  private get session(): SyncSession {
    return this.ctx.host.sync;
  }

  dispose(): void {
    this.enrollmentAbort?.abort();
    this.enrollmentAbort = null;
  }

  focusSection(section: "activity" | "conflicts"): void {
    this.ctx.destination = "sync";
    this.pendingSyncFocus = section;
    this.ctx.render();
    window.setTimeout(() => this.focusPendingSyncSection(), 0);
  }

  async reconnectCollection(): Promise<void> {
    const result = await this.session.reconnect();
    if (result === "reauthorize") await this.ctx.perform(() => this.reauthorizeCollection());
  }

  render(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-sync-document" });
    const profile = this.ctx.host.getMirrorProfile();
    if (!profile) {
      this.renderEnrollment(document);
      return;
    }
    const state = this.session.state;
    const syncing = Boolean(state.fileProgress || state.progress);
    const problem = state.problem?.kind === "busy" ? null : state.problem;
    const recoveryProblem: SyncProblem | null = problem ?? (state.paused && !syncing ? {
      code: "sync_paused",
      kind: "paused",
      title: "Sync is paused",
      message: "Changes on this device and in Connect wait until you resume.",
      action: "resume",
      actionLabel: "Resume sync",
    } : state.status?.recovery_required ? {
      code: "mirror_recovery_required",
      kind: "recovery",
      title: "Synchronization needs recovery",
      message: "Your original files are safe. Resume from the durable checkpoint before disconnecting this vault.",
      action: "resume",
      actionLabel: "Resume recovery",
    } : null);
    const authorizing = Boolean(this.enrollmentAbort);
    const label = authorizing ? "Waiting for approval" : syncing ? "Syncing" : state.busy ? "Checking…"
      : recoveryProblem?.kind === "paused" ? "Paused"
      : recoveryProblem?.kind === "offline" ? "Offline"
      : recoveryProblem?.kind === "auth" ? "Approval needed"
      : recoveryProblem?.kind === "device" ? "Set up this device"
      : recoveryProblem ? "Needs attention" : syncStateLabel(state.status);

    const status = document.createEl("section", { cls: "mdbase-sync-status" });
    status.setAttr("data-state", state.status?.state ?? "checking");
    const heading = status.createDiv({ cls: "mdbase-sync-heading" });
    heading.createEl("h2", { text: profile.name });
    heading.createDiv({ cls: "mdbase-muted", text:
      `${label} · ${relativeTime(state.status?.last_synced_at)}`,
    });
    const scope = heading.createDiv({ cls: "mdbase-muted mdbase-sync-scope" });
    scope.createSpan({ text: this.syncScopeText(profile.mode) });
    const settings = scope.createEl("button", { cls: "mdbase-link-button", text: "Settings" });
    settings.setAttr("aria-label", "Open sync settings");
    settings.onclick = () => this.ctx.host.openSettings();

    if (state.message && !state.problem) {
      const message = status.createDiv({ cls: "mdbase-inline-message mdbase-notice" });
      message.createSpan({ text: state.message }).setAttr("role", "status");
      const dismiss = this.ctx.iconButton(message, "x", "Dismiss sync message");
      dismiss.onclick = () => this.session.clearMessage();
    }

    if (syncing) {
      const progressArea = status.createDiv({ cls: "mdbase-sync-progress", attr: { "aria-live": "polite" } });
      const total = state.fileProgress?.totalBytes ?? state.progress?.total ?? null;
      const completed = state.fileProgress?.transferredBytes ?? state.progress?.completed ?? 0;
      const progress = progressArea.createEl("progress");
      progress.setAttr("aria-label", "Sync progress");
      progress.max = total ?? 1;
      progress.value = total == null ? 0 : completed;
      if (total == null) progress.removeAttribute("value");
      progressArea.createDiv({
        cls: "mdbase-progress-label",
        text: state.fileProgress
          ? `${state.fileProgress.direction === "upload" ? "Uploading" : "Downloading"} ${state.fileProgress.path} · ${formatBytes(completed)} of ${formatBytes(total ?? 0)}`
          : `${state.progress?.phase === "uploading"
            ? "Uploading local changes"
            : state.progress?.phase === "downloading"
              ? "Downloading collection files"
              : "Applying changes"} · ${completed}${total == null ? "" : ` of ${total}`}`,
      });
      const cancel = progressArea.createEl("button", { text: "Stop" });
      cancel.setAttr("data-focus-key", "sync-stop");
      cancel.onclick = () => this.session.cancel();
    }

    const otherServices = this.ctx.host.otherSyncServices();
    if (otherServices.length) {
      status.createDiv({
        cls: "mdbase-inline-message mdbase-sync-coexistence",
        text: `${otherServices.join(" and ")} also ${otherServices.length === 1 ? "syncs" : "sync"} this vault. Two services syncing the same notes can duplicate them or bring deleted ones back; let only one of them sync this vault's notes.`,
      });
    }

    if (authorizing) this.renderApproval(status, false);
    else if (recoveryProblem) this.renderRecoveryCard(status, recoveryProblem);

    const busy = this.ctx.busy || state.busy || syncing;
    const preview = state.preview;
    // Comparisons belong to the plan they were opened from.
    if (preview !== this.comparedPreview) {
      this.previewComparisons.clear();
      this.comparedPreview = preview;
      this.transferPages.clear();
    }
    const safety = this.session.safety();
    const reviewing = Boolean(preview?.plan.actions.length || preview?.entries.length);
    if (!syncing && !recoveryProblem && !authorizing) {
      const actions = status.createDiv({ cls: "mdbase-sync-actions" });
      if (reviewing && preview) {
        // The plan needs consent: apply exactly what is listed below.
        const presentation = syncReviewPresentation(preview.plan, preview.entries.length, busy);
        if (preview.plan.actions.length && !presentation.actionDisabled) {
          const sync = actions.createEl("button", { text: presentation.actionLabel, cls: "mod-cta" });
          sync.setAttr("data-focus-key", "sync-apply");
          sync.disabled = presentation.actionDisabled;
          sync.onclick = () => void this.session.apply();
        }
        const refresh = this.ctx.iconButton(actions, "refresh-cw", "Refresh review");
        refresh.disabled = busy;
        refresh.onclick = () => void this.session.review();
      } else {
        // One action: routine changes apply at once; anything risky stops for review.
        const sync = actions.createEl("button", { text: state.busy ? "Checking…" : "Sync now", cls: "mod-cta" });
        sync.setAttr("data-focus-key", "sync-now");
        sync.disabled = busy;
        sync.onclick = () => void this.session.syncNow();
      }
    }
    if (reviewing && safety && !safety.safe && preview?.plan.actions.length) {
      status.createDiv({ cls: "mdbase-muted mdbase-review-reasons", text: `Review needed: ${safety.reasons.join(", ").toLowerCase()}.` });
    }

    if (preview && reviewing) this.renderMirrorPreview(document, preview);
    if (state.status?.conflicts.length) this.renderConflicts(document, state.status);
    if (state.status?.local_issues.length && !reviewing) {
      this.renderLocalMirrorIssues(document, state.status);
    }
    this.renderHistory(document);
    window.setTimeout(() => this.focusPendingSyncSection(), 0);
  }

  /** Which part of this vault the mirror owns, and with what access. */
  private syncScopeText(mode: MirrorProfile["mode"]): string {
    const excluded = this.ctx.host.connectSync.getSelectiveSync().excluded_folders;
    const scope = excluded.length
      ? `Whole vault except ${excluded.length > 2 ? `${excluded.slice(0, 2).join(", ")} +${excluded.length - 2}` : excluded.join(", ")}`
      : "Whole vault";
    return `${mode === "read_only" ? "Read only" : "Read and write"} · ${scope}`;
  }

  private renderRecoveryCard(container: HTMLElement, problem: SyncProblem): void {
    const card = container.createDiv({ cls: "mdbase-recovery-card" });
    card.setAttr("data-kind", problem.kind);
    const text = card.createDiv();
    text.createEl("strong", { text: problem.title });
    text.createDiv({ text: problem.message });
    const retryAt = this.session.state.retryAt;
    if (retryAt && (problem.kind === "offline" || problem.kind === "internal")) {
      const seconds = Math.max(0, Math.round((retryAt - Date.now()) / 1000));
      text.createDiv({
        cls: "mdbase-muted",
        text: seconds <= 1
          ? "Trying again now…"
          : seconds < 60 ? `Trying again in ${seconds}s.` : `Trying again in ${Math.round(seconds / 60)} min.`,
      });
    }
    const buttons = card.createDiv({ cls: "mdbase-recovery-actions" });
    const action = buttons.createEl("button", { text: problem.actionLabel, cls: "mod-cta" });
    action.setAttr("data-focus-key", "sync-recovery");
    action.disabled = this.ctx.busy || this.session.state.busy;
    action.onclick = () => {
      if (problem.kind === "auth") void this.reconnectCollection();
      else if (problem.action === "reauthorize") void this.ctx.perform(() => this.reauthorizeCollection());
      else if (problem.action === "review") void this.session.review();
      else void this.session.syncNow();
    };
    if (problem.kind === "internal" || problem.kind === "recovery") {
      const copy = buttons.createEl("button", { text: "Copy diagnostics" });
      copy.setAttr("data-focus-key", "sync-diagnostics");
      copy.onclick = () => void this.ctx.host.copySyncDiagnostics();
    }
  }

  /** The same approval wait, whether enrolling or restoring an existing connection. */
  private renderApproval(container: HTMLElement, showStatus = true): void {
    const approval = container.createDiv({ cls: "mdbase-approval-link" });
    if (showStatus) approval.createSpan({ text: this.enrollmentVerification ? "Waiting for approval · " : "Connecting… " }).setAttr("role", "status");
    if (this.enrollmentVerification) {
      const link = approval.createEl("a", { text: "Open Connect", href: this.enrollmentVerification });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener noreferrer");
      link.setAttr("data-focus-key", "approval-link");
    }
    const stop = approval.createEl("button", { text: "Stop waiting" });
    stop.setAttr("data-focus-key", "stop-approval");
    stop.onclick = () => {
      this.enrollmentAbort?.abort();
      this.enrollmentVerification = "";
      this.ctx.render();
    };
  }

  private async reauthorizeCollection(): Promise<void> {
    this.enrollmentAbort?.abort();
    const abort = new AbortController();
    this.enrollmentAbort = abort;
    this.ctx.pendingFocusKey = "stop-approval";
    this.ctx.render();
    try {
      await this.session.reauthorize({
        signal: abort.signal,
        onVerification: (verification) => {
          this.enrollmentVerification = verification.verificationUri;
          this.ctx.message = "";
          window.open(verification.verificationUri, "_blank", "noopener,noreferrer");
          this.ctx.render();
        },
        onStatus: (status) => {
          this.ctx.message = status.state === "waiting_for_approval"
            ? ""
            : `Connect is retrying approval (attempt ${status.attempt}).`;
          this.ctx.render();
        },
      });
      this.ctx.message = "";
    } catch (error) {
      if (!isAbortError(error)) throw error;
      this.ctx.message = "Cancelled. Your files and connection are unchanged.";
      this.ctx.pendingFocusKey = "sync-recovery";
    } finally {
      if (this.enrollmentAbort === abort) {
        this.enrollmentAbort = null;
        this.enrollmentVerification = "";
      }
    }
  }

  private renderHistory(container: HTMLElement): void {
    const runs = this.session.historyRuns();
    if (!runs.length) return;
    const pinned = runs.filter((run) => run.needsAcknowledgement);
    const section = this.ctx.disclosure(container, "sync-activity", "History", pinned.length > 0);
    section.addClass("mdbase-activity");
    section.id = "mdbase-sync-activity";
    for (const run of [...pinned].reverse()) this.renderEventRow(section, run);

    const header = section.createDiv({ cls: "mdbase-section-header mdbase-history-controls" });
    const query = header.createEl("input", { type: "search" });
    query.setAttr("aria-label", "Filter history by path");
    query.setAttr("data-focus-key", "history-search");
    query.placeholder = "Filter by path";
    query.value = this.historyQuery;
    query.oninput = () => {
      this.historyQuery = query.value;
      this.historyLimit = HISTORY_PAGE;
      this.ctx.render();
    };
    if (runs.length > pinned.length) {
      const clear = header.createEl("button", { text: "Clear history" });
      clear.disabled = this.ctx.busy;
      clear.onclick = () => void this.session.clearHistory();
    }

    const needle = this.historyQuery.trim().toLowerCase();
    const timeline = filterRuns(runs.filter((run) => !run.needsAcknowledgement), needle)
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    if (!timeline.length) {
      section.createDiv({ cls: "mdbase-muted", text: needle ? "No synced files match." : "No completed syncs." });
      return;
    }
    for (const run of timeline.slice(0, this.historyLimit)) {
      if (isHistoryEvent(run)) this.renderEventRow(section, run);
      else this.renderHistoryRun(section, run, needle !== "");
    }
    if (timeline.length > this.historyLimit) {
      const more = section.createEl("button", { cls: "mdbase-link-button", text: `Show ${Math.min(HISTORY_PAGE, timeline.length - this.historyLimit)} more` });
      more.setAttr("data-focus-key", "history-more");
      more.onclick = () => {
        this.historyLimit += HISTORY_PAGE;
        this.ctx.render();
      };
    }
  }

  private renderHistoryRun(container: HTMLElement, run: SyncHistoryRun, filtered: boolean): void {
    const details = container.createEl("details", { cls: "mdbase-history-run" });
    const key = `history-run-${run.id}`;
    // Filtered results open without overwriting the remembered disclosure state.
    if (filtered) details.open = true;
    else {
      details.dataset.disclosure = key;
      details.open = this.ctx.disclosures.get(key) ?? false;
    }
    const summary = details.createEl("summary", { cls: "mdbase-activity-row" });
    summary.setAttr("data-focus-key", `disclosure-${key}`);
    const tone = run.outcome === "applied" ? "success" : run.outcome === "failed" ? "error" : "attention";
    summary.setAttr("data-tone", tone);
    setIcon(summary.createSpan(), tone === "success" ? "check" : "circle-alert");
    const body = summary.createDiv();
    body.createEl("strong", { text: summarizeRun(run) });
    const outcome = HISTORY_OUTCOMES[run.outcome];
    body.createSpan({
      cls: "mdbase-muted",
      text: outcome ? `${formatHistoryTime(run.finishedAt)} · ${outcome}` : formatHistoryTime(run.finishedAt),
    });
    if (run.message && run.outcome !== "applied") body.createDiv({ text: run.message });
    setIcon(summary.createSpan({ cls: "mdbase-history-chevron" }), "chevron-right");

    const ledger = details.createDiv({ cls: "mdbase-transfer-ledger mdbase-history-files" });
    for (const file of run.files.slice(0, 250)) {
      const row = ledger.createDiv({ cls: "mdbase-transfer-row" });
      row.setAttr("title", new Date(file.at).toLocaleString());
      const action = row.createSpan({ cls: "mdbase-transfer-action", text: file.action });
      action.setAttr("data-action", file.status === "completed" ? file.action : "fix");
      const direction = row.createDiv({ cls: "mdbase-transfer-body" });
      const pathLine = direction.createDiv({ cls: "mdbase-transfer-path" });
      const icon = pathLine.createSpan({ cls: "mdbase-history-direction" });
      const directionLabel = file.direction === "download" ? "Downloaded" : file.direction === "upload" ? "Uploaded" : "Needs attention";
      icon.setAttr("aria-label", directionLabel);
      icon.setAttr("title", directionLabel);
      setIcon(icon, file.direction === "download" ? "download" : file.direction === "upload" ? "upload" : "circle-alert");
      if (file.action !== "delete" && this.ctx.app.vault.getAbstractFileByPath(file.path)) {
        const open = pathLine.createEl("button", { cls: "mdbase-link-button mdbase-transfer-open" });
        open.createEl("code", { text: file.path });
        open.setAttr("title", `Open ${file.path}`);
        open.setAttr("data-focus-key", `history-open-${run.id}-${file.path}`);
        open.onclick = () => void this.ctx.host.openFileByPath(file.path);
      } else pathLine.createEl("code", { text: file.path });
      if (file.fromPath) direction.createDiv({ cls: "mdbase-muted", text: `From ${file.fromPath}` });
      if (file.status !== "completed") {
        direction.createDiv({ text: file.message ? `${capitalize(file.status)}: ${file.message}` : capitalize(file.status) });
      }
    }
    if (run.files.length > 250) {
      ledger.createDiv({ cls: "mdbase-transfer-more", text: `${run.files.length - 250} more files are recorded in this sync.` });
    }
  }

  /** A non-transfer event: reconnects, conflict decisions, pauses and failures. */
  private renderEventRow(container: HTMLElement, run: SyncHistoryRun): void {
    const tone = run.tone ?? "info";
    const row = container.createDiv({ cls: "mdbase-activity-row" });
    row.setAttr("data-tone", tone);
    setIcon(row.createSpan(), tone === "success" ? "check" : tone === "info" ? "info" : "circle-alert");
    const body = row.createDiv();
    const summary = run.summary ?? "";
    if (run.message && run.message !== summary) {
      const details = body.createEl("details");
      details.createEl("summary", { text: summary });
      details.createDiv({ text: run.message });
    } else body.createEl("strong", { text: summary });
    body.createSpan({ cls: "mdbase-muted", text: formatHistoryTime(run.finishedAt) });
    if (run.needsAcknowledgement) {
      const dismiss = row.createEl("button", { text: "Dismiss" });
      dismiss.disabled = this.ctx.busy;
      dismiss.onclick = () => void this.session.dismissEvent(run.id);
    }
  }

  private focusPendingSyncSection(): void {
    if (!this.pendingSyncFocus) return;
    const id = this.pendingSyncFocus === "activity" ? "mdbase-sync-activity" : "mdbase-sync-conflicts";
    const target = this.ctx.containerEl.querySelector<HTMLElement>(`#${id}`);
    if (!target) return;
    this.pendingSyncFocus = null;
    const details = target.closest("details");
    if (details) details.open = true;
    target.scrollIntoView({ block: "nearest" });
  }

  private filePolicy(): SelectiveSyncPolicy {
    this.filePolicyDraft ??= JSON.parse(JSON.stringify(this.ctx.host.connectSync.getSelectiveSync())) as SelectiveSyncPolicy;
    return this.filePolicyDraft;
  }

  /** Attachment and folder choices made before connecting; afterwards they live in settings. */
  private renderFilePolicyControls(container: HTMLElement): void {
    const policy = this.filePolicy();
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-file-policy" });
    section.createEl("h3", { text: "Attachments" });
    const choices = section.createDiv({ cls: "mdbase-file-class-grid" });
    const labels: Array<[FileMediaClass, string]> = [
      ["image", "Images"],
      ["audio", "Audio"],
      ["video", "Video"],
      ["pdf", "PDFs"],
      ["other", "Other files"],
    ];
    for (const [value, label] of labels) {
      const choice = choices.createEl("label");
      const checkbox = choice.createEl("input", { type: "checkbox" });
      checkbox.setAttr("data-focus-key", `file-class-${value}`);
      checkbox.checked = policy.file_classes.includes(value);
      checkbox.onchange = () => {
        policy.file_classes = checkbox.checked
          ? [...new Set([...policy.file_classes, value])]
          : policy.file_classes.filter((entry) => entry !== value);
        this.ctx.render();
      };
      choice.createSpan({ text: label });
    }
    section.createDiv({ cls: "mdbase-form-description", text: ATTACHMENT_SCOPE_DESCRIPTION });
    section.createEl("h4", { text: "Excluded folders" });
    renderFolderExclusions(this.ctx.app, section, policy.excluded_folders, folders => { policy.excluded_folders = folders; });
    if (policy.file_classes.includes("other")) {
      section.createDiv({
        cls: "mdbase-inline-message",
        text: "Other files includes all remaining visible file formats.",
      });
    }
  }

  private renderEnrollment(container: HTMLElement): void {
    if (this.ctx.schema || this.ctx.host.connectSync.getAdoptionMarker()) {
      this.renderLocalAdoption(container);
      return;
    }
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-enrollment" });
    section.createEl("h3", { text: "Copy a collection from Connect" });
    section.createEl("p", { cls: "mdbase-muted", text: "Connect holds the collection; this vault syncs a copy. Choose a collection in Connect, then review the first sync." });
    if (this.enrollmentAbort) {
      this.renderApproval(section);
      return;
    }
    inputRow(section, "Device name", this.enrollmentMirrorName, (value) => {
      this.enrollmentMirrorName = value;
    });
    const access = section.createDiv({ cls: "mdbase-form-row" });
    const accessLabel = access.createEl("label", { text: "Access" });
    const select = access.createEl("select");
    accessLabel.htmlFor = select.id = "mdbase-enrollment-access";
    select.setAttr("data-focus-key", "enrollment-access");
    select.createEl("option", { value: "read_write", text: "Read and write" });
    select.createEl("option", { value: "read_only", text: "Read only" });
    select.value = this.enrollmentMode;
    select.onchange = () => {
      this.enrollmentMode = select.value === "read_only" ? "read_only" : "read_write";
      this.ctx.render();
    };
    const scope = section.createDiv({ cls: "mdbase-form-row mdbase-sync-target" });
    scope.createEl("label", { text: "Syncs" });
    const scopeValue = scope.createDiv({ cls: "mdbase-sync-target-value" });
    const excluded = this.filePolicy().excluded_folders;
    scopeValue.createSpan({
      text: `Whole vault “${this.ctx.app.vault.getName()}”${excluded.length ? ` except ${excluded.join(", ")}` : ""}`,
    });
    const change = scopeValue.createEl("button", { cls: "mdbase-link-button", text: "Exclude folders" });
    change.onclick = () => {
      this.ctx.disclosures.set("enrollment-options", true);
      this.ctx.render();
    };
    section.createEl("p", { cls: "mdbase-form-description", text: this.enrollmentMode === "read_write"
      ? "Existing notes may upload. Nothing moves until you review and sync."
      : "Downloads only. Existing local changes must be resolved or excluded.",
    });
    const advanced = this.ctx.disclosure(section, "enrollment-options", "Advanced");
    inputRow(advanced, "Connect URL", this.enrollmentControlUrl, (value) => {
      this.enrollmentControlUrl = value;
    }, { placeholder: DEFAULT_CONNECT_CONTROL_URL });
    inputRow(advanced, "Collection ID", this.enrollmentCollectionId, (value) => {
      this.enrollmentCollectionId = value;
    }, { placeholder: "Choose during approval" });
    this.renderFilePolicyControls(advanced);
    const enrollmentActions = section.createDiv({ cls: "mdbase-actions mdbase-enrollment-actions" });
    const button = enrollmentActions.createEl("button", { text: "Connect" });
    button.setAttr("title", "Opens Connect in your browser to choose a collection");
    button.setAttr("data-focus-key", "enrollment-connect");
    button.addClass("mod-cta");
    button.disabled = this.ctx.busy;
    button.onclick = () => void this.ctx.perform(async () => {
      this.enrollmentAbort?.abort();
      const abort = new AbortController();
      this.enrollmentAbort = abort;
      this.ctx.pendingFocusKey = "stop-approval";
      this.ctx.render();
      try {
        await this.ctx.host.connectSync.enroll({
          controlUrl: this.enrollmentControlUrl,
          mirrorName: this.enrollmentMirrorName,
          mode: this.enrollmentMode,
          selectiveSync: this.filePolicy(),
          ...(this.enrollmentCollectionId.trim() ? { collectionId: this.enrollmentCollectionId.trim() } : {}),
        }, {
          signal: abort.signal,
          onVerification: (verification) => {
            this.enrollmentVerification = verification.verificationUri;
            this.ctx.message = "";
            window.open(verification.verificationUri, "_blank", "noopener,noreferrer");
            this.ctx.render();
          },
          onStatus: (status) => {
            this.ctx.message = status.state === "waiting_for_approval"
              ? ""
              : `Connect is retrying enrollment (attempt ${status.attempt}).`;
            this.ctx.render();
          },
        });
        this.enrollmentVerification = "";
        // The first sync always stops for review; show it straight away.
        const preview = await this.session.review();
        const bytes = preview?.entries.reduce((sum, entry) => sum + (entry.estimatedBytes ?? 0), 0) ?? 0;
        const items = preview?.entries.length ?? 0;
        this.ctx.message = `Connected. Review ${items} ${items === 1 ? "item" : "items"}${bytes ? ` · ${formatBytes(bytes)}` : ""} before syncing.`;
        this.ctx.render();
      } catch (error) {
        this.ctx.pendingFocusKey = "enrollment-connect";
        if (!isAbortError(error)) throw error;
        this.enrollmentVerification = "";
        this.ctx.message = "Cancelled. No files synced.";
      } finally {
        if (this.enrollmentAbort === abort) {
          this.enrollmentAbort = null;
          this.enrollmentVerification = "";
        }
      }
    });
  }

  private renderLocalAdoption(container: HTMLElement): void {
    const checkpoint = this.ctx.host.connectSync.getAdoptionMarker();
    const recovery = checkpoint ? this.ctx.host.connectSync.getAdoptionRecovery() : null;
    const usesLiveFiles = !checkpoint || ["waiting_for_approval", "uploading"].includes(checkpoint.phase);
    const conflicts = usesLiveFiles ? this.adoptionPreview?.conflicts ?? [] : [];
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-enrollment" });
    section.createEl("h3", { text: "Upload to Connect" });
    section.createEl("p", { cls: "mdbase-muted", text: recovery
      ? recovery.canReset
        ? "This upload expired and its device authorization is missing. Reset setup to start again. Your files stay local."
        : recovery.canReconnect
          ? "Device authorization is unavailable. Reconnect to the hosted collection through Connect. This vault stays protected until approval succeeds."
          : `Device authorization is unavailable. Restore Obsidian's secret storage, or reset setup after ${new Date(checkpoint?.session.expiresAt ?? "").toLocaleString()}.`
      : this.ctx.busy && this.adoptionStage
        ? this.adoptionStage
        : checkpoint
          ? checkpoint.phase === "waiting_for_approval"
            ? "Not connected yet. Approval is pending in Connect."
            : checkpoint.phase === "adopted"
              ? "Collection is hosted. Finish connecting this device."
              : checkpoint.phase === "activating"
                ? "Activation outcome is pending. Resume to check it safely."
                : conflicts.length || this.adoptionFailed
              ? "Approval received. Upload stopped; this vault is not connected yet."
              : "Approval received. Transfer is not running; resume to continue."
          : "This vault holds the collection. Upload it to Connect to sync it with other devices; Connect then holds the collection and this vault syncs a copy.",
      attr: { role: "status", "aria-live": "polite" },
    });
    const verificationUri = this.enrollmentVerification || (!recovery && checkpoint?.phase === "waiting_for_approval" ? checkpoint.session.verificationUri : undefined);
    if (verificationUri) {
      const approval = section.createDiv({ cls: "mdbase-approval-link" });
      approval.createSpan({ text: "Approval page: " });
      const link = approval.createEl("a", { text: "Open Connect", href: verificationUri });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener noreferrer");
    }
    if (checkpoint) {
      this.enrollmentControlUrl = checkpoint.session.controlUrl;
      this.enrollmentMirrorName = checkpoint.session.requested.mirrorName ?? "Obsidian";
    }
    if (!checkpoint) {
      inputRow(section, "Device name", this.enrollmentMirrorName, (value) => {
        this.enrollmentMirrorName = value;
      });
      const advanced = this.ctx.disclosure(section, "adoption-options", "Advanced");
      inputRow(advanced, "Connect URL", this.enrollmentControlUrl, (value) => {
        this.enrollmentControlUrl = value;
      }, { placeholder: DEFAULT_CONNECT_CONTROL_URL });
      this.renderFilePolicyControls(advanced);
    } else {
      const values = this.ctx.disclosure(section, "adoption-details", "Details");
      renderStatus(values, "Collection", checkpoint.session.requested.collectionId);
      renderStatus(values, "Phase", checkpoint.phase.replace(/_/g, " "));
      renderStatus(values, "Connect", checkpoint.session.controlUrl);
      const policy = this.ctx.host.connectSync.getSelectiveSync();
      renderStatus(values, "Files", policy.file_classes.length ? policy.file_classes.join(", ") : "Markdown only");
    }
    if (!recovery && usesLiveFiles) {
      if (this.adoptionPreview) section.createEl("p", {
        cls: "mdbase-muted", text: `${this.adoptionPreview.records.toLocaleString()} notes · ${this.adoptionPreview.files.toLocaleString()} attachments`,
      });
      if (conflicts.length) {
        section.createEl("h4", { text: `${conflicts.length} filename conflicts` });
        this.renderAdoptionRenameReview(section, conflicts);
      }
    }
    if (!recovery) section.createEl("p", { cls: "mdbase-form-description", text: "Sync starts only after the upload completes." });
    const actions = section.createDiv({ cls: "mdbase-actions mdbase-enrollment-actions" });
    if (!recovery && usesLiveFiles) {
      const check = actions.createEl("button", { text: "Check files" });
      check.disabled = this.ctx.busy;
      check.onclick = () => void this.ctx.perform(async () => {
        this.adoptionRenamePlan = null;
        this.adoptionPreview = await this.ctx.host.connectSync.previewAdoption(this.filePolicy());
        this.ctx.message = this.adoptionPreview.conflicts.length ? "Resolve the listed filename conflicts before continuing." : "Files checked. No filename conflicts.";
      });
    }
    if (recovery && !recovery.canReconnect) {
      if (recovery.canReset) {
        const reset = actions.createEl("button", { text: "Reset setup", cls: "mod-cta" });
        reset.disabled = this.ctx.busy;
        reset.onclick = () => void this.ctx.perform(async () => {
          this.filePolicyDraft = this.ctx.host.connectSync.getSelectiveSync();
          await this.ctx.host.connectSync.resetExpiredAdoption();
          this.enrollmentVerification = "";
          this.ctx.message = "Expired setup cleared. Your files and collection identity are unchanged. Start a new upload to approve this device again.";
          await this.ctx.refresh(true);
        });
      } else {
        const check = actions.createEl("button", { text: "Check again" });
        check.disabled = this.ctx.busy;
        check.onclick = () => this.ctx.render();
      }
      return;
    }
    if (checkpoint && !recovery && !["activating", "adopted"].includes(checkpoint.phase)) {
      const cancel = actions.createEl("button", { text: "Cancel upload" });
      cancel.disabled = this.ctx.busy;
      cancel.onclick = () => void this.ctx.perform(async () => {
        await this.ctx.host.connectSync.cancelAdoption();
        this.enrollmentVerification = "";
        this.ctx.message = "Upload cancelled. The collection is still local.";
        await this.ctx.refresh(true);
      });
    }
    if (this.enrollmentAbort) {
      const stop = actions.createEl("button", { text: checkpoint?.phase === "waiting_for_approval" ? "Stop waiting" : "Pause upload" });
      stop.onclick = () => {
        this.enrollmentAbort?.abort();
        this.ctx.message = "Upload paused. Resume when ready.";
        this.ctx.render();
      };
    }
    const button = actions.createEl("button", {
      text: recovery ? "Reconnect collection" : checkpoint ? "Resume upload" : "Upload to Connect",
    });
    button.addClass("mod-cta");
    button.disabled = this.ctx.busy || (!recovery && conflicts.length > 0);
    button.onclick = () => void this.ctx.perform(async () => {
      this.adoptionFailed = false;
      this.adoptionStage = "Checking files…";
      this.enrollmentAbort?.abort();
      const abort = new AbortController();
      this.enrollmentAbort = abort;
      const onVerification = (verification: { verificationUri: string }) => {
        this.enrollmentVerification = verification.verificationUri;
        this.adoptionStage = "Waiting for approval in Connect…";
        this.ctx.message = "Approve the upload in Connect.";
        this.ctx.render();
      };
      const onStatus = (status: AuthorityAdoptionStatus) => {
        this.ctx.message = status.state === "waiting_for_approval"
          ? "Waiting for upload approval in Connect…"
          : `Connect is retrying (attempt ${status.attempt}).`;
        this.ctx.render();
      };
      const onProgress: NonNullable<AdoptLocalCollectionCallbacks["onProgress"]> = (progress) => {
        this.adoptionStage = progress.stage === "checking" ? "Checking files…"
          : progress.stage === "uploading" ? `Approval received. Uploading ${progress.records?.toLocaleString() ?? ""} notes…`
          : progress.stage === "activating" ? "Activating hosted collection. Keep this vault open…"
          : "Finishing this device's connection…";
        this.enrollmentVerification = "";
        this.ctx.message = "";
        this.ctx.render();
      };
      const onFileProgress = (path: string, transferredBytes: number, totalBytes: number) => {
        this.adoptionFileProgress = `${path} · ${formatBytes(transferredBytes)} of ${formatBytes(totalBytes)}`;
        this.adoptionStage = `Uploading ${this.adoptionFileProgress}`;
        this.ctx.render();
      };
      const callbacks = { signal: abort.signal, onVerification, onStatus, onFileProgress, onProgress };
      try {
        if (recovery) {
          await this.ctx.host.connectSync.reconnectAdoption(callbacks);
        } else if (checkpoint) {
          await this.ctx.host.connectSync.resumeAdoption(callbacks);
        } else {
          await this.ctx.host.connectSync.adoptLocalCollection({
            controlUrl: this.enrollmentControlUrl,
            mirrorName: this.enrollmentMirrorName,
            selectiveSync: this.filePolicy(),
          }, callbacks);
        }
        this.enrollmentVerification = "";
        this.ctx.message = "Collection hosted. This vault is now connected.";
        await this.ctx.refresh(true);
      } catch (error) {
        if (this.ctx.host.connectSync.getAdoptionMarker()?.phase !== "waiting_for_approval") this.enrollmentVerification = "";
        if (!isAbortError(error)) {
          this.adoptionFailed = true;
          await this.ctx.host.connectSync.previewAdoption(this.filePolicy()).then(preview => { this.adoptionPreview = preview; }).catch(() => undefined);
          throw error;
        }
        this.ctx.message = "Upload paused. Resume when ready.";
      } finally {
        this.adoptionStage = "";
        if (this.enrollmentAbort === abort) this.enrollmentAbort = null;
      }
    });
  }

  private renderAdoptionRenameReview(container: HTMLElement, conflicts: string[][]): void {
    const plan = this.adoptionRenamePlan;
    container.createEl("p", { text: plan
      ? "Keep both files with distinct names. Nothing is merged or deleted. Link updates follow your Obsidian settings."
      : "Names must also be distinct on case-insensitive devices. Review suggested names, or rename the files yourself." });
    const list = container.createEl("ul", { cls: "mdbase-adoption-conflicts" });
    const rows = plan ? plan.renames.map(change => [change.from, change.to]) : conflicts;
    for (const paths of rows) {
      const row = list.createEl("li");
      paths.forEach((path, index) => {
        if (index) row.appendText(plan ? " → " : " ↔ ");
        row.createEl("code", { text: path });
      });
    }
    if (plan?.manual.length) container.createEl("p", { text: "Collection-resource conflicts need manual review: " + plan.manual.map(group => group.join(" ↔ ")).join("; ") });
    const actions = container.createDiv({ cls: "mdbase-actions" });
    if (!plan) {
      const review = actions.createEl("button", { text: "Review renames…" });
      review.disabled = this.ctx.busy;
      review.onclick = () => void this.ctx.perform(async () => {
        this.adoptionRenamePlan = await this.ctx.host.connectSync.planAdoptionRenames(this.filePolicy());
      });
      return;
    }
    const apply = actions.createEl("button", { text: `Rename ${plan.renames.length} ${plan.renames.length === 1 ? "file" : "files"}`, cls: "mod-cta" });
    apply.disabled = this.ctx.busy || !plan.renames.length;
    apply.onclick = () => void this.ctx.perform(async () => {
      try {
        const count = await this.ctx.host.connectSync.applyAdoptionRenames(plan, this.filePolicy(), (done, total) => {
          this.adoptionStage = `Renaming ${done} of ${total} files…`;
          this.ctx.render();
        });
        this.ctx.message = `Renamed ${count} ${count === 1 ? "file" : "files"}. Review the file check, then resume the upload.`;
      } finally {
        this.adoptionStage = "";
        this.adoptionRenamePlan = null;
        await this.ctx.host.connectSync.previewAdoption(this.filePolicy()).then(preview => { this.adoptionPreview = preview; }).catch(() => undefined);
      }
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.disabled = this.ctx.busy;
    cancel.onclick = () => { this.adoptionRenamePlan = null; this.ctx.render(); };
  }

  private renderMirrorPreview(container: HTMLElement, preview: MdbaseSyncPreview): void {
    const section = container.createEl("section", { cls: "mdbase-transfer-review" });
    const heading = section.createDiv({ cls: "mdbase-transfer-heading" });
    const title = heading.createDiv();
    title.createEl("h3", { text: preview.phase === "initial" ? "First sync" : "Changes" });
    const estimatedBytes = preview.entries.reduce((sum, entry) => sum + (entry.estimatedBytes ?? 0), 0);
    heading.createSpan({
      cls: "mdbase-transfer-total",
      text: preview.entries.length ? `${preview.entries.length} ${preview.entries.length === 1 ? "item" : "items"}${estimatedBytes ? ` · ${formatBytes(estimatedBytes)}` : ""}` : "No changes",
    });

    const controls = section.createDiv({ cls: "mdbase-issue-controls" });
    const query = controls.createEl("input", { type: "search", placeholder: "Search transfer paths" });
    query.setAttr("aria-label", "Search transfer paths");
    query.setAttr("data-focus-key", "transfer-search");
    query.value = this.transferQuery;
    query.oninput = () => { this.transferQuery = query.value; this.transferPages.clear(); this.ctx.render(); };
    const filter = controls.createEl("select");
    filter.setAttr("aria-label", "Filter transfers");
    filter.setAttr("data-focus-key", "transfer-filter");
    for (const [value, label] of [["all", "All changes"], ["delete", "Deletes"], ["replace", "Replacements"], ["upload", "Uploads"], ["download", "Downloads"], ["attention", "Needs attention"]]) {
      filter.createEl("option", { value, text: label });
    }
    filter.value = this.transferFilter;
    filter.onchange = () => { this.transferFilter = filter.value; this.transferPages.clear(); this.ctx.render(); };
    const needle = this.transferQuery.trim().toLowerCase();
    const visible = preview.entries.filter(entry => (!needle || `${entry.path} ${entry.detail}`.toLowerCase().includes(needle))
      && (this.transferFilter === "all" || entry.action === this.transferFilter || entry.direction === this.transferFilter));
    if (!visible.length) section.createDiv({ cls: "mdbase-muted", text: "No changes match these filters." });
    section.createDiv({ cls: "mdbase-muted", text: `Showing ${visible.length} of ${preview.entries.length} items. Approval always applies to the entire reviewed plan, not just these filters.` });
    const groups: Array<{ direction: SyncPreviewDirection; title: string }> = [
      { direction: "download", title: "Downloads" },
      { direction: "upload", title: "Uploads" },
      { direction: "attention", title: "Needs attention" },
    ];
    for (const group of groups) {
      const entries = visible.filter((entry) => entry.direction === group.direction);
      if (!entries.length) continue;
      const block = section.createEl("section", { cls: "mdbase-transfer-group" });
      block.setAttr("data-direction", group.direction);
      const groupHeading = block.createDiv({ cls: "mdbase-transfer-group-heading" });
      const icon = groupHeading.createSpan({ cls: "mdbase-transfer-group-icon" });
      setIcon(icon, group.direction === "download" ? "download" : group.direction === "upload" ? "upload" : "circle-alert");
      groupHeading.createEl("h4", { text: group.title });
      groupHeading.createSpan({ text: String(entries.length), cls: "mdbase-transfer-count" });
      const ledger = block.createDiv({ cls: "mdbase-transfer-ledger" });
      const page = Math.min(this.transferPages.get(group.direction) ?? 0, Math.floor((entries.length - 1) / 250));
      const start = page * 250;
      for (const entry of entries.slice(start, start + 250)) {
        const row = ledger.createDiv({ cls: "mdbase-transfer-row" });
        const action = row.createSpan({ cls: "mdbase-transfer-action", text: entry.action });
        action.setAttr("data-action", entry.action);
        const body = row.createDiv({ cls: "mdbase-transfer-body" });
        const pathLine = body.createDiv({ cls: "mdbase-transfer-path" });
        const localPath = this.ctx.app.vault.getAbstractFileByPath(entry.path) ? entry.path : null;
        if (localPath) {
          const open = pathLine.createEl("button", { cls: "mdbase-link-button mdbase-transfer-open" });
          open.createEl("code", { text: entry.path });
          open.setAttr("title", `Open ${entry.path}`);
          open.setAttr("data-focus-key", `preview-open-${entry.path}`);
          open.onclick = () => void this.ctx.host.openFileByPath(localPath);
        } else pathLine.createEl("code", { text: entry.path });
        if (entry.estimatedBytes !== undefined) {
          pathLine.createSpan({ cls: "mdbase-transfer-size", text: formatBytes(entry.estimatedBytes) });
        }
        if (entry.direction === "attention" || ["rename", "replace", "delete"].includes(entry.action)) {
          body.createDiv({ text: entry.detail });
        } else row.setAttr("title", entry.detail);
        const recordId = entry.recordId;
        if (recordId && entry.kind === "document" && entry.action === "update" && localPath) {
          const key = `${recordId}:${entry.path}`;
          const comparison = this.previewComparisons.get(key);
          const compare = row.createEl("button", {
            text: comparison ? "Hide" : this.loadingPreviewComparisons.has(key) ? "Loading…" : "Compare",
          });
          compare.setAttr("data-focus-key", `preview-compare-${key}`);
          compare.disabled = this.loadingPreviewComparisons.has(key);
          compare.onclick = () => {
            if (comparison) {
              this.previewComparisons.delete(key);
              this.ctx.render();
            } else void this.loadPreviewComparison(key, recordId, entry.path);
          };
          if (comparison) this.renderConflictComparison(body, comparison);
        }
      }
      if (entries.length > 250) {
        const pages = ledger.createDiv({ cls: "mdbase-actions" });
        pages.createSpan({ cls: "mdbase-muted", text: `Showing ${start + 1}–${Math.min(start + 250, entries.length)} of ${entries.length}` });
        const previous = pages.createEl("button", { text: `Previous ${group.title.toLowerCase()}` });
        previous.disabled = page === 0;
        previous.setAttr("data-focus-key", `transfer-previous-${group.direction}`);
        previous.onclick = () => { this.transferPages.set(group.direction, page - 1); this.ctx.render(); };
        const next = pages.createEl("button", { text: `Next ${group.title.toLowerCase()}` });
        next.disabled = start + 250 >= entries.length;
        next.setAttr("data-focus-key", `transfer-next-${group.direction}`);
        next.onclick = () => { this.transferPages.set(group.direction, page + 1); this.ctx.render(); };
      }
    }

    if (preview.collisions.length) {
      section.createDiv({
        cls: "mdbase-inline-error",
        text: "Colliding files and related moves are left unchanged. Independent files can still sync. Move or rename the obstruction, then review again.",
      });
    } else if (preview.local_issues.length) {
      section.createDiv({
        cls: "mdbase-inline-message",
        text: preview.plan.summary.blocking_issues > 0
          ? syncReviewPresentation(preview.plan, preview.entries.length).message
          : "These diagnostics do not block synchronization. Document bytes are preserved unchanged.",
      });
    }
  }

  private renderConflicts(container: HTMLElement, status: MirrorStatus): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section" });
    section.id = "mdbase-sync-conflicts";
    section.createEl("h3", { text: "Conflicts" });
    for (const conflict of status.conflicts) {
      const row = section.createDiv({ cls: "mdbase-conflict-row" });
      const text = row.createDiv({ cls: "mdbase-conflict-summary" });
      text.createEl("strong", { text: conflict.path ?? conflict.object_id });
      text.createDiv({ text: conflict.message });
      const actions = row.createDiv({ cls: "mdbase-actions" });
      const comparisonKey = `${conflict.object_id}:${conflict.decision_id}`;
      const comparison = this.conflictComparisons.get(comparisonKey);
      const compare = actions.createEl("button", {
        text: comparison ? "Hide" : this.loadingConflictComparisons.has(comparisonKey) ? "Loading…" : "Resolve…",
      });
      compare.setAttr("data-focus-key", `compare-${comparisonKey}`);
      compare.disabled = this.ctx.busy || this.loadingConflictComparisons.has(comparisonKey);
      compare.onclick = () => {
        if (comparison) {
          this.conflictComparisons.delete(comparisonKey);
          this.ctx.render();
          return;
        }
        void this.loadConflictComparison(conflict, comparisonKey);
      };
      if (comparison) {
        for (const resolution of ["local", "remote"] as const) {
          const button = actions.createEl("button", {
            text: resolution === "local" ? "Keep local" : "Use hosted",
          });
          button.disabled = this.ctx.busy;
          button.onclick = () => void this.resolveMirrorConflict(conflict, resolution, false);
        }
        if (conflict.path) {
          const keepBoth = actions.createEl("button", { text: "Keep both" });
          keepBoth.disabled = this.ctx.busy;
          keepBoth.onclick = () => void this.resolveMirrorConflict(conflict, "remote", true);
        }
        this.renderConflictComparison(row, comparison);
      }
    }
  }

  private async loadPreviewComparison(key: string, recordId: string, path: string): Promise<void> {
    this.loadingPreviewComparisons.add(key);
    this.ctx.render();
    try {
      this.previewComparisons.set(key, await this.ctx.host.connectSync.recordComparison(recordId, path));
    } catch (error) {
      this.ctx.message = syncProblem(error).message;
    } finally {
      this.loadingPreviewComparisons.delete(key);
      this.ctx.render();
    }
  }

  private async loadConflictComparison(
    conflict: MirrorStatus["conflicts"][number],
    comparisonKey: string,
  ): Promise<void> {
    this.loadingConflictComparisons.add(comparisonKey);
    this.ctx.render();
    try {
      this.conflictComparisons.set(comparisonKey, await this.ctx.host.connectSync.conflictComparison(conflict));
    } catch (error) {
      const problem = this.session.reportProblem(error);
      if (problem.code === "conflict_decision_stale") await this.session.refreshStatus();
    } finally {
      this.loadingConflictComparisons.delete(comparisonKey);
      this.ctx.render();
    }
  }

  private renderConflictComparison(container: HTMLElement, comparison: MirrorConflictComparison): void {
    const comparisonEl = container.createDiv({ cls: "mdbase-conflict-comparison" });
    if (comparison.entity === "record") {
      const diff = boundedLineDiff(comparison.local.document ?? "", comparison.remote.document ?? "");
      const legend = comparisonEl.createDiv({ cls: "mdbase-conflict-legend" });
      legend.createSpan({ text: "− Local only", cls: "is-local" });
      legend.createSpan({ text: "+ Hosted only", cls: "is-remote" });
      const code = comparisonEl.createEl("pre", { cls: "mdbase-conflict-diff" });
      for (const line of diff.lines) {
        const output = code.createEl("div", { cls: `is-${line.kind}` });
        output.createSpan({ text: line.kind === "local" ? "−" : line.kind === "remote" ? "+" : " " });
        output.createSpan({ text: line.value || " " });
      }
      if (diff.truncated) comparisonEl.createDiv({ cls: "mdbase-muted", text: "Diff shortened for a responsive review. Open the local note to inspect it in full." });
      return;
    }
    const sides = comparisonEl.createDiv({ cls: "mdbase-conflict-sides" });
    this.renderConflictSide(sides, "Local", comparison.local);
    this.renderConflictSide(sides, "Hosted", comparison.remote);
  }

  private renderConflictSide(
    container: HTMLElement,
    label: string,
    side: MirrorConflictComparison["local"],
  ): void {
    const card = container.createDiv({ cls: "mdbase-conflict-side" });
    card.createEl("h4", { text: label });
    if (side.state === "absent") {
      card.createDiv({ cls: "mdbase-muted", text: "File is absent in this version." });
      return;
    }
    if (side.path) card.createEl("code", { text: side.path });
    if (side.size !== undefined) card.createDiv({ text: `Size: ${formatBytes(side.size)}` });
    if (side.modifiedAt) card.createDiv({ text: `Modified: ${new Date(side.modifiedAt).toLocaleString()}` });
    if (side.revision) card.createDiv({ cls: "mdbase-conflict-digest", text: `Digest: ${side.revision}` });
    if (side.resourceUrl && side.path && /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(side.path)) {
      const preview = card.createEl("img", { cls: "mdbase-conflict-image-preview" });
      preview.src = side.resourceUrl;
      preview.alt = `${label} preview of ${side.path}`;
    } else if (label === "Hosted") {
      card.createDiv({ cls: "mdbase-muted", text: "Hosted binary preview is materialized only after you choose it." });
    }
  }

  private async resolveMirrorConflict(
    conflict: MirrorStatus["conflicts"][number],
    resolution: "local" | "remote",
    keepBoth: boolean,
  ): Promise<void> {
    await this.ctx.perform(async () => {
      if (await this.session.resolveConflict(conflict, resolution, keepBoth)) {
        this.conflictComparisons.delete(`${conflict.object_id}:${conflict.decision_id}`);
      }
    });
  }

  private renderLocalMirrorIssues(container: HTMLElement, status: MirrorStatus): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section" });
    section.createEl("h3", { text: "Local files needing attention" });
    section.createEl("p", {
      text: "Review these file diagnostics. The sync preview identifies which issues block synchronization; a diagnostic alone does not mean syncing is paused.",
    });
    for (const issue of status.local_issues) {
      const row = section.createDiv({ cls: "mdbase-conflict-row" });
      const text = row.createDiv();
      text.createEl("strong", { text: issue.path });
      text.createDiv({ text: issue.message });
      const actions = row.createDiv({ cls: "mdbase-actions" });
      const open = actions.createEl("button", { text: "Open file" });
      open.disabled = this.ctx.busy;
      open.onclick = () => void this.ctx.host.openFileByPath(issue.path);
    }
  }

  /** Refresh what the Sync destination shows: mirror status, or the upload check for a local collection. */
  async refresh(): Promise<void> {
    if (this.session.isSyncing()) return;
    if (!this.ctx.host.getMirrorProfile()) {
      if (!this.ctx.schema || this.enrollmentAbort) return;
      try {
        this.adoptionPreview = await this.ctx.host.connectSync.previewAdoption(this.filePolicy());
      } catch (error) {
        this.ctx.message = syncProblem(error).message;
      }
      return;
    }
    await this.session.refreshStatus();
  }

}

