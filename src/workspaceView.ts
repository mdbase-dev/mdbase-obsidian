import {
  ItemView,
  Modal,
  Notice,
  Platform,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type { MirrorProgress, MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import type { AuthorityAdoptionStatus } from "@mdbase-dev/connect-sync/adoption";
import type {
  ConnectSyncController,
  DisconnectMirrorResult,
  MirrorConflictComparison,
  MirrorProfile,
} from "./connectSync";
import type {
  MdbaseConfig,
  MdbaseIssue,
  MdbaseTypeDef,
} from "./mdbaseCore";
import type {
  CollectionContractDescriptor,
  FileMediaClass,
  JsonObject,
  SelectiveSyncPolicy,
} from "@mdbase-dev/connect-protocol";
import { formatMarkdown, parseFrontmatter } from "./mdbaseCore";
import type { V02MigrationPlan } from "./migration";
import { MDBASE_ICON_ID } from "./mdbaseIcon";
import type { StoredTypeDraft, TypeEditorField, TypeEditorModel } from "./typeEditorTypes";
import type { MdbaseSyncPreview, SyncPreviewDirection } from "./syncPreview";
import { resolveConflictAndRefresh } from "./syncConflict";
import { boundedLineDiff } from "./conflictPresentation";
import {
  formatBytes,
  syncProblem,
  syncReviewPresentation,
  type FileTransferProgress,
  type SyncActivityEntry,
  type SyncProblem,
} from "./syncUx";
import {
  createDefaultTypeModel,
  frontmatterFromTypeModel,
  typeModelFromDocument,
} from "./typeModel";
import {
  addImplementation,
  assessMapping,
  contractFields,
  contractKey,
  mappingForContractField,
  removeImplementation,
  schemaInitialValue,
  schemaType,
  schemaTypeLabel,
  setBinding,
  setFieldMapping,
  typeFieldsForModel,
} from "./typeContracts";

declare const __MDBASE_CONNECT_CONTROL_URL__: string;
const DEFAULT_CONNECT_CONTROL_URL = typeof __MDBASE_CONNECT_CONTROL_URL__ === "string"
  ? __MDBASE_CONNECT_CONTROL_URL__
  : "https://connect.mdbase.dev";
import {
  describeTypeChanges,
  type TypeDraftChange,
  typeModelsEqual,
  validateTypeDraft,
} from "./typeDraft";

export const MDBASE_WORKSPACE_VIEW = "mdbase-workspace-view";

export interface MdbaseWorkspaceSchema {
  config: MdbaseConfig;
  types: Map<string, MdbaseTypeDef>;
  contracts: Map<string, CollectionContractDescriptor>;
}

export interface MdbaseWorkspaceHost {
  readonly connectSync: ConnectSyncController;
  getMirrorProfile(): MirrorProfile | null;
  loadWorkspaceSchema(forceReload?: boolean): Promise<MdbaseWorkspaceSchema | null>;
  loadTypeModel(path: string): Promise<TypeEditorModel>;
  saveTypeModel(model: TypeEditorModel, existingPath: string | null, expectedSourceRevision?: string): Promise<TFile>;
  loadTypeDraft(path: string | null): StoredTypeDraft | null;
  saveTypeDraft(draft: StoredTypeDraft): Promise<void>;
  clearTypeDraft(path: string | null): Promise<void>;
  initializeCollection(): Promise<void>;
  getIssues(): MdbaseIssue[];
  validateCollection(): Promise<void>;
  getQuickFixLabel(issue: MdbaseIssue): string | null;
  applyQuickFix(issue: MdbaseIssue): Promise<void>;
  openFileByPath(path: string, field?: string): Promise<void>;
  analyzeMigration(): Promise<V02MigrationPlan>;
  applyMigration(plan: V02MigrationPlan, allowLossy: boolean): Promise<void>;
  getSyncActivity(): SyncActivityEntry[];
  getCurrentSyncProblem(): SyncProblem | null;
  setSyncStatus(status: MirrorStatus | null, options?: { clearLocalChanges?: boolean }): void;
  setSyncProgress(progress: MirrorProgress | null, fileProgress?: FileTransferProgress | null): void;
  setSyncProblem(problem: SyncProblem | null): void;
  recordSyncActivity(entry: Omit<SyncActivityEntry, "id" | "occurredAt">): Promise<void>;
  dismissSyncActivity(id: string): Promise<void>;
  clearCompletedSyncActivity(): Promise<void>;
}

interface RenderSnapshot {
  focusKey: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  scroll: Map<string, { top: number; left: number }>;
}

type Destination = "types" | "sync" | "issues";
type EditorMode = "design" | "yaml";

const FIELD_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "time",
  "enum",
  "link",
  "list",
  "object",
  "any",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function definitionType(definition: Record<string, unknown>): string {
  return typeof definition.type === "string" ? definition.type : "any";
}

function nextNestedFieldName(fields: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(fields, "field")) return "field";
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(fields, `field${suffix}`)) suffix += 1;
  return `field${suffix}`;
}

function setOwnField(
  fields: Record<string, unknown>,
  name: string,
  definition: Record<string, unknown>,
): void {
  Object.defineProperty(fields, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: definition,
  });
}

