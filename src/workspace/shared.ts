import type { SyncSession } from "../syncSession";
import {
  type App,
  Platform,
  TFile,
} from "obsidian";
import type { MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import type { ConnectSyncController, MirrorProfile } from "../connectSync";
import type {
  CollectionRecord,
  MdbaseConfig,
  MdbaseIssue,
  MdbaseTypeDef,
} from "../mdbaseCore";
import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import type { V02MigrationPlan } from "../migration";
import type { StoredTypeDraft, TypeEditorModel } from "../typeEditorTypes";

declare const __MDBASE_CONNECT_CONTROL_URL__: string;
export const DEFAULT_CONNECT_CONTROL_URL = typeof __MDBASE_CONNECT_CONTROL_URL__ === "string"
  ? __MDBASE_CONNECT_CONTROL_URL__
  : "https://connect.mdbase.dev";

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
  readonly sync: SyncSession;
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

export function defaultDeviceName(vaultName: string): string {
  const platform = Platform.isIosApp ? "iOS"
    : Platform.isAndroidApp ? "Android"
      : Platform.isMacOS ? "Mac"
        : Platform.isWin ? "Windows"
          : Platform.isLinux ? "Linux"
            : "Obsidian";
  return `${vaultName} · ${platform}`;
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

export const HISTORY_PAGE = 10;

export const HISTORY_OUTCOMES: Record<string, string> = {
  cancelled: "Paused",
  stale: "Stopped: changes detected",
  attention: "Needs attention",
  blocked: "Stopped",
  failed: "Failed",
};

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function relativeTime(value: string | null | undefined): string {
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

export function syncStateLabel(status: MirrorStatus | null): string {
  if (!status) return "Checking connection";
  if (status.state === "up_to_date") return "Up to date";
  if (status.state === "changes_waiting") return "Changes waiting";
  if (["attention", "blocked", "failed", "stale"].includes(status.state) || status.recovery_required) return "Needs attention";
  if (status.state === "cancelled") return "Paused safely";
  if (status.state === "applying") return "Synchronizing";
  if (status.state === "planned") return "Review ready";
  return "Ready for first sync";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

