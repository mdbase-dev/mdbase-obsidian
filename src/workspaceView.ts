import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type { CollectionRecord } from "./mdbaseCore";
import { MDBASE_ICON_ID } from "./mdbaseIcon";
import { IssuesPane } from "./workspace/issuesPane";
import {
  compactCount,
  type Destination,
  type MdbaseWorkspaceHost,
  type MdbaseWorkspaceSchema,
  type RenderSnapshot,
  type WorkspaceContext,
} from "./workspace/shared";
import { SyncPane } from "./workspace/syncPane";
import { TypesPane } from "./workspace/typesPane";

export type { MdbaseWorkspaceHost, MdbaseWorkspaceSchema } from "./workspace/shared";

export const MDBASE_WORKSPACE_VIEW = "mdbase-workspace-view";

/**
 * The workspace shell: destination tabs, the shared message line, and render
 * bookkeeping. Each destination's state and rendering lives in its own pane.
 */
export class MdbaseWorkspaceView extends ItemView implements WorkspaceContext {
  destination: Destination = "types";
  message = "";
  pendingFocusKey: string | null = null;
  busy = false;
  schema: MdbaseWorkspaceSchema | null = null;
  records: CollectionRecord[] | null = null;
  readonly disclosures = new Map<string, boolean>();
  readonly types = new TypesPane(this);
  readonly sync = new SyncPane(this);
  readonly issues = new IssuesPane(this);
  private static nextNavigationId = 0;
  private readonly navigationId = `mdbase-workspace-${++MdbaseWorkspaceView.nextNavigationId}`;
  private refreshVersion = 0;
  private unsubscribeSync: (() => void) | null = null;
  private syncRenderTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, readonly host: MdbaseWorkspaceHost) {
    super(leaf);
  }

  getState(): Record<string, unknown> {
    this.captureRenderSnapshot(this.containerEl);
    return { destination: this.destination, ...this.types.getState(), ...this.issues.getState(), ...this.sync.getState(), disclosures: Object.fromEntries(this.disclosures) };
  }

  async setState(state: Record<string, unknown>, result: import("obsidian").ViewStateResult): Promise<void> {
    if (["types", "sync", "issues"].includes(String(state.destination))) this.destination = state.destination as Destination;
    if (state.disclosures && typeof state.disclosures === "object") for (const [key, value] of Object.entries(state.disclosures)) if (typeof value === "boolean") this.disclosures.set(key, value);
    await this.types.setState(state);
    this.issues.setState(state);
    this.sync.setState(state);
    await this.refresh();
    this.types.restoreEditorMode(state.editorMode);
    await super.setState(state, result);
  }

  refreshValidationControls(): void {
    if (this.destination === "issues") this.render();
  }

  updateValidationProgress(): void { this.issues.updateValidationProgress(); }

  getViewType(): string {
    return MDBASE_WORKSPACE_VIEW;
  }

  getDisplayText(): string {
    return "mdbase";
  }

  getIcon(): string {
    return MDBASE_ICON_ID;
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("mdbase-workspace");
    this.registerDomEvent(this.containerEl, "keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && this.types.dirty) {
        event.preventDefault();
        void this.types.saveCurrentType();
      }
    });
    // Progress is current in the session immediately, but a burst of transfer
    // callbacks needs only one presentation update. Decisions/outcomes never wait.
    let previous = this.host.sync.state;
    this.unsubscribeSync = this.host.sync.subscribe(() => {
      const state = this.host.sync.state;
      const progressOnly = (Object.keys(state) as Array<keyof typeof state>).every((key) =>
        key === "progress" || key === "fileProgress" || previous[key] === state[key]);
      previous = state;
      if (progressOnly && (state.progress || state.fileProgress)) {
        if (this.destination === "sync" && this.syncRenderTimer === null) {
          this.syncRenderTimer = window.setTimeout(() => {
            this.syncRenderTimer = null;
            if (this.destination === "sync") this.render();
          }, 100);
        }
        return;
      }
      this.cancelSyncRender();
      if (this.destination === "sync") this.render();
      else this.renderTopbarOnly();
    });
    // Obsidian calls setState after onOpen. Load there, once the restored or
    // requested destination is known, rather than scanning Types before Sync.
  }

  async onClose(): Promise<void> {
    this.refreshVersion++;
    this.unsubscribeSync?.();
    this.unsubscribeSync = null;
    this.cancelSyncRender();
    await this.types.dispose();
    this.sync.dispose();
  }

  private cancelSyncRender(): void {
    if (this.syncRenderTimer !== null) window.clearTimeout(this.syncRenderTimer);
    this.syncRenderTimer = null;
  }

  async refresh(forceReload = false): Promise<void> {
    const version = ++this.refreshVersion;
    const isCurrent = () => version === this.refreshVersion;
    try {
      const schema = await this.host.loadWorkspaceSchema(forceReload);
      if (!isCurrent()) return;
      this.schema = schema;
      if (this.destination === "types") {
        await this.types.onSchemaLoaded(forceReload, isCurrent);
        if (!isCurrent()) return;
        const records = schema ? await this.host.loadCollectionRecords() : null;
        if (!isCurrent()) return;
        const recordsChanged = records !== this.records;
        this.records = records;
        this.types.onRecordsLoaded(recordsChanged || forceReload);
      } else if (this.destination === "sync") await this.sync.refresh();
      if (!isCurrent()) return;
      this.render();
    } catch (error) {
      if (!isCurrent()) return;
      this.message = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  showDestination(destination: Destination): void {
    this.destination = destination;
    this.render();
    if (destination === "types") void this.refresh();
    else if (destination === "sync") void this.sync.refresh().then(() => this.render());
  }

  /** Open Issues filtered to one note. */
  showIssuesForPath(path: string): void {
    this.issues.filterToPath(path);
    this.showDestination("issues");
  }

  openTypeField(typePath: string, fieldPath: string | undefined): Promise<void> {
    return this.types.openTypeField(typePath, fieldPath);
  }

  recordTypes(): Map<string, string[]> {
    return this.types.currentStats().recordTypes;
  }

  createNewType(): void {
    this.types.createNewType();
  }

  editType(path: string): Promise<void> {
    return this.types.editType(path);
  }

  focusSyncSection(section: "activity" | "conflicts"): void {
    this.sync.focusSection(section);
  }

  reconnectCollection(): Promise<void> {
    return this.sync.reconnectCollection();
  }

  render(): void {
    const root = this.containerEl;
    const snapshot = this.captureRenderSnapshot(root);
    root.empty();
    root.addClass("mdbase-workspace");
    const shell = root.createDiv({ cls: "mdbase-shell" });
    this.renderTopbar(shell);
    if (this.message) {
      const message = shell.createDiv({ cls: "mdbase-inline-message mdbase-notice" });
      message.createSpan({ text: this.message }).setAttr("role", "status");
      const dismiss = this.iconButton(message, "x", "Dismiss message");
      dismiss.onclick = () => { this.message = ""; this.render(); };
    }
    const content = shell.createDiv({ cls: "mdbase-workspace-content" });
    content.setAttr("data-scroll-key", "workspace");
    content.id = `${this.navigationId}-${this.destination}-panel`;
    content.setAttr("role", "tabpanel");
    content.setAttr("aria-labelledby", `${this.navigationId}-${this.destination}-tab`);
    if (this.destination === "types") this.types.render(content);
    else if (this.destination === "sync") this.sync.render(content);
    else this.issues.render(content);
    this.restoreRenderSnapshot(root, snapshot);
    this.app.workspace?.requestSaveLayout();
    if (this.pendingFocusKey) {
      this.focusTarget(root, this.pendingFocusKey)?.focus();
      this.pendingFocusKey = null;
    }
    if (this.destination === "types") this.types.afterRender(root);
  }

  /** Conflicts, or a plan held for review, deserve a badge on the Sync tab. */
  private syncAttention(): { count: number; label: string } | null {
    const { status, preview } = this.host.sync.state;
    const conflicts = status?.conflicts.length ?? 0;
    if (conflicts) return { count: conflicts, label: `${conflicts} sync ${conflicts === 1 ? "conflict" : "conflicts"}` };
    const safety = this.host.sync.safety();
    const changes = safety && !safety.safe ? preview?.plan.actions.length ?? 0 : 0;
    return changes ? { count: changes, label: `${changes} ${changes === 1 ? "change needs" : "changes need"} review` } : null;
  }

  /** Mobile has no status bar; trouble must remain discoverable outside Sync. */
  private syncTabStatus(): { label: string; detail: string; kind: string } | null {
    if (this.destination === "sync" || !this.host.getMirrorProfile()) return null;
    const { problem, paused, status, progress, fileProgress } = this.host.sync.state;
    if (progress || fileProgress) return null;
    const kind = problem?.kind ?? (paused ? "paused" : status?.recovery_required ? "recovery" : null);
    if (!kind || kind === "busy") return null;
    const labels = { offline: "Offline", auth: "Sign in", device: "Set up", internal: "Error", decision: "Review", recovery: "Review", paused: "Paused" };
    return { kind, label: labels[kind], detail: problem?.title ?? (paused ? "Sync is paused" : "Synchronization needs recovery") };
  }

  /** Refresh tab badges without rebuilding the active pane (and losing its focus). */
  private renderTopbarOnly(): void {
    const topbar = this.containerEl.querySelector<HTMLElement>(".mdbase-topbar");
    if (!topbar) return;
    const snapshot = this.captureRenderSnapshot(topbar);
    const replacement = this.containerEl.ownerDocument.createElement("div");
    this.renderTopbar(replacement);
    const next = replacement.firstElementChild;
    if (next) {
      topbar.replaceWith(next);
      this.restoreRenderSnapshot(next as HTMLElement, snapshot);
    }
  }

  private captureRenderSnapshot(root: HTMLElement): RenderSnapshot {
    for (const details of Array.from(root.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]"))) {
      const key = details.dataset.disclosure;
      if (key) this.disclosures.set(key, details.open);
    }
    const activeDocument = root.ownerDocument;
    const active = root.contains(activeDocument.activeElement) ? activeDocument.activeElement as HTMLElement : null;
    const editable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
    const scroll = new Map<string, { top: number; left: number }>();
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-scroll-key]"))) {
      const key = element.getAttr("data-scroll-key");
      if (key) scroll.set(key, { top: element.scrollTop, left: element.scrollLeft });
    }
    return {
      focusKey: active?.getAttr("data-focus-key") ?? null,
      selectionStart: editable?.selectionStart ?? null,
      selectionEnd: editable?.selectionEnd ?? null,
      scroll,
    };
  }

  private restoreRenderSnapshot(root: HTMLElement, snapshot: RenderSnapshot): void {
    for (const [key, position] of snapshot.scroll) {
      const element = root.querySelector<HTMLElement>(`[data-scroll-key="${key}"]`);
      if (!element) continue;
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
    if (!snapshot.focusKey) return;
    const active = this.focusTarget(root, snapshot.focusKey);
    active?.focus({ preventScroll: true });
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      && snapshot.selectionStart !== null
      && snapshot.selectionEnd !== null
    ) active.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }

  /** Paths and field names are opaque keys, not CSS selector fragments. */
  private focusTarget(root: HTMLElement, key: string): HTMLElement | undefined {
    return Array.from(root.querySelectorAll<HTMLElement>("[data-focus-key]"))
      .find((element) => element.getAttr("data-focus-key") === key);
  }

  iconButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = container.createEl("button", { cls: "clickable-icon mdbase-icon-button" });
    button.setAttr("aria-label", label);
    button.setAttr("title", label);
    button.setAttr("data-focus-key", `action-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    setIcon(button, icon);
    return button;
  }

  disclosure(container: HTMLElement, key: string, label: string, initiallyOpen = false): HTMLDivElement {
    const details = container.createEl("details", { cls: "mdbase-disclosure" });
    details.dataset.disclosure = key;
    details.open = this.disclosures.get(key) ?? initiallyOpen;
    details.addEventListener("toggle", () => {
      if (!this.containerEl.contains(details)) return;
      this.disclosures.set(key, details.open);
      this.app.workspace?.requestSaveLayout();
    });
    details.createEl("summary", { text: label }).setAttr("data-focus-key", `disclosure-${key}`);
    return details.createDiv({ cls: "mdbase-disclosure-body" });
  }

  private renderTopbar(container: HTMLElement): void {
    const topbar = container.createDiv({ cls: "mdbase-topbar" });
    const nav = topbar.createDiv({ cls: "mdbase-nav" });
    nav.setAttr("role", "tablist");
    nav.setAttr("aria-label", "mdbase destinations");
    const destinations = [["types", "Types"], ["sync", "Sync"], ["issues", "Issues"]] as const;
    for (const [index, [destination, label]] of destinations.entries()) {
      const button = nav.createEl("button", { text: label, cls: "clickable-icon" });
      button.addClass("mdbase-nav-button");
      button.setAttr("role", "tab");
      button.id = `${this.navigationId}-${destination}-tab`;
      if (this.destination === destination) button.setAttr("aria-controls", `${this.navigationId}-${destination}-panel`);
      button.tabIndex = this.destination === destination ? 0 : -1;
      button.setAttr("data-focus-key", `destination-${destination}`);
      button.setAttr("aria-selected", String(this.destination === destination));
      if (this.destination === destination) button.addClass("is-active");
      if (destination === "issues" && this.host.getIssues().length) {
        const issueCount = this.host.getIssues().length;
        const count = button.createSpan({ cls: "mdbase-count", text: compactCount(issueCount) });
        count.setAttr("title", `${issueCount} issues`);
        button.setAttr("aria-label", `Issues · ${issueCount} validation ${issueCount === 1 ? "issue" : "issues"}`);
      }
      const tabStatus = destination === "sync" ? this.syncTabStatus() : null;
      const attention = destination === "sync" ? this.syncAttention() : null;
      if (tabStatus) {
        const indicator = button.createSpan({ cls: "mdbase-count mdbase-nav-status", text: tabStatus.label });
        indicator.setAttr("data-kind", tabStatus.kind);
        indicator.setAttr("title", tabStatus.detail);
        button.setAttr("aria-label", `Sync · ${tabStatus.detail}`);
      } else if (attention) {
        const count = button.createSpan({ cls: "mdbase-count", text: compactCount(attention.count) });
        count.setAttr("title", attention.label);
        button.setAttr("aria-label", `Sync · ${attention.label}`);
      }
      button.onclick = () => this.showDestination(destination);
      button.onkeydown = (event) => {
        const nextIndex = event.key === "ArrowRight" ? (index + 1) % destinations.length
          : event.key === "ArrowLeft" ? (index + destinations.length - 1) % destinations.length
          : event.key === "Home" ? 0
          : event.key === "End" ? destinations.length - 1 : null;
        if (nextIndex === null) return;
        event.preventDefault();
        this.pendingFocusKey = `destination-${destinations[nextIndex][0]}`;
        this.showDestination(destinations[nextIndex][0]);
      };
    }
  }

  async perform(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = "";
    this.render();
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.message = message;
      new Notice(message);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