function inputRow(
  container: HTMLElement,
  label: string,
  value: string,
  onInput: (value: string) => void,
  options: { description?: string; placeholder?: string; multiline?: boolean } = {},
): HTMLInputElement | HTMLTextAreaElement {
  const row = container.createDiv({ cls: "mdbase-form-row" });
  const labelEl = row.createEl("label", { text: label });
  const id = `mdbase-${Math.random().toString(36).slice(2)}`;
  labelEl.htmlFor = id;
  if (options.description) row.createDiv({ cls: "mdbase-form-description", text: options.description });
  const control = options.multiline
    ? row.createEl("textarea")
    : row.createEl("input", { type: "text" });
  control.id = id;
  control.setAttr("data-focus-key", `form-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  control.value = value;
  control.placeholder = options.placeholder ?? "";
  control.addEventListener("input", () => onInput(control.value));
  return control;
}

function renderStatus(container: HTMLElement, label: string, value: string): void {
  const row = container.createDiv({ cls: "mdbase-status-row" });
  row.createSpan({ cls: "mdbase-status-label", text: label });
  row.createSpan({ cls: "mdbase-status-value", text: value });
}

function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  const digits = value < 10_000 ? 1 : 0;
  return `${(value / 1_000).toFixed(digits)}k`;
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return "Never synced";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function syncStateLabel(status: MirrorStatus | null): string {
  if (!status) return "Checking connection";
  if (status.state === "up_to_date") return "Up to date";
  if (status.state === "changes_waiting") return "Local changes waiting";
  if (["attention", "blocked", "failed", "stale"].includes(status.state) || status.recovery_required) return "Needs attention";
  if (status.state === "cancelled") return "Paused safely";
  if (status.state === "applying") return "Synchronizing";
  if (status.state === "planned") return "Review ready";
  return "Ready for first sync";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class TypeChangeConfirmationModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  confirm(changes: readonly TypeDraftChange[]): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.titleEl.setText("Confirm high-impact type changes");
      this.contentEl.createEl("p", {
        text: "These schema changes can change membership or invalidate existing records. The plugin will save only the type definition; it will not rewrite records.",
      });
      const list = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list" });
      for (const change of changes) list.createEl("li", { text: change.summary });
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: "Keep reviewing" });
      cancel.onclick = () => this.finish(false);
      const save = actions.createEl("button", { text: "Save high-impact changes" });
      save.addClass("mod-warning");
      save.onclick = () => this.finish(true);
      this.open();
    });
  }

  onClose(): void {
    if (!this.settled) this.finish(false, false);
    this.contentEl.empty();
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve?.(confirmed);
    this.resolve = null;
    if (close) this.close();
  }
}

type DisconnectChoice = "keep" | "remove" | null;

class DisconnectMirrorModal extends Modal {
  private resolve: ((choice: DisconnectChoice) => void) | null = null;
  private settled = false;

  choose(collectionName: string): Promise<DisconnectChoice> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.titleEl.setText("Disconnect this vault?");
      this.contentEl.createEl("p", {
        text: `This stops synchronization with ${collectionName}. It does not delete the hosted collection.`,
      });
      const explanation = this.contentEl.createEl("ul");
      explanation.createEl("li", { text: "Keep local files leaves the current vault contents in place as an unsynced local copy." });
      explanation.createEl("li", { text: "Remove synced files deletes only files that still exactly match the last checkpoint. Local edits are preserved." });
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.onclick = () => this.finish(null);
      const keep = actions.createEl("button", { text: "Disconnect and keep files" });
      keep.onclick = () => this.finish("keep");
      const remove = actions.createEl("button", { text: "Remove unchanged synced files" });
      remove.addClass("mod-warning");
      remove.onclick = () => this.finish("remove");
      this.open();
    });
  }

  onClose(): void {
    if (!this.settled) this.finish(null, false);
    this.contentEl.empty();
  }

  private finish(choice: DisconnectChoice, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve?.(choice);
    this.resolve = null;
    if (close) this.close();
  }
}

export class MdbaseWorkspaceView extends ItemView {
  private destination: Destination = "types";
  private editorMode: EditorMode = "design";
  private schema: MdbaseWorkspaceSchema | null = null;
  private query = "";
  private selectedPath: string | null = null;
  private model: TypeEditorModel | null = null;
  private originalModel: TypeEditorModel | null = null;
  private yamlDraft = "";
  private dirty = false;
  private busy = false;
  private migrationPlan: V02MigrationPlan | null = null;
  private allowLossy = false;
  private mirrorStatus: MirrorStatus | null = null;
  private mirrorPreview: MdbaseSyncPreview | null = null;
  private mirrorProgress: MirrorProgress | null = null;
  private fileProgress: FileTransferProgress | null = null;
  private syncProblem: SyncProblem | null = null;
  private readonly conflictComparisons = new Map<string, MirrorConflictComparison>();
  private readonly loadingConflictComparisons = new Set<string>();
  private pendingSyncFocus: "activity" | "conflicts" | null = null;
  private transientMessage = "";
  private issueQuery = "";
  private issueSeverity: "all" | "error" | "warn" = "all";
  private issueLimit = 250;
  private enrollmentVerification = "";
  private enrollmentAbort: AbortController | null = null;
  private enrollmentControlUrl = DEFAULT_CONNECT_CONTROL_URL;
  private enrollmentMirrorName = "Obsidian";
  private enrollmentCollectionId = "";
  private enrollmentMode: "read_only" | "read_write" = "read_write";
  private filePolicyDraft: SelectiveSyncPolicy | null = null;
  private adoptionFileProgress = "";
  private draftSaveTimer: number | null = null;
  private fieldQuery = "";
  private readonly expandedFields = new Set<string>();
  private readonly fieldIds = new WeakMap<Record<string, unknown>, string>();
  private nextFieldId = 1;
  private refreshVersion = 0;
  private typeSelectionVersion = 0;

  constructor(leaf: WorkspaceLeaf, private readonly host: MdbaseWorkspaceHost) {
    super(leaf);
  }

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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && this.dirty) {
        event.preventDefault();
        void this.saveCurrentType();
      }
    });
    await this.refresh(true);
  }

  async onClose(): Promise<void> {
    await this.flushTypeDraft();
    this.enrollmentAbort?.abort();
    this.enrollmentAbort = null;
  }

  async refresh(forceReload = false): Promise<void> {
    const version = ++this.refreshVersion;
    try {
      const schema = await this.host.loadWorkspaceSchema(forceReload);
      if (version !== this.refreshVersion) return;
      this.schema = schema;
      if (this.selectedPath && !this.typeEntries().some((entry) => entry.filePath === this.selectedPath)) {
        this.selectedPath = null;
        this.model = null;
        this.originalModel = null;
      }
      if (!this.selectedPath && this.typeEntries().length && !Platform.isMobile) {
        this.selectedPath = this.typeEntries()[0].filePath;
      }
      if (this.selectedPath && (!this.model || forceReload)) {
        await this.selectType(this.selectedPath, false);
        if (version !== this.refreshVersion) return;
      }
      if (this.destination === "sync") await this.refreshMirrorStatus();
      if (version !== this.refreshVersion) return;
      this.render();
    } catch (error) {
      if (version !== this.refreshVersion) return;
      this.transientMessage = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  showDestination(destination: Destination): void {
    this.destination = destination;
    if (destination === "sync") void this.refreshMirrorStatus().then(() => this.render());
    else this.render();
  }

  createNewType(): void {
    this.destination = "types";
    this.createType();
  }

  async editType(path: string): Promise<void> {
    this.destination = "types";
    await this.selectType(path);
  }

  async reviewSyncChanges(): Promise<void> {
    if (!this.host.getMirrorProfile()) return;
    await this.perform(() => this.loadMirrorPreview());
  }

  async syncNow(): Promise<void> {
    if (!this.host.getMirrorProfile()) return;
    if (!this.mirrorPreview) {
      await this.reviewSyncChanges();
      const refreshedPreview = this.mirrorPreview as MdbaseSyncPreview | null;
      if (refreshedPreview?.plan.actions.length) {
        new Notice("The current transfer review is open. Run sync now again or confirm it in the mdbase view.");
      }
      return;
    }
    await this.perform(() => this.applyReviewedSync());
  }

  focusSyncSection(section: "activity" | "conflicts"): void {
    this.destination = "sync";
    this.pendingSyncFocus = section;
    this.render();
    window.setTimeout(() => this.focusPendingSyncSection(), 0);
  }

  async reconnectCollection(): Promise<void> {
    await this.perform(async () => {
      try {
        this.mirrorStatus = await this.host.connectSync.reconnect();
        this.syncProblem = null;
        this.host.setSyncStatus(this.mirrorStatus);
        await this.host.recordSyncActivity({
          summary: "Collection reconnected",
          detail: "Connect credentials were renewed and the mirror checkpoint was preserved.",
          tone: "success",
          requiresAcknowledgement: false,
        });
        this.transientMessage = "Connection restored. Your mirror checkpoint was preserved.";
      } catch (error) {
        const problem = syncProblem(error);
        if (problem.action !== "reauthorize") throw error;
        await this.reauthorizeCollection();
      }
    });
  }

  private typeEntries(): MdbaseTypeDef[] {
    return this.schema
      ? [...this.schema.types.values()].sort((a, b) => a.name.localeCompare(b.name))
      : [];
  }

  private render(): void {
    const root = this.containerEl;
    const snapshot = this.captureRenderSnapshot(root);
    root.empty();
    root.addClass("mdbase-workspace");
    const shell = root.createDiv({ cls: "mdbase-shell" });
    this.renderTopbar(shell);
    if (this.transientMessage) {
      const message = shell.createDiv({ cls: "mdbase-inline-message", text: this.transientMessage });
      message.setAttr("role", "status");
    }
    const content = shell.createDiv({ cls: "mdbase-workspace-content" });
    content.setAttr("data-scroll-key", "workspace");
    if (this.destination === "types") this.renderTypes(content);
    else if (this.destination === "sync") this.renderSync(content);
    else this.renderIssues(content);
    this.restoreRenderSnapshot(root, snapshot);
  }

  private captureRenderSnapshot(root: HTMLElement): RenderSnapshot {
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
    const active = root.querySelector<HTMLElement>(`[data-focus-key="${snapshot.focusKey}"]`);
    active?.focus({ preventScroll: true });
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      && snapshot.selectionStart !== null
      && snapshot.selectionEnd !== null
    ) active.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }

  private renderTopbar(container: HTMLElement): void {
    const topbar = container.createDiv({ cls: "mdbase-topbar" });
    const identity = topbar.createDiv({ cls: "mdbase-identity" });
    const mark = identity.createSpan({ cls: "mdbase-mark" });
    mark.setAttr("aria-hidden", "true");
    setIcon(mark, MDBASE_ICON_ID);
    identity.createSpan({ cls: "mdbase-title", text: "mdbase" });
    const nav = topbar.createDiv({ cls: "mdbase-nav" });
    nav.setAttr("role", "tablist");
    for (const [destination, label] of [["types", "Types"], ["sync", "Sync"], ["issues", "Issues"]] as const) {
      const button = nav.createEl("button", { text: label });
      button.addClass("mdbase-nav-button");
      button.setAttr("role", "tab");
      button.setAttr("aria-selected", String(this.destination === destination));
      if (this.destination === destination) button.addClass("is-active");
      if (destination === "issues" && this.host.getIssues().length) {
        const issueCount = this.host.getIssues().length;
        const count = button.createSpan({ cls: "mdbase-count", text: compactCount(issueCount) });
        count.setAttr("title", `${issueCount} issues`);
      }
      button.onclick = () => this.showDestination(destination);
    }
  }

  private renderTypes(container: HTMLElement): void {
    if (!this.schema) {
      const empty = container.createDiv({ cls: "mdbase-empty-state" });
      empty.createEl("h2", { text: "Start an mdbase collection" });
      empty.createEl("p", {
        text: "Initialize this vault as a local v0.3 collection, or use Sync to connect an empty vault to a collection authority.",
      });
      const actions = empty.createDiv({ cls: "mdbase-actions" });
      const initialize = actions.createEl("button", { text: "Initialize local collection" });
      initialize.addClass("mod-cta");
      initialize.disabled = this.busy || this.host.getMirrorProfile() !== null;
      initialize.onclick = () => void this.perform(async () => {
        await this.host.initializeCollection();
        await this.refresh(true);
      });
      const connect = actions.createEl("button", { text: "Connect collection authority" });
      connect.onclick = () => this.showDestination("sync");
      return;
    }

    if (this.schema.config.spec_version.startsWith("0.2.")) {
      this.renderLegacyBanner(container);
    }

    const layout = container.createDiv({ cls: "mdbase-types-layout" });
    if (this.model) layout.addClass("has-selection");
    this.renderTypeList(layout);
    this.renderTypeEditor(layout);
  }

  private renderLegacyBanner(container: HTMLElement): void {
    const banner = container.createDiv({ cls: "mdbase-legacy-banner" });
    const text = banner.createDiv();
    text.createEl("strong", { text: `mdbase ${this.schema?.config.spec_version} compatibility mode` });
    text.createEl("p", {
      text: "Types are readable and validation remains available, but authoring is disabled until a reviewed v0.3 migration.",
    });
    const button = banner.createEl("button", { text: this.migrationPlan ? "Review migration" : "Analyze migration" });
    button.disabled = this.busy || this.host.getMirrorProfile() !== null;
    button.onclick = () => void this.perform(async () => {
      this.migrationPlan = await this.host.analyzeMigration();
      this.render();
    });
    if (this.host.getMirrorProfile()) {
      banner.createDiv({
        cls: "mdbase-form-description",
        text: "Hosted resources must be migrated at the collection authority.",
      });
    }
    if (this.migrationPlan) this.renderMigrationReview(container, this.migrationPlan);
  }

  private renderMigrationReview(container: HTMLElement, plan: V02MigrationPlan): void {
    const review = container.createDiv({ cls: "mdbase-migration-review" });
    const header = review.createDiv({ cls: "mdbase-section-header" });
    header.createEl("h3", { text: "Migration review" });
    header.createSpan({ cls: "mdbase-spec-badge", text: `${plan.sourceVersion} → ${plan.targetVersion}` });
    const summary = review.createDiv({ cls: "mdbase-status-list" });
    renderStatus(summary, "Files replaced", String(plan.operations.length));
    renderStatus(summary, "Type definitions", String(plan.typeSummaries.length));
    renderStatus(summary, "Record reads verified", String(plan.recordsVerified));
    if (plan.recordsSkipped) renderStatus(summary, "Records skipped", String(plan.recordsSkipped));
    renderStatus(summary, "Record files rewritten", "0");
    renderStatus(summary, "Recovery backup", plan.backupLocation);
    const warnings = review.createDiv({ cls: "mdbase-review-list" });
    if (!plan.diagnostics.length) {
      warnings.createDiv({ cls: "mdbase-review-ok", text: "No migration diagnostics." });
    }
    for (const diagnostic of plan.diagnostics.slice(0, 250)) {
      const item = warnings.createDiv({ cls: "mdbase-review-item" });
      item.setAttr("data-severity", diagnostic.severity);
      item.createDiv({ cls: "mdbase-review-code", text: `${diagnostic.severity} · ${diagnostic.path}` });
      item.createDiv({ text: diagnostic.message });
    }
    if (plan.diagnostics.length > 250) {
      warnings.createDiv({
        cls: "mdbase-form-description",
        text: `Showing 250 of ${plan.diagnostics.length} diagnostics.`,
      });
    }
    if (!plan.applicable) {
      const consent = review.createEl("label", { cls: "mdbase-consent" });
      const checkbox = consent.createEl("input", { type: "checkbox" });
      checkbox.checked = this.allowLossy;
      checkbox.onchange = () => {
        this.allowLossy = checkbox.checked;
        this.render();
      };
      consent.createSpan({ text: "I reviewed the lossy diagnostics and want to apply this migration." });
    }
    const actions = review.createDiv({ cls: "mdbase-actions" });
    const apply = actions.createEl("button", { text: "Apply migration" });
    apply.addClass("mod-warning");
    apply.disabled = this.busy || (!plan.applicable && !this.allowLossy);
    apply.onclick = () => void this.perform(async () => {
      await this.host.applyMigration(plan, this.allowLossy);
      this.migrationPlan = null;
      this.allowLossy = false;
      this.model = null;
      this.originalModel = null;
      await this.refresh(true);
    });
    const dismiss = actions.createEl("button", { text: "Close review" });
    dismiss.onclick = () => {
      this.migrationPlan = null;
      this.render();
    };
  }

  private renderTypeList(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-list-pane" });
    const header = pane.createDiv({ cls: "mdbase-pane-header" });
    header.createEl("h2", { text: "Types" });
    const add = header.createEl("button");
    add.setAttr("aria-label", "Create type");
    setIcon(add, "plus");
    add.disabled = (this.schema?.config.spec_version.startsWith("0.2.") ?? true)
      || this.host.getMirrorProfile()?.mode === "read_only";
    add.onclick = () => this.createType();

    const search = pane.createEl("input", { type: "search" });
    search.addClass("mdbase-type-search");
    search.placeholder = "Search types";
    search.setAttr("aria-label", "Search types");
    search.setAttr("data-focus-key", "type-search");
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.render();
      const next = this.containerEl.querySelector<HTMLInputElement>(".mdbase-type-search");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    };

    const list = pane.createDiv({ cls: "mdbase-type-list" });
    list.setAttr("data-scroll-key", "type-list");
    const query = this.query.trim().toLowerCase();
    const entries = this.typeEntries().filter((entry) =>
      `${entry.name} ${entry.description ?? ""} ${entry.filePath}`.toLowerCase().includes(query));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: query ? "No matching types." : "No type definitions." });
      return;
    }
    for (const type of entries) {
      const button = list.createEl("button", { cls: "mdbase-type-row" });
      if (type.filePath === this.selectedPath) button.addClass("is-active");
      button.setAttr("aria-current", type.filePath === this.selectedPath ? "true" : "false");
      button.createSpan({ cls: "mdbase-type-name", text: type.name });
      button.createSpan({
        cls: "mdbase-type-meta",
        text: `${Object.keys(type.fields).length} fields · ${type.specProfile ?? "v0.2"}`,
      });
      button.onclick = () => void this.selectType(type.filePath);
    }
  }

  private renderTypeEditor(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-editor-pane" });
    pane.setAttr("data-scroll-key", "type-editor");
    if (!this.model) {
      const empty = pane.createDiv({ cls: "mdbase-empty-state" });
      empty.createEl("h2", { text: "Choose a type" });
      empty.createEl("p", { text: "Select a type definition from the list to inspect or edit it." });
      return;
    }
    const mirrorReadOnly = this.host.getMirrorProfile()?.mode === "read_only";
    const readOnly = this.model.specProfile === "v0.2" || mirrorReadOnly || Boolean(this.model.readOnlyReason);
    const readOnlyReason = this.model.readOnlyReason
      ?? (mirrorReadOnly
        ? "This mirror has read-only access. Re-enroll it with write access before editing types."
        : "This v0.2 type is read-only. Review and apply a collection migration before editing.");
    const header = pane.createDiv({ cls: "mdbase-editor-header" });
    const back = header.createEl("button", { cls: "mdbase-mobile-back" });
    back.setAttr("aria-label", "Back to type list");
    setIcon(back, "arrow-left");
    back.onclick = () => {
      if (this.dirty) {
        new Notice("Save or discard the current type changes before going back.");
        return;
      }
      this.selectedPath = null;
      this.model = null;
      this.originalModel = null;
      this.render();
    };
    const heading = header.createDiv();
    const titleLine = heading.createDiv({ cls: "mdbase-editor-title-line" });
    titleLine.createEl("h2", { text: this.model.name || "Untitled type" });
    titleLine.createSpan({ cls: "mdbase-spec-badge", text: this.model.specProfile ?? "v0.2" });
    if (this.dirty) titleLine.createSpan({ cls: "mdbase-dirty", text: "Unsaved" });
    heading.createDiv({ cls: "mdbase-editor-path", text: this.selectedPath ?? "New type" });

    const headerActions = header.createDiv({ cls: "mdbase-editor-actions" });
    if (this.selectedPath) {
      const selectedPath = this.selectedPath;
      const source = headerActions.createEl("button", { text: "Open source" });
      source.onclick = () => void this.host.openFileByPath(selectedPath);
    }
    const save = headerActions.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.disabled = readOnly || !this.dirty || this.busy;
    save.onclick = () => void this.saveCurrentType();
    if (this.dirty) {
      const discard = headerActions.createEl("button", { text: "Discard" });
      discard.onclick = () => void this.discardCurrentType();
    }

    if (readOnly) {
      pane.createDiv({
        cls: "mdbase-readonly-note",
        text: readOnlyReason,
      });
    }
    const mode = pane.createDiv({ cls: "mdbase-mode-switch" });
    mode.setAttr("role", "tablist");
    for (const [value, label] of [["design", "Design"], ["yaml", "YAML"]] as const) {
      const button = mode.createEl("button", { text: label });
      button.setAttr("role", "tab");
      button.setAttr("aria-selected", String(this.editorMode === value));
      if (this.editorMode === value) button.addClass("is-active");
      button.onclick = () => this.switchEditorMode(value);
    }

    const editor = pane.createDiv({ cls: "mdbase-editor-document" });
    editor.setAttr("data-scroll-key", "type-document");
    if (this.editorMode === "design") this.renderDesignEditor(editor, this.model, readOnly);
    else this.renderYamlEditor(editor, readOnly);
    if (this.dirty && !readOnly) this.renderDraftBar(pane, this.model);
  }

  private renderDraftBar(container: HTMLElement, model: TypeEditorModel): void {
    const changes = describeTypeChanges(this.originalModel, model);
    const diagnostics = validateTypeDraft(model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.schema?.contracts.values(),
    });
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const highRiskCount = changes.filter((change) => change.risk === "high").length;
    const bar = container.createDiv({ cls: "mdbase-draft-bar" });
    const summary = bar.createDiv({ cls: "mdbase-draft-summary" });
    summary.createEl("strong", { text: `${changes.length} pending ${changes.length === 1 ? "change" : "changes"}` });
    summary.createSpan({
      text: errorCount
        ? `${errorCount} ${errorCount === 1 ? "error" : "errors"} to fix`
        : highRiskCount
          ? `${highRiskCount} high-impact ${highRiskCount === 1 ? "change" : "changes"}`
          : "Ready to save",
    });
    const actions = bar.createDiv({ cls: "mdbase-actions" });
    if (this.editorMode === "design") {
      const review = actions.createEl("button", { text: "Review" });
      review.onclick = () => this.containerEl.querySelector<HTMLElement>("#mdbase-section-review")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const discard = actions.createEl("button", { text: "Discard" });
    discard.onclick = () => void this.discardCurrentType();
    const save = actions.createEl("button", { text: "Save changes" });
    save.addClass("mod-cta");
    save.disabled = errorCount > 0 || this.busy;
    save.onclick = () => void this.saveCurrentType();
  }

  private renderDesignEditor(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const diagnostics = validateTypeDraft(model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.schema?.contracts.values(),
    });
    this.renderSectionNavigation(container, diagnostics);
    const identity = container.createEl("section", { cls: "mdbase-editor-section" });
    identity.id = "mdbase-section-identity";
    identity.createEl("h3", { text: "Identity" });
    const name = inputRow(identity, "Name", model.name, (value) => {
      model.name = value;
      this.markDirty();
    }, { description: "Stable type name used by collection records." });
    name.disabled = readOnly;
    const description = inputRow(identity, "Description", model.description, (value) => {
      model.description = value;
      this.markDirty();
    }, { multiline: true });
    description.disabled = readOnly;
    const displayRow = identity.createDiv({ cls: "mdbase-form-row" });
    const displayLabel = displayRow.createEl("label", { text: "Display field" });
    const display = displayRow.createEl("select");
    displayLabel.htmlFor = display.id = "mdbase-display-field";
    display.createEl("option", { value: "", text: "Use the file name" });
    for (const field of model.fields) {
      display.createEl("option", { value: field.name, text: field.name || "Unnamed field" });
    }
    if (model.displayNameKey && !model.fields.some((field) => field.name === model.displayNameKey)) {
      display.createEl("option", { value: model.displayNameKey, text: `${model.displayNameKey} · missing` });
    }
    display.value = model.displayNameKey;
    display.onchange = () => {
      model.displayNameKey = display.value;
      this.markDirty();
    };
    display.disabled = readOnly;
    const strictRow = identity.createEl("label", { cls: "mdbase-checkbox-row" });
    const strict = strictRow.createEl("input", { type: "checkbox" });
    strict.checked = model.strictMode === true;
    strict.disabled = readOnly;
    strict.onchange = () => {
      model.strictMode = strict.checked;
      this.markDirty();
    };
    strictRow.createSpan({ text: "Reject undeclared fields" });

    const membership = container.createEl("section", { cls: "mdbase-editor-section" });
    membership.id = "mdbase-section-membership";
    membership.createEl("h3", { text: "Membership" });
    const glob = inputRow(membership, "Path glob", model.matchPathGlob, (value) => {
      model.matchPathGlob = value;
      this.markDirty();
    }, { placeholder: "Projects/**/*.md" });
    glob.disabled = readOnly;
    const present = inputRow(membership, "Fields present", model.matchFieldsPresent, (value) => {
      model.matchFieldsPresent = value;
      this.markDirty();
    }, { description: "Comma-separated frontmatter keys." });
    present.disabled = readOnly;
    const where = inputRow(membership, "Where", model.matchWhere, (value) => {
      model.matchWhere = value;
      this.markDirty();
    }, {
      multiline: true,
      description: "YAML predicate, including contains and nested equality conditions.",
      placeholder: "tags:\n  contains: task",
    });
    where.disabled = readOnly;

    const fields = container.createEl("section", { cls: "mdbase-editor-section" });
    fields.id = "mdbase-section-fields";
    const fieldsHeader = fields.createDiv({ cls: "mdbase-section-header" });
    fieldsHeader.createEl("h3", { text: "Fields" });
    const addField = fieldsHeader.createEl("button", { text: "Add field" });
    addField.disabled = readOnly;
    addField.onclick = () => {
      const definition: Record<string, unknown> = { type: "string" };
      model.fields.push({ name: "", definition });
      this.expandedFields.add(this.fieldId(definition));
      this.markDirty(true);
    };
    const fieldToolbar = fields.createDiv({ cls: "mdbase-field-toolbar" });
    const requiredCount = model.fields.filter((field) => field.definition.required === true).length;
    fieldToolbar.createDiv({
      cls: "mdbase-field-count",
      text: `${model.fields.length} ${model.fields.length === 1 ? "field" : "fields"} · ${requiredCount} required`,
    });
    const fieldActions = fieldToolbar.createDiv({ cls: "mdbase-field-toolbar-actions" });
    const fieldSearch = fieldActions.createEl("input", { type: "search" });
    fieldSearch.placeholder = "Filter fields";
    fieldSearch.setAttr("aria-label", "Filter fields");
    fieldSearch.setAttr("data-focus-key", "field-search");
    fieldSearch.value = this.fieldQuery;
    fieldSearch.oninput = () => {
      this.fieldQuery = fieldSearch.value;
      this.render();
    };
    const collapse = fieldActions.createEl("button", { text: "Collapse all" });
    collapse.disabled = this.expandedFields.size === 0;
    collapse.onclick = () => {
      this.expandedFields.clear();
      this.render();
    };
    const fieldList = fields.createDiv({ cls: "mdbase-fields" });
    const normalizedFieldQuery = this.fieldQuery.trim().toLowerCase();
    const visibleFields = model.fields.filter((field) =>
      !normalizedFieldQuery || this.fieldMatches(field.name, field.definition, normalizedFieldQuery));
    for (const field of visibleFields) {
      const index = model.fields.indexOf(field);
      this.renderFieldRow(fieldList, field, index, readOnly);
    }
    if (!visibleFields.length) {
      fieldList.createDiv({
        cls: "mdbase-empty-list",
        text: model.fields.length ? "No fields match this filter." : "No fields declared.",
      });
    }

    const placement = container.createEl("section", { cls: "mdbase-editor-section" });
    placement.id = "mdbase-section-placement";
    placement.createEl("h3", { text: "Placement" });
    const path = inputRow(placement, "Path pattern", model.pathPattern, (value) => {
      model.pathPattern = value;
      this.markDirty();
    }, { placeholder: "Notes/{title}.md" });
    path.disabled = readOnly;

    this.renderContractEditor(container, model, readOnly);

    const review = container.createEl("section", { cls: "mdbase-editor-section mdbase-change-review" });
    review.id = "mdbase-section-review";
    review.createEl("h3", { text: "Change review" });
    if (diagnostics.length) {
      const diagnosticSummary = review.createDiv({ cls: "mdbase-diagnostic-summary" });
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
      const warnings = diagnostics.length - errors;
      diagnosticSummary.createEl("strong", {
        text: `${errors} ${errors === 1 ? "error" : "errors"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
      });
      for (const diagnostic of diagnostics.slice(0, 12)) {
        const item = diagnosticSummary.createDiv({ cls: "mdbase-diagnostic-item" });
        item.setAttr("data-severity", diagnostic.severity);
        item.createEl("code", { text: diagnostic.path });
        item.createSpan({ text: diagnostic.message });
      }
    }
    if (!this.dirty) {
      review.createEl("p", { text: "No pending changes." });
    } else {
      const list = review.createEl("ul");
      for (const change of describeTypeChanges(this.originalModel, model)) {
        const item = list.createEl("li", { text: change.summary });
        item.setAttr("data-risk", change.risk);
      }
    }
  }

  private renderSectionNavigation(container: HTMLElement, diagnostics: readonly { severity: string }[]): void {
    const navigation = container.createDiv({ cls: "mdbase-section-nav" });
    navigation.setAttr("aria-label", "Type sections");
    navigation.setAttr("data-scroll-key", "section-nav");
    const items = [
      ["identity", "Overview"],
      ["membership", "Membership"],
      ["fields", "Fields"],
      ["applications", "Applications"],
      ["review", diagnostics.some((item) => item.severity === "error") ? "Review · errors" : "Review"],
    ] as const;
    for (const [id, label] of items) {
      const button = navigation.createEl("button", { text: label });
      button.onclick = () => {
        this.containerEl.querySelector<HTMLElement>(`#mdbase-section-${id}`)?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "start",
        });
      };
    }
  }

  private renderContractEditor(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-contracts-section" });
    section.id = "mdbase-section-applications";
    const header = section.createDiv({ cls: "mdbase-section-header" });
    const heading = header.createDiv();
    heading.createEl("h3", { text: "Works with applications" });
    heading.createDiv({
      cls: "mdbase-form-description",
      text: "Tell compatible applications what this type's fields mean.",
    });

    const contracts = [...(this.schema?.contracts.values() ?? [])];
    const implemented = new Set(model.implementations.map((implementation) => `${implementation.contract}@${implementation.version}`));
    const available = contracts.filter((contract) => !implemented.has(contractKey(contract)));

    if (!contracts.length) {
      section.createDiv({
        cls: "mdbase-contract-empty",
        text: "No record contracts are installed in this collection. Add contract files under the configured contracts folder to connect this type to an application.",
      });
    }

    for (const implementation of model.implementations) {
      const contract = contracts.find((candidate) =>
        candidate.id === implementation.contract && candidate.version === implementation.version);
      this.renderContractImplementation(section, model, implementation, contract, readOnly);
    }

    if (available.length) {
      const add = section.createDiv({ cls: "mdbase-contract-add" });
      const label = add.createEl("label", { text: "Installed contract" });
      const select = add.createEl("select");
      label.htmlFor = select.id = `mdbase-contract-${Math.random().toString(36).slice(2)}`;
      for (const contract of available) {
        select.createEl("option", { value: contractKey(contract), text: `${contract.id} · ${contract.version}` });
      }
      const button = add.createEl("button", { text: "Connect application contract" });
      button.disabled = readOnly;
      button.onclick = () => {
        const selected = available.find((candidate) => contractKey(candidate) === select.value);
        if (!selected) return;
        try {
          addImplementation(model, selected);
          this.markDirty(true);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      };
    }
  }

  private renderContractImplementation(
    container: HTMLElement,
    model: TypeEditorModel,
    implementation: TypeEditorModel["implementations"][number],
    contract: CollectionContractDescriptor | undefined,
    readOnly: boolean,
  ): void {
    const article = container.createEl("article", { cls: "mdbase-contract-implementation" });
    const header = article.createDiv({ cls: "mdbase-contract-header" });
    const identity = header.createDiv();
    identity.createEl("strong", { text: implementation.contract });
    identity.createSpan({ cls: "mdbase-contract-version", text: implementation.version });
    const remove = header.createEl("button", { text: "Remove" });
    remove.disabled = readOnly;
    remove.onclick = () => {
      removeImplementation(model, implementation.contract, implementation.version);
      this.markDirty(true);
    };

    if (!contract) {
      article.createDiv({
        cls: "mdbase-contract-unavailable",
        text: "This exact contract is not installed in the collection. Restore it or remove this implementation before saving.",
      });
      return;
    }

    const fields = contractFields(contract);
    const typeFields = typeFieldsForModel(model);
    const mapped = fields.filter((field) => mappingForContractField(implementation, field));
    const required = fields.filter((field) => field.required);
    const requiredMapped = required.filter((field) => mappingForContractField(implementation, field)).length;
    const details = article.createEl("details");
    details.open = requiredMapped < required.length;
    const summary = details.createEl("summary");
    summary.createSpan({ text: "Field mappings" });
    summary.createSpan({
      cls: "mdbase-contract-summary",
      text: `${requiredMapped}/${required.length} required · ${mapped.length}/${fields.length} total`,
    });
    const mappingList = details.createDiv({ cls: "mdbase-contract-mapping-list" });
    if (!fields.length) {
      mappingList.createDiv({
        cls: "mdbase-contract-unavailable",
        text: "This contract does not expose simple top-level properties. Configure its field references in YAML.",
      });
    }
    for (const field of fields) {
      const current = mappingForContractField(implementation, field);
      const mappedField = typeFields.find((candidate) => candidate.reference === current);
      const assessment = assessMapping(field, mappedField);
      const row = mappingList.createDiv({ cls: `mdbase-contract-mapping-row ${assessment.level}` });
      const definition = row.createDiv({ cls: "mdbase-contract-field-definition" });
      definition.createEl("code", { text: field.reference });
      definition.createSpan({
        cls: field.required ? "mdbase-contract-required" : "mdbase-contract-optional",
        text: field.required ? "Required" : "Optional",
      });
      definition.createEl("small", { text: field.description || schemaTypeLabel(field.schema) });
      const source = row.createEl("select");
      source.setAttr("aria-label", `${implementation.contract} ${field.reference} source field`);
      source.setAttr("aria-invalid", assessment.level === "error" ? "true" : "false");
      source.disabled = readOnly;
      source.createEl("option", { value: "", text: field.required ? "Choose a source field" : "Not exposed" });
      for (const candidate of typeFields) {
        const optionAssessment = assessMapping(field, candidate);
        const option = source.createEl("option", {
          value: candidate.reference,
          text: `${candidate.reference} · ${candidate.type}${optionAssessment.level === "warning" ? " · review" : ""}`,
        });
        option.disabled = optionAssessment.level === "error";
      }
      source.value = current;
      source.onchange = () => {
        setFieldMapping(implementation, field.reference, source.value || undefined);
        this.markDirty(true);
      };
      const status = row.createDiv({ cls: "mdbase-contract-mapping-status" });
      status.createEl("strong", { text: assessment.label });
      status.createEl("small", { text: assessment.message });
    }

    if (contract.binding_schema) {
      const settings = article.createEl("details", { cls: "mdbase-contract-settings" });
      settings.open = Boolean(implementation.binding);
      const settingsSummary = settings.createEl("summary");
      settingsSummary.createSpan({ text: "Contract settings" });
      settingsSummary.createSpan({
        cls: "mdbase-contract-summary",
        text: implementation.binding ? "Configured" : "Optional",
      });
      const body = settings.createDiv({ cls: "mdbase-contract-settings-body" });
      body.createEl("p", {
        cls: "mdbase-form-description",
        text: "Control how compatible applications interpret this type. Values follow the contract's schema.",
      });
      if (!implementation.binding) {
        const configure = body.createEl("button", { text: "Configure settings" });
        configure.disabled = readOnly;
        configure.onclick = () => {
          const initial = schemaInitialValue(contract.binding_schema);
          if (!isRecord(initial)) return;
          setBinding(implementation, initial);
          this.markDirty(true);
        };
      } else {
        this.renderContractSchemaValue(body, contract.binding_schema, implementation.binding, (value) => {
          if (!isRecord(value)) return;
          setBinding(implementation, value);
          this.markDirty();
        }, "Settings", readOnly);
      }
    }
  }

  private renderContractSchemaValue(
    container: HTMLElement,
    schema: JsonObject,
    value: unknown,
    onChange: (value: unknown) => void,
    label: string,
    readOnly: boolean,
  ): void {
    const type = schemaType(schema);
    if (type === "object") {
      const object = isRecord(value) ? value : {};
      const fieldset = container.createEl("fieldset", { cls: "mdbase-contract-schema-object" });
      fieldset.createEl("legend", { text: label });
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
      const names = [...new Set([...required, ...Object.keys(object).filter((name) => name in properties)])];
      for (const name of names) {
        const childSchema = properties[name];
        if (!isRecord(childSchema)) continue;
        const row = fieldset.createDiv({ cls: "mdbase-contract-schema-field" });
        const description = typeof childSchema.description === "string" ? childSchema.description : undefined;
        row.createEl("label", { text: `${name}${required.has(name) ? " · required" : ""}` });
        if (description) row.createEl("small", { text: description });
        this.renderContractSchemaControl(row, childSchema, object[name], (next) => {
          onChange({ ...object, [name]: next });
        }, name, readOnly);
      }
      if (!names.length) fieldset.createDiv({ cls: "mdbase-empty-list", text: "No settings declared." });
      const optional = Object.keys(properties).filter((name) => !names.includes(name));
      if (optional.length) {
        const add = fieldset.createDiv({ cls: "mdbase-contract-schema-add" });
        const select = add.createEl("select");
        for (const name of optional) select.createEl("option", { value: name, text: name });
        const button = add.createEl("button", { text: "Add optional setting" });
        button.disabled = readOnly;
        button.onclick = () => {
          const name = select.value;
          const childSchema = properties[name];
          if (!isRecord(childSchema)) return;
          onChange({ ...object, [name]: schemaInitialValue(childSchema) });
        };
      }
      return;
    }
    this.renderContractSchemaControl(container, schema, value, onChange, label, readOnly);
  }

  private renderContractSchemaControl(
    container: HTMLElement,
    schema: JsonObject,
    value: unknown,
    onChange: (value: unknown) => void,
    label: string,
    readOnly: boolean,
  ): void {
    const type = schemaType(schema);
    if (Array.isArray(schema.enum)) {
      const select = container.createEl("select");
      select.setAttr("aria-label", label);
      for (const choice of schema.enum) select.createEl("option", { value: JSON.stringify(choice), text: String(choice) });
      select.value = JSON.stringify(value);
      select.disabled = readOnly;
      select.onchange = () => onChange(JSON.parse(select.value));
      return;
    }
    if (type === "array") {
      const itemsSchema = isRecord(schema.items) ? schema.items : { type: "string" };
      const list = Array.isArray(value) ? value : [];
      const listEl = container.createDiv({ cls: "mdbase-contract-schema-array" });
      for (const [index, item] of list.entries()) {
        const itemEl = listEl.createDiv({ cls: "mdbase-contract-schema-array-item" });
        itemEl.createSpan({ text: `${index + 1}.` });
        this.renderContractSchemaControl(itemEl, itemsSchema, item, (next) => {
          onChange(list.map((current, currentIndex) => currentIndex === index ? next : current));
        }, `${label} item ${index + 1}`, readOnly);
        const remove = itemEl.createEl("button", { text: "Remove" });
        remove.disabled = readOnly || list.length <= (typeof schema.minItems === "number" ? schema.minItems : 0);
        remove.onclick = () => onChange(list.filter((_, currentIndex) => currentIndex !== index));
      }
      const add = container.createEl("button", { text: `Add ${label.toLowerCase()} item` });
      add.disabled = readOnly || (typeof schema.maxItems === "number" && list.length >= schema.maxItems);
      add.onclick = () => onChange([...list, schemaInitialValue(itemsSchema)]);
      return;
    }
    if (type === "object") {
      this.renderContractSchemaValue(container, schema, value, onChange, label, readOnly);
      return;
    }
    if (type === "boolean") {
      const checkbox = container.createEl("input", { type: "checkbox" });
      checkbox.checked = value === true;
      checkbox.disabled = readOnly;
      checkbox.setAttr("aria-label", label);
      checkbox.onchange = () => onChange(checkbox.checked);
      return;
    }
    const input = container.createEl("input", { type: type === "number" || type === "integer" ? "number" : "text" });
    input.setAttr("aria-label", label);
    input.value = value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    input.disabled = readOnly;
    input.oninput = () => onChange(type === "number" || type === "integer" ? Number(input.value) : input.value);
  }

  private renderFieldRow(container: HTMLElement, field: TypeEditorField, index: number, readOnly: boolean): void {
    this.renderFieldDefinition(container, field.definition, {
      name: field.name,
      nameLabel: `Field ${index + 1} name`,
      onNameInput: (value) => {
        field.name = value;
        this.markDirty();
      },
      required: field.definition.required === true,
      onRequiredChange: (value) => {
        field.definition.required = value;
        this.markDirty();
      },
      onRemove: () => {
        this.model?.fields.splice(index, 1);
        this.markDirty(true);
      },
      readOnly,
      depth: 0,
    });
  }

  private renderFieldDefinition(
    container: HTMLElement,
    definition: Record<string, unknown>,
    options: {
      name?: string;
      nameLabel: string;
      staticLabel?: string;
      onNameInput?: (value: string) => void;
      onNameCommit?: (value: string, input: HTMLInputElement) => void;
      required?: boolean;
      onRequiredChange?: (value: boolean) => void;
      onRemove?: () => void;
      readOnly: boolean;
      depth: number;
    },
  ): void {
    const node = container.createEl("details", { cls: "mdbase-field-node" });
    node.setAttr("data-depth", String(options.depth));
    const fieldId = this.fieldId(definition);
    const queryMatch = Boolean(this.fieldQuery.trim())
      && this.fieldMatches(
        options.name ?? options.staticLabel ?? "",
        definition,
        this.fieldQuery.trim().toLowerCase(),
      );
    node.open = this.expandedFields.has(fieldId) || queryMatch;
    node.ontoggle = () => {
      if (node.open) this.expandedFields.add(fieldId);
      else this.expandedFields.delete(fieldId);
    };
    const summary = node.createEl("summary", { cls: "mdbase-field-summary" });
    summary.createSpan({
      cls: "mdbase-field-summary-name",
      text: options.name || options.staticLabel || "Unnamed field",
    });
    summary.createSpan({ cls: "mdbase-field-summary-type", text: definitionType(definition) });
    summary.createSpan({
      cls: "mdbase-field-summary-rule",
      text: options.required ? "Required" : options.staticLabel ? "Item shape" : "Optional",
    });
    const row = node.createDiv({ cls: "mdbase-field-row" });

    if (options.staticLabel) {
      row.createDiv({ cls: "mdbase-field-role", text: options.staticLabel });
    } else {
      const name = row.createEl("input", { type: "text", cls: "mdbase-field-name-control" });
      name.setAttr("data-focus-key", `field-${fieldId}-name`);
      name.setAttr("aria-label", options.nameLabel);
      name.placeholder = "fieldName";
      name.value = options.name ?? "";
      name.disabled = options.readOnly;
      if (options.onNameInput) name.oninput = () => options.onNameInput?.(name.value);
      if (options.onNameCommit) name.onchange = () => options.onNameCommit?.(name.value, name);
    }

    const type = row.createEl("select", { cls: "mdbase-field-type-control" });
    type.setAttr("data-focus-key", `field-${fieldId}-type`);
    type.setAttr("aria-label", `${options.name || options.staticLabel || "Field"} type`);
    for (const value of FIELD_TYPES) {
      const label = value === "any" ? "Any value" : value[0].toUpperCase() + value.slice(1);
      type.createEl("option", { value, text: label });
    }
    type.value = definitionType(definition);
    type.disabled = options.readOnly;
    type.onchange = () => {
      definition.type = type.value;
      if (type.value === "list" && !isRecord(definition.items)) {
        definition.items = { type: "string" };
      }
      if (type.value === "object" && !isRecord(definition.fields)) {
        definition.fields = {};
      }
      if (type.value === "enum" && !Array.isArray(definition.values)) {
        definition.values = [];
      }
      this.markDirty(true);
    };

    const description = row.createEl("input", { type: "text", cls: "mdbase-field-description-control" });
    description.setAttr("data-focus-key", `field-${fieldId}-description`);
    description.setAttr("aria-label", `${options.name || options.staticLabel || "Field"} description`);
    description.placeholder = "Description";
    description.value = typeof definition.description === "string" ? definition.description : "";
    description.disabled = options.readOnly;
    description.oninput = () => {
      if (description.value) definition.description = description.value;
      else delete definition.description;
      this.markDirty();
    };

    if (options.onRequiredChange) {
      const required = row.createEl("label", { cls: "mdbase-field-required" });
      const checkbox = required.createEl("input", { type: "checkbox" });
      checkbox.setAttr("data-focus-key", `field-${fieldId}-required`);
      checkbox.checked = options.required === true;
      checkbox.disabled = options.readOnly;
      checkbox.onchange = () => options.onRequiredChange?.(checkbox.checked);
      required.createSpan({ text: "Required" });
    }

    if (options.onRemove) {
      const remove = row.createEl("button", { cls: "mdbase-field-remove" });
      remove.setAttr("aria-label", `Remove ${options.name || options.staticLabel || "field"}`);
      setIcon(remove, "trash-2");
      remove.disabled = options.readOnly;
      remove.onclick = options.onRemove;
    }

    const typeName = definitionType(definition);
    if (typeName === "enum") this.renderEnumFieldDetails(node, definition, options);
    if (typeName === "link") this.renderLinkFieldDetails(node, definition, options);
    if (typeName === "list") this.renderListFieldDetails(node, definition, options);
    if (typeName === "object") this.renderObjectFieldDetails(node, definition, options);
  }

  private fieldId(definition: Record<string, unknown>): string {
    const existing = this.fieldIds.get(definition);
    if (existing) return existing;
    const id = `field-${this.nextFieldId}`;
    this.nextFieldId += 1;
    this.fieldIds.set(definition, id);
    return id;
  }

  private fieldMatches(name: string, definition: Record<string, unknown>, query: string): boolean {
    const own = `${name} ${definitionType(definition)} ${typeof definition.description === "string" ? definition.description : ""}`
      .toLowerCase();
    if (own.includes(query)) return true;
    if (isRecord(definition.items) && this.fieldMatches("item", definition.items, query)) return true;
    if (isRecord(definition.fields)) {
      return Object.entries(definition.fields).some(([childName, child]) =>
        isRecord(child) && this.fieldMatches(childName, child, query));
    }
    return false;
  }

  private renderEnumFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-options" });
    const label = details.createEl("label", { text: "Allowed values" });
    const values = details.createEl("input", { type: "text" });
    values.setAttr("aria-label", `${options.name || options.staticLabel || "Enum"} allowed values`);
    values.placeholder = "draft, published, archived";
    values.value = Array.isArray(definition.values) ? definition.values.map(String).join(", ") : "";
    values.disabled = options.readOnly;
    values.oninput = () => {
      definition.values = values.value.split(",").map((value) => value.trim()).filter(Boolean);
      this.markDirty();
    };
    label.htmlFor = values.id = `mdbase-${Math.random().toString(36).slice(2)}`;
  }

  private renderLinkFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-options" });
    const targetLabel = details.createEl("label", { text: "Target type" });
    const target = details.createEl("select");
    target.setAttr("aria-label", `${options.name || options.staticLabel || "Link"} target type`);
    target.createEl("option", { value: "", text: "Any type" });
    const currentTarget = typeof definition.target === "string" ? definition.target : "";
    for (const type of this.typeEntries()) target.createEl("option", { value: type.name, text: type.name });
    if (currentTarget && !this.typeEntries().some((type) => type.name === currentTarget)) {
      target.createEl("option", { value: currentTarget, text: `${currentTarget} · missing` });
    }
    target.value = currentTarget;
    target.disabled = options.readOnly;
    target.onchange = () => {
      if (target.value) definition.target = target.value;
      else delete definition.target;
      this.markDirty();
    };
    targetLabel.htmlFor = target.id = `mdbase-${Math.random().toString(36).slice(2)}`;
    const existsLabel = details.createEl("label", { cls: "mdbase-field-required" });
    const exists = existsLabel.createEl("input", { type: "checkbox" });
    exists.checked = definition.validate_exists === true;
    exists.disabled = options.readOnly;
    exists.onchange = () => {
      definition.validate_exists = exists.checked;
      this.markDirty();
    };
    existsLabel.createSpan({ text: "Validate target exists" });
  }

  private renderListFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { readOnly: boolean; depth: number },
  ): void {
    const children = node.createDiv({ cls: "mdbase-field-children" });
    children.createDiv({ cls: "mdbase-field-children-label", text: "List items" });
    const items = isRecord(definition.items) ? definition.items : { type: "any" };
    if (!isRecord(definition.items) && !options.readOnly) definition.items = items;
    this.renderFieldDefinition(children, items, {
      staticLabel: "Item",
      nameLabel: "List item",
      readOnly: options.readOnly,
      depth: options.depth + 1,
    });
  }

  private renderObjectFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { readOnly: boolean; depth: number },
  ): void {
    const children = node.createDiv({ cls: "mdbase-field-children" });
    const header = children.createDiv({ cls: "mdbase-field-children-header" });
    header.createDiv({ cls: "mdbase-field-children-label", text: "Object fields" });
    const add = header.createEl("button", { text: "Add nested field" });
    add.disabled = options.readOnly;
    const fields = isRecord(definition.fields) ? definition.fields : {};
    if (!isRecord(definition.fields) && !options.readOnly) definition.fields = fields;
    add.onclick = () => {
      const name = nextNestedFieldName(fields);
      setOwnField(fields, name, { type: "string" });
      this.markDirty(true);
    };
    const list = children.createDiv({ cls: "mdbase-nested-fields" });
    const entries = Object.entries(fields).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: "No nested fields." });
      return;
    }
    for (const [initialName, childDefinition] of entries) {
      let currentName = initialName;
      this.renderFieldDefinition(list, childDefinition, {
        name: currentName,
        nameLabel: `${currentName} nested field name`,
        onNameCommit: (value, input) => {
          const nextName = value.trim();
          if (!nextName) {
            new Notice("Nested field name is required.");
            input.value = currentName;
            return;
          }
          if (
            nextName !== currentName
            && Object.prototype.hasOwnProperty.call(fields, nextName)
          ) {
            new Notice(`Nested field already exists: ${nextName}`);
            input.value = currentName;
            return;
          }
          if (nextName === currentName) return;
          delete fields[currentName];
          setOwnField(fields, nextName, childDefinition);
          currentName = nextName;
          this.markDirty();
        },
        required: childDefinition.required === true,
        onRequiredChange: (value) => {
          childDefinition.required = value;
          this.markDirty();
        },
        onRemove: () => {
          delete fields[currentName];
          this.markDirty(true);
        },
        readOnly: options.readOnly,
        depth: options.depth + 1,
      });
    }
  }

  private renderYamlEditor(container: HTMLElement, readOnly: boolean): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-yaml-section" });
    section.createEl("h3", { text: "Canonical type document" });
    section.createEl("p", {
      cls: "mdbase-form-description",
      text: "Unknown v0.3 extensions are preserved. Invalid YAML is never normalized or saved.",
    });
    const textarea = section.createEl("textarea", { cls: "mdbase-yaml-editor" });
    textarea.setAttr("aria-label", "Type definition YAML");
    textarea.setAttr("data-focus-key", "yaml-editor");
    textarea.value = this.yamlDraft;
    textarea.disabled = readOnly;
    textarea.spellcheck = false;
    textarea.oninput = () => {
      this.yamlDraft = textarea.value;
      this.markDirty(false);
    };
  }

  private renderSync(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-sync-document" });
    const header = document.createDiv({ cls: "mdbase-document-header" });
    header.createEl("h2", { text: "Sync" });
    header.createEl("p", { text: "A clear handoff between this vault and its hosted collection authority." });
    const profile = this.host.getMirrorProfile();
    if (!profile) {
      this.renderEnrollment(document);
      return;
    }
    this.syncProblem = this.host.getCurrentSyncProblem() ?? this.syncProblem;

    const status = document.createEl("section", { cls: "mdbase-sync-hero" });
    status.setAttr("data-state", this.mirrorStatus?.state ?? "checking");
    const route = status.createDiv({ cls: "mdbase-sync-route" });
    const local = route.createDiv({ cls: "mdbase-sync-endpoint" });
    setIcon(local.createSpan({ cls: "mdbase-sync-endpoint-icon" }), "vault");
    const localText = local.createDiv();
    localText.createEl("strong", { text: this.app.vault.getName() });
    const filePolicy = profile.selectiveSync ?? { file_classes: [], excluded_folders: [] };
    const fileSummary = filePolicy.file_classes.length
      ? `Markdown + ${filePolicy.file_classes.join(", ")}`
      : "Markdown only";
    localText.createSpan({ text: `${profile.mode === "read_write" ? "Upload and download" : "Downloads only"} · ${fileSummary}` });
    const connection = route.createDiv({ cls: "mdbase-sync-connection" });
    setIcon(connection.createSpan(), profile.mode === "read_write" ? "arrow-left-right" : "arrow-left");
    connection.createSpan({ text: syncStateLabel(this.mirrorStatus) });
    const hosted = route.createDiv({ cls: "mdbase-sync-endpoint" });
    setIcon(hosted.createSpan({ cls: "mdbase-sync-endpoint-icon" }), "cloud");
    const hostedText = hosted.createDiv();
    hostedText.createEl("strong", { text: profile.name });
    hostedText.createSpan({ text: "Hosted authority" });

    const meta = status.createDiv({ cls: "mdbase-sync-meta" });
    const pendingFiles = this.mirrorStatus?.pending_files ?? 0;
    meta.createSpan({
      text: `${profile.mode === "read_write" ? "Read–write mirror" : "Read-only mirror"} · ${relativeTime(this.mirrorStatus?.last_synced_at)}${pendingFiles ? ` · ${pendingFiles} queued ${pendingFiles === 1 ? "file" : "files"}` : ""}`,
    });
    const identity = meta.createEl("code", { text: profile.collectionId });
    identity.setAttr("title", "Collection ID");

    if (this.fileProgress || this.mirrorProgress) {
      const progressArea = status.createDiv({ cls: "mdbase-sync-progress", attr: { "aria-live": "polite" } });
      const total = this.fileProgress?.totalBytes ?? this.mirrorProgress?.total ?? null;
      const completed = this.fileProgress?.transferredBytes ?? this.mirrorProgress?.completed ?? 0;
      const progress = progressArea.createEl("progress");
      progress.max = total ?? 1;
      progress.value = total == null ? 0 : completed;
      if (total == null) progress.removeAttribute("value");
      progressArea.createDiv({
        cls: "mdbase-progress-label",
        text: this.fileProgress
          ? `${this.fileProgress.direction === "upload" ? "Uploading" : "Downloading"} ${this.fileProgress.path} · ${formatBytes(completed)} of ${formatBytes(total ?? 0)}`
          : `${this.mirrorProgress?.phase === "uploading"
            ? "Uploading local changes"
            : this.mirrorProgress?.phase === "downloading"
              ? "Downloading collection files"
              : "Applying changes"} · ${completed}${total == null ? "" : ` of ${total}`}`,
      });
      const cancel = progressArea.createEl("button", { text: "Stop safely" });
      cancel.onclick = () => {
        this.host.connectSync.cancelSync();
        this.transientMessage = "Stopping after the current network request…";
        this.render();
      };
    }

    if (this.syncProblem || this.mirrorStatus?.recovery_required) {
      this.renderRecoveryCard(status, this.syncProblem ?? {
        code: "mirror_recovery_required",
        title: "Synchronization needs recovery",
        message: "Your original files are safe. Resume from the durable checkpoint before disconnecting this vault.",
        action: "resume",
        actionLabel: "Resume recovery",
      });
    }

    const actions = status.createDiv({ cls: "mdbase-sync-actions" });
    const preview = actions.createEl("button", { text: this.mirrorPreview ? "Refresh review" : "Review changes" });
    preview.disabled = this.busy;
    preview.onclick = () => void this.reviewSyncChanges();
    const syncPresentation = syncReviewPresentation(
      this.mirrorPreview?.plan ?? null,
      this.mirrorPreview?.entries.length ?? 0,
      this.busy,
    );
    const sync = actions.createEl("button", { text: syncPresentation.actionLabel });
    sync.addClass("mod-cta");
    sync.disabled = syncPresentation.actionDisabled;
    sync.onclick = () => void this.perform(() => this.applyReviewedSync());

    this.renderFilePolicyControls(document, { connected: true });

    if (this.mirrorPreview) this.renderMirrorPreview(document, this.mirrorPreview);
    if (this.mirrorStatus?.conflicts.length) this.renderConflicts(document, this.mirrorStatus);
    if (this.mirrorStatus?.local_issues.length) {
      this.renderLocalMirrorIssues(document, this.mirrorStatus);
    }
    this.renderActivity(document);
    this.renderConnectionDetails(document, profile);
    window.setTimeout(() => this.focusPendingSyncSection(), 0);
  }

  private async loadMirrorPreview(): Promise<void> {
    this.mirrorPreview = await this.host.connectSync.preview();
    this.mirrorStatus = await this.host.connectSync.status();
    this.syncProblem = null;
    this.host.setSyncStatus(this.mirrorStatus);
    this.transientMessage = syncReviewPresentation(
      this.mirrorPreview.plan,
      this.mirrorPreview.entries.length,
    ).message;
  }

  private async applyReviewedSync(): Promise<void> {
    if (!this.mirrorPreview) {
      await this.loadMirrorPreview();
      return;
    }
    const reviewed = this.mirrorPreview;
    try {
      const outcome = await this.host.connectSync.sync(
        reviewed,
        (progress) => {
          this.mirrorProgress = progress;
          this.host.setSyncProgress(progress, this.fileProgress);
          this.render();
        },
        (progress) => {
          this.fileProgress = progress;
          this.host.setSyncProgress(this.mirrorProgress, progress);
          this.render();
        },
      );
      this.mirrorStatus = await this.host.connectSync.status();
      this.mirrorPreview = await this.host.connectSync.preview();
      this.syncProblem = outcome.status === "cancelled"
        ? syncProblem(new DOMException("Synchronization stopped.", "AbortError"))
        : outcome.status === "stale"
          ? syncProblem(Object.assign(new Error("The reviewed plan changed."), { code: "mirror_plan_stale" }))
          : null;
      if (this.syncProblem) this.host.setSyncProblem(this.syncProblem);
      else this.host.setSyncStatus(this.mirrorStatus, { clearLocalChanges: outcome.status === "applied" && outcome.pending === 0 });
      this.transientMessage = outcome.status === "applied"
        ? "Sync completed and the local checkpoint was verified."
        : outcome.status === "attention"
          ? "Completed changes are checkpointed. Review the items that still need attention."
          : outcome.status === "cancelled"
            ? `Sync paused safely after ${outcome.applied} actions; ${outcome.pending} remain.`
            : outcome.status === "stale"
              ? "The collection changed again. Review the newest plan; no stale decision was applied."
              : `Sync stopped at a durable boundary: ${outcome.failure?.message ?? outcome.status}.`;
      await this.host.recordSyncActivity({
        summary: outcome.status === "applied"
          ? `Synchronized ${outcome.applied} ${outcome.applied === 1 ? "change" : "changes"}`
          : outcome.status === "cancelled"
            ? "Synchronization paused safely"
            : "Synchronization needs attention",
        detail: this.transientMessage,
        tone: outcome.status === "applied" ? "success" : "attention",
        requiresAcknowledgement: outcome.status !== "applied",
      });
    } catch (error) {
      const problem = syncProblem(error);
      this.syncProblem = problem;
      this.host.setSyncProblem(problem);
      this.transientMessage = problem.message;
      await this.host.recordSyncActivity({
        summary: problem.title,
        detail: problem.message,
        tone: problem.action === "resume" ? "attention" : "error",
        requiresAcknowledgement: true,
      });
      if (!isAbortError(error)) throw error;
    } finally {
      this.mirrorProgress = null;
      this.fileProgress = null;
      this.host.setSyncProgress(null, null);
    }
  }

  private renderRecoveryCard(container: HTMLElement, problem: SyncProblem): void {
    const card = container.createDiv({ cls: "mdbase-recovery-card" });
    const text = card.createDiv();
    text.createEl("strong", { text: problem.title });
    text.createDiv({ text: problem.message });
    const action = card.createEl("button", { text: problem.actionLabel });
    action.disabled = this.busy;
    action.onclick = () => {
      if (problem.action === "retry") void this.reconnectCollection();
      else if (problem.action === "reauthorize") void this.perform(() => this.reauthorizeCollection());
      else void this.reviewSyncChanges();
    };
  }

  private async reauthorizeCollection(): Promise<void> {
    this.enrollmentAbort?.abort();
    const abort = new AbortController();
    this.enrollmentAbort = abort;
    try {
      this.mirrorStatus = await this.host.connectSync.reauthorize({
        signal: abort.signal,
        onVerification: (verification) => {
          this.enrollmentVerification = verification.verificationUri;
          this.transientMessage = "Approve this vault again in Connect. Its local files and checkpoint remain unchanged.";
          window.open(verification.verificationUri, "_blank", "noopener,noreferrer");
          this.render();
        },
        onStatus: (status) => {
          this.transientMessage = status.state === "waiting_for_approval"
            ? "Waiting for approval in Connect…"
            : `Connect is retrying approval (attempt ${status.attempt}).`;
          this.render();
        },
      });
      this.enrollmentVerification = "";
      this.syncProblem = null;
      this.host.setSyncStatus(this.mirrorStatus);
      this.transientMessage = "Approval restored. The existing mirror checkpoint was preserved.";
      await this.host.recordSyncActivity({
        summary: "Connect approval restored",
        detail: "The existing mirror checkpoint and local files were preserved.",
        tone: "success",
        requiresAcknowledgement: false,
      });
    } finally {
      if (this.enrollmentAbort === abort) this.enrollmentAbort = null;
    }
  }

  private renderActivity(container: HTMLElement): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-activity" });
    section.id = "mdbase-sync-activity";
    const header = section.createDiv({ cls: "mdbase-section-header" });
    header.createEl("h3", { text: "Recent activity" });
    const entries = this.host.getSyncActivity();
    if (entries.some((entry) => !entry.requiresAcknowledgement)) {
      const clear = header.createEl("button", { text: "Clear completed" });
      clear.disabled = this.busy;
      clear.onclick = () => void this.host.clearCompletedSyncActivity().then(() => this.render());
    }
    if (this.fileProgress) {
      const current = section.createDiv({ cls: "mdbase-activity-row is-current" });
      setIcon(current.createSpan(), this.fileProgress.direction === "upload" ? "upload" : "download");
      const body = current.createDiv();
      body.createEl("strong", { text: `${this.fileProgress.direction === "upload" ? "Uploading" : "Downloading"} ${this.fileProgress.path}` });
      body.createDiv({ text: `${formatBytes(this.fileProgress.transferredBytes)} of ${formatBytes(this.fileProgress.totalBytes)}` });
    }
    const visible = [...entries].reverse().filter((entry, index) => entry.requiresAcknowledgement || index < 8);
    if (!visible.length && !this.fileProgress) {
      section.createDiv({ cls: "mdbase-muted", text: "No recent synchronization activity." });
      return;
    }
    for (const entry of visible) {
      const row = section.createDiv({ cls: "mdbase-activity-row" });
      row.setAttr("data-tone", entry.tone);
      setIcon(row.createSpan(), entry.tone === "success" ? "check" : entry.tone === "info" ? "info" : "circle-alert");
      const body = row.createDiv();
      body.createEl("strong", { text: entry.summary });
      if (entry.detail) body.createDiv({ text: entry.detail });
      body.createSpan({ cls: "mdbase-muted", text: relativeTime(entry.occurredAt) });
      if (entry.requiresAcknowledgement) {
        const dismiss = row.createEl("button", { text: "Dismiss" });
        dismiss.disabled = this.busy;
        dismiss.onclick = () => void this.host.dismissSyncActivity(entry.id).then(() => this.render());
      }
    }
  }

  private renderConnectionDetails(container: HTMLElement, profile: MirrorProfile): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-connection-details" });
    section.createEl("h3", { text: "Collection connection" });
    const values = section.createDiv({ cls: "mdbase-status-list" });
    renderStatus(values, "Collection", profile.name);
    renderStatus(values, "Collection ID", profile.collectionId);
    renderStatus(values, "Vault", this.app.vault.getName());
    renderStatus(values, "Access", profile.mode === "read_write" ? "Read and write" : "Read only");
    renderStatus(values, "Account", "Approved through Connect");
    renderStatus(values, "Connect", new URL(profile.controlUrl).host);
    renderStatus(values, "Last successful sync", relativeTime(this.mirrorStatus?.last_synced_at));
    section.createEl("p", {
      text: "This plugin is the only sync owner for this vault. Connect owns authorization and the mirror engine owns checkpoints and conflict decisions.",
    });
    const actions = section.createDiv({ cls: "mdbase-actions" });
    const reconnect = actions.createEl("button", { text: "Reconnect" });
    reconnect.disabled = this.busy;
    reconnect.onclick = () => void this.reconnectCollection();
    const disconnect = actions.createEl("button", { text: "Disconnect…" });
    disconnect.disabled = this.busy || this.host.connectSync.isSyncing();
    disconnect.onclick = () => void this.disconnectCollection(profile);
  }

  private async disconnectCollection(profile: MirrorProfile): Promise<void> {
    const choice = await new DisconnectMirrorModal(this.app).choose(profile.name);
    if (!choice) return;
    await this.perform(async () => {
      const result: DisconnectMirrorResult = await this.host.connectSync.disconnect(choice === "remove");
      this.mirrorStatus = null;
      this.mirrorPreview = null;
      this.syncProblem = null;
      this.host.setSyncStatus(null, { clearLocalChanges: true });
      const detail = choice === "remove"
        ? `${result.removed.length} unchanged synced ${result.removed.length === 1 ? "file was" : "files were"} removed. ${result.preserved.length} locally changed ${result.preserved.length === 1 ? "file was" : "files were"} preserved.`
        : "All local files were retained as an unsynced copy.";
      this.transientMessage = `Disconnected from ${profile.name}. ${detail}`;
      await this.host.recordSyncActivity({
        summary: `Disconnected from ${profile.name}`,
        detail,
        tone: result.preserved.length ? "attention" : "info",
        requiresAcknowledgement: result.preserved.length > 0,
      });
      await this.refresh(true);
    });
  }

  private focusPendingSyncSection(): void {
    if (!this.pendingSyncFocus) return;
    const id = this.pendingSyncFocus === "activity" ? "mdbase-sync-activity" : "mdbase-sync-conflicts";
    const target = this.containerEl.querySelector<HTMLElement>(`#${id}`);
    if (!target) return;
    this.pendingSyncFocus = null;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  private filePolicy(): SelectiveSyncPolicy {
    this.filePolicyDraft ??= JSON.parse(JSON.stringify(this.host.connectSync.getSelectiveSync())) as SelectiveSyncPolicy;
    return this.filePolicyDraft;
  }

  private renderFilePolicyControls(
    container: HTMLElement,
    options: { connected: boolean },
  ): void {
    const policy = this.filePolicy();
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-file-policy" });
    section.createEl("h3", { text: options.connected ? "Files on this device" : "Collection files" });
    section.createEl("p", {
      text: "Markdown always syncs. Choose which binary file classes this device should materialize; hidden and reserved paths remain excluded.",
    });
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
        this.render();
      };
      choice.createSpan({ text: label });
    }
    let apply: HTMLButtonElement | null = null;
    inputRow(section, "Excluded folders", policy.excluded_folders.join(", "), (value) => {
      policy.excluded_folders = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      if (apply) {
        const changed = JSON.stringify(this.host.connectSync.getSelectiveSync()) !== JSON.stringify(policy);
        apply.textContent = changed ? "Apply file policy" : "File policy applied";
        apply.disabled = !changed || this.busy;
      }
    }, {
      description: "Comma-separated collection-relative folders. Exclusions apply to Markdown and binary files on this device.",
      placeholder: "Archive, Private exports",
    });
    if (!policy.file_classes.length) {
      section.createDiv({ cls: "mdbase-inline-message", text: "Binary sync is off. This mirror remains Markdown-only." });
    } else if (policy.file_classes.includes("other")) {
      section.createDiv({
        cls: "mdbase-inline-message",
        text: "Other files includes every eligible visible non-Markdown format. Review the transfer ledger carefully before syncing.",
      });
    }
    if (!options.connected) return;
    const current = this.host.connectSync.getSelectiveSync();
    const changed = JSON.stringify(current) !== JSON.stringify(policy);
    const actions = section.createDiv({ cls: "mdbase-actions" });
    apply = actions.createEl("button", { text: changed ? "Apply file policy" : "File policy applied" });
    apply.disabled = !changed || this.busy;
    apply.onclick = () => void this.perform(async () => {
      await this.host.connectSync.configureSelectiveSync(policy);
      this.filePolicyDraft = null;
      this.mirrorPreview = null;
      this.transientMessage = "File policy updated. Review the rebuild before files move.";
      this.render();
    });
  }

  private renderEnrollment(container: HTMLElement): void {
    if (this.schema || this.host.connectSync.getAdoptionMarker()) {
      this.renderLocalAdoption(container);
      return;
    }
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-enrollment" });
    section.createEl("h3", { text: "Connect an empty vault" });
    section.createEl("p", {
      text: "Choose access, approve it in Connect, then review the first transfer before any files move.",
    });
    this.renderEnrollmentSteps(section, this.enrollmentVerification ? 2 : this.enrollmentAbort ? 2 : 1, [
      "Choose connection",
      "Approve in Connect",
      "Review first sync",
    ]);
    if (this.enrollmentVerification) {
      const approval = section.createDiv({ cls: "mdbase-approval-link" });
      approval.createSpan({ text: "Waiting for approval · " });
      const link = approval.createEl("a", {
        text: "Open approval page again",
        href: this.enrollmentVerification,
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener noreferrer");
    }
    inputRow(section, "Connect URL", this.enrollmentControlUrl, (value) => {
      this.enrollmentControlUrl = value;
    }, { placeholder: DEFAULT_CONNECT_CONTROL_URL });
    inputRow(section, "Mirror name", this.enrollmentMirrorName, (value) => {
      this.enrollmentMirrorName = value;
    });
    inputRow(section, "Collection ID", this.enrollmentCollectionId, (value) => {
      this.enrollmentCollectionId = value;
    }, { description: "Optional. Leave blank to choose during approval." });
    const access = section.createDiv({ cls: "mdbase-form-row" });
    access.createEl("label", { text: "Access" });
    const select = access.createEl("select");
    select.createEl("option", { value: "read_write", text: "Read and write" });
    select.createEl("option", { value: "read_only", text: "Read only" });
    select.value = this.enrollmentMode;
    select.onchange = () => {
      this.enrollmentMode = select.value === "read_only" ? "read_only" : "read_write";
    };
    this.renderFilePolicyControls(section, { connected: false });
    const enrollmentActions = section.createDiv({ cls: "mdbase-actions" });
    const button = enrollmentActions.createEl("button", { text: this.enrollmentAbort ? "Waiting for approval…" : "Continue to approval" });
    button.addClass("mod-cta");
    button.disabled = this.busy;
    button.onclick = () => void this.perform(async () => {
      this.enrollmentAbort?.abort();
      const abort = new AbortController();
      this.enrollmentAbort = abort;
      try {
        await this.host.connectSync.enroll({
          controlUrl: this.enrollmentControlUrl,
          mirrorName: this.enrollmentMirrorName,
          mode: this.enrollmentMode,
          selectiveSync: this.filePolicy(),
          ...(this.enrollmentCollectionId.trim() ? { collectionId: this.enrollmentCollectionId.trim() } : {}),
        }, {
          signal: abort.signal,
          onVerification: (verification) => {
            this.enrollmentVerification = verification.verificationUri;
            this.transientMessage = "Approve the mirror in the Connect page. This view will keep waiting securely.";
            window.open(verification.verificationUri, "_blank", "noopener,noreferrer");
            this.render();
          },
          onStatus: (status) => {
            this.transientMessage = status.state === "waiting_for_approval"
              ? "Waiting for approval in Connect…"
              : `Connect is retrying enrollment (attempt ${status.attempt}).`;
            this.render();
          },
        });
        this.enrollmentVerification = "";
        await this.loadMirrorPreview();
        const bytes = this.mirrorPreview?.entries.reduce((sum, entry) => sum + (entry.estimatedBytes ?? 0), 0) ?? 0;
        const items = this.mirrorPreview?.entries.length ?? 0;
        this.transientMessage = `Mirror enrolled. The first review contains ${items} ${items === 1 ? "item" : "items"}${bytes ? ` and about ${formatBytes(bytes)} of binary data` : ""}. No files have moved yet.`;
        this.render();
      } catch (error) {
        if (!isAbortError(error)) throw error;
        this.transientMessage = "Approval wait cancelled. No files were synchronized.";
      } finally {
        if (this.enrollmentAbort === abort) this.enrollmentAbort = null;
      }
    });
    if (this.enrollmentAbort) {
      const cancel = enrollmentActions.createEl("button", { text: "Stop waiting" });
      cancel.onclick = () => {
        this.enrollmentAbort?.abort();
        this.transientMessage = "Approval wait cancelled. No files were synchronized.";
        this.render();
      };
    }
  }

  private renderLocalAdoption(container: HTMLElement): void {
    const checkpoint = this.host.connectSync.getAdoptionMarker();
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-enrollment" });
    section.createEl("h3", { text: "Host this local collection" });
    section.createEl("p", {
      text: checkpoint
        ? "This vault has a durable adoption checkpoint. Resume it without creating another hosted collection."
        : "Hosted mdbase will adopt an exact snapshot and become the collection authority. This vault will then continue as a read-write mirror.",
    });
    const adoptionStep = checkpoint
      ? ["waiting_for_approval", "uploading", "fenced", "activating", "adopted"].indexOf(checkpoint.phase) + 1
      : 1;
    this.renderEnrollmentSteps(section, Math.min(4, Math.max(1, adoptionStep)), [
      "Approve move",
      "Stage snapshot",
      "Activate authority",
      "Reconnect mirror",
    ]);
    const verificationUri = this.enrollmentVerification || checkpoint?.session.verificationUri;
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
      inputRow(section, "Connect URL", this.enrollmentControlUrl, (value) => {
        this.enrollmentControlUrl = value;
      }, { placeholder: DEFAULT_CONNECT_CONTROL_URL });
      inputRow(section, "Mirror name", this.enrollmentMirrorName, (value) => {
        this.enrollmentMirrorName = value;
      });
      this.renderFilePolicyControls(section, { connected: false });
    } else {
      const values = section.createDiv({ cls: "mdbase-status-list" });
      renderStatus(values, "Collection", checkpoint.session.requested.collectionId);
      renderStatus(values, "Phase", checkpoint.phase.replace(/_/g, " "));
      renderStatus(values, "Connect", checkpoint.session.controlUrl);
      const policy = this.host.connectSync.getSelectiveSync();
      renderStatus(values, "Files", policy.file_classes.length ? policy.file_classes.join(", ") : "Markdown only");
    }
    const warning = section.createDiv({ cls: "mdbase-inline-message" });
    warning.createEl("strong", { text: "Authority cut-over: " });
    warning.appendText(
      "once final staging begins, plugin-managed local edits pause until hosted activation is confirmed. The checkpoint survives app restarts and uncertain network responses.",
    );
    const button = section.createEl("button", {
      text: checkpoint ? "Resume adoption" : "Approve and host collection",
    });
    button.addClass("mod-cta");
    button.disabled = this.busy;
    button.onclick = () => void this.perform(async () => {
      this.enrollmentAbort?.abort();
      const abort = new AbortController();
      this.enrollmentAbort = abort;
      const onVerification = (verification: { verificationUri: string }) => {
        this.enrollmentVerification = verification.verificationUri;
        this.transientMessage = "Approve the authority move in Connect, then return here. This checkpoint is safe to resume.";
        this.render();
      };
      const onStatus = (status: AuthorityAdoptionStatus) => {
        this.transientMessage = status.state === "waiting_for_approval"
          ? "Waiting for authority-move approval in Connect…"
          : `Connect is retrying (attempt ${status.attempt}).`;
        this.render();
      };
      const onFileProgress = (path: string, transferredBytes: number, totalBytes: number) => {
        this.adoptionFileProgress = `${path} · ${formatBytes(transferredBytes)} of ${formatBytes(totalBytes)}`;
        this.transientMessage = `Uploading collection file ${this.adoptionFileProgress}`;
        this.render();
      };
      try {
        if (checkpoint) {
          await this.host.connectSync.resumeAdoption({
            signal: abort.signal,
            onVerification,
            onStatus,
            onFileProgress,
          });
        } else {
          await this.host.connectSync.adoptLocalCollection({
            controlUrl: this.enrollmentControlUrl,
            mirrorName: this.enrollmentMirrorName,
            selectiveSync: this.filePolicy(),
          }, {
            signal: abort.signal,
            onVerification,
            onStatus,
            onFileProgress,
          });
        }
        this.enrollmentVerification = "";
        this.transientMessage = "Hosted mdbase is authoritative and this vault is now its read-write mirror.";
        await this.refresh(true);
      } catch (error) {
        if (!isAbortError(error)) throw error;
        this.transientMessage = "Paused safely. Use Resume adoption to continue from the durable checkpoint.";
      } finally {
        if (this.enrollmentAbort === abort) this.enrollmentAbort = null;
      }
    });
    if (this.enrollmentAbort) {
      const stop = section.createEl("button", { text: "Stop waiting" });
      stop.onclick = () => {
        this.enrollmentAbort?.abort();
        this.transientMessage = "Paused safely. Use Resume adoption to continue from the durable checkpoint.";
        this.render();
      };
    }
    if (checkpoint && !["activating", "adopted"].includes(checkpoint.phase)) {
      const cancel = section.createEl("button", { text: "Cancel adoption" });
      cancel.disabled = this.busy;
      cancel.onclick = () => void this.perform(async () => {
        await this.host.connectSync.cancelAdoption();
        this.enrollmentVerification = "";
        this.transientMessage = "Collection adoption cancelled. This vault remains the local authority.";
        await this.refresh(true);
      });
    }
  }

  private renderEnrollmentSteps(container: HTMLElement, active: number, steps: readonly string[]): void {
    const list = container.createEl("ol", { cls: "mdbase-enrollment-steps" });
    steps.forEach((label, index) => {
      const item = list.createEl("li");
      const step = index + 1;
      item.toggleClass("is-complete", step < active);
      item.toggleClass("is-active", step === active);
      item.createSpan({ text: String(step), cls: "mdbase-enrollment-step-number" });
      item.createSpan({ text: label });
      if (step === active) item.setAttr("aria-current", "step");
    });
  }

  private renderMirrorPreview(container: HTMLElement, preview: MdbaseSyncPreview): void {
    const section = container.createEl("section", { cls: "mdbase-transfer-review" });
    const heading = section.createDiv({ cls: "mdbase-transfer-heading" });
    const title = heading.createDiv();
    title.createEl("h3", { text: preview.phase === "rebuild" ? "Rebuild review" : "Transfer review" });
    title.createEl("p", {
      text: preview.phase === "initial"
        ? "First sync establishes the local checkpoint shown below."
        : preview.phase === "rebuild"
          ? "The hosted history changed; this mirror needs a fresh, reviewable baseline."
          : `Compared local checkpoint ${preview.cursor ?? "—"} with hosted head ${preview.remoteHead ?? "—"}.`,
    });
    const estimatedBytes = preview.entries.reduce((sum, entry) => sum + (entry.estimatedBytes ?? 0), 0);
    heading.createSpan({
      cls: "mdbase-transfer-total",
      text: `${preview.entries.length} ${preview.entries.length === 1 ? "item" : "items"} · ${preview.entries.filter((entry) => entry.kind === "file").length} files${estimatedBytes ? ` · about ${formatBytes(estimatedBytes)}` : ""}`,
    });

    const groups: Array<{ direction: SyncPreviewDirection; title: string; empty: string }> = [
      { direction: "download", title: "Download to this vault", empty: "No hosted changes to download." },
      { direction: "upload", title: "Upload to hosted", empty: "No local changes to upload." },
      { direction: "attention", title: "Needs attention", empty: "Nothing is blocking or excluded." },
    ];
    for (const group of groups) {
      const entries = preview.entries.filter((entry) => entry.direction === group.direction);
      if (!entries.length && group.direction !== "attention") continue;
      const block = section.createEl("section", { cls: "mdbase-transfer-group" });
      block.setAttr("data-direction", group.direction);
      const groupHeading = block.createDiv({ cls: "mdbase-transfer-group-heading" });
      const icon = groupHeading.createSpan({ cls: "mdbase-transfer-group-icon" });
      setIcon(icon, group.direction === "download" ? "download" : group.direction === "upload" ? "upload" : "circle-alert");
      groupHeading.createEl("h4", { text: group.title });
      groupHeading.createSpan({ text: String(entries.length), cls: "mdbase-transfer-count" });
      if (!entries.length) {
        block.createDiv({ cls: "mdbase-transfer-empty", text: group.empty });
        continue;
      }
      const ledger = block.createDiv({ cls: "mdbase-transfer-ledger" });
      for (const entry of entries.slice(0, 250)) {
        const row = ledger.createDiv({ cls: "mdbase-transfer-row" });
        const action = row.createSpan({ cls: "mdbase-transfer-action", text: entry.action });
        action.setAttr("data-action", entry.action);
        const body = row.createDiv({ cls: "mdbase-transfer-body" });
        const pathLine = body.createDiv({ cls: "mdbase-transfer-path" });
        pathLine.createEl("code", { text: entry.path });
        pathLine.createSpan({ cls: "mdbase-transfer-kind", text: entry.kind === "file" ? "File" : "Markdown" });
        if (entry.estimatedBytes !== undefined) {
          pathLine.createSpan({ cls: "mdbase-transfer-size", text: formatBytes(entry.estimatedBytes) });
        }
        body.createDiv({ text: entry.detail });
        if (entry.direction === "attention") {
          const open = row.createEl("button", { text: "Open" });
          open.onclick = () => void this.host.openFileByPath(entry.path);
        }
      }
      if (entries.length > 250) {
        ledger.createDiv({ cls: "mdbase-transfer-more", text: `${entries.length - 250} more items are included in this transfer.` });
      }
    }

    if (preview.collisions.length) {
      section.createDiv({
        cls: "mdbase-inline-error",
        text: "Resolve path collisions before the first sync. Existing local files are never overwritten without review.",
      });
    } else if (preview.local_issues.length) {
      section.createDiv({
        cls: "mdbase-inline-message",
        text: "Synchronization is paused until every invalid or unreadable local file listed here is fixed.",
      });
    }
  }

  private renderConflicts(container: HTMLElement, status: MirrorStatus): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section" });
    section.id = "mdbase-sync-conflicts";
    section.createEl("h3", { text: "Conflicts" });
    section.createEl("p", {
      text: "Inspect both versions before deciding. Decisions are checked again immediately before they are applied.",
    });
    for (const conflict of status.conflicts) {
      const row = section.createDiv({ cls: "mdbase-conflict-row" });
      const text = row.createDiv({ cls: "mdbase-conflict-summary" });
      text.createEl("strong", { text: conflict.path ?? conflict.object_id });
      text.createDiv({
        text: conflict.entity === "file" ? "Binary file conflict" : "Note conflict",
        cls: "mdbase-muted",
      });
      text.createDiv({ text: conflict.message });
      const actions = row.createDiv({ cls: "mdbase-actions" });
      const comparisonKey = `${conflict.object_id}:${conflict.decision_id}`;
      const comparison = this.conflictComparisons.get(comparisonKey);
      const compare = actions.createEl("button", {
        text: comparison ? "Hide versions" : this.loadingConflictComparisons.has(comparisonKey) ? "Loading versions…" : "Compare versions",
      });
      compare.disabled = this.busy || this.loadingConflictComparisons.has(comparisonKey);
      compare.onclick = () => {
        if (comparison) {
          this.conflictComparisons.delete(comparisonKey);
          this.render();
          return;
        }
        void this.loadConflictComparison(conflict, comparisonKey);
      };
      for (const resolution of ["local", "remote"] as const) {
        const button = actions.createEl("button", {
          text: resolution === "local" ? "Keep local" : "Use hosted",
        });
        button.disabled = this.busy;
        button.onclick = () => void this.resolveMirrorConflict(conflict, resolution, false);
      }
      if (conflict.path) {
        const keepBoth = actions.createEl("button", { text: "Keep both" });
        keepBoth.disabled = this.busy;
        keepBoth.onclick = () => void this.resolveMirrorConflict(conflict, "remote", true);
      }
      if (comparison) this.renderConflictComparison(row, comparison);
    }
  }

  private async loadConflictComparison(
    conflict: MirrorStatus["conflicts"][number],
    comparisonKey: string,
  ): Promise<void> {
    this.loadingConflictComparisons.add(comparisonKey);
    this.render();
    try {
      this.conflictComparisons.set(comparisonKey, await this.host.connectSync.conflictComparison(conflict));
    } catch (error) {
      const problem = syncProblem(error);
      this.syncProblem = problem;
      this.host.setSyncProblem(problem);
      this.transientMessage = problem.message;
      if (problem.code === "conflict_decision_stale") await this.refreshMirrorStatus();
    } finally {
      this.loadingConflictComparisons.delete(comparisonKey);
      this.render();
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
    await this.perform(async () => {
      let copiedPath: string | null = null;
      try {
        if (keepBoth) copiedPath = await this.host.connectSync.preserveConflictCopy(conflict.path ?? "");
        this.mirrorPreview = null;
        const resolved = await resolveConflictAndRefresh(
          this.host.connectSync,
          conflict.object_id,
          conflict.decision_id,
          resolution,
        );
        this.mirrorStatus = resolved.status;
        this.mirrorPreview = resolved.preview;
        this.host.setSyncStatus(resolved.status);
        this.conflictComparisons.delete(`${conflict.object_id}:${conflict.decision_id}`);
        this.transientMessage = copiedPath
          ? `Both versions are safe: the hosted version will use the original path and the local version was copied to ${copiedPath}. Review the refreshed plan before syncing.`
          : "Conflict resolved. Review the refreshed engine plan before syncing.";
        await this.host.recordSyncActivity({
          summary: copiedPath ? "Conflict kept as two files" : `Conflict resolved with ${resolution === "local" ? "local" : "hosted"} version`,
          detail: this.transientMessage,
          path: conflict.path ?? undefined,
          tone: "info",
          requiresAcknowledgement: false,
        });
      } catch (error) {
        const problem = syncProblem(error);
        if (copiedPath) {
          problem.message = `The local copy at ${copiedPath} is safe, but the original changed again. Review the newest versions before deciding.`;
        }
        this.syncProblem = problem;
        this.host.setSyncProblem(problem);
        this.transientMessage = problem.message;
        if (problem.code === "conflict_decision_stale") {
          this.mirrorPreview = null;
          await this.refreshMirrorStatus();
        }
        await this.host.recordSyncActivity({
          summary: problem.title,
          detail: problem.message,
          path: conflict.path ?? undefined,
          tone: "attention",
          requiresAcknowledgement: true,
        });
      }
    });
  }

  private renderLocalMirrorIssues(container: HTMLElement, status: MirrorStatus): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section" });
    section.createEl("h3", { text: "Local files needing attention" });
    section.createEl("p", {
      text: "Synchronization is paused to keep the mirror checkpoint exact. Fix every malformed or unreadable file below, then preview again.",
    });
    for (const issue of status.local_issues) {
      const row = section.createDiv({ cls: "mdbase-conflict-row" });
      const text = row.createDiv();
      text.createEl("strong", { text: issue.path });
      text.createDiv({ text: issue.message });
      const actions = row.createDiv({ cls: "mdbase-actions" });
      const open = actions.createEl("button", { text: "Open file" });
      open.disabled = this.busy;
      open.onclick = () => void this.host.openFileByPath(issue.path);
    }
  }

  private renderIssues(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-issues-document" });
    const allIssues = this.host.getIssues();
    const allFiles = new Set(allIssues.map((issue) => issue.path)).size;
    const header = document.createDiv({ cls: "mdbase-document-header" });
    const heading = header.createDiv();
    heading.createEl("h2", { text: "Issues" });
    heading.createEl("p", {
      text: allIssues.length
        ? `${allIssues.length.toLocaleString()} validation issues in ${allFiles.toLocaleString()} files.`
        : "The collection has no current validation issues.",
    });
    const refresh = header.createEl("button", { text: "Validate collection" });
    refresh.disabled = this.busy;
    refresh.onclick = () => void this.perform(async () => {
      await this.host.validateCollection();
      this.render();
    });
    const controls = document.createDiv({ cls: "mdbase-issue-controls" });
    const severity = controls.createEl("select");
    severity.setAttr("aria-label", "Issue severity");
    severity.createEl("option", { value: "all", text: "All severities" });
    severity.createEl("option", { value: "error", text: "Errors" });
    severity.createEl("option", { value: "warn", text: "Warnings" });
    severity.value = this.issueSeverity;
    severity.onchange = () => {
      this.issueSeverity = severity.value === "error" || severity.value === "warn" ? severity.value : "all";
      this.issueLimit = 250;
      this.render();
    };
    const query = controls.createEl("input", { type: "search" });
    query.setAttr("aria-label", "Filter issues");
    query.setAttr("data-focus-key", "issue-search");
    query.placeholder = "Filter by path, code, field, or message";
    query.value = this.issueQuery;
    query.oninput = () => {
      this.issueQuery = query.value;
      this.issueLimit = 250;
      this.render();
      const next = this.containerEl.querySelector<HTMLInputElement>(".mdbase-issue-controls input[type='search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    };
    const normalizedQuery = this.issueQuery.trim().toLowerCase();
    const filtered = allIssues.filter((issue) => {
      if (this.issueSeverity !== "all" && issue.severity !== this.issueSeverity) return false;
      if (!normalizedQuery) return true;
      return `${issue.path} ${issue.code} ${issue.field ?? ""} ${issue.message}`.toLowerCase().includes(normalizedQuery);
    });
    const filteredFiles = new Set(filtered.map((issue) => issue.path)).size;
    document.createDiv({
      cls: "mdbase-issues-summary",
      text: filtered.length === allIssues.length
        ? `Showing ${Math.min(filtered.length, this.issueLimit).toLocaleString()} of ${filtered.length.toLocaleString()} issues`
        : `${filtered.length.toLocaleString()} matching issues in ${filteredFiles.toLocaleString()} files`,
    });
    if (!filtered.length) {
      document.createDiv({ cls: "mdbase-empty-state", text: "No validation issues." });
      return;
    }
    const issues = filtered.slice(0, this.issueLimit);
    const groups = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) groups.set(issue.path, [...(groups.get(issue.path) ?? []), issue]);
    for (const [path, fileIssues] of groups) {
      const group = document.createEl("section", { cls: "mdbase-issue-group" });
      const groupHeader = group.createDiv({ cls: "mdbase-issue-group-header" });
      const fileButton = groupHeader.createEl("button", { cls: "mdbase-issue-file-button" });
      setIcon(fileButton.createSpan({ cls: "mdbase-issue-file-icon" }), "file-text");
      fileButton.createSpan({ cls: "mdbase-issue-file-path", text: path });
      fileButton.onclick = () => void this.host.openFileByPath(path);
      groupHeader.createSpan({
        cls: "mdbase-issue-file-count",
        text: `${fileIssues.length} ${fileIssues.length === 1 ? "issue" : "issues"}`,
      });
      for (const issue of fileIssues) {
        const row = group.createDiv({ cls: "mdbase-issue-row" });
        row.setAttr("data-severity", issue.severity);
        row.createSpan({ cls: "mdbase-issue-indicator" }).setAttr("aria-hidden", "true");
        const metadata = row.createDiv({ cls: "mdbase-issue-metadata" });
        metadata.createEl("code", { text: issue.code });
        metadata.createDiv({
          cls: "mdbase-issue-context",
          text: `${issue.severity === "warn" ? "Warning" : "Error"}${issue.field ? ` · ${issue.field}` : ""}`,
        });
        row.createDiv({ cls: "mdbase-issue-row-message", text: issue.message });
        const actions = row.createDiv({ cls: "mdbase-issue-row-actions" });
        const open = actions.createEl("button", { text: issue.field ? "Open field" : "Open file" });
        open.setAttr("aria-label", `Open ${issue.path}${issue.field ? ` at ${issue.field}` : ""}`);
        open.onclick = () => void this.host.openFileByPath(issue.path, issue.field);
        const quickFixLabel = this.host.getQuickFixLabel(issue);
        if (quickFixLabel) {
          const fix = actions.createEl("button", { text: quickFixLabel });
          fix.addClass("mod-cta");
          fix.onclick = () => void this.perform(async () => {
            await this.host.applyQuickFix(issue);
          });
        }
      }
    }
    if (filtered.length > issues.length) {
      const load = document.createEl("button", {
        cls: "mdbase-load-more",
        text: `Load ${Math.min(250, filtered.length - issues.length)} more`,
      });
      load.onclick = () => {
        this.issueLimit += 250;
        this.render();
      };
    }
  }

  private async selectType(path: string, confirmDirty = true): Promise<void> {
    if (confirmDirty && this.dirty && path !== this.selectedPath) {
      new Notice("Save or discard the current type changes before switching.");
      return;
    }
    const version = ++this.typeSelectionVersion;
    const sourceModel = await this.host.loadTypeModel(path);
    if (version !== this.typeSelectionVersion) return;
    const draft = this.host.loadTypeDraft(path);
    const canRestore = draft?.version === 1 && draft.sourceRevision === (sourceModel.sourceRevision ?? null);
    const model = canRestore ? clone(draft.model) : sourceModel;
    this.selectedPath = path;
    this.model = model;
    this.originalModel = clone(sourceModel);
    this.yamlDraft = canRestore && draft.yamlDraft
      ? draft.yamlDraft
      : `${formatMarkdown(frontmatterFromReadableModel(model), model.body)}\n`;
    this.dirty = !typeModelsEqual(this.originalModel, model);
    this.editorMode = canRestore && draft.editorMode === "yaml" ? "yaml" : "design";
    if (this.editorMode === "yaml") this.dirty = true;
    if (canRestore && this.dirty) {
      this.transientMessage = `Recovered unsaved changes for ${path}.`;
    } else if (draft && !canRestore) {
      this.transientMessage = `An older draft for ${path} was kept, but the source changed. The current file is shown.`;
    }
    this.render();
  }

  private createType(): void {
    if (this.dirty) {
      new Notice("Save or discard the current type changes before creating another type.");
      return;
    }
    this.typeSelectionVersion += 1;
    const draft = this.host.loadTypeDraft(null);
    const model = draft?.version === 1 ? clone(draft.model) : createDefaultTypeModel();
    this.selectedPath = null;
    this.model = model;
    this.originalModel = null;
    this.yamlDraft = draft?.yamlDraft
      ?? "";
    this.dirty = true;
    if (draft) this.transientMessage = "Recovered an unsaved new type.";
    this.editorMode = draft?.editorMode ?? "design";
    this.render();
  }

  private switchEditorMode(mode: EditorMode): void {
    if (!this.model || mode === this.editorMode) return;
    if (mode === "yaml") {
      try {
        this.yamlDraft = `${formatMarkdown(frontmatterFromReadableModel(this.model), this.model.body)}\n`;
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        return;
      }
    } else if (!this.readYamlDraftIntoModel()) {
      return;
    }
    this.editorMode = mode;
    this.render();
  }

  private readYamlDraftIntoModel(): boolean {
    const parsed = parseFrontmatter(this.yamlDraft);
    if (!parsed.hasFrontmatter || parsed.error) {
      new Notice(`Invalid type YAML: ${parsed.error ?? "frontmatter is missing"}`);
      return false;
    }
    if (parsed.frontmatter.kind !== "mdbase.type") {
      new Notice("Canonical v0.3 type YAML requires kind: mdbase.type.");
      return false;
    }
    try {
      this.model = typeModelFromDocument(parsed.frontmatter, parsed.body, this.model?.name || "type");
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async saveCurrentType(): Promise<void> {
    if (!this.model || this.model.specProfile !== "v0.3" || this.model.readOnlyReason) return;
    if (this.editorMode === "yaml" && !this.readYamlDraftIntoModel()) return;
    const diagnostics = validateTypeDraft(this.model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.schema?.contracts.values(),
    });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length) {
      this.transientMessage = `${errors.length} ${errors.length === 1 ? "error must" : "errors must"} be fixed before saving.`;
      this.render();
      new Notice(errors[0].message);
      return;
    }
    const highImpact = describeTypeChanges(this.originalModel, this.model)
      .filter((change) => change.risk === "high");
    if (highImpact.length) {
      const confirmed = await new TypeChangeConfirmationModal(this.app).confirm(highImpact);
      if (!confirmed) return;
    }
    const model = this.model;
    await this.perform(async () => {
      const previousPath = this.selectedPath;
      const file = await this.host.saveTypeModel(model, previousPath, this.originalModel?.sourceRevision);
      await this.host.clearTypeDraft(previousPath);
      if (previousPath !== file.path) await this.host.clearTypeDraft(file.path);
      this.selectedPath = file.path;
      this.originalModel = clone(model);
      this.dirty = false;
      this.transientMessage = `Saved ${file.path}.`;
      await this.refresh(true);
    });
  }

  private markDirty(render = false): void {
    const wasDirty = this.dirty;
    this.dirty = this.editorMode === "yaml"
      ? true
      : !typeModelsEqual(this.originalModel, this.model);
    this.scheduleTypeDraftSave();
    if (this.dirty && !wasDirty) this.transientMessage = "";
    if (render || wasDirty !== this.dirty) {
      this.render();
      return;
    }
    const titleLine = this.containerEl.querySelector<HTMLElement>(".mdbase-editor-title-line");
    if (titleLine && !titleLine.querySelector(".mdbase-dirty")) {
      titleLine.createSpan({ cls: "mdbase-dirty", text: "Unsaved" });
    }
    const save = this.containerEl.querySelector<HTMLButtonElement>(".mdbase-editor-actions .mod-cta");
    if (
      save
      && this.model?.specProfile === "v0.3"
      && !this.model.readOnlyReason
      && this.host.getMirrorProfile()?.mode !== "read_only"
    ) save.disabled = false;
    const review = this.containerEl.querySelector<HTMLElement>(".mdbase-change-review");
    if (review) {
      const empty = review.querySelector("p");
      if (empty) empty.setText("Pending changes. Review details after leaving the current field.");
    }
  }

  private scheduleTypeDraftSave(): void {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.flushTypeDraft();
    }, 2_000);
  }

  private async flushTypeDraft(): Promise<void> {
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    if (!this.model || !this.dirty) return;
    const draft: StoredTypeDraft = {
      version: 1,
      path: this.selectedPath,
      sourceRevision: this.originalModel?.sourceRevision ?? null,
      model: clone(this.model),
      editorMode: this.editorMode,
      yamlDraft: this.editorMode === "yaml" ? this.yamlDraft : undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.host.saveTypeDraft(draft);
  }

  private async discardCurrentType(): Promise<void> {
    const path = this.selectedPath;
    await this.host.clearTypeDraft(path);
    if (path) {
      const model = await this.host.loadTypeModel(path);
      this.model = model;
      this.originalModel = clone(model);
      this.yamlDraft = `${formatMarkdown(frontmatterFromReadableModel(model), model.body)}\n`;
      this.dirty = false;
    } else {
      this.model = null;
      this.originalModel = null;
      this.yamlDraft = "";
      this.dirty = false;
    }
    this.transientMessage = "Unsaved changes discarded.";
    this.render();
  }

  private async refreshMirrorStatus(): Promise<void> {
    if (this.host.connectSync.isSyncing()) return;
    try {
      this.mirrorStatus = await this.host.connectSync.status();
      this.syncProblem = null;
      this.host.setSyncStatus(this.mirrorStatus);
    } catch (error) {
      this.mirrorStatus = null;
      this.syncProblem = syncProblem(error);
      this.host.setSyncProblem(this.syncProblem);
      this.transientMessage = this.syncProblem.message;
    }
  }

  private async perform(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.transientMessage = "";
    this.render();
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transientMessage = message;
      new Notice(message);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

function frontmatterFromReadableModel(model: TypeEditorModel): Record<string, unknown> {
  if (model.specProfile === "v0.3" && !model.readOnlyReason) return frontmatterFromTypeModel(model);
  return clone(model.originalFrontmatter ?? {
    name: model.name,
    fields: Object.fromEntries(model.fields.map((field) => [field.name, field.definition])),
  });
}
