import type { App, TFile } from "obsidian";
import type { SyncController } from "../sync/controller";
import type {
  CollectionRecord,
  MdbaseConfig,
  MdbaseIssue,
  MdbaseTypeDef,
} from "../mdbaseCore";
import type { CollectionContractDescriptor } from "../contractTypes";
import type { V02MigrationPlan } from "../migration";
import type { StoredTypeDraft, TypeEditorModel } from "../typeEditorTypes";

export interface MdbaseWorkspaceSchema {
  config: MdbaseConfig;
  types: Map<string, MdbaseTypeDef>;
  contracts: Map<string, CollectionContractDescriptor>;
}

export interface MdbaseWorkspaceHost {
  readonly syncController: SyncController;
  /** The earlier Connect sync this vault used, if any. */
  legacyConnect(): { name: string; collectionId: string } | null;
  /** Visible names at the top of the vault (not `.obsidian` and other hidden entries). */
  vaultTopLevelEntries(): string[];
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
  /** Opens this plugin's settings, where sync and validation options live. */
  openSettings(): void;
}

export interface RenderSnapshot {
  focusKey: string | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  scroll: Map<string, { top: number; left: number }>;
}

/** What a pane can use from the workspace shell that hosts it. */
export interface WorkspaceContext {
  readonly app: App;
  readonly host: MdbaseWorkspaceHost;
  readonly containerEl: HTMLElement;
  readonly schema: MdbaseWorkspaceSchema | null;
  readonly records: CollectionRecord[] | null;
  readonly busy: boolean;
  readonly disclosures: Map<string, boolean>;
  destination: Destination;
  message: string;
  pendingFocusKey: string | null;
  render(): void;
  refresh(forceReload?: boolean): Promise<void>;
  perform(operation: () => Promise<void>): Promise<void>;
  showDestination(destination: Destination): void;
  openTypeField(typePath: string, fieldPath: string | undefined): Promise<void>;
  /** Which types each record matches, keyed by path. */
  recordTypes(): Map<string, string[]>;
  iconButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement;
  disclosure(container: HTMLElement, key: string, label: string, initiallyOpen?: boolean): HTMLDivElement;
}

export type Destination = "types" | "sync" | "issues";
export type EditorMode = "design" | "yaml";

export const FIELD_TYPES = [
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function fieldTypeLabel(type: string): string {
  if (type === "any") return "Any value";
  if (type === "datetime") return "Date and time";
  return type ? type[0].toUpperCase() + type.slice(1) : type;
}

export function definitionType(definition: Record<string, unknown>): string {
  return typeof definition.type === "string" ? definition.type : "any";
}

export function nextNestedFieldName(fields: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(fields, "field")) return "field";
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(fields, `field${suffix}`)) suffix += 1;
  return `field${suffix}`;
}

export function setOwnField(
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

export function inputRow(
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

export function renderStatus(container: HTMLElement, label: string, value: string): void {
  const row = container.createDiv({ cls: "mdbase-status-row" });
  row.createSpan({ cls: "mdbase-status-label", text: label });
  row.createSpan({ cls: "mdbase-status-value", text: value });
}

export function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  const digits = value < 10_000 ? 1 : 0;
  return `${(value / 1_000).toFixed(digits)}k`;
}
