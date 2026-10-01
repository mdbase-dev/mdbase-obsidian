import {
  ItemView,
  Menu,
  Modal,
  Notice,
  Platform,
  setIcon,
  TFile,
  WorkspaceLeaf,
  TFolder,
} from "obsidian";
import type { MirrorProgress, MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import type { AuthorityAdoptionStatus } from "@mdbase-dev/connect-sync/adoption";
import type { AdoptionRenamePlan } from "./adoptionPaths";
import type {
  AdoptionPreview,
  AdoptLocalCollectionCallbacks,
  ConnectSyncController,
  DisconnectMirrorResult,
  MirrorConflictComparison,
  MirrorProfile,
} from "./connectSync";
import type {
  CollectionRecord,
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
import {
  filterRuns,
  formatHistoryTime,
  historyFileFromReceipt,
  summarizeRun,
  type SyncHistoryFile,
  type SyncHistoryRun,
} from "./syncHistory";
import { boundedLineDiff } from "./conflictPresentation";
import { fieldConstraintSummary, parseDefaultValue, parseEnumValue, scalarText } from "./fieldSummary";
import { groupIssuesByRule, issueRuleLabel } from "./issuePresentation";
import {
  analyzeTypeImpact,
  indexRecordTypes,
  issueTypeNames,
  typeStats,
  type TypeImpactResult,
  type TypeStats,
} from "./typeImpact";
import { YamlSourceEditor, yamlErrorLine, yamlKeyLine, type YamlProblem } from "./yamlEditor";
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
  getArchivedTypeDrafts(path: string): StoredTypeDraft[];
  discardArchivedTypeDraft(draft: StoredTypeDraft): Promise<void>;
  createNoteFromType(typeName?: string): Promise<void>;
  openContractCatalog(): Promise<void>;
  initializeCollection(): Promise<void>;
  getIssues(): MdbaseIssue[];
  validateCollection(): Promise<void>;
  getValidationSummary(): string;
  isValidating(): boolean;
  cancelValidation(): void;
  getQuickFixLabel(issue: MdbaseIssue): string | null;
  applyQuickFix(issue: MdbaseIssue): Promise<void>;
  applyQuickFixes(issues: MdbaseIssue[]): Promise<{ changed: number; skipped: number }>;
  loadCollectionRecords(): Promise<CollectionRecord[]>;
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
  getSyncHistory(): SyncHistoryRun[];
  recordSyncHistory(run: SyncHistoryRun): Promise<void>;
  clearSyncHistory(): Promise<void>;
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

function defaultDeviceName(vaultName: string): string {
  const platform = Platform.isIosApp ? "iOS"
    : Platform.isAndroidApp ? "Android"
      : Platform.isMacOS ? "Mac"
        : Platform.isWin ? "Windows"
          : Platform.isLinux ? "Linux"
            : "Obsidian";
  return `${vaultName} · ${platform}`;
}

function fieldTypeLabel(type: string): string {
  if (type === "any") return "Any value";
  if (type === "datetime") return "Date and time";
  return type ? type[0].toUpperCase() + type.slice(1) : type;
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

const HISTORY_PAGE = 10;

const HISTORY_OUTCOMES: Record<string, string> = {
  cancelled: "Paused",
  stale: "Stopped: changes detected",
  attention: "Needs attention",
  blocked: "Stopped",
  failed: "Failed",
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
  if (status.state === "changes_waiting") return "Changes waiting";
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

  confirm(changes: readonly TypeDraftChange[], failingNotes: readonly string[] = []): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.titleEl.setText("Confirm high-impact type changes");
      this.contentEl.createEl("p", {
        text: failingNotes.length
          ? `${failingNotes.length} existing ${failingNotes.length === 1 ? "note" : "notes"} would fail validation. Only the type definition will be saved; notes are not changed.`
          : "These changes may invalidate existing notes. Only the type definition will be saved.",
      });
      const list = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list" });
      for (const change of changes) list.createEl("li", { text: change.summary });
      if (failingNotes.length) {
        const notes = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list mdbase-confirm-notes" });
        for (const path of failingNotes.slice(0, 5)) notes.createEl("li", { text: path });
        if (failingNotes.length > 5) notes.createEl("li", { text: `${failingNotes.length - 5} more` });
      }
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

class BulkFixConfirmationModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  confirm(label: string, issues: readonly MdbaseIssue[]): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      const paths = [...new Set(issues.map((issue) => issue.path))];
      const notes = `${paths.length} ${paths.length === 1 ? "note" : "notes"}`;
      this.titleEl.setText(`${label} in ${notes}?`);
      this.contentEl.createEl("p", {
        text: `Only the '${issues[0]?.field ?? "affected"}' frontmatter field changes in each note. Notes that changed since validation are skipped.`,
      });
      const list = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list" });
      for (const path of paths.slice(0, 8)) list.createEl("li", { text: path });
      if (paths.length > 8) list.createEl("li", { text: `${paths.length - 8} more` });
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.onclick = () => this.finish(false);
      const apply = actions.createEl("button", { text: `Update ${notes}` });
      apply.addClass("mod-cta");
      apply.onclick = () => this.finish(true);
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
      this.contentEl.createEl("p", { text: "Keep all local files, or remove unchanged synced files. Local edits are kept either way." });
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.onclick = () => this.finish(null);
      const keep = actions.createEl("button", { text: "Keep files", cls: "mod-cta" });
      keep.onclick = () => this.finish("keep");
      const remove = actions.createEl("button", { text: "Remove unchanged files" });
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
  private transferQuery = "";
  private transferFilter = "all";
  private readonly transferPages = new Map<SyncPreviewDirection, number>();
  private historyQuery = "";
  private historyLimit = HISTORY_PAGE;
  private issueSeverity: "all" | "error" | "warn" = "all";
  private issueLimit = 250;
  private issueGroupBy: "file" | "rule" = "file";
  private records: CollectionRecord[] | null = null;
  private statsCache: {
    records: CollectionRecord[] | null;
    types: Map<string, MdbaseTypeDef> | null;
    issues: MdbaseIssue[];
    recordTypes: Map<string, string[]>;
    stats: Map<string, TypeStats>;
  } | null = null;
  private impact: TypeImpactResult | null = null;
  private impactVersion = 0;
  private impactTimer: number | null = null;
  private showAllMatches = false;
  private pendingFieldReveal: string | null = null;
  private pendingFocusKey: string | null = null;
  /** Drafts written during this session; restoring them is expected, not a recovery. */
  private readonly sessionDrafts = new Set<string>();
  private yamlEditor: YamlSourceEditor | null = null;
  private yamlProblemTimer: number | null = null;
  private readonly previewComparisons = new Map<string, MirrorConflictComparison>();
  private readonly loadingPreviewComparisons = new Set<string>();
  private enrollmentVerification = "";
  private enrollmentAbort: AbortController | null = null;
  private enrollmentControlUrl = DEFAULT_CONNECT_CONTROL_URL;
  // Connect lists devices by this name; the vault and platform tell them apart.
  private enrollmentMirrorName = defaultDeviceName(this.app.vault.getName());
  private enrollmentCollectionId = "";
  private enrollmentMode: "read_only" | "read_write" = "read_write";
  private filePolicyDraft: SelectiveSyncPolicy | null = null;
  private adoptionFileProgress = "";
  private adoptionPreview: AdoptionPreview | null = null;
  private adoptionRenamePlan: AdoptionRenamePlan | null = null;
  private adoptionStage = "";
  private adoptionFailed = false;
  private draftSaveTimer: number | null = null;
  private fieldQuery = "";
  private readonly expandedFields = new Set<string>();
  private readonly disclosures = new Map<string, boolean>();
  private readonly fieldIds = new WeakMap<Record<string, unknown>, string>();
  private nextFieldId = 1;
  private refreshVersion = 0;
  private typeSelectionVersion = 0;

  constructor(leaf: WorkspaceLeaf, private readonly host: MdbaseWorkspaceHost) {
    super(leaf);
  }

  getState(): Record<string, unknown> {
    this.captureRenderSnapshot(this.containerEl);
    return { destination: this.destination, selectedPath: this.selectedPath, editorMode: this.editorMode,
      query: this.query, fieldQuery: this.fieldQuery, issueQuery: this.issueQuery, issueSeverity: this.issueSeverity,
      issueGroupBy: this.issueGroupBy, historyQuery: this.historyQuery, disclosures: Object.fromEntries(this.disclosures) };
  }

  async setState(state: Record<string, unknown>, result: import("obsidian").ViewStateResult): Promise<void> {
    if (["types", "sync", "issues"].includes(String(state.destination))) this.destination = state.destination as Destination;
    for (const key of ["query", "fieldQuery", "issueQuery", "historyQuery"] as const) if (typeof state[key] === "string") this[key] = state[key].slice(0, 2000);
    if (["all", "error", "warn"].includes(String(state.issueSeverity))) this.issueSeverity = state.issueSeverity as typeof this.issueSeverity;
    if (state.issueGroupBy === "rule" || state.issueGroupBy === "file") this.issueGroupBy = state.issueGroupBy;
    if (isRecord(state.disclosures)) for (const [key, open] of Object.entries(state.disclosures)) if (typeof open === "boolean") this.disclosures.set(key, open);
    if (typeof state.selectedPath === "string" && state.selectedPath !== this.selectedPath) {
      await this.leaveCurrentType();
      this.selectedPath = state.selectedPath;
      this.model = null;
      this.originalModel = null;
    }
    await this.refresh();
    if (state.editorMode === "yaml" && this.editorMode !== "yaml") this.switchEditorMode("yaml");
    await super.setState(state, result);
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
    if (this.impactTimer !== null) window.clearTimeout(this.impactTimer);
    if (this.yamlProblemTimer !== null) window.clearTimeout(this.yamlProblemTimer);
    this.impactVersion++;
    this.refreshVersion++;
    await this.flushTypeDraft();
    this.yamlEditor?.destroy();
    this.yamlEditor = null;
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
        // Persist in-progress edits first so the reload restores them.
        if (this.dirty) await this.flushTypeDraft();
        await this.selectType(this.selectedPath, false);
        if (version !== this.refreshVersion) return;
      }
      if (this.destination === "sync") await this.refreshMirrorStatus();
      if (version !== this.refreshVersion) return;
      const records = schema ? await this.host.loadCollectionRecords() : null;
      if (version !== this.refreshVersion) return;
      const recordsChanged = records !== this.records;
      this.records = records;
      if (recordsChanged || forceReload || !this.impact) this.scheduleImpact(0);
      this.render();
    } catch (error) {
      if (version !== this.refreshVersion) return;
      this.transientMessage = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  /** Open Issues filtered to one note. */
  showIssuesForPath(path: string): void {
    this.issueQuery = path;
    this.issueLimit = 250;
    this.showDestination("issues");
  }

  /** Open a type with one field (a dotted or `[]` path) expanded and in view. */
  async openTypeField(typePath: string, fieldPath: string | undefined): Promise<void> {
    this.destination = "types";
    if (typePath !== this.selectedPath || !this.model) await this.selectType(typePath);
    if (!this.model || this.selectedPath !== typePath) return;
    if (fieldPath) this.revealField(fieldPath);
    this.render();
  }

  private revealField(fieldPath: string): void {
    if (!this.model) return;
    const segments = fieldPath.split(".").filter(Boolean);
    const top = segments.shift()?.replace(/\[\]$/g, "") ?? "";
    let definition = this.model.fields.find((field) => field.name === top)?.definition;
    if (!definition) return;
    this.editorMode = "design";
    this.fieldQuery = "";
    this.expandedFields.add(this.fieldId(definition));
    for (const segment of segments) {
      const name = segment.replace(/\[\]$/g, "");
      const container: Record<string, unknown> | undefined = isRecord(definition.items) ? definition.items : definition;
      const child: unknown = isRecord(container.fields) ? container.fields[name] : undefined;
      if (!isRecord(child)) break;
      if (container !== definition) this.expandedFields.add(this.fieldId(container));
      definition = child;
      this.expandedFields.add(this.fieldId(definition));
    }
    this.pendingFieldReveal = this.fieldId(definition);
  }

  private currentStats(): { recordTypes: Map<string, string[]>; stats: Map<string, TypeStats> } {
    const issues = this.host.getIssues();
    const types = this.schema?.types ?? null;
    const cached = this.statsCache;
    if (cached && cached.records === this.records && cached.types === types && cached.issues === issues) return cached;
    const recordTypes = this.records && this.schema
      ? indexRecordTypes(this.records, this.schema.config, this.schema.types)
      : new Map<string, string[]>();
    this.statsCache = { records: this.records, types, issues, recordTypes, stats: typeStats(recordTypes, issues) };
    return this.statsCache;
  }

  /** Re-run the draft/record comparison after a pause in editing. */
  private scheduleImpact(delay = 400): void {
    if (this.impactTimer !== null) window.clearTimeout(this.impactTimer);
    this.impactTimer = window.setTimeout(() => {
      this.impactTimer = null;
      void this.computeImpact().then((result) => {
        if (result === undefined) return;
        this.impact = result;
        this.updateImpactRegions();
      });
    }, delay);
  }

  /** undefined when superseded; null when there is nothing to analyze. */
  private async computeImpact(): Promise<TypeImpactResult | null | undefined> {
    const version = ++this.impactVersion;
    const parsedYaml = this.editorMode === "yaml" ? this.modelFromYamlDraft() : null;
    if (parsedYaml && "error" in parsedYaml) return { error: parsedYaml.error };
    const model = parsedYaml?.model ?? this.model;
    if (!model || !this.schema || !this.records || model.specProfile !== "v0.3" || model.readOnlyReason) return null;
    const savedName = this.selectedPath
      ? [...this.schema.types.values()].find((type) => type.filePath === this.selectedPath)?.name ?? null
      : null;
    const result = await analyzeTypeImpact({
      records: this.records,
      config: this.schema.config,
      types: this.schema.types,
      draft: model,
      savedName,
      filePath: this.selectedPath,
      isCurrent: () => version === this.impactVersion,
    });
    return version === this.impactVersion && result !== null ? result : undefined;
  }

  /** Refresh only the regions that show record impact, leaving inputs untouched. */
  private updateImpactRegions(): void {
    const preview = this.containerEl.querySelector<HTMLElement>(".mdbase-match-preview");
    if (preview) {
      preview.empty();
      this.fillMatchPreview(preview);
    }
    const summary = this.containerEl.querySelector<HTMLElement>("[data-disclosure='type-matching'] > summary");
    if (summary) summary.textContent = this.matchingLabel();
    const effect = this.containerEl.querySelector<HTMLElement>(".mdbase-impact");
    if (effect) {
      effect.empty();
      this.fillImpact(effect);
    }
    const pane = this.containerEl.querySelector<HTMLElement>(".mdbase-type-editor-pane");
    const bar = pane?.querySelector(".mdbase-draft-bar");
    if (pane && bar && this.model) {
      bar.remove();
      this.renderDraftBar(pane, this.model);
    }
  }

  showDestination(destination: Destination): void {
    this.destination = destination;
    if (destination === "sync") void this.refreshMirrorStatus().then(() => this.render());
    else this.render();
  }

  createNewType(): void {
    this.destination = "types";
    void this.createType();
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
    if (this.transientMessage && this.transientMessage !== this.syncProblem?.message) {
      const message = shell.createDiv({ cls: "mdbase-inline-message mdbase-notice" });
      message.createSpan({ text: this.transientMessage }).setAttr("role", "status");
      const dismiss = this.iconButton(message, "x", "Dismiss message");
      dismiss.onclick = () => { this.transientMessage = ""; this.render(); };
    }
    const content = shell.createDiv({ cls: "mdbase-workspace-content" });
    content.setAttr("data-scroll-key", "workspace");
    if (this.destination === "types") this.renderTypes(content);
    else if (this.destination === "sync") this.renderSync(content);
    else this.renderIssues(content);
    this.restoreRenderSnapshot(root, snapshot);
    this.app.workspace?.requestSaveLayout();
    if (this.pendingFocusKey) {
      root.querySelector<HTMLElement>(`[data-focus-key="${this.pendingFocusKey}"]`)?.focus();
      this.pendingFocusKey = null;
    }
    if (this.pendingFieldReveal && this.destination === "types") {
      const node = root.querySelector<HTMLElement>(`[data-field-id="${this.pendingFieldReveal}"]`);
      if (node) {
        node.scrollIntoView({ block: "nearest" });
        if (!root.contains(root.ownerDocument.activeElement) || root.ownerDocument.activeElement === root.ownerDocument.body) {
          node.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        }
        node.addClass("is-revealed");
      }
      this.pendingFieldReveal = null;
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
    const active = root.querySelector<HTMLElement>(`[data-focus-key="${snapshot.focusKey}"]`);
    active?.focus({ preventScroll: true });
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      && snapshot.selectionStart !== null
      && snapshot.selectionEnd !== null
    ) active.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }

  private iconButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = container.createEl("button", { cls: "clickable-icon mdbase-icon-button" });
    button.setAttr("aria-label", label);
    button.setAttr("title", label);
    button.setAttr("data-focus-key", `action-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    setIcon(button, icon);
    return button;
  }

  private disclosure(container: HTMLElement, key: string, label: string, initiallyOpen = false): HTMLDivElement {
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
    for (const [destination, label] of [["types", "Types"], ["sync", "Sync"], ["issues", "Issues"]] as const) {
      const button = nav.createEl("button", { text: label, cls: "clickable-icon" });
      button.addClass("mdbase-nav-button");
      button.setAttr("role", "tab");
      button.setAttr("data-focus-key", `destination-${destination}`);
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
      empty.createEl("h2", { text: "No collection" });
      empty.createEl("p", { text: "Initialize to manage a local collection in this vault. Connect to mirror a collection already hosted in Connect." });
      const actions = empty.createDiv({ cls: "mdbase-actions" });
      const initialize = actions.createEl("button", { text: "Initialize collection" });
      initialize.addClass("mod-cta");
      initialize.disabled = this.busy || this.host.getMirrorProfile() !== null;
      initialize.onclick = () => void this.perform(async () => {
        await this.host.initializeCollection();
        await this.refresh(true);
      });
      const connect = actions.createEl("button", { text: "Connect collection" });
      connect.onclick = () => this.showDestination("sync");
      return;
    }

    if (this.schema.config.spec_version.startsWith("0.2.")) {
      this.renderLegacyBanner(container);
    }

    if (!this.typeEntries().length && !this.model) {
      const welcome = container.createDiv({ cls: "mdbase-empty-state" });
      welcome.createEl("h2", { text: "Add your first type" });
      welcome.createEl("p", { text: "Install ready-made types and application contracts from mdbase-contracts, or design your own type." });
      const actions = welcome.createDiv({ cls: "mdbase-actions" });
      const install = actions.createEl("button", { text: "Browse ready-made types", cls: "mod-cta" });
      install.disabled = this.busy || this.schema.config.spec_version.startsWith("0.2.") || this.host.getMirrorProfile() !== null;
      install.onclick = () => void this.perform(() => this.host.openContractCatalog());
      const custom = actions.createEl("button", { text: "Design a custom type" });
      custom.disabled = this.schema.config.spec_version.startsWith("0.2.") || this.host.getMirrorProfile()?.mode === "read_only";
      custom.onclick = () => void this.createType();
      return;
    }
    const layout = container.createDiv({ cls: "mdbase-types-layout" });
    if (this.model) layout.addClass("has-selection");
    this.renderTypeList(layout);
    this.renderTypeEditor(layout);
  }

  private renderLegacyBanner(container: HTMLElement): void {
    const banner = container.createDiv({ cls: "mdbase-legacy-banner" });
    const text = banner.createDiv();
    text.createEl("strong", { text: "Read-only · v0.2 collection" });
    text.createEl("p", { text: "Migrate to edit types." });
    if (!this.migrationPlan) {
      const button = banner.createEl("button", { text: "Review migration" });
      button.disabled = this.busy || this.host.getMirrorProfile() !== null;
      button.onclick = () => void this.perform(async () => {
        this.migrationPlan = await this.host.analyzeMigration();
        this.render();
      });
    }
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
    const catalog = this.iconButton(header, "download", "Browse ready-made types");
    catalog.disabled = this.busy || this.schema?.config.spec_version.startsWith("0.2.") === true || this.host.getMirrorProfile() !== null;
    catalog.onclick = () => void this.perform(() => this.host.openContractCatalog());
    const createBlocked = (this.schema?.config.spec_version.startsWith("0.2.") ?? true)
      ? "Migrate to v0.3 to create types"
      : this.host.getMirrorProfile()?.mode === "read_only" ? "Read-only mirror" : "";
    const add = this.iconButton(header, "plus", createBlocked ? `Create type · ${createBlocked}` : "Create type");
    add.disabled = Boolean(createBlocked);
    add.onclick = () => void this.createType();

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
    const { stats } = this.currentStats();
    for (const type of entries) {
      const button = list.createEl("button", { cls: "mdbase-type-row" });
      if (type.filePath === this.selectedPath) button.addClass("is-active");
      button.setAttr("aria-current", type.filePath === this.selectedPath ? "true" : "false");
      const nameLine = button.createDiv({ cls: "mdbase-type-name-line" });
      nameLine.createSpan({ cls: "mdbase-type-name", text: type.name });
      const unsaved = type.filePath === this.selectedPath ? this.dirty : this.host.loadTypeDraft(type.filePath) !== null;
      if (unsaved) {
        const dot = nameLine.createSpan({ cls: "mdbase-unsaved-dot" });
        dot.setAttr("aria-label", "Unsaved changes");
        dot.setAttr("title", "Unsaved changes");
      }
      const typeStat = stats.get(type.name);
      if (this.records) {
        const meta = button.createDiv({ cls: "mdbase-type-meta" });
        const notes = typeStat?.notes ?? 0;
        meta.createSpan({ text: `${notes.toLocaleString()} ${notes === 1 ? "note" : "notes"}` });
        if (typeStat?.issues) {
          meta.createSpan({
            cls: "mdbase-type-issues",
            text: `${typeStat.issues.toLocaleString()} ${typeStat.issues === 1 ? "issue" : "issues"}`,
          });
        }
      }
      button.onclick = () => void this.selectType(type.filePath);
    }
  }

  private renderTypeEditor(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-editor-pane" });
    pane.setAttr("data-scroll-key", "type-editor");
    if (!this.model) {
      const empty = pane.createDiv({ cls: "mdbase-empty-state" });
      empty.createEl("p", { text: "Select a type" });
      return;
    }
    const mirrorReadOnly = this.host.getMirrorProfile()?.mode === "read_only";
    const readOnly = this.model.specProfile === "v0.2" || mirrorReadOnly || Boolean(this.model.readOnlyReason);
    const readOnlyReason = this.model.readOnlyReason
      ?? (mirrorReadOnly
        ? "Read-only mirror. Reconnect with write access to edit."
        : "Migrate this v0.2 collection to edit types.");
    const header = pane.createDiv({ cls: "mdbase-editor-header" });
    const back = this.iconButton(header, "arrow-left", "Back to type list");
    back.addClass("mdbase-mobile-back");
    back.onclick = () => void this.leaveCurrentType().then(() => {
      this.selectedPath = null;
      this.model = null;
      this.originalModel = null;
      this.render();
    });
    const heading = header.createDiv({ cls: "mdbase-editor-heading" });
    const titleLine = heading.createDiv({ cls: "mdbase-editor-title-line" });
    titleLine.createEl("h2", { text: this.model.name || "Untitled type" });
    heading.createDiv({ cls: "mdbase-editor-path", text: this.selectedPath ?? "New type" });

    const headerActions = header.createDiv({ cls: "mdbase-editor-actions" });
    if (this.selectedPath) {
      const selectedPath = this.selectedPath;
      const source = this.iconButton(headerActions, "file-code", "Open source");
      source.onclick = () => void this.host.openFileByPath(selectedPath);
    }

    if (this.selectedPath) {
      const name = this.model.name;
      const create = headerActions.createEl("button", { text: "New note" });
      create.disabled = readOnly || this.busy;
      create.onclick = () => void this.host.createNoteFromType(name);
      this.renderStaleDrafts(pane);
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
      button.id = `mdbase-mode-${value}`;
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

  private renderStaleDrafts(container: HTMLElement): void {
    if (!this.selectedPath || !this.originalModel) return;
    const path = this.selectedPath;
    const active = this.host.loadTypeDraft(path);
    const drafts = [...this.host.getArchivedTypeDrafts(path),
      ...(active && active.sourceRevision !== (this.originalModel.sourceRevision ?? null) ? [active] : [])];
    for (const draft of drafts) {
      const row = container.createDiv({ cls: "mdbase-recovery-card" });
      row.createDiv({ text: `An older draft from ${new Date(draft.updatedAt).toLocaleString()} is available. The source changed; it will not be applied automatically.` });
      const compare = row.createEl("button", { text: "Compare draft" });
      compare.onclick = () => {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Current source and recovered draft");
        let draftText = draft.yamlDraft;
        if (draftText === undefined) {
          try { draftText = formatMarkdown(frontmatterFromReadableModel(draft.model), draft.model.body); }
          catch { draftText = JSON.stringify(draft.model, null, 2); }
        }
        modal.contentEl.createEl("h3", { text: "Current source" });
        modal.contentEl.createEl("pre", { text: this.originalModel ? formatMarkdown(frontmatterFromReadableModel(this.originalModel), this.originalModel.body) : this.yamlDraft });
        modal.contentEl.createEl("h3", { text: "Recovered draft (read-only)" });
        modal.contentEl.createEl("pre", { text: draftText });
        modal.contentEl.createEl("p", { text: "Copy the parts you want into the current definition, then review before saving." });
        modal.open();
      };
      const exportDraft = row.createEl("button", { text: "Export draft" });
      exportDraft.onclick = () => void this.perform(async () => {
        const folder = "mdbase-draft-recovery";
        if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        const file = await this.app.vault.create(`${folder}/draft-${crypto.randomUUID()}.txt`, draft.yamlDraft ?? JSON.stringify(draft.model, null, 2));
        this.transientMessage = `Exported recovery draft to ${file.path}. The original draft is still retained.`;
      });
      const discard = row.createEl("button", { text: "Discard old draft" });
      discard.onclick = () => {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Discard this recovered draft?");
        modal.contentEl.createEl("p", { text: "This removes the saved recovery copy, not the current source or your current edits. Export it first if you might need it." });
        modal.contentEl.createEl("button", { text: "Cancel" }).onclick = () => modal.close();
        modal.contentEl.createEl("button", { text: "Discard old draft", cls: "mod-warning" }).onclick = () => {
          modal.close();
          void this.perform(async () => {
            if (draft === active) await this.host.clearTypeDraft(path);
            else await this.host.discardArchivedTypeDraft(draft);
          });
        };
        modal.open();
      };
    }
  }

  private renderDraftBar(container: HTMLElement, model: TypeEditorModel): void {
    const changes = describeTypeChanges(this.originalModel, model);
    const diagnostics = validateTypeDraft(model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.schema?.contracts.values(),
    });
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const highRiskCount = changes.filter((change) => change.risk === "high").length;
    const failing = this.newlyFailing();
    const yamlErrors = this.editorMode === "yaml"
      ? this.yamlProblems().filter((problem) => problem.severity === "error").length
      : 0;
    const bar = container.createDiv({ cls: "mdbase-draft-bar" });
    const summary = bar.createDiv({ cls: "mdbase-draft-summary" });
    const shownErrors = this.editorMode === "yaml" ? yamlErrors : errorCount;
    summary.setAttr("data-tone", shownErrors ? "error" : failing || highRiskCount ? "warning" : "normal");
    summary.createSpan({
      text: shownErrors ? `${shownErrors} ${shownErrors === 1 ? "error" : "errors"}`
        : failing ? `${failing} ${failing === 1 ? "note" : "notes"} would fail`
          : highRiskCount ? `${highRiskCount} high-impact ${highRiskCount === 1 ? "change" : "changes"}`
            : "Unsaved changes",
    });
    const actions = bar.createDiv({ cls: "mdbase-actions" });
    if (this.editorMode === "design") {
      const review = actions.createEl("button", { text: "Review" });
      review.onclick = () => {
        const target = this.containerEl.querySelector<HTMLElement>("#mdbase-section-review");
        const details = target?.closest("details");
        if (details) details.open = true;
        this.render();
        this.containerEl.querySelector("#mdbase-section-review")?.scrollIntoView({ block: "nearest" });
      };
    }
    const discard = actions.createEl("button", { text: "Discard" });
    discard.onclick = () => void this.discardCurrentType();
    const save = actions.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.disabled = (this.editorMode === "design" ? errorCount > 0 : yamlErrors > 0) || this.busy;
    save.onclick = () => void this.saveCurrentType();
  }

  private newlyFailing(): number {
    if (!this.dirty || !this.impact || "error" in this.impact) return 0;
    return this.impact.impact.failing.filter((record) => record.isNew).length;
  }

  private matchingLabel(): string {
    const count = this.impact && !("error" in this.impact)
      ? this.impact.impact.matched.length
      : this.savedTypeName() ? this.currentStats().stats.get(this.savedTypeName() ?? "")?.notes : undefined;
    return count === undefined || !this.records
      ? "Matching"
      : `Matching · ${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;
  }

  private savedTypeName(): string | null {
    if (!this.selectedPath || !this.schema) return null;
    return [...this.schema.types.values()].find((type) => type.filePath === this.selectedPath)?.name ?? null;
  }

  /** The notes this type (as drafted) matches, with notes gained or lost against the saved type. */
  private fillMatchPreview(container: HTMLElement): void {
    const result = this.impact;
    let matched: string[];
    let added: string[] = [];
    let removed: string[] = [];
    if (result && !("error" in result)) {
      ({ matched, added, removed } = result.impact);
    } else {
      const name = this.savedTypeName();
      if (!this.records || !name || (result && "error" in result && this.dirty)) {
        container.createDiv({
          cls: "mdbase-muted",
          text: !this.records ? "Counting notes…" : result && "error" in result ? "Fix errors to preview matching notes." : "Save the type to preview matching notes.",
        });
        return;
      }
      matched = [...this.currentStats().recordTypes].filter(([, names]) => names.includes(name)).map(([path]) => path);
    }
    const summary = container.createDiv({ cls: "mdbase-match-summary" });
    summary.createSpan({ text: `${matched.length.toLocaleString()} ${matched.length === 1 ? "note matches" : "notes match"}` });
    if (added.length) summary.createSpan({ cls: "mdbase-match-added", text: `${added.length} added` });
    if (removed.length) summary.createSpan({ cls: "mdbase-match-removed", text: `${removed.length} no longer match` });
    const addedSet = new Set(added);
    const ordered: Array<{ path: string; change: "added" | "removed" | null }> = [
      ...added.map((path) => ({ path, change: "added" as const })),
      ...removed.map((path) => ({ path, change: "removed" as const })),
      ...matched.filter((path) => !addedSet.has(path)).map((path) => ({ path, change: null })),
    ];
    if (!ordered.length) return;
    const limit = this.showAllMatches ? 200 : 5;
    const list = container.createDiv({ cls: "mdbase-match-list" });
    for (const entry of ordered.slice(0, limit)) {
      const row = list.createEl("button", { cls: "mdbase-match-row" });
      if (entry.change) {
        row.setAttr("data-change", entry.change);
        row.createSpan({
          cls: "mdbase-match-marker",
          text: entry.change === "added" ? "+" : "−",
          attr: { "aria-label": entry.change === "added" ? "Added" : "No longer matches" },
        });
      }
      row.createSpan({ text: entry.path });
      row.setAttr("title", `Open ${entry.path}`);
      row.onclick = () => void this.host.openFileByPath(entry.path);
    }
    if (ordered.length > 5) {
      const more = container.createEl("button", {
        cls: "mdbase-link-button",
        text: this.showAllMatches
          ? "Show fewer"
          : ordered.length > 200
            ? `Show 200 of ${ordered.length.toLocaleString()}`
            : `Show all ${ordered.length.toLocaleString()}`,
      });
      more.onclick = () => {
        this.showAllMatches = !this.showAllMatches;
        container.empty();
        this.fillMatchPreview(container);
      };
    }
  }

  /** What saving the draft would do to existing notes. */
  private fillImpact(container: HTMLElement): void {
    const result = this.impact;
    if (!result) {
      container.createDiv({ cls: "mdbase-muted", text: this.records ? "Checking notes…" : "Counting notes…" });
      return;
    }
    if ("error" in result) {
      container.createDiv({ cls: "mdbase-muted", text: "Fix errors to check existing notes." });
      return;
    }
    const { impact } = result;
    const newlyFailing = impact.failing.filter((record) => record.isNew);
    const alreadyFailing = impact.failing.length - newlyFailing.length;
    const heading = container.createDiv({ cls: "mdbase-impact-heading" });
    heading.setAttr("data-tone", newlyFailing.length ? "warning" : "normal");
    heading.createEl("strong", {
      text: newlyFailing.length
        ? `${newlyFailing.length} ${newlyFailing.length === 1 ? "note" : "notes"} would fail`
        : "No notes newly fail",
    });
    const facts = [`${impact.matched.length.toLocaleString()} ${impact.matched.length === 1 ? "note" : "notes"} checked`];
    if (impact.fixed) facts.push(`${impact.fixed} fixed`);
    if (alreadyFailing) facts.push(`${alreadyFailing} already failing`);
    heading.createSpan({ cls: "mdbase-muted", text: facts.join(" · ") });
    if (!newlyFailing.length) return;
    const list = container.createDiv({ cls: "mdbase-impact-list" });
    for (const record of newlyFailing.slice(0, 10)) {
      const row = list.createDiv({ cls: "mdbase-impact-row" });
      const open = row.createEl("button", { cls: "mdbase-link-button", text: record.path });
      open.onclick = () => void this.host.openFileByPath(record.path, record.issues[0]?.field);
      row.createSpan({
        cls: "mdbase-muted",
        text: `${record.issues[0]?.message ?? ""}${record.issues.length > 1 ? ` · +${record.issues.length - 1} more` : ""}`,
      });
    }
    if (newlyFailing.length > 10) {
      list.createDiv({ cls: "mdbase-muted", text: `${newlyFailing.length - 10} more notes` });
    }
  }

  private renderDesignEditor(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const diagnostics = validateTypeDraft(model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.schema?.contracts.values(),
    });
    const identity = container.createEl("section", { cls: "mdbase-editor-section" });
    identity.id = "mdbase-section-identity";
    const name = inputRow(identity, "Name", model.name, (value) => {
      model.name = value;
      this.markDirty();
    });
    name.disabled = readOnly;
    const description = inputRow(identity, "Description", model.description, (value) => {
      model.description = value;
      this.markDirty();
    }, { multiline: true });
    description.disabled = readOnly;
    const options = this.disclosure(container, "type-options", "Options");
    const displayRow = options.createDiv({ cls: "mdbase-form-row" });
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
    const strictRow = options.createEl("label", { cls: "mdbase-checkbox-row" });
    const strict = strictRow.createEl("input", { type: "checkbox" });
    strict.checked = model.strictMode === true;
    strict.disabled = readOnly;
    strict.onchange = () => {
      model.strictMode = strict.checked;
      this.markDirty();
    };
    strictRow.createSpan({ text: "Reject undeclared fields" });

    const membership = this.disclosure(container, "type-matching", this.matchingLabel());
    membership.id = "mdbase-section-membership";
    this.fillMatchPreview(membership.createDiv({ cls: "mdbase-match-preview" }));
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
    const headerActions = fieldsHeader.createDiv({ cls: "mdbase-section-actions" });
    if (this.expandedFields.size) {
      const collapse = this.iconButton(headerActions, "fold-vertical", "Collapse all fields");
      collapse.onclick = () => {
        this.expandedFields.clear();
        this.render();
      };
    }
    const addField = this.iconButton(headerActions, "plus", "Add field");
    addField.disabled = readOnly;
    addField.onclick = () => {
      const definition: Record<string, unknown> = { type: "string" };
      model.fields.push({ name: "", definition });
      this.expandedFields.add(this.fieldId(definition));
      this.markDirty(true);
    };
    if (model.fields.length > 6 || this.fieldQuery) {
      const fieldToolbar = fields.createDiv({ cls: "mdbase-field-toolbar" });
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
    }
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

    // Keep the common editing surface (name, description, fields) first.
    if (membership.parentElement) container.appendChild(membership.parentElement);
    if (options.parentElement) container.appendChild(options.parentElement);
    const placement = options;
    const path = inputRow(placement, "Path pattern", model.pathPattern, (value) => {
      model.pathPattern = value;
      this.markDirty();
    }, { placeholder: "Notes/{title}.md" });
    path.disabled = readOnly;

    this.renderContractEditor(container, model, readOnly);

    if (!this.dirty && !diagnostics.length) return;
    const review = this.disclosure(container, "type-review", "Changes", diagnostics.some((item) => item.severity === "error"));
    review.id = "mdbase-section-review";
    if (this.dirty) this.fillImpact(review.createDiv({ cls: "mdbase-impact" }));
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
    if (this.dirty) {
      const list = review.createEl("ul");
      for (const change of describeTypeChanges(this.originalModel, model)) {
        const item = list.createEl("li", { text: change.summary });
        item.setAttr("data-risk", change.risk);
      }
    }
  }

  private renderContractEditor(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const section = this.disclosure(container, "type-applications", "Applications");
    section.addClass("mdbase-contracts-section");
    section.id = "mdbase-section-applications";

    const contracts = [...(this.schema?.contracts.values() ?? [])];
    const implemented = new Set(model.implementations.map((implementation) => `${implementation.contract}@${implementation.version}`));
    const available = contracts.filter((contract) => !implemented.has(contractKey(contract)));

    if (!contracts.length) {
      section.createDiv({
        cls: "mdbase-contract-empty",
        text: "No application contracts installed.",
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
      const button = add.createEl("button", { text: "Add contract" });
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
    const fields = this.model?.fields ?? [];
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
      onMove: (offset) => {
        const target = index + offset;
        if (target < 0 || target >= fields.length) return;
        [fields[index], fields[target]] = [fields[target], fields[index]];
        this.pendingFieldReveal = this.fieldId(field.definition);
        this.markDirty(true);
      },
      canMoveUp: index > 0,
      canMoveDown: index < fields.length - 1,
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
      onMove?: (offset: -1 | 1) => void;
      canMoveUp?: boolean;
      canMoveDown?: boolean;
      readOnly: boolean;
      depth: number;
    },
  ): void {
    const node = container.createEl("details", { cls: "mdbase-field-node" });
    node.setAttr("data-depth", String(options.depth));
    const fieldId = this.fieldId(definition);
    node.setAttr("data-field-id", fieldId);
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
    const label = options.name || options.staticLabel || "Unnamed field";
    const summary = node.createEl("summary", { cls: "mdbase-field-summary" });
    summary.setAttr("data-focus-key", `field-${fieldId}-summary`);
    const chevron = summary.createSpan({ cls: "mdbase-field-chevron" });
    chevron.setAttr("aria-hidden", "true");
    setIcon(chevron, "chevron-right");
    summary.createSpan({ cls: "mdbase-field-summary-name", text: label });
    summary.createSpan({ cls: "mdbase-field-summary-type", text: fieldTypeLabel(definitionType(definition)) });
    const rules = summary.createSpan({ cls: "mdbase-field-summary-rules" });
    const refreshSummary = () => {
      rules.textContent = fieldConstraintSummary(definition).join(" · ");
    };
    refreshSummary();
    if (options.required) summary.createSpan({ cls: "mdbase-field-summary-rule", text: "Required" });
    if (options.onMove && !options.readOnly) {
      summary.addEventListener("keydown", (event: KeyboardEvent) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        if (event.key === "ArrowUp" && options.canMoveUp) options.onMove?.(-1);
        if (event.key === "ArrowDown" && options.canMoveDown) options.onMove?.(1);
      });
    }
    const row = node.createDiv({ cls: "mdbase-field-row" });

    if (options.staticLabel) {
      row.createDiv({ cls: "mdbase-field-role", text: options.staticLabel });
    } else {
      const name = row.createEl("input", { type: "text", cls: "mdbase-field-name-control" });
      name.setAttr("data-focus-key", `field-${fieldId}-name`);
      name.setAttr("aria-label", options.nameLabel);
      name.placeholder = "Field name";
      name.value = options.name ?? "";
      name.disabled = options.readOnly;
      if (options.onNameInput) name.oninput = () => options.onNameInput?.(name.value);
      if (options.onNameCommit) name.onchange = () => options.onNameCommit?.(name.value, name);
    }

    const type = row.createEl("select", { cls: "mdbase-field-type-control" });
    type.setAttr("data-focus-key", `field-${fieldId}-type`);
    type.setAttr("aria-label", `${options.name || options.staticLabel || "Field"} type`);
    for (const value of FIELD_TYPES) type.createEl("option", { value, text: fieldTypeLabel(value) });
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
      // Rules that do not apply to the new type would be dropped on save; drop them now so the row is honest.
      if (type.value !== "integer" && type.value !== "number") {
        delete definition.min;
        delete definition.max;
      }
      if (type.value !== "string") delete definition.pattern;
      if (!["string", "list"].includes(type.value)) {
        delete definition.min_length;
        delete definition.max_length;
      }
      delete definition.default;
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

    if (options.onRemove || options.onMove) {
      const more = this.iconButton(row, "more-horizontal", `${label} actions`);
      more.addClass("mdbase-field-menu");
      more.setAttr("data-focus-key", `field-${fieldId}-menu`);
      more.disabled = options.readOnly;
      more.onclick = (event) => {
        const menu = new Menu();
        if (options.onMove) {
          menu.addItem((item) => item.setTitle("Move up").setIcon("arrow-up")
            .setDisabled(!options.canMoveUp).onClick(() => options.onMove?.(-1)));
          menu.addItem((item) => item.setTitle("Move down").setIcon("arrow-down")
            .setDisabled(!options.canMoveDown).onClick(() => options.onMove?.(1)));
        }
        if (options.onRemove) {
          if (options.onMove) menu.addSeparator();
          menu.addItem((item) => {
            item.setTitle("Remove field").setIcon("trash-2").onClick(() => options.onRemove?.());
            item.setWarning(true);
          });
        }
        if (event.detail === 0) {
          const rect = more.getBoundingClientRect();
          menu.showAtPosition({ x: rect.left, y: rect.bottom });
        } else menu.showAtMouseEvent(event);
      };
    }

    const typeName = definitionType(definition);
    this.renderConstraintControls(node, definition, typeName, options, refreshSummary);
    if (typeName === "enum") this.renderEnumFieldDetails(node, definition, options, refreshSummary);
    if (typeName === "link") this.renderLinkFieldDetails(node, definition, options);
    if (typeName === "list") this.renderListFieldDetails(node, definition, options);
    if (typeName === "object") this.renderObjectFieldDetails(node, definition, options);
  }

  /** Bounds, pattern and default for the field's type; the rules mdbase validates records against. */
  private renderConstraintControls(
    node: HTMLElement,
    definition: Record<string, unknown>,
    typeName: string,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
    refreshSummary: () => void,
  ): void {
    const numeric = typeName === "integer" || typeName === "number";
    const controls: Array<[key: string, label: string]> = numeric
      ? [["min", "Minimum"], ["max", "Maximum"]]
      : typeName === "string"
        ? [["min_length", "Min length"], ["max_length", "Max length"]]
        : typeName === "list"
          ? [["min_length", "Min items"], ["max_length", "Max items"]]
          : [];
    const supportsDefault = !["list", "object", "any", "link"].includes(typeName);
    if (!controls.length && typeName !== "string" && !supportsDefault) return;
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-constraints" });
    const fieldLabel = options.name || options.staticLabel || "Field";
    const fieldId = this.fieldId(definition);
    for (const [key, label] of controls) {
      const cell = details.createDiv({ cls: "mdbase-constraint" });
      const labelEl = cell.createEl("label", { text: label });
      const input = cell.createEl("input", { type: "number" });
      input.id = `mdbase-${fieldId}-${key}`;
      labelEl.htmlFor = input.id;
      input.setAttr("data-focus-key", `field-${fieldId}-${key}`);
      input.setAttr("aria-label", `${fieldLabel} ${label.toLowerCase()}`);
      if (key.endsWith("length") || typeName === "integer") input.step = "1";
      if (key.endsWith("length")) input.min = "0";
      input.value = typeof definition[key] === "number" ? String(definition[key]) : "";
      input.disabled = options.readOnly;
      input.oninput = () => {
        const value = input.value.trim() === "" ? NaN : Number(input.value);
        if (Number.isFinite(value)) definition[key] = value;
        else delete definition[key];
        refreshSummary();
        this.markDirty();
      };
    }
    if (typeName === "string") {
      const cell = details.createDiv({ cls: "mdbase-constraint mdbase-constraint-wide" });
      const labelEl = cell.createEl("label", { text: "Pattern" });
      const input = cell.createEl("input", { type: "text" });
      input.id = `mdbase-${fieldId}-pattern`;
      labelEl.htmlFor = input.id;
      input.setAttr("data-focus-key", `field-${fieldId}-pattern`);
      input.setAttr("aria-label", `${fieldLabel} pattern`);
      input.placeholder = "Regular expression";
      input.spellcheck = false;
      input.value = typeof definition.pattern === "string" ? definition.pattern : "";
      input.disabled = options.readOnly;
      input.oninput = () => {
        if (input.value) definition.pattern = input.value;
        else delete definition.pattern;
        refreshSummary();
        this.markDirty();
      };
    }
    if (!supportsDefault) return;
    const cell = details.createDiv({ cls: "mdbase-constraint mdbase-constraint-wide" });
    const labelEl = cell.createEl("label", { text: "Default" });
    const controlId = `mdbase-${fieldId}-default`;
    labelEl.htmlFor = controlId;
    if (typeName === "enum" || typeName === "boolean") {
      const select = cell.createEl("select");
      select.id = controlId;
      select.setAttr("data-focus-key", `field-${fieldId}-default`);
      select.createEl("option", { value: "", text: "None" });
      const choices = typeName === "boolean" ? [true, false] : Array.isArray(definition.values) ? definition.values : [];
      for (const [index, choice] of choices.entries()) select.createEl("option", { value: String(index), text: scalarText(choice) });
      const current = choices.findIndex((choice) => JSON.stringify(choice) === JSON.stringify(definition.default));
      if (definition.default !== undefined && current === -1) {
        select.createEl("option", { value: "missing", text: `${scalarText(definition.default)} · not allowed` });
        select.value = "missing";
      } else select.value = current === -1 ? "" : String(current);
      select.disabled = options.readOnly;
      select.onchange = () => {
        if (select.value === "") delete definition.default;
        else if (select.value !== "missing") definition.default = choices[Number(select.value)];
        refreshSummary();
        this.markDirty();
      };
      return;
    }
    const input = cell.createEl("input", { type: "text" });
    input.id = controlId;
    input.setAttr("data-focus-key", `field-${fieldId}-default`);
    input.setAttr("aria-label", `${fieldLabel} default`);
    input.placeholder = typeName === "date" ? "YYYY-MM-DD" : typeName === "time" ? "HH:MM" : "None";
    input.value = definition.default === undefined ? "" : scalarText(definition.default);
    input.disabled = options.readOnly;
    const error = cell.createDiv({ cls: "mdbase-constraint-error" });
    input.oninput = () => {
      const parsed = parseDefaultValue(input.value, typeName);
      error.textContent = parsed.error ?? "";
      input.toggleClass("is-invalid", Boolean(parsed.error));
      if (parsed.error) return;
      if (parsed.value === undefined) delete definition.default;
      else definition.default = parsed.value;
      refreshSummary();
      this.markDirty();
    };
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

  /** One row per allowed value, so values can contain commas and keep their YAML types. */
  private renderEnumFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
    refreshSummary: () => void,
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-enum-values" });
    const fieldLabel = options.name || options.staticLabel || "Enum";
    const fieldId = this.fieldId(definition);
    details.createDiv({ cls: "mdbase-field-children-label", text: "Allowed values" });
    const values = Array.isArray(definition.values) ? definition.values : [];
    if (!Array.isArray(definition.values) && !options.readOnly) definition.values = values;
    const list = details.createDiv({ cls: "mdbase-enum-list" });
    list.setAttr("role", "list");
    const mixedTypes = new Set(values.map((value) => typeof value)).size > 1;
    for (const [index, value] of values.entries()) {
      const row = list.createDiv({ cls: "mdbase-enum-row" });
      row.setAttr("role", "listitem");
      const input = row.createEl("input", { type: "text" });
      input.setAttr("data-focus-key", `field-${fieldId}-value-${index}`);
      input.setAttr("aria-label", `${fieldLabel} allowed value ${index + 1}`);
      input.value = scalarText(value);
      input.disabled = options.readOnly;
      input.oninput = () => {
        values[index] = parseEnumValue(input.value, value, values.filter((_, other) => other !== index));
        refreshSummary();
        this.markDirty();
      };
      input.onkeydown = (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        values.splice(index + 1, 0, "");
        this.pendingFocusKey = `field-${fieldId}-value-${index + 1}`;
        this.markDirty(true);
      };
      // Types only need calling out when a list mixes them, e.g. `1` beside `"1"`.
      if (mixedTypes) row.createSpan({ cls: "mdbase-enum-kind", text: typeof value });
      for (const [icon, label, offset] of [["arrow-up", "Move value up", -1], ["arrow-down", "Move value down", 1]] as const) {
        const move = this.iconButton(row, icon, `${label}: ${scalarText(value)}`);
        move.disabled = options.readOnly || index + offset < 0 || index + offset >= values.length;
        move.onclick = () => {
          [values[index], values[index + offset]] = [values[index + offset], values[index]];
          this.markDirty(true);
        };
      }
      const remove = this.iconButton(row, "x", `Remove value ${scalarText(value)}`);
      remove.disabled = options.readOnly;
      remove.onclick = () => {
        values.splice(index, 1);
        this.markDirty(true);
      };
    }
    const add = details.createEl("button", { cls: "mdbase-link-button", text: "Add value" });
    add.disabled = options.readOnly;
    add.onclick = () => {
      values.push("");
      this.pendingFocusKey = `field-${fieldId}-value-${values.length - 1}`;
      this.markDirty(true);
    };
  }

  private renderLinkFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-options" });
    const fieldId = this.fieldId(definition);
    const targetLabel = details.createEl("label", { text: "Target type" });
    const target = details.createEl("select");
    target.setAttr("data-focus-key", `field-${fieldId}-target`);
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
    targetLabel.htmlFor = target.id = `mdbase-${fieldId}-target`;
    const existsLabel = details.createEl("label", { cls: "mdbase-field-required" });
    const exists = existsLabel.createEl("input", { type: "checkbox" });
    exists.setAttr("data-focus-key", `field-${fieldId}-exists`);
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
    children.createDiv({ cls: "mdbase-field-children-label", text: "Object fields" });
    const fields = isRecord(definition.fields) ? definition.fields : {};
    if (!isRecord(definition.fields) && !options.readOnly) definition.fields = fields;
    const list = children.createDiv({ cls: "mdbase-nested-fields" });
    const add = children.createEl("button", { cls: "mdbase-link-button", text: "Add nested field" });
    add.disabled = options.readOnly;
    add.onclick = () => {
      const name = nextNestedFieldName(fields);
      setOwnField(fields, name, { type: "string" });
      this.expandedFields.add(this.fieldId(fields[name] as Record<string, unknown>));
      this.markDirty(true);
    };
    const entries = Object.entries(fields).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: "No nested fields." });
      return;
    }
    for (const [position, [initialName, childDefinition]] of entries.entries()) {
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
        onMove: (offset) => {
          const keys = Object.keys(fields);
          const from = keys.indexOf(currentName);
          const to = from + offset;
          if (from === -1 || to < 0 || to >= keys.length) return;
          [keys[from], keys[to]] = [keys[to], keys[from]];
          const ordered = keys.map((key) => [key, fields[key]] as const);
          for (const key of keys) delete fields[key];
          for (const [key, value] of ordered) if (isRecord(value)) setOwnField(fields, key, value);
          this.pendingFieldReveal = this.fieldId(childDefinition);
          this.markDirty(true);
        },
        canMoveUp: position > 0,
        canMoveDown: position < entries.length - 1,
        readOnly: options.readOnly,
        depth: options.depth + 1,
      });
    }
  }

  private renderYamlEditor(container: HTMLElement, readOnly: boolean): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-yaml-section" });
    // Problems sit above the editor so they are visible without scrolling past a long type.
    this.fillYamlProblems(section.createDiv({ cls: "mdbase-yaml-problems" }));
    const editor = this.ensureYamlEditor(readOnly);
    if (editor) {
      section.appendChild(editor.dom);
    } else {
      const textarea = section.createEl("textarea", { cls: "mdbase-yaml-editor" });
      textarea.setAttr("aria-label", "Type definition YAML");
      textarea.setAttr("data-focus-key", "yaml-editor");
      textarea.value = this.yamlDraft;
      textarea.disabled = readOnly;
      textarea.spellcheck = false;
      textarea.oninput = () => this.onYamlInput(textarea.value);
    }
  }

  /** One CodeMirror instance per open type, re-attached on every render so history and cursor survive. */
  private ensureYamlEditor(readOnly: boolean): YamlSourceEditor | null {
    try {
      if (!this.yamlEditor) {
        this.yamlEditor = new YamlSourceEditor({
          doc: this.yamlDraft,
          readOnly,
          labelledBy: "mdbase-mode-yaml",
          onChange: (doc) => this.onYamlInput(doc),
        });
      } else {
        this.yamlEditor.setValue(this.yamlDraft);
        this.yamlEditor.setReadOnly(readOnly);
      }
      this.yamlEditor.setProblems(this.yamlProblems());
      return this.yamlEditor;
    } catch (error) {
      // CodeMirror is supplied by Obsidian; a plain textarea keeps YAML editable without it.
      console.error("mdbase: YAML editor unavailable", error);
      this.yamlEditor = null;
      return null;
    }
  }

  private onYamlInput(value: string): void {
    this.yamlDraft = value;
    this.markDirty(false);
    if (this.yamlProblemTimer !== null) window.clearTimeout(this.yamlProblemTimer);
    this.yamlProblemTimer = window.setTimeout(() => {
      this.yamlProblemTimer = null;
      const problems = this.yamlProblems();
      this.yamlEditor?.setProblems(problems);
      const list = this.containerEl.querySelector<HTMLElement>(".mdbase-yaml-problems");
      if (list) {
        list.empty();
        this.fillYamlProblems(list, problems);
      }
    }, 250);
  }

  private fillYamlProblems(container: HTMLElement, problems = this.yamlProblems()): void {
    if (!this.dirty || !problems.length) return;
    for (const problem of problems.slice(0, 20)) {
      const row = container.createEl("button", { cls: "mdbase-yaml-problem" });
      row.setAttr("data-severity", problem.severity);
      row.createSpan({ cls: "mdbase-yaml-problem-line-number", text: problem.line ? `Line ${problem.line}` : "Type" });
      row.createSpan({ text: problem.message });
      row.disabled = problem.line === null;
      if (problem.line !== null) {
        const line = problem.line;
        row.onclick = () => this.yamlEditor?.revealLine(line);
      }
    }
  }

  private renderSync(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-sync-document" });
    const profile = this.host.getMirrorProfile();
    if (!profile) {
      this.renderEnrollment(document);
      return;
    }
    this.syncProblem = this.host.getCurrentSyncProblem() ?? this.syncProblem;

    const status = document.createEl("section", { cls: "mdbase-sync-status" });
    status.setAttr("data-state", this.mirrorStatus?.state ?? "checking");
    const heading = status.createDiv({ cls: "mdbase-sync-heading" });
    heading.createEl("h2", { text: profile.name });
    heading.createDiv({ cls: "mdbase-muted", text:
      `${this.fileProgress || this.mirrorProgress ? "Syncing" : syncStateLabel(this.mirrorStatus)} · ${relativeTime(this.mirrorStatus?.last_synced_at)}`,
    });
    heading.createDiv({ cls: "mdbase-muted mdbase-sync-scope", text: this.syncScopeText(profile.mode) });

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
      const cancel = progressArea.createEl("button", { text: "Stop" });
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
    const upToDate = this.mirrorStatus?.state === "up_to_date" && !this.mirrorStatus.pending;
    const hasProblem = Boolean(this.syncProblem || this.mirrorStatus?.recovery_required);
    const preview = this.mirrorPreview
      ? this.iconButton(actions, "refresh-cw", "Refresh review")
      : actions.createEl("button", {
        text: upToDate ? "Check for changes" : "Review changes",
        cls: upToDate || hasProblem ? "" : "mod-cta",
      });
    preview.disabled = this.busy;
    preview.onclick = () => void this.reviewSyncChanges();
    const syncPresentation = syncReviewPresentation(
      this.mirrorPreview?.plan ?? null,
      this.mirrorPreview?.entries.length ?? 0,
      this.busy,
    );
    if (this.mirrorPreview?.plan.actions.length && !syncPresentation.actionDisabled) {
      const sync = actions.createEl("button", { text: syncPresentation.actionLabel, cls: "mod-cta" });
      sync.disabled = syncPresentation.actionDisabled;
      sync.onclick = () => void this.perform(() => this.applyReviewedSync());
    }

    if (this.mirrorPreview) this.renderMirrorPreview(document, this.mirrorPreview);
    if (this.mirrorStatus?.conflicts.length) this.renderConflicts(document, this.mirrorStatus);
    if (this.mirrorStatus?.local_issues.length && !this.mirrorPreview) {
      this.renderLocalMirrorIssues(document, this.mirrorStatus);
    }
    this.renderHistory(document);
    const settings = this.disclosure(document, "sync-settings", "Sync settings");
    this.renderFilePolicyControls(settings, { connected: true });
    this.renderConnectionDetails(settings, profile);
    window.setTimeout(() => this.focusPendingSyncSection(), 0);
  }

  private async loadMirrorPreview(): Promise<void> {
    this.previewComparisons.clear();
    this.transferPages.clear();
    this.mirrorPreview = await this.host.connectSync.preview();
    this.mirrorStatus = await this.host.connectSync.status();
    this.syncProblem = null;
    this.host.setSyncStatus(this.mirrorStatus);
    this.transientMessage = "";
  }

  private async applyReviewedSync(): Promise<void> {
    if (!this.mirrorPreview) {
      await this.loadMirrorPreview();
      return;
    }
    const reviewed = this.mirrorPreview;
    const collectionId = this.host.getMirrorProfile()?.collectionId;
    const startedAt = new Date().toISOString();
    const files: SyncHistoryFile[] = [];
    let runOutcome = "failed";
    let runMessage: string | undefined;
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
        (action, receipt) => {
          const file = historyFileFromReceipt(action, receipt, new Date().toISOString());
          if (file) files.push(file);
        },
      );
      runOutcome = outcome.status;
      runMessage = outcome.failure?.message;
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
        ? "Sync complete."
        : outcome.status === "attention"
          ? outcome.applied > 0 ? "Available changes synced. Remaining items need attention." : "No available changes. Resolve the listed items and review again."
          : outcome.status === "cancelled"
            ? `Sync paused safely after ${outcome.applied} actions; ${outcome.pending} remain.`
            : outcome.status === "stale"
              ? "Changes detected. Refresh the review."
              : `Sync stopped at a durable boundary: ${outcome.failure?.message ?? outcome.status}.`;
      // A completed run with file rows is already its own history entry.
      if (outcome.status !== "applied" || !files.length) await this.host.recordSyncActivity({
        summary: outcome.status === "applied"
          ? `Synchronized ${outcome.applied} ${outcome.applied === 1 ? "change" : "changes"}`
          : outcome.status === "cancelled"
            ? "Synchronization paused safely"
            : outcome.applied > 0 ? "Synced available changes" : "Synchronization needs attention",
        detail: this.transientMessage,
        tone: outcome.status === "applied" ? "success" : "attention",
        requiresAcknowledgement: outcome.status !== "applied",
      });
    } catch (error) {
      const problem = syncProblem(error);
      runOutcome = isAbortError(error) ? "cancelled" : "failed";
      runMessage = problem.message;
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
      if (collectionId && files.length) {
        await this.host.recordSyncHistory({
          id: crypto.randomUUID(),
          collectionId,
          startedAt,
          finishedAt: new Date().toISOString(),
          outcome: runOutcome,
          files,
          ...(runMessage ? { message: runMessage } : {}),
        });
      }
    }
  }

  /** Which part of this vault the mirror owns, and with what access. */
  private syncScopeText(mode: MirrorProfile["mode"]): string {
    const excluded = this.host.connectSync.getSelectiveSync().excluded_folders;
    const scope = excluded.length
      ? `Whole vault except ${excluded.length > 2 ? `${excluded.slice(0, 2).join(", ")} +${excluded.length - 2}` : excluded.join(", ")}`
      : "Whole vault";
    return `${mode === "read_only" ? "Read only" : "Read and write"} · ${scope}`;
  }

  private renderRecoveryCard(container: HTMLElement, problem: SyncProblem): void {
    const card = container.createDiv({ cls: "mdbase-recovery-card" });
    const text = card.createDiv();
    text.createEl("strong", { text: problem.title });
    text.createDiv({ text: problem.message });
    const action = card.createEl("button", { text: problem.actionLabel, cls: "mod-cta" });
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

  private renderHistory(container: HTMLElement): void {
    const entries = this.host.getSyncActivity();
    const runs = this.host.getSyncHistory();
    if (!entries.length && !runs.length) return;
    const section = this.disclosure(container, "sync-activity", "History", entries.some((entry) => entry.requiresAcknowledgement));
    section.addClass("mdbase-activity");
    section.id = "mdbase-sync-activity";
    for (const entry of [...entries].reverse().filter((candidate) => candidate.requiresAcknowledgement)) {
      this.renderActivityRow(section, entry);
    }

    const header = section.createDiv({ cls: "mdbase-section-header mdbase-history-controls" });
    if (runs.length) {
      const query = header.createEl("input", { type: "search" });
      query.setAttr("aria-label", "Filter history by path");
      query.setAttr("data-focus-key", "history-search");
      query.placeholder = "Filter by path";
      query.value = this.historyQuery;
      query.oninput = () => {
        this.historyQuery = query.value;
        this.historyLimit = HISTORY_PAGE;
        this.render();
      };
    }
    if (runs.length || entries.some((entry) => !entry.requiresAcknowledgement)) {
      const clear = header.createEl("button", { text: "Clear history" });
      clear.disabled = this.busy;
      clear.onclick = () => void Promise.all([
        this.host.clearSyncHistory(),
        this.host.clearCompletedSyncActivity(),
      ]).then(() => this.render());
    }

    const needle = this.historyQuery.trim().toLowerCase();
    const timeline: Array<{ at: string; run?: SyncHistoryRun; entry?: SyncActivityEntry }> = [
      ...filterRuns(runs, needle).map((run) => ({ at: run.finishedAt, run })),
      ...entries
        .filter((entry) => !entry.requiresAcknowledgement)
        .filter((entry) => !needle || entry.path?.toLowerCase().includes(needle))
        .map((entry) => ({ at: entry.occurredAt, entry })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    if (!timeline.length) {
      section.createDiv({ cls: "mdbase-muted", text: needle ? "No synced files match." : "No completed syncs." });
      return;
    }
    for (const item of timeline.slice(0, this.historyLimit)) {
      if (item.run) this.renderHistoryRun(section, item.run, needle !== "");
      else if (item.entry) this.renderActivityRow(section, item.entry);
    }
    if (timeline.length > this.historyLimit) {
      const more = section.createEl("button", { cls: "mdbase-link-button", text: `Show ${Math.min(HISTORY_PAGE, timeline.length - this.historyLimit)} more` });
      more.setAttr("data-focus-key", "history-more");
      more.onclick = () => {
        this.historyLimit += HISTORY_PAGE;
        this.render();
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
      details.open = this.disclosures.get(key) ?? false;
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
      if (file.action !== "delete" && this.app.vault.getAbstractFileByPath(file.path)) {
        const open = pathLine.createEl("button", { cls: "mdbase-link-button mdbase-transfer-open" });
        open.createEl("code", { text: file.path });
        open.setAttr("title", `Open ${file.path}`);
        open.onclick = () => void this.host.openFileByPath(file.path);
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

  private renderActivityRow(container: HTMLElement, entry: SyncActivityEntry): void {
    const row = container.createDiv({ cls: "mdbase-activity-row" });
    row.setAttr("data-tone", entry.tone);
    setIcon(row.createSpan(), entry.tone === "success" ? "check" : entry.tone === "info" ? "info" : "circle-alert");
    const body = row.createDiv();
    if (entry.detail && entry.detail !== entry.summary) {
      const details = body.createEl("details");
      details.createEl("summary", { text: entry.summary });
      details.createDiv({ text: entry.detail });
    } else body.createEl("strong", { text: entry.summary });
    body.createSpan({ cls: "mdbase-muted", text: formatHistoryTime(entry.occurredAt) });
    if (entry.requiresAcknowledgement) {
      const dismiss = row.createEl("button", { text: "Dismiss" });
      dismiss.disabled = this.busy;
      dismiss.onclick = () => void this.host.dismissSyncActivity(entry.id).then(() => this.render());
    }
  }

  private renderConnectionDetails(container: HTMLElement, profile: MirrorProfile): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-connection-details" });
    section.createEl("h3", { text: "Connection" });
    const values = section.createDiv({ cls: "mdbase-status-list" });
    renderStatus(values, "Collection", profile.name);
    renderStatus(values, "Collection ID", profile.collectionId);
    renderStatus(values, "Vault", this.app.vault.getName());
    renderStatus(values, "Access", profile.mode === "read_write" ? "Read and write" : "Read only");
    renderStatus(values, "Connect", new URL(profile.controlUrl).host);
    renderStatus(values, "Last successful sync", relativeTime(this.mirrorStatus?.last_synced_at));
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
    const details = target.closest("details");
    if (details) details.open = true;
    target.scrollIntoView({ block: "nearest" });
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
        this.render();
      };
      choice.createSpan({ text: label });
    }
    section.createDiv({ cls: "mdbase-form-description", text: "Attachments are limited to 32 MiB per file on desktop and mobile. Exclusions apply to both notes and attachments. Previously synced files remain in this vault; excluded paths no longer transfer. Excluding a folder does not delete hosted copies." });
    const folders = section.createDiv({ cls: "mdbase-form-row" });
    folders.createEl("label", { text: "Excluded folders", attr: { for: "mdbase-excluded-folder" } });
    const chips = folders.createDiv({ cls: "mdbase-folder-chips" });
    for (const path of policy.excluded_folders) {
      const chip = chips.createEl("button", { text: `${path} ×` });
      chip.setAttr("aria-label", `Remove exclusion ${path}`);
      chip.onclick = () => { policy.excluded_folders = policy.excluded_folders.filter(folder => folder !== path); this.render(); };
    }
    const input = folders.createEl("input", { type: "text", placeholder: "Choose or enter a folder" });
    input.id = "mdbase-excluded-folder";
    input.setAttr("data-focus-key", "excluded-folder-input");
    const list = folders.createEl("datalist");
    list.id = "mdbase-folder-options";
    input.setAttr("list", list.id);
    for (const folder of this.app.vault.getAllLoadedFiles().filter(file => file instanceof TFolder && file.path && file.path !== "/")) list.createEl("option", { value: folder.path });
    const error = folders.createDiv({ cls: "mdbase-inline-error", attr: { role: "alert" } });
    const add = folders.createEl("button", { text: "Exclude folder" });
    const addFolder = () => {
      const path = input.value.trim().replace(/\/+$/, "");
      if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
        error.textContent = "Choose a vault-relative folder without parent traversal or empty segments.";
        return;
      }
      if (!policy.excluded_folders.includes(path)) policy.excluded_folders.push(path);
      this.render();
    };
    add.onclick = addFolder;
    input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); addFolder(); } };
    const files = this.app.vault.getFiles();
    const excluded = files.filter(file => policy.excluded_folders.some(folder => file.path === folder || file.path.startsWith(`${folder}/`)));
    const notes = excluded.filter(file => file.extension === "md").length;
    section.createDiv({ cls: "mdbase-muted", text: `This device excludes ${notes} notes and ${excluded.length - notes} attachments currently in the vault.` });
    if (policy.file_classes.includes("other")) {
      section.createDiv({
        cls: "mdbase-inline-message",
        text: "Other files includes all remaining visible file formats.",
      });
    }
    if (!options.connected) return;
    const current = this.host.connectSync.getSelectiveSync();
    const changed = JSON.stringify(current) !== JSON.stringify(policy);
    const actions = section.createDiv({ cls: "mdbase-actions" });
    const apply = actions.createEl("button", { text: "Apply" });
    apply.disabled = !changed || this.busy;
    apply.onclick = () => void this.perform(async () => {
      await this.host.connectSync.configureSelectiveSync(policy);
      this.filePolicyDraft = null;
      this.mirrorPreview = null;
      this.transientMessage = "Sync settings updated. Review changes to continue.";
      this.render();
    });
  }

  private renderEnrollment(container: HTMLElement): void {
    if (this.schema || this.host.connectSync.getAdoptionMarker()) {
      this.renderLocalAdoption(container);
      return;
    }
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-enrollment" });
    section.createEl("h3", { text: "Connect collection" });
    section.createEl("p", { cls: "mdbase-muted", text: "Choose a collection in Connect, then review what will sync." });
    if (this.enrollmentVerification) {
      const approval = section.createDiv({ cls: "mdbase-approval-link" });
      approval.createSpan({ text: "Waiting for approval · " });
      const link = approval.createEl("a", {
        text: "Open Connect",
        href: this.enrollmentVerification,
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener noreferrer");
    }
    if (this.enrollmentAbort && this.enrollmentVerification) {
      const stop = section.createEl("button", { text: "Stop waiting" });
      stop.onclick = () => this.enrollmentAbort?.abort();
      return;
    }
    inputRow(section, "Device name", this.enrollmentMirrorName, (value) => {
      this.enrollmentMirrorName = value;
    });
    const access = section.createDiv({ cls: "mdbase-form-row" });
    const accessLabel = access.createEl("label", { text: "Access" });
    const select = access.createEl("select");
    accessLabel.htmlFor = select.id = "mdbase-enrollment-access";
    select.createEl("option", { value: "read_write", text: "Read and write" });
    select.createEl("option", { value: "read_only", text: "Read only" });
    select.value = this.enrollmentMode;
    select.onchange = () => {
      this.enrollmentMode = select.value === "read_only" ? "read_only" : "read_write";
      this.render();
    };
    const scope = section.createDiv({ cls: "mdbase-form-row mdbase-sync-target" });
    scope.createEl("label", { text: "Syncs" });
    const scopeValue = scope.createDiv({ cls: "mdbase-sync-target-value" });
    const excluded = this.filePolicy().excluded_folders;
    scopeValue.createSpan({
      text: `Whole vault “${this.app.vault.getName()}”${excluded.length ? ` except ${excluded.join(", ")}` : ""}`,
    });
    const change = scopeValue.createEl("button", { cls: "mdbase-link-button", text: "Exclude folders" });
    change.onclick = () => {
      this.disclosures.set("enrollment-options", true);
      this.render();
    };
    section.createEl("p", { cls: "mdbase-form-description", text: this.enrollmentMode === "read_write"
      ? "Existing notes may upload. Nothing moves until you review and sync."
      : "Downloads only. Existing local changes must be resolved or excluded.",
    });
    const advanced = this.disclosure(section, "enrollment-options", "Advanced");
    inputRow(advanced, "Connect URL", this.enrollmentControlUrl, (value) => {
      this.enrollmentControlUrl = value;
    }, { placeholder: DEFAULT_CONNECT_CONTROL_URL });
    inputRow(advanced, "Collection ID", this.enrollmentCollectionId, (value) => {
      this.enrollmentCollectionId = value;
    }, { placeholder: "Choose during approval" });
    this.renderFilePolicyControls(advanced, { connected: false });
    const enrollmentActions = section.createDiv({ cls: "mdbase-actions mdbase-enrollment-actions" });
    const button = enrollmentActions.createEl("button", { text: this.enrollmentAbort ? "Waiting for approval…" : "Connect" });
    button.setAttr("title", "Opens Connect in your browser to choose a collection");
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
            this.transientMessage = "";
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
        this.transientMessage = `Connected. Review ${items} ${items === 1 ? "item" : "items"}${bytes ? ` · ${formatBytes(bytes)}` : ""} before syncing.`;
        this.render();
      } catch (error) {
        if (!isAbortError(error)) throw error;
        this.enrollmentVerification = "";
        this.transientMessage = "Cancelled. No files synced.";
      } finally {
        if (this.enrollmentAbort === abort) this.enrollmentAbort = null;
      }
    });
    if (this.enrollmentAbort) {
      const cancel = enrollmentActions.createEl("button", { text: "Stop waiting" });
      cancel.onclick = () => {
        this.enrollmentAbort?.abort();
        this.enrollmentVerification = "";
        this.transientMessage = "Cancelled. No files synced.";
        this.render();
      };
    }
  }

  private renderLocalAdoption(container: HTMLElement): void {
    const checkpoint = this.host.connectSync.getAdoptionMarker();
    const recovery = checkpoint ? this.host.connectSync.getAdoptionRecovery() : null;
    const usesLiveFiles = !checkpoint || ["waiting_for_approval", "uploading"].includes(checkpoint.phase);
    const conflicts = usesLiveFiles ? this.adoptionPreview?.conflicts ?? [] : [];
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-enrollment" });
    section.createEl("h3", { text: "Host collection" });
    section.createEl("p", { cls: "mdbase-muted", text: recovery
      ? recovery.canReset
        ? "This move expired and its device authorization is missing. Reset setup to start again. Your files stay local."
        : recovery.canReconnect
          ? "Device authorization is unavailable. Reconnect to the hosted collection through Connect. This vault stays protected until approval succeeds."
          : `Device authorization is unavailable. Restore Obsidian's secret storage, or reset setup after ${new Date(checkpoint?.session.expiresAt ?? "").toLocaleString()}.`
      : this.busy && this.adoptionStage
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
          : "Move this collection to Connect. This vault becomes a synced copy.",
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
      const advanced = this.disclosure(section, "adoption-options", "Advanced");
      inputRow(advanced, "Connect URL", this.enrollmentControlUrl, (value) => {
        this.enrollmentControlUrl = value;
      }, { placeholder: DEFAULT_CONNECT_CONTROL_URL });
      this.renderFilePolicyControls(advanced, { connected: false });
    } else {
      const values = this.disclosure(section, "adoption-details", "Details");
      renderStatus(values, "Collection", checkpoint.session.requested.collectionId);
      renderStatus(values, "Phase", checkpoint.phase.replace(/_/g, " "));
      renderStatus(values, "Connect", checkpoint.session.controlUrl);
      const policy = this.host.connectSync.getSelectiveSync();
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
    if (!recovery) section.createEl("p", { cls: "mdbase-form-description", text: "Sync starts only after this move completes." });
    const actions = section.createDiv({ cls: "mdbase-actions mdbase-enrollment-actions" });
    if (!recovery && usesLiveFiles) {
      const check = actions.createEl("button", { text: "Check files" });
      check.disabled = this.busy;
      check.onclick = () => void this.perform(async () => {
        this.adoptionRenamePlan = null;
        this.adoptionPreview = await this.host.connectSync.previewAdoption(this.filePolicy());
        this.transientMessage = this.adoptionPreview.conflicts.length ? "Resolve the listed filename conflicts before continuing." : "Files checked. No filename conflicts.";
      });
    }
    if (recovery && !recovery.canReconnect) {
      if (recovery.canReset) {
        const reset = actions.createEl("button", { text: "Reset setup", cls: "mod-cta" });
        reset.disabled = this.busy;
        reset.onclick = () => void this.perform(async () => {
          this.filePolicyDraft = this.host.connectSync.getSelectiveSync();
          await this.host.connectSync.resetExpiredAdoption();
          this.enrollmentVerification = "";
          this.transientMessage = "Expired setup cleared. Your files and collection identity are unchanged. Start a new move to approve this device again.";
          await this.refresh(true);
        });
      } else {
        const check = actions.createEl("button", { text: "Check again" });
        check.disabled = this.busy;
        check.onclick = () => this.render();
      }
      return;
    }
    if (checkpoint && !recovery && !["activating", "adopted"].includes(checkpoint.phase)) {
      const cancel = actions.createEl("button", { text: "Cancel move" });
      cancel.disabled = this.busy;
      cancel.onclick = () => void this.perform(async () => {
        await this.host.connectSync.cancelAdoption();
        this.enrollmentVerification = "";
        this.transientMessage = "Move cancelled. The collection is still local.";
        await this.refresh(true);
      });
    }
    if (this.enrollmentAbort) {
      const stop = actions.createEl("button", { text: checkpoint?.phase === "waiting_for_approval" ? "Stop waiting" : "Pause move" });
      stop.onclick = () => {
        this.enrollmentAbort?.abort();
        this.transientMessage = "Move paused. Resume when ready.";
        this.render();
      };
    }
    const button = actions.createEl("button", {
      text: recovery ? "Reconnect collection" : checkpoint ? "Resume move" : "Host collection",
    });
    button.addClass("mod-cta");
    button.disabled = this.busy || (!recovery && conflicts.length > 0);
    button.onclick = () => void this.perform(async () => {
      this.adoptionFailed = false;
      this.adoptionStage = "Checking files…";
      this.enrollmentAbort?.abort();
      const abort = new AbortController();
      this.enrollmentAbort = abort;
      const onVerification = (verification: { verificationUri: string }) => {
        this.enrollmentVerification = verification.verificationUri;
        this.adoptionStage = "Waiting for approval in Connect…";
        this.transientMessage = "Approve the move in Connect.";
        this.render();
      };
      const onStatus = (status: AuthorityAdoptionStatus) => {
        this.transientMessage = status.state === "waiting_for_approval"
          ? "Waiting for authority-move approval in Connect…"
          : `Connect is retrying (attempt ${status.attempt}).`;
        this.render();
      };
      const onProgress: NonNullable<AdoptLocalCollectionCallbacks["onProgress"]> = (progress) => {
        this.adoptionStage = progress.stage === "checking" ? "Checking files…"
          : progress.stage === "uploading" ? `Approval received. Uploading ${progress.records?.toLocaleString() ?? ""} notes…`
          : progress.stage === "activating" ? "Activating hosted collection. Keep this vault open…"
          : "Finishing this device's connection…";
        this.enrollmentVerification = "";
        this.transientMessage = "";
        this.render();
      };
      const onFileProgress = (path: string, transferredBytes: number, totalBytes: number) => {
        this.adoptionFileProgress = `${path} · ${formatBytes(transferredBytes)} of ${formatBytes(totalBytes)}`;
        this.adoptionStage = `Uploading ${this.adoptionFileProgress}`;
        this.render();
      };
      const callbacks = { signal: abort.signal, onVerification, onStatus, onFileProgress, onProgress };
      try {
        if (recovery) {
          await this.host.connectSync.reconnectAdoption(callbacks);
        } else if (checkpoint) {
          await this.host.connectSync.resumeAdoption(callbacks);
        } else {
          await this.host.connectSync.adoptLocalCollection({
            controlUrl: this.enrollmentControlUrl,
            mirrorName: this.enrollmentMirrorName,
            selectiveSync: this.filePolicy(),
          }, callbacks);
        }
        this.enrollmentVerification = "";
        this.transientMessage = "Collection hosted. This vault is now connected.";
        await this.refresh(true);
      } catch (error) {
        if (this.host.connectSync.getAdoptionMarker()?.phase !== "waiting_for_approval") this.enrollmentVerification = "";
        if (!isAbortError(error)) {
          this.adoptionFailed = true;
          await this.host.connectSync.previewAdoption(this.filePolicy()).then(preview => { this.adoptionPreview = preview; }).catch(() => undefined);
          throw error;
        }
        this.transientMessage = "Move paused. Resume when ready.";
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
      review.disabled = this.busy;
      review.onclick = () => void this.perform(async () => {
        this.adoptionRenamePlan = await this.host.connectSync.planAdoptionRenames(this.filePolicy());
      });
      return;
    }
    const apply = actions.createEl("button", { text: `Rename ${plan.renames.length} ${plan.renames.length === 1 ? "file" : "files"}`, cls: "mod-cta" });
    apply.disabled = this.busy || !plan.renames.length;
    apply.onclick = () => void this.perform(async () => {
      try {
        const count = await this.host.connectSync.applyAdoptionRenames(plan, this.filePolicy(), (done, total) => {
          this.adoptionStage = `Renaming ${done} of ${total} files…`;
          this.render();
        });
        this.transientMessage = `Renamed ${count} ${count === 1 ? "file" : "files"}. Review the file check, then resume the move.`;
      } finally {
        this.adoptionStage = "";
        this.adoptionRenamePlan = null;
        await this.host.connectSync.previewAdoption(this.filePolicy()).then(preview => { this.adoptionPreview = preview; }).catch(() => undefined);
      }
    });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.disabled = this.busy;
    cancel.onclick = () => { this.adoptionRenamePlan = null; this.render(); };
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
    query.oninput = () => { this.transferQuery = query.value; this.transferPages.clear(); this.render(); };
    const filter = controls.createEl("select");
    filter.setAttr("aria-label", "Filter transfers");
    for (const [value, label] of [["all", "All changes"], ["delete", "Deletes"], ["replace", "Replacements"], ["upload", "Uploads"], ["download", "Downloads"], ["attention", "Needs attention"]]) {
      filter.createEl("option", { value, text: label });
    }
    filter.value = this.transferFilter;
    filter.onchange = () => { this.transferFilter = filter.value; this.transferPages.clear(); this.render(); };
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
        const localPath = this.app.vault.getAbstractFileByPath(entry.path) ? entry.path : null;
        if (localPath) {
          const open = pathLine.createEl("button", { cls: "mdbase-link-button mdbase-transfer-open" });
          open.createEl("code", { text: entry.path });
          open.setAttr("title", `Open ${entry.path}`);
          open.onclick = () => void this.host.openFileByPath(localPath);
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
              this.render();
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
        previous.onclick = () => { this.transferPages.set(group.direction, page - 1); this.render(); };
        const next = pages.createEl("button", { text: `Next ${group.title.toLowerCase()}` });
        next.disabled = start + 250 >= entries.length;
        next.setAttr("data-focus-key", `transfer-next-${group.direction}`);
        next.onclick = () => { this.transferPages.set(group.direction, page + 1); this.render(); };
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
      compare.disabled = this.busy || this.loadingConflictComparisons.has(comparisonKey);
      compare.onclick = () => {
        if (comparison) {
          this.conflictComparisons.delete(comparisonKey);
          this.render();
          return;
        }
        void this.loadConflictComparison(conflict, comparisonKey);
      };
      if (comparison) {
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
        this.renderConflictComparison(row, comparison);
      }
    }
  }

  private async loadPreviewComparison(key: string, recordId: string, path: string): Promise<void> {
    this.loadingPreviewComparisons.add(key);
    this.render();
    try {
      this.previewComparisons.set(key, await this.host.connectSync.recordComparison(recordId, path));
    } catch (error) {
      this.transientMessage = syncProblem(error).message;
    } finally {
      this.loadingPreviewComparisons.delete(key);
      this.render();
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
          ? `Local copy saved to ${copiedPath}. Review to apply the hosted version.`
          : "Conflict resolved. Review changes to continue.";
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
      text: "Review these file diagnostics. The sync preview identifies which issues block synchronization; a diagnostic alone does not mean syncing is paused.",
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

  refreshValidationControls(): void {
    if (this.destination === "issues") this.render();
  }

  updateValidationProgress(): void {
    const summary = this.containerEl.querySelector<HTMLElement>("[data-validation-summary]");
    if (summary) summary.textContent = this.host.getValidationSummary();
  }

  private renderIssues(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-issues-document" });
    const allIssues = this.host.getIssues();
    const allFiles = new Set(allIssues.map((issue) => issue.path)).size;
    const header = document.createDiv({ cls: "mdbase-document-header" });
    const heading = header.createDiv();
    const validationSummary = this.host.getValidationSummary();
    heading.createEl("h2", { text: allIssues.length
      ? `${allIssues.length.toLocaleString()} ${allIssues.length === 1 ? "issue" : "issues"} · ${allFiles.toLocaleString()} ${allFiles === 1 ? "file" : "files"}`
      : validationSummary === "Not checked yet" ? "Validation" : "No known issues",
    });
    const freshness = heading.createDiv({ cls: "mdbase-muted", text: validationSummary });
    freshness.setAttr("role", "status");
    freshness.setAttr("data-validation-summary", "true");
    if (this.host.isValidating()) {
      const cancel = header.createEl("button", { text: "Stop validation" });
      cancel.onclick = () => this.host.cancelValidation();
    }
    const refresh = header.createEl("button", { text: "Validate" });
    refresh.disabled = this.busy || this.host.isValidating();
    refresh.onclick = () => void this.perform(async () => {
      await this.host.validateCollection();
      this.render();
    });
    if (!allIssues.length) return;
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
    const groupBy = controls.createEl("select");
    groupBy.setAttr("aria-label", "Group issues");
    groupBy.createEl("option", { value: "file", text: "By file" });
    groupBy.createEl("option", { value: "rule", text: "By rule" });
    groupBy.value = this.issueGroupBy;
    groupBy.onchange = () => {
      this.issueGroupBy = groupBy.value === "rule" ? "rule" : "file";
      this.render();
    };
    const query = controls.createEl("input", { type: "search" });
    query.setAttr("aria-label", "Filter issues");
    query.setAttr("data-focus-key", "issue-search");
    query.placeholder = "Filter issues";
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
      return `${issue.path} ${issue.code} ${issue.type ?? ""} ${issue.field ?? ""} ${issue.message}`.toLowerCase().includes(normalizedQuery);
    });
    const filteredFiles = new Set(filtered.map((issue) => issue.path)).size;
    if (filtered.length !== allIssues.length || filtered.length > this.issueLimit) {
      document.createDiv({ cls: "mdbase-issues-summary", text:
        `${Math.min(filtered.length, this.issueLimit).toLocaleString()} of ${filtered.length.toLocaleString()} issues · ${filteredFiles.toLocaleString()} files`,
      });
    }
    if (!filtered.length) {
      document.createDiv({ cls: "mdbase-empty-state", text: "No issues match these filters." });
      return;
    }
    const issues = filtered.slice(0, this.issueLimit);
    if (this.issueGroupBy === "rule") this.renderIssuesByRule(document, issues);
    else this.renderIssuesByFile(document, issues);
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

  private renderIssuesByFile(document: HTMLElement, issues: MdbaseIssue[]): void {
    const groups = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) groups.set(issue.path, [...(groups.get(issue.path) ?? []), issue]);
    for (const [path, fileIssues] of groups) {
      const group = document.createEl("section", { cls: "mdbase-issue-group" });
      const groupHeader = group.createDiv({ cls: "mdbase-issue-group-header" });
      const fileButton = groupHeader.createEl("button", { cls: "mdbase-issue-file-button" });
      setIcon(fileButton.createSpan({ cls: "mdbase-issue-file-icon" }), "file-text");
      fileButton.createSpan({ cls: "mdbase-issue-file-path", text: path });
      fileButton.setAttr("title", `Open ${path}`);
      fileButton.onclick = () => void this.host.openFileByPath(path);
      groupHeader.createSpan({
        cls: "mdbase-issue-file-count",
        text: `${fileIssues.length} ${fileIssues.length === 1 ? "issue" : "issues"}`,
      });
      for (const issue of fileIssues) {
        const row = group.createDiv({ cls: "mdbase-issue-row" });
        this.fillIssueRow(row, issue, `${issue.severity === "warn" ? "Warning" : "Error"}${issue.field ? ` · ${issue.field}` : ""}`);
      }
    }
  }

  /** Issues from the same rule together, so one schema decision or bulk fix covers them all. */
  private renderIssuesByRule(document: HTMLElement, issues: MdbaseIssue[]): void {
    for (const rule of groupIssuesByRule(issues)) {
      const first = rule.issues[0];
      const group = document.createEl("section", { cls: "mdbase-issue-group" });
      const groupHeader = group.createDiv({ cls: "mdbase-issue-group-header" });
      const title = groupHeader.createDiv({ cls: "mdbase-issue-rule-title" });
      title.createSpan({ cls: "mdbase-issue-indicator", attr: { "data-severity": first.severity, "aria-hidden": "true" } });
      title.createSpan({ cls: "mdbase-issue-file-path", text: issueRuleLabel(first) });
      const files = new Set(rule.issues.map((issue) => issue.path)).size;
      groupHeader.createSpan({
        cls: "mdbase-issue-file-count",
        text: `${files.toLocaleString()} ${files === 1 ? "note" : "notes"}`,
      });
      const actions = groupHeader.createDiv({ cls: "mdbase-issue-row-actions" });
      this.renderEditRuleButton(actions, first);
      const fixLabel = this.host.getQuickFixLabel(first);
      const fixable = fixLabel ? rule.issues.filter((issue) => this.host.getQuickFixLabel(issue) === fixLabel) : [];
      const fixableNotes = new Set(fixable.map((issue) => issue.path)).size;
      if (fixLabel && fixableNotes > 1) {
        const bulk = actions.createEl("button", { text: `${fixLabel} · ${fixableNotes} notes` });
        bulk.disabled = this.busy;
        bulk.onclick = () => void this.applyBulkQuickFix(fixLabel, fixable);
      }
      for (const issue of rule.issues) {
        const row = group.createDiv({ cls: "mdbase-issue-row" });
        this.fillIssueRow(row, issue, issue.path, true);
      }
    }
  }

  private fillIssueRow(row: HTMLElement, issue: MdbaseIssue, context: string, contextOpensFile = false): void {
    row.setAttr("data-severity", issue.severity);
    row.createSpan({ cls: "mdbase-issue-indicator" }).setAttr("aria-hidden", "true");
    const technical = typeof issue.details?.technical_message === "string" ? issue.details.technical_message : "";
    row.setAttr("title", technical ? `${issue.code}: ${technical}` : issue.code);
    const metadata = row.createDiv({ cls: "mdbase-issue-metadata" });
    if (contextOpensFile) {
      const open = metadata.createEl("button", { cls: "mdbase-link-button mdbase-issue-context", text: context });
      open.setAttr("title", `Open ${issue.path}${issue.field ? ` at ${issue.field}` : ""}`);
      open.onclick = () => void this.host.openFileByPath(issue.path, issue.field);
    } else {
      metadata.createDiv({ cls: "mdbase-issue-context", text: context });
    }
    row.createDiv({ cls: "mdbase-issue-row-message", text: issue.message });
    const actions = row.createDiv({ cls: "mdbase-issue-row-actions" });
    // The file header already opens the note; a row action is only useful when it lands on the field.
    if (!contextOpensFile && issue.field) {
      const open = this.iconButton(actions, "arrow-up-right", `Open ${issue.path} at ${issue.field}`);
      open.onclick = () => void this.host.openFileByPath(issue.path, issue.field);
    }
    if (!contextOpensFile) this.renderEditRuleButton(actions, issue);
    const quickFixLabel = this.host.getQuickFixLabel(issue);
    if (quickFixLabel) {
      const fix = actions.createEl("button", { text: quickFixLabel });
      fix.disabled = this.busy;
      fix.onclick = () => void this.perform(async () => {
        await this.host.applyQuickFix(issue);
      });
    }
  }

  /** Jump from an issue to the type field whose rule produced it. */
  private renderEditRuleButton(container: HTMLElement, issue: MdbaseIssue): void {
    const typeName = issueTypeNames(issue, this.currentStats().recordTypes)[0];
    const typeDef = typeName ? this.schema?.types.get(typeName) : undefined;
    if (!typeDef) return;
    const edit = this.iconButton(
      container,
      "pencil",
      issue.field ? `Edit ${issue.field} in ${typeDef.name}` : `Edit type ${typeDef.name}`,
    );
    edit.onclick = () => void this.openTypeField(typeDef.filePath, issue.field);
  }

  private async applyBulkQuickFix(label: string, issues: MdbaseIssue[]): Promise<void> {
    const notes = new Set(issues.map((issue) => issue.path)).size;
    const confirmed = await new BulkFixConfirmationModal(this.app).confirm(label, issues);
    if (!confirmed) return;
    await this.perform(async () => {
      const result = await this.host.applyQuickFixes(issues);
      this.transientMessage = result.skipped
        ? `${label}: updated ${result.changed} of ${notes} ${notes === 1 ? "note" : "notes"}. ${result.skipped} changed since validation and were left as they are.`
        : `${label}: updated ${result.changed} ${result.changed === 1 ? "note" : "notes"}.`;
    });
  }

  /** Keep the current draft (if any) so another type can be opened without losing work. */
  private async leaveCurrentType(): Promise<void> {
    if (this.dirty) await this.flushTypeDraft();
    this.yamlEditor?.destroy();
    this.yamlEditor = null;
    this.impact = null;
    this.showAllMatches = false;
  }

  private async selectType(path: string, keepCurrentDraft = true): Promise<void> {
    if (keepCurrentDraft && path !== this.selectedPath) await this.leaveCurrentType();
    const version = ++this.typeSelectionVersion;
    const sourceModel = await this.host.loadTypeModel(path);
    if (version !== this.typeSelectionVersion) return;
    const draft = this.host.loadTypeDraft(path);
    const canRestore = draft?.version === 1 && draft.sourceRevision === (sourceModel.sourceRevision ?? null);
    const model = canRestore ? clone(draft.model) : sourceModel;
    this.selectedPath = path;
    this.model = model;
    this.originalModel = clone(sourceModel);
    // Design drafts may be incomplete; serialize only the valid saved source.
    // Switching to YAML will validate/serialize the edited model explicitly.
    this.yamlDraft = canRestore && draft.yamlDraft !== undefined
      ? draft.yamlDraft
      : `${formatMarkdown(frontmatterFromReadableModel(sourceModel), sourceModel.body)}\n`;
    this.dirty = !typeModelsEqual(this.originalModel, model);
    this.editorMode = canRestore && draft.editorMode === "yaml" ? "yaml" : "design";
    if (this.editorMode === "yaml") this.dirty = true;
    if (canRestore && this.dirty) {
      if (!this.sessionDrafts.has(path)) this.transientMessage = `Recovered unsaved changes for ${path}.`;
    } else if (draft && !canRestore) {
      this.transientMessage = `An older draft for ${path} was kept, but the source changed. The current file is shown.`;
    }
    this.scheduleImpact(0);
    this.render();
  }

  private async createType(): Promise<void> {
    await this.leaveCurrentType();
    this.typeSelectionVersion += 1;
    const draft = this.host.loadTypeDraft(null);
    const model = draft?.version === 1 ? clone(draft.model) : createDefaultTypeModel();
    this.selectedPath = null;
    this.model = model;
    this.originalModel = null;
    this.yamlDraft = draft?.yamlDraft
      ?? "";
    this.dirty = true;
    if (draft && !this.sessionDrafts.has("__new__")) this.transientMessage = "Recovered an unsaved new type.";
    this.editorMode = draft?.editorMode ?? "design";
    this.scheduleImpact(0);
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
    if (mode === "design") {
      this.yamlEditor?.destroy();
      this.yamlEditor = null;
    }
    this.scheduleImpact(0);
    this.render();
  }

  private modelFromYamlDraft(): { model: TypeEditorModel } | { error: string; line?: number | null } {
    const parsed = parseFrontmatter(this.yamlDraft);
    if (!parsed.hasFrontmatter) return { error: "Type YAML must start with a --- frontmatter block.", line: 1 };
    // Parser messages append a code excerpt; the first line carries the meaning.
    if (parsed.error) {
      // The row shows the editor's line number; the parser's own position counts from the frontmatter.
      const message = parsed.error.split("\n")[0].replace(/:$/, "").replace(/ at line \d+, column \d+$/, "");
      return { error: `Invalid YAML: ${message}`, line: yamlErrorLine(parsed.error) };
    }
    if (parsed.frontmatter.kind !== "mdbase.type") {
      return { error: "Canonical v0.3 type YAML requires kind: mdbase.type.", line: yamlKeyLine(this.yamlDraft, "kind") ?? 2 };
    }
    try {
      const model = typeModelFromDocument(parsed.frontmatter, parsed.body, this.model?.name || "type");
      if (this.model?.sourceRevision) model.sourceRevision = this.model.sourceRevision;
      return { model };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), line: null };
    }
  }

  /** Syntax and type problems in the YAML draft, located by line where possible. */
  private yamlProblems(): YamlProblem[] {
    const result = this.modelFromYamlDraft();
    if ("error" in result) return [{ line: result.line ?? null, message: result.error, severity: "error" }];
    return validateTypeDraft(result.model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.schema?.contracts.values(),
    }).map((diagnostic) => {
      const key = diagnostic.path.startsWith("fields.")
        ? diagnostic.path.slice("fields.".length).split(/[.[]/)[0]
        : diagnostic.path === "identity.displayNameKey" ? "name_field" : diagnostic.path.split(".").pop() ?? "";
      return {
        line: yamlKeyLine(this.yamlDraft, key),
        message: diagnostic.message,
        severity: diagnostic.severity === "error" ? "error" : "warning",
      };
    });
  }

  private readYamlDraftIntoModel(): boolean {
    const result = this.modelFromYamlDraft();
    if ("error" in result) {
      new Notice(result.error);
      if (result.line) this.yamlEditor?.revealLine(result.line);
      return false;
    }
    this.model = result.model;
    return true;
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
    // Check notes against exactly what is about to be saved, not a debounced result.
    const fresh = await this.computeImpact();
    if (fresh !== undefined) this.impact = fresh;
    const failingNotes = this.impact && !("error" in this.impact)
      ? this.impact.impact.failing.filter((record) => record.isNew).map((record) => record.path)
      : [];
    if (highImpact.length || failingNotes.length) {
      const changes = highImpact.length
        ? highImpact
        : describeTypeChanges(this.originalModel, this.model).filter((change) => change.risk !== "safe");
      const confirmed = await new TypeChangeConfirmationModal(this.app).confirm(changes, failingNotes);
      if (!confirmed) return;
    }
    const model = this.model;
    await this.flushTypeDraft();
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
    this.scheduleImpact();
    if (this.dirty && !wasDirty) this.transientMessage = "";
    if (render || wasDirty !== this.dirty) {
      this.render();
      return;
    }
    // Update validation/save state without replacing the input being edited.
    const pane = this.containerEl.querySelector<HTMLElement>(".mdbase-type-editor-pane");
    const bar = pane?.querySelector(".mdbase-draft-bar");
    if (pane && bar && this.model) {
      bar.remove();
      this.renderDraftBar(pane, this.model);
      const title = pane.querySelector(".mdbase-editor-title-line h2");
      if (title) title.textContent = this.model.name || "Untitled type";
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
    if (!this.model) return;
    if (!this.dirty) {
      const draft = this.host.loadTypeDraft(this.selectedPath);
      if (draft && draft.sourceRevision === (this.originalModel?.sourceRevision ?? null)) await this.host.clearTypeDraft(this.selectedPath);
      return;
    }
    this.sessionDrafts.add(this.selectedPath ?? "__new__");
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
    const draft = this.host.loadTypeDraft(path);
    if (!draft || draft.sourceRevision === (this.originalModel?.sourceRevision ?? null)) await this.host.clearTypeDraft(path);
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
    const profile = this.host.getMirrorProfile();
    try {
      if (!profile && this.schema && !this.enrollmentAbort) {
        this.adoptionPreview = await this.host.connectSync.previewAdoption(this.filePolicy());
      }
      const status = await this.host.connectSync.status();
      if (profile !== this.host.getMirrorProfile()) return;
      this.mirrorStatus = status;
      this.syncProblem = null;
      this.host.setSyncStatus(this.mirrorStatus);
    } catch (error) {
      if (profile !== this.host.getMirrorProfile()) return;
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
