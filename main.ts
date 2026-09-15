import { applyQuickFixToDocument, quickFixLabel } from "./src/quickFix";
import { SyncError } from "@mdbase-dev/connect-sync";
import {
  App,
  addIcon,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  normalizePath,
} from "obsidian";
import {
  ObsidianInteropBridge,
  type MdbaseObsidianInteropApi,
} from "./src/interopBridge";
import {
  MdbaseConfig,
  MdbaseIssue,
  MdbaseTypeDef,
  buildInitialFrontmatter,
  buildUniqueNotePath,
  coerceFieldInput,
  createNoteFromType,
  ensureCollectionInitialized,
  formatMarkdown,
  getPromptFields,
  getTopLevelFieldFromIssuePath,
  getTypesForFile,
  loadMdbaseConfig,
  loadContractDefinitions,
  loadTypeDefinitions,
  parseFrontmatter,
  validateCollection,
  validateFile,
} from "./src/mdbaseCore";
import type { StoredTypeDraft, TypeEditorModel } from "./src/typeEditorTypes";
import {
  ConnectSyncController,
  normalizeSelectiveSync,
  type MirrorProfile,
} from "./src/connectSync";
import type { MirrorProgress, MirrorStatus } from "@mdbase-dev/connect-sync/mirror";
import {
  analyzeV02Migration,
  applyV02Migration,
  type V02MigrationPlan,
} from "./src/migration";
import {
  frontmatterFromTypeModel,
  typeModelFromDocument,
} from "./src/typeModel";
import { sourceRevision } from "./src/typeDraft";
import {
  MDBASE_WORKSPACE_VIEW,
  MdbaseWorkspaceView,
  type MdbaseWorkspaceSchema,
} from "./src/workspaceView";
import { MDBASE_ICON_ID, MDBASE_ICON_SVG } from "./src/mdbaseIcon";
import { KeyedTrailingDebouncer } from "./src/trailingDebouncer";
import {
  activityEntry,
  appendActivity,
  normalizeActivity,
  syncIndicator,
  syncProblem,
  type FileTransferProgress,
  type SyncActivityEntry,
  type SyncProblem,
} from "./src/syncUx";

interface MdbasePluginSettings {
  validateOnSave: boolean;
  validateOnOpen: boolean;
  showNoticeOnSave: boolean;
  interopEnabled: boolean;
  mirrorProfile: MirrorProfile | null;
  typeDrafts: Record<string, StoredTypeDraft>;
  syncActivity: SyncActivityEntry[];
}

const DEFAULT_SETTINGS: MdbasePluginSettings = {
  validateOnSave: true,
  validateOnOpen: true,
  showNoticeOnSave: false,
  interopEnabled: false,
  mirrorProfile: null,
  typeDrafts: {},
  syncActivity: [],
};

function isMirrorProfile(value: unknown): value is MirrorProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Partial<MirrorProfile>;
  return profile.version === 1
    && typeof profile.syncUrl === "string"
    && typeof profile.controlUrl === "string"
    && typeof profile.collectionId === "string"
    && typeof profile.replicaId === "string"
    && (profile.mode === "read_only" || profile.mode === "read_write")
    && typeof profile.name === "string"
    && typeof profile.enrollmentId === "string"
    && typeof profile.accessTokenExpiresAt === "string"
    && (profile.selectiveSync === undefined || (
      Array.isArray(profile.selectiveSync.file_classes)
      && Array.isArray(profile.selectiveSync.excluded_folders)
    ));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class TextPromptModal extends Modal {
  private resolvePromise: ((value: string | null) => void) | null = null;
  private settled = false;
  private readonly title: string;
  private readonly placeholder: string;
  private readonly defaultValue: string;

  constructor(app: App, title: string, placeholder = "", defaultValue = "") {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.defaultValue = defaultValue;
  }

  openAndGetValue(): Promise<string | null> {
    return new Promise((resolve) => {
      this.settled = false;
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = this.placeholder;
    input.value = this.defaultValue;
    input.addClass("prompt-input");

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const submitButton = actions.createEl("button", { text: "OK" });
    submitButton.addClass("mod-cta");

    cancelButton.onclick = () => {
      this.finish(null);
      this.close();
    };

    submitButton.onclick = () => {
      this.finish(input.value.trim());
      this.close();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.finish(input.value.trim());
        this.close();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        this.finish(null);
        this.close();
      }
    });

    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    if (!this.settled) this.finish(null);
    this.contentEl.empty();
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise?.(value);
    this.resolvePromise = null;
  }
}

type TypePickerResult =
  | { type: "selected"; typeDef: MdbaseTypeDef }
  | { type: "cancelled" };

class TypeSuggestModal extends SuggestModal<MdbaseTypeDef> {
  private readonly typeDefs: MdbaseTypeDef[];
  private readonly onResult: (result: TypePickerResult) => void;
  private resultHandled = false;

  constructor(app: App, typeDefs: MdbaseTypeDef[], onResult: (result: TypePickerResult) => void) {
    super(app);
    this.typeDefs = [...typeDefs].sort((a, b) => a.name.localeCompare(b.name));
    this.onResult = onResult;
    this.setPlaceholder("Type to search...");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "select" },
      { command: "esc", purpose: "cancel" },
    ]);
    this.containerEl.addClass("mdbase-type-picker-modal");
    this.titleEl.setText("Select type definition");
  }

  getSuggestions(query: string): MdbaseTypeDef[] {
    const lowered = query.trim().toLowerCase();
    if (!lowered) return this.typeDefs.slice(0, 100);

    return this.typeDefs
      .filter((typeDef) => {
        const desc = typeDef.match?.path_glob ?? "";
        const haystack = `${typeDef.name} ${typeDef.display_name_key ?? ""} ${typeDef.filePath} ${desc}`.toLowerCase();
        return haystack.includes(lowered);
      })
      .slice(0, 100);
  }

  renderSuggestion(typeDef: MdbaseTypeDef, el: HTMLElement): void {
    const wrap = el.createDiv({ cls: "mdbase-type-picker-suggestion" });

    wrap.createDiv({
      cls: "mdbase-type-picker-name",
      text: typeDef.name,
    });

    const meta = wrap.createDiv({ cls: "mdbase-type-picker-meta" });
    meta.createSpan({
      cls: "mdbase-type-picker-path",
      text: typeDef.filePath,
    });
    meta.createSpan({
      cls: "mdbase-type-picker-count",
      text: `${Object.keys(typeDef.fields ?? {}).length} fields`,
    });

    if (typeDef.match?.path_glob) {
      wrap.createDiv({
        cls: "mdbase-type-picker-match",
        text: `match: ${typeDef.match.path_glob}`,
      });
    }
  }

  onChooseSuggestion(typeDef: MdbaseTypeDef): void {
    this.resultHandled = true;
    this.onResult({ type: "selected", typeDef });
  }

  onClose(): void {
    window.setTimeout(() => {
      if (!this.resultHandled) {
        this.onResult({ type: "cancelled" });
      }
    }, 0);
    super.onClose();
  }
}

function pickType(app: App, typeDefs: MdbaseTypeDef[]): Promise<MdbaseTypeDef | null> {
  return new Promise((resolve) => {
    const modal = new TypeSuggestModal(app, typeDefs, (result) => {
      if (result.type === "selected") {
        resolve(result.typeDef);
        return;
      }
      resolve(null);
    });
    modal.open();
  });
}

class MdbaseSettingTab extends PluginSettingTab {
  plugin: MdbasePlugin;

  constructor(app: App, plugin: MdbasePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    if (this.plugin.connectSync.getRecoveryStatus()) {
      new Setting(containerEl)
        .setName("Collection recovery required")
        .setDesc("Settings changes are blocked until collection authority has been verified.")
        .addButton((button) => button.setButtonText("Open recovery").onClick(() => {
          void this.plugin.openWorkspace("sync");
        }));
      return;
    }

    new Setting(containerEl)
      .setName("Validate on save")
      .setDesc("Run mdbase validation when a Markdown file is modified.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.validateOnSave).onChange(async (value) => {
          this.plugin.settings.validateOnSave = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Validate on file open")
      .setDesc("Validate the active note when opened.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.validateOnOpen).onChange(async (value) => {
          this.plugin.settings.validateOnOpen = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show notices on save")
      .setDesc("Display a notice when save-time validation finds issues.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showNoticeOnSave).onChange(async (value) => {
          this.plugin.settings.showNoticeOnSave = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Allow local application interoperability")
      .setDesc(
        "Allow installed Obsidian plugins to exchange validated mdbase events and actions in this vault. "
        + "Contracts establish compatibility; this switch is the separate user grant.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.interopEnabled).onChange(async (value) => {
          this.plugin.settings.interopEnabled = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}

interface LoadedSchema {
  config: MdbaseConfig;
  types: Map<string, MdbaseTypeDef>;
  contracts: Awaited<ReturnType<typeof loadContractDefinitions>>;
}

export interface MdbaseObsidianApiV1 {
  readonly apiVersion: 1;
  readonly interop: MdbaseObsidianInteropApi;
  getInteropStatus(): {
    enabled: boolean;
    profileVersion: "0.1";
  };
}

export default class MdbasePlugin extends Plugin {
  readonly api: MdbaseObsidianApiV1;
  readonly connectSync: ConnectSyncController;
  settings: MdbasePluginSettings = { ...DEFAULT_SETTINGS, typeDrafts: {}, syncActivity: [] };
  private issueMap = new Map<string, MdbaseIssue[]>();
  private sortedIssuesCache: MdbaseIssue[] | null = null;
  private statusBarEl: HTMLElement;
  private mirrorStatus: MirrorStatus | null = null;
  private mirrorProgress: MirrorProgress | null = null;
  private fileProgress: FileTransferProgress | null = null;
  private currentSyncProblem: SyncProblem | null = null;
  private localChangeObserved = false;
  private schemaCache: LoadedSchema | null = null;
  private schemaLoadPromise: Promise<LoadedSchema | null> | null = null;
  // Obsidian commonly persists the final editor buffer about 1.3 seconds after
  // typing stops. Wait beyond that write so the edit burst and final autosave
  // produce one validation/schema refresh against the latest saved content.
  private readonly saveValidationDebounceMs = 2_000;
  private readonly schemaRefreshDebounceMs = 2_000;
  private readonly saveValidations = new KeyedTrailingDebouncer<string, TFile>(
    this.saveValidationDebounceMs,
    async (file, isCurrent) => {
      try {
        await this.validateFileAndStore(file, "save", isCurrent);
      } catch (error) {
        console.error("mdbase: background validation failed", error);
      }
    },
  );
  private readonly schemaRefreshes = new KeyedTrailingDebouncer<"schema", undefined>(
    this.schemaRefreshDebounceMs,
    async () => {
      this.invalidateSchemaCache();
      this.refreshWorkspaceViews();
    },
  );
  private readonly interopBridge: ObsidianInteropBridge;

  constructor(app: App, manifest: import("obsidian").PluginManifest) {
    super(app, manifest);
    this.connectSync = new ConnectSyncController(app, {
      getMirrorProfile: () => this.getMirrorProfile(),
      saveMirrorProfile: async (profile) => {
        this.settings.mirrorProfile = profile;
        await this.saveSettings();
        if (!profile) {
          this.mirrorStatus = null;
          this.currentSyncProblem = null;
          this.localChangeObserved = false;
          this.updateStatusBar();
        } else {
          void this.refreshSyncStatus();
        }
      },
    });
    this.interopBridge = new ObsidianInteropBridge(app, () => this.settings.interopEnabled === true
      && this.connectSync.getRecoveryStatus() === null);
    this.api = {
      apiVersion: 1,
      interop: this.interopBridge,
      getInteropStatus: () => ({
        enabled: this.settings.interopEnabled === true && this.connectSync.getRecoveryStatus() === null,
        profileVersion: "0.1",
      }),
    };
  }

  async onload(): Promise<void> {
    await this.retryInitialization();
    addIcon(MDBASE_ICON_ID, MDBASE_ICON_SVG);

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mdbase-status-bar");
    this.statusBarEl.setAttr("role", "button");
    this.statusBarEl.setAttr("tabindex", "0");
    this.registerDomEvent(this.statusBarEl, "click", () => void this.openStatusDestination());
    this.registerDomEvent(this.statusBarEl, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void this.openStatusDestination();
    });
    this.updateStatusBar();

    this.registerView(MDBASE_WORKSPACE_VIEW, (leaf) => new MdbaseWorkspaceView(leaf, this));
    this.addSettingTab(new MdbaseSettingTab(this.app, this));
    this.addRibbonIcon(MDBASE_ICON_ID, "Open mdbase", () => void this.openWorkspace());

    this.addCommand({
      id: "mdbase-open",
      name: "Open workspace",
      callback: () => void this.openWorkspace(),
    });

    this.addCommand({
      id: "mdbase-initialize-collection",
      name: "Initialize collection",
      callback: () => void this.initializeCollectionCommand(),
    });

    this.addCommand({
      id: "mdbase-create-type",
      name: "Create type definition",
      callback: () => void this.createTypeDefinitionCommand(),
    });

    this.addCommand({
      id: "mdbase-edit-type",
      name: "Edit type definition",
      callback: () => void this.editTypeDefinitionCommand(),
    });

    this.addCommand({
      id: "mdbase-edit-current-type",
      name: "Edit current type definition",
      callback: () => void this.editCurrentTypeDefinitionCommand(),
    });

    this.addCommand({
      id: "mdbase-create-note-from-type",
      name: "Create note from type",
      callback: () => void this.createNoteFromTypeCommand(),
    });

    this.addCommand({
      id: "mdbase-validate-current-note",
      name: "Validate current note",
      callback: () => void this.validateCurrentNoteCommand(),
    });

    this.addCommand({
      id: "mdbase-validate-collection",
      name: "Validate collection",
      callback: () => void this.runCollectionValidation(true),
    });

    this.addCommand({
      id: "mdbase-open-issues-view",
      name: "Open issues view",
      callback: () => void this.openWorkspace("issues"),
    });

    this.addCommand({
      id: "mdbase-sync",
      name: "Review sync changes",
      callback: () => void this.reviewSyncCommand(),
    });

    this.addCommand({
      id: "mdbase-open-sync",
      name: "Open sync",
      callback: () => void this.openWorkspace("sync"),
    });

    this.addCommand({
      id: "mdbase-sync-now",
      name: "Sync now",
      callback: () => void this.syncNowCommand(),
    });

    this.addCommand({
      id: "mdbase-cancel-sync",
      name: "Cancel current sync",
      checkCallback: (checking) => {
        if (!this.connectSync.isSyncing()) return false;
        if (!checking) {
          this.connectSync.cancelSync();
          this.setSyncProblem(syncProblem(new DOMException("Synchronization stopped.", "AbortError")));
        }
        return true;
      },
    });

    this.addCommand({
      id: "mdbase-open-activity",
      name: "Open sync activity",
      callback: () => void this.openSyncSection("activity"),
    });

    this.addCommand({
      id: "mdbase-resolve-conflicts",
      name: "Resolve sync conflicts",
      callback: () => void this.openSyncSection("conflicts"),
    });

    this.addCommand({
      id: "mdbase-reconnect",
      name: "Reconnect collection",
      callback: () => void this.reconnectCommand(),
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        this.onVaultModify(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.onVaultRename(file, oldPath);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        this.onVaultDelete(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;
        this.onVaultCreate(file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.validateOnOpen) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.validateFileAndStore(file, "open");
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const file = info.file;
        if (!(file instanceof TFile)) return;
        if (this.saveValidations.has(file.path)) {
          this.scheduleSaveValidation(file);
        }
        if (this.schemaRefreshes.has("schema") && this.isSchemaRelevantPath(file.path)) {
          this.scheduleSchemaRefresh();
        }
      }),
    );

    const active = this.app.workspace.getActiveFile();
    if (active && this.settings.validateOnOpen) {
      void this.validateFileAndStore(active, "open");
    }
    if (this.connectSync.getRecoveryStatus()) {
      new Notice("mdbase needs recovery. Open the mdbase workspace to review the next steps.");
    } else if (this.getMirrorProfile()) void this.refreshSyncStatus();
    this.registerInterval(window.setInterval(() => {
      if (this.getMirrorProfile() && !this.connectSync.isSyncing()) void this.refreshSyncStatus();
    }, 60_000));
  }

  onunload(): void {
    this.connectSync.dispose();
    void this.interopBridge.dispose().catch((error: unknown) => {
      console.error("mdbase: failed to dispose the interoperability bridge", error);
    });
    this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW).forEach((leaf) => leaf.detach());
    this.saveValidations.clear();
    this.schemaRefreshes.clear();
  }

  async retryInitialization(): Promise<void> {
    try {
      await this.connectSync.initialize(() => this.loadSettings());
    } catch {
      // The controller keeps a fail-closed, redacted recovery status. Register
      // the workspace even on failure; do not log potentially private payloads.
    }
    this.invalidateSchemaCache();
    if (this.statusBarEl) this.updateStatusBar();
    this.refreshWorkspaceViews(true);
  }

  async loadSettings(): Promise<void> {
    let stored: unknown = {};
    const settingsPath = normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/data.json`);
    try {
      // Obsidian loadData() can log and swallow non-ENOENT read/parse errors,
      // returning undefined. Authority settings must distinguish loss from absence.
      if (await this.app.vault.adapter.exists(settingsPath)) {
        stored = JSON.parse(await this.app.vault.adapter.read(settingsPath));
      }
    } catch {
      throw new SyncError("invalid_plugin_settings", "Plugin settings could not be read.");
    }
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
      throw new SyncError("invalid_plugin_settings", "Plugin settings must be an object.");
    }
    const settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    if (settings.mirrorProfile != null && !isMirrorProfile(settings.mirrorProfile)) {
      throw new SyncError("invalid_plugin_settings", "Mirror settings are invalid.");
    }
    this.settings = settings;
    if (this.settings.mirrorProfile == null) {
      this.settings.mirrorProfile = null;
    } else {
      try {
        this.settings.mirrorProfile.selectiveSync = normalizeSelectiveSync(this.settings.mirrorProfile.selectiveSync);
      } catch {
        throw new SyncError("invalid_plugin_settings", "File sync settings are invalid.");
      }
    }
    if (!this.settings.typeDrafts || typeof this.settings.typeDrafts !== "object" || Array.isArray(this.settings.typeDrafts)) {
      this.settings.typeDrafts = {};
    }
    this.settings.syncActivity = normalizeActivity(this.settings.syncActivity);
  }

  async saveSettings(): Promise<void> {
    this.connectSync.assertReady();
    await this.saveData(this.settings);
  }

  getIssues(): MdbaseIssue[] {
    this.sortedIssuesCache ??= Array.from(this.issueMap.values())
      .flat()
      .sort((a, b) => a.path.localeCompare(b.path) || a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code));
    return this.sortedIssuesCache;
  }

  getMirrorProfile(): MirrorProfile | null {
    return this.settings.mirrorProfile
      ? JSON.parse(JSON.stringify(this.settings.mirrorProfile)) as MirrorProfile
      : null;
  }

  getSyncActivity(): SyncActivityEntry[] {
    return this.settings.syncActivity.map((entry) => ({ ...entry }));
  }

  getCurrentSyncProblem(): SyncProblem | null {
    return this.currentSyncProblem ? { ...this.currentSyncProblem } : null;
  }

  setSyncStatus(status: MirrorStatus | null, options: { clearLocalChanges?: boolean } = {}): void {
    this.mirrorStatus = status ? JSON.parse(JSON.stringify(status)) as MirrorStatus : null;
    if (options.clearLocalChanges) this.localChangeObserved = false;
    this.currentSyncProblem = null;
    this.updateStatusBar();
  }

  setSyncProgress(progress: MirrorProgress | null, fileProgress: FileTransferProgress | null = null): void {
    this.mirrorProgress = progress ? { ...progress } : null;
    this.fileProgress = fileProgress ? { ...fileProgress } : null;
    this.updateStatusBar();
  }

  setSyncProblem(problem: SyncProblem | null): void {
    this.currentSyncProblem = problem ? { ...problem } : null;
    this.updateStatusBar();
  }

  async recordSyncActivity(input: Omit<SyncActivityEntry, "id" | "occurredAt">): Promise<void> {
    this.settings.syncActivity = appendActivity(this.settings.syncActivity, activityEntry(input));
    await this.saveSettings();
    this.refreshWorkspaceViews();
  }

  async dismissSyncActivity(id: string): Promise<void> {
    this.settings.syncActivity = this.settings.syncActivity.filter((entry) => entry.id !== id);
    await this.saveSettings();
    this.refreshWorkspaceViews();
  }

  async clearCompletedSyncActivity(): Promise<void> {
    this.settings.syncActivity = this.settings.syncActivity.filter((entry) => entry.requiresAcknowledgement);
    await this.saveSettings();
    this.refreshWorkspaceViews();
  }

  async refreshSyncStatus(): Promise<MirrorStatus | null> {
    if (this.connectSync.getRecoveryStatus()) return null;
    if (!this.getMirrorProfile()) {
      this.setSyncStatus(null);
      return null;
    }
    if (this.connectSync.isSyncing()) return this.mirrorStatus;
    try {
      const status = await this.connectSync.status();
      this.setSyncStatus(status);
      return status;
    } catch (error) {
      this.setSyncProblem(syncProblem(error));
      return null;
    }
  }

  async loadWorkspaceSchema(forceReload = false): Promise<MdbaseWorkspaceSchema | null> {
    return this.getConfigAndTypes(forceReload);
  }

  async loadTypeModel(path: string): Promise<TypeEditorModel> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error(`Type file not found: ${path}`);
    const source = await this.app.vault.cachedRead(file);
    const parsed = parseFrontmatter(source);
    if (!parsed.hasFrontmatter || parsed.error) {
      throw new Error(`Invalid type frontmatter: ${parsed.error ?? "frontmatter is missing"}`);
    }
    const model = typeModelFromDocument(parsed.frontmatter, parsed.body, file.basename);
    model.sourceRevision = sourceRevision(source);
    return model;
  }

  loadTypeDraft(path: string | null): StoredTypeDraft | null {
    const draft = this.settings.typeDrafts[path ?? "__new__"];
    return draft ? JSON.parse(JSON.stringify(draft)) as StoredTypeDraft : null;
  }

  async saveTypeDraft(draft: StoredTypeDraft): Promise<void> {
    this.settings.typeDrafts[draft.path ?? "__new__"] = JSON.parse(JSON.stringify(draft)) as StoredTypeDraft;
    await this.saveSettings();
  }

  async clearTypeDraft(path: string | null): Promise<void> {
    const key = path ?? "__new__";
    if (!(key in this.settings.typeDrafts)) return;
    delete this.settings.typeDrafts[key];
    await this.saveSettings();
  }

  async saveTypeModel(
    model: TypeEditorModel,
    existingPath: string | null,
    expectedSourceRevision?: string,
  ): Promise<TFile> {
    this.connectSync.assertLocalAuthorityWritable();
    if (this.getMirrorProfile()?.mode === "read_only") {
      throw new Error("This mirror has read-only access. Re-enroll it with write access before editing types.");
    }
    const config = await loadMdbaseConfig(this.app.vault);
    if (!config) throw new Error("No mdbase.yaml found.");
    if (!config.spec_version.startsWith("0.3.")) {
      throw new Error("mdbase v0.2 type definitions are read-only. Migrate the collection first.");
    }
    const existing = existingPath
      ? this.app.vault.getAbstractFileByPath(normalizePath(existingPath))
      : null;
    if (existing != null && !(existing instanceof TFile)) {
      throw new Error(`Type file not found: ${existingPath}`);
    }
    const saved = await this.writeTypeDefinition(
      config,
      model,
      existing,
      expectedSourceRevision,
    );
    this.refreshWorkspaceViews(true);
    return saved;
  }

  async initializeCollection(): Promise<void> {
    this.connectSync.assertLocalAuthorityWritable();
    await this.initializeCollectionCommand();
    this.refreshWorkspaceViews(true);
  }

  async validateCollection(): Promise<void> {
    await this.runCollectionValidation(false);
  }

  analyzeMigration(): Promise<V02MigrationPlan> {
    if (this.getMirrorProfile()) {
      throw new Error("Collection authority resources must be migrated at the collection authority.");
    }
    return analyzeV02Migration(this.app.vault);
  }

  async applyMigration(plan: V02MigrationPlan, allowLossy: boolean): Promise<void> {
    this.connectSync.assertLocalAuthorityWritable();
    if (this.getMirrorProfile()) {
      throw new Error("Collection authority resources must be migrated at the collection authority.");
    }
    const result = await applyV02Migration(this.app.vault, plan, { allowLossy });
    if (!result.applied) {
      throw new Error(
        result.restored
          ? `Migration failed and all writes were rolled back. ${result.error ?? ""}`.trim()
          : `Migration needs manual recovery. See ${result.manifestPath}. ${result.error ?? ""}`.trim(),
      );
    }
    this.invalidateSchemaCache();
    new Notice(`Migrated to mdbase v0.3. Recovery manifest: ${result.manifestPath}`);
    this.refreshWorkspaceViews(true);
  }

  async openIssue(issue: MdbaseIssue): Promise<void> {
    await this.openFileByPath(issue.path, issue.field);
  }

  getQuickFixLabel(issue: MdbaseIssue): string | null {
    return quickFixLabel(issue);
  }

  async applyQuickFix(issue: MdbaseIssue): Promise<void> {
    this.connectSync.assertLocalAuthorityWritable();
    const file = this.app.vault.getAbstractFileByPath(issue.path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${issue.path}`);
      return;
    }

    if (this.getMirrorProfile()?.mode === "read_only") throw new Error("This mirror has read-only access.");
    let changed = false;
    await this.app.vault.process(file, (raw) => {
      this.connectSync.assertLocalAuthorityWritable();
      const result = applyQuickFixToDocument(raw, issue);
      changed = result.changed;
      return result.content;
    });
    new Notice(changed ? `Updated '${issue.field ?? "field"}' in ${file.basename}` : "The field changed or no safe quick fix is available. Revalidate the note.");
    await this.validateFileAndStore(file, "manual");
  }

  async openFileByPath(path: string, field?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${path}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    if (field) {
      this.revealFrontmatterField(file, field);
    }
  }

  private revealFrontmatterField(file: TFile, fieldPath: string): void {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return;
    if (!(leaf.view instanceof MarkdownView)) return;

    const view = leaf.view;
    if (!(view.file instanceof TFile) || view.file.path !== file.path) return;

    const editor = view.editor;
    const totalLines = editor.lineCount();
    if (totalLines < 3) return;

    const targetKey = getTopLevelFieldFromIssuePath(fieldPath);
    const matcher = new RegExp(`^\\s*${escapeRegExp(targetKey)}\\s*:`);

    if (editor.getLine(0).trim() !== "---") return;
    for (let line = 1; line < totalLines; line += 1) {
      const value = editor.getLine(line);
      if (value.trim() === "---") break;
      if (matcher.test(value)) {
        editor.setCursor({ line, ch: 0 });
        editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        return;
      }
    }
  }

  private updateStatusBar(): void {
    const recovery = this.connectSync.getRecoveryStatus();
    if (recovery) {
      this.statusBarEl.setText("mdbase: recovery required");
      this.statusBarEl.setAttr("aria-label", "Plugin writes are blocked. Open mdbase recovery.");
      this.statusBarEl.setAttr("title", recovery.summary);
      this.statusBarEl.setAttr("data-state", "attention");
      return;
    }
    const issues = this.getIssues();
    const indicator = syncIndicator({
      connected: this.getMirrorProfile() !== null,
      status: this.mirrorStatus,
      progress: this.mirrorProgress,
      fileProgress: this.fileProgress,
      problem: this.currentSyncProblem,
      validationIssues: issues.length,
      localChangeObserved: this.localChangeObserved,
    });
    this.statusBarEl.setText(indicator.label);
    this.statusBarEl.setAttr("aria-label", `${indicator.detail}. Open mdbase ${indicator.destination}.`);
    this.statusBarEl.setAttr("title", indicator.detail);
    this.statusBarEl.setAttr("data-state", indicator.state);
  }

  private async openStatusDestination(): Promise<void> {
    if (this.connectSync.getRecoveryStatus()) {
      await this.openWorkspace("sync");
      return;
    }
    const indicator = syncIndicator({
      connected: this.getMirrorProfile() !== null,
      status: this.mirrorStatus,
      progress: this.mirrorProgress,
      fileProgress: this.fileProgress,
      problem: this.currentSyncProblem,
      validationIssues: this.getIssues().length,
      localChangeObserved: this.localChangeObserved,
    });
    await this.openWorkspace(indicator.destination);
  }

  private async openIssuesView(): Promise<void> {
    await this.openWorkspace("issues");
  }

  async openWorkspace(destination: "types" | "sync" | "issues" = "types"): Promise<MdbaseWorkspaceView> {
    const existing = this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      const view = existing.view as MdbaseWorkspaceView;
      view.showDestination(destination);
      await view.refresh();
      return view;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: MDBASE_WORKSPACE_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as MdbaseWorkspaceView;
    await view.refresh();
    view.showDestination(destination);
    return view;
  }

  private refreshWorkspaceViews(forceReload = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW)) {
      // Plugin reload can briefly leave a leaf carrying the previous module's
      // view instance. Ignore that stale leaf until Obsidian replaces it.
      const view = leaf.view as unknown as Partial<MdbaseWorkspaceView>;
      if (typeof view.refresh === "function") void view.refresh(forceReload);
    }
  }

  private refreshIssueViews(): void {
    this.updateStatusBar();
    this.refreshWorkspaceViews();
  }

  private setFileIssues(path: string, issues: MdbaseIssue[]): void {
    if (issues.length === 0) {
      this.issueMap.delete(path);
    } else {
      this.issueMap.set(path, issues);
    }
    this.sortedIssuesCache = null;
    this.refreshIssueViews();
  }

  private clearFileIssues(path: string): void {
    if (!this.issueMap.has(path)) return;
    this.issueMap.delete(path);
    this.sortedIssuesCache = null;
    this.refreshIssueViews();
  }

  private moveFileIssues(oldPath: string, newPath: string): void {
    const current = this.issueMap.get(oldPath);
    if (!current) return;

    this.issueMap.delete(oldPath);
    this.issueMap.set(
      newPath,
      current.map((issue) => ({
        ...issue,
        path: newPath,
      })),
    );
    this.sortedIssuesCache = null;
    this.refreshIssueViews();
  }

  private clearPendingSaveValidation(path: string): void {
    this.saveValidations.cancel(path);
  }

  private scheduleSaveValidation(file: TFile): void {
    this.saveValidations.schedule(file.path, file);
  }

  private scheduleSchemaRefresh(): void {
    this.schemaRefreshes.schedule("schema", undefined);
  }

  private refreshSchemaNow(): void {
    this.schemaRefreshes.cancel("schema");
    this.invalidateSchemaCache();
    this.refreshWorkspaceViews();
  }

  private isSchemaRelevantPath(path: string): boolean {
    const normalized = normalizePath(path);
    if (normalized === "mdbase.yaml") return true;

    const possibleFolders = new Set<string>(["_types", "_contracts"]);
    if (this.schemaCache) {
      possibleFolders.add(normalizePath(this.schemaCache.config.settings.types_folder));
      possibleFolders.add(normalizePath(this.schemaCache.config.settings.contracts_folder ?? "_contracts"));
    }

    for (const folder of possibleFolders) {
      if (normalized === folder || normalized.startsWith(`${folder}/`)) return true;
    }

    return false;
  }

  private invalidateSchemaCache(): void {
    this.schemaCache = null;
    this.schemaLoadPromise = null;
  }

  private async getConfigAndTypes(forceReload = false): Promise<LoadedSchema | null> {
    if (forceReload) {
      this.invalidateSchemaCache();
    }

    if (this.schemaCache) return this.schemaCache;
    if (this.schemaLoadPromise) return this.schemaLoadPromise;

    this.schemaLoadPromise = (async () => {
      const config = await loadMdbaseConfig(this.app.vault);
      if (!config) return null;
      const types = await loadTypeDefinitions(this.app.vault, config);
      const contracts = await loadContractDefinitions(this.app.vault, config);
      return { config, types, contracts };
    })();

    try {
      const loaded = await this.schemaLoadPromise;
      if (loaded) this.schemaCache = loaded;
      return loaded;
    } finally {
      this.schemaLoadPromise = null;
    }
  }

  private async requireConfigAndTypes(options: { background?: boolean; forceReload?: boolean } = {}): Promise<LoadedSchema | null> {
    const background = options.background ?? false;
    const loaded = await this.getConfigAndTypes(options.forceReload ?? false);
    if (!loaded) {
      if (!background) {
        new Notice("No mdbase.yaml found. Run 'mdbase: Initialize collection' first.");
      }
      return null;
    }

    if (loaded.types.size === 0 && !background) {
      new Notice(`No types found in ${loaded.config.settings.types_folder}`);
    }

    return loaded;
  }

  private onVaultModify(file: TFile): void {
    this.observeLocalMirrorChange(file.path);
    if (this.isSchemaRelevantPath(file.path)) {
      this.scheduleSchemaRefresh();
    }

    if (!this.settings.validateOnSave) return;
    if (file.extension !== "md") return;
    this.scheduleSaveValidation(file);
  }

  private onVaultRename(file: TFile, oldPath: string): void {
    this.observeLocalMirrorChange(oldPath);
    this.observeLocalMirrorChange(file.path);
    if (this.isSchemaRelevantPath(oldPath) || this.isSchemaRelevantPath(file.path)) {
      this.refreshSchemaNow();
    }

    if (file.extension !== "md") return;

    this.clearPendingSaveValidation(oldPath);
    this.moveFileIssues(oldPath, file.path);

    if (this.settings.validateOnSave) {
      this.scheduleSaveValidation(file);
    }
  }

  private onVaultDelete(file: TFile): void {
    this.observeLocalMirrorChange(file.path);
    if (this.isSchemaRelevantPath(file.path)) {
      this.refreshSchemaNow();
    }

    if (file.extension !== "md") return;
    this.clearPendingSaveValidation(file.path);
    this.clearFileIssues(file.path);
  }

  private onVaultCreate(file: TFile): void {
    this.observeLocalMirrorChange(file.path);
    if (this.isSchemaRelevantPath(file.path)) {
      this.refreshSchemaNow();
    }
  }

  private observeLocalMirrorChange(path: string): void {
    if (!this.getMirrorProfile() || this.connectSync.isSyncing()) return;
    const normalized = normalizePath(path);
    const reservedFolders = [this.app.vault.configDir, ".mdbase", ".trash", ".git"];
    if (reservedFolders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`))) return;
    this.localChangeObserved = true;
    this.updateStatusBar();
  }

  private async validateFileAndStore(
    file: TFile,
    reason: "save" | "open" | "manual",
    isCurrent: () => boolean = () => true,
  ): Promise<MdbaseIssue[]> {
    const loaded = await this.requireConfigAndTypes({ background: reason !== "manual" });
    if (!isCurrent()) return [];
    if (!loaded) {
      if (reason !== "manual") {
        this.clearFileIssues(file.path);
      }
      return [];
    }

    const issues = await validateFile(this.app.vault, file, loaded.config, loaded.types);
    if (!isCurrent()) return issues;
    this.setFileIssues(file.path, issues);

    if (reason === "save" && this.settings.showNoticeOnSave && issues.length > 0) {
      new Notice(`mdbase: ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${file.basename}`);
    }

    return issues;
  }

  private async initializeCollectionCommand(): Promise<void> {
    if (this.connectSync.getRecoveryStatus()) {
      await this.openWorkspace("sync");
      return;
    }
    this.connectSync.assertLocalAuthorityWritable();
    if (this.getMirrorProfile()) {
      new Notice("This vault is configured as a mirror. Sync it instead of initializing a local collection.");
      return;
    }
    const { created } = await ensureCollectionInitialized(this.app.vault);
    this.invalidateSchemaCache();

    if (created.length === 0) {
      new Notice("mdbase collection already initialized.");
      return;
    }

    new Notice(`Initialized mdbase collection: ${created.join(", ")}`);
  }

  private async reviewSyncCommand(): Promise<void> {
    const view = await this.openWorkspace("sync");
    if (this.getMirrorProfile()) await view.reviewSyncChanges();
  }

  private async syncNowCommand(): Promise<void> {
    const view = await this.openWorkspace("sync");
    if (this.getMirrorProfile()) await view.syncNow();
  }

  private async openSyncSection(section: "activity" | "conflicts"): Promise<void> {
    const view = await this.openWorkspace("sync");
    view.focusSyncSection(section);
  }

  private async reconnectCommand(): Promise<void> {
    const view = await this.openWorkspace("sync");
    if (this.getMirrorProfile()) await view.reconnectCollection();
  }

  private async createTypeDefinitionCommand(): Promise<void> {
    const view = await this.openWorkspace("types");
    view.createNewType();
  }

  private async editTypeDefinitionCommand(): Promise<void> {
    const loaded = await this.requireConfigAndTypes();
    if (!loaded || loaded.types.size === 0) {
      new Notice("No type definitions found.");
      return;
    }
    const chosen = await pickType(this.app, [...loaded.types.values()]);
    if (!chosen) return;
    const view = await this.openWorkspace("types");
    await view.editType(chosen.filePath);
  }

  private async editCurrentTypeDefinitionCommand(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("Open a typed Markdown note or type definition first.");
      return;
    }
    const loaded = await this.requireConfigAndTypes();
    if (!loaded) return;
    const definition = [...loaded.types.values()].find((type) => type.filePath === file.path);
    let chosen = definition ?? null;
    if (!chosen) {
      const parsed = parseFrontmatter(await this.app.vault.cachedRead(file));
      if (parsed.error) {
        new Notice(`Cannot identify this note's type: ${parsed.error}`);
        return;
      }
      const names = getTypesForFile(file.path, parsed.frontmatter, loaded.config, loaded.types);
      const candidates = names.flatMap((name) => {
        const type = loaded.types.get(name);
        return type ? [type] : [];
      });
      if (candidates.length === 0) {
        new Notice("The current note does not match a known type definition.");
        return;
      }
      chosen = candidates.length === 1 ? candidates[0] : await pickType(this.app, candidates);
    }
    if (!chosen) {
      new Notice("The current note does not match a known type definition.");
      return;
    }
    const view = await this.openWorkspace("types");
    await view.editType(chosen.filePath);
  }

  private async createNoteFromTypeCommand(): Promise<void> {
    if (this.connectSync.getRecoveryStatus()) {
      await this.openWorkspace("sync");
      return;
    }
    this.connectSync.assertLocalAuthorityWritable();
    const loaded = await this.requireConfigAndTypes();
    if (!loaded) return;

    if (loaded.types.size === 0) {
      new Notice("No type definitions found.");
      return;
    }

    const chosenType = await pickType(this.app, Array.from(loaded.types.values()));
    if (!chosenType) return;

    const frontmatter = buildInitialFrontmatter(chosenType, loaded.config);
    const promptFields = getPromptFields(chosenType, frontmatter);

    for (const [fieldName, fieldDef] of promptFields) {
      const prompt = `Required field: ${fieldName}`;
      const value = await new TextPromptModal(this.app, prompt, fieldDef.type ?? "string").openAndGetValue();
      if (value == null) return;
      if (value.trim().length === 0) {
        new Notice(`Field '${fieldName}' is required.`);
        return;
      }

      try {
        frontmatter[fieldName] = coerceFieldInput(value, fieldDef);
      } catch (error) {
        new Notice(`Invalid value for ${fieldName}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    const displayKey = chosenType.display_name_key ?? "title";
    if (frontmatter[displayKey] == null) {
      const displayValue = await new TextPromptModal(
        this.app,
        `Optional ${displayKey} (used for filename)`,
        "",
      ).openAndGetValue();
      if (displayValue && displayValue.trim().length > 0) {
        frontmatter[displayKey] = displayValue.trim();
      }
    }

    const suggestedPath = await buildUniqueNotePath(this.app.vault, chosenType, frontmatter);
    const chosenPathInput = await new TextPromptModal(
      this.app,
      "Note path",
      "Relative path in vault",
      suggestedPath,
    ).openAndGetValue();

    if (chosenPathInput == null) return;

    let finalPath = normalizePath(chosenPathInput.trim().length > 0 ? chosenPathInput.trim() : suggestedPath);
    if (!finalPath.endsWith(".md")) {
      finalPath = `${finalPath}.md`;
    }

    try {
      const file = await createNoteFromType(this.app.vault, finalPath, frontmatter);
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice(`Created note: ${file.path}`);
      await this.validateFileAndStore(file, "manual");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async validateCurrentNoteCommand(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
      new Notice("Open a Markdown note first.");
      return;
    }

    const issues = await this.validateFileAndStore(activeFile, "manual");
    if (issues.length === 0) {
      new Notice("No issues in current note.");
    } else {
      new Notice(`Found ${issues.length} issue${issues.length === 1 ? "" : "s"} in current note.`);
      await this.openIssuesView();
    }
  }

  async runCollectionValidation(showSummary: boolean): Promise<void> {
    const loaded = await this.requireConfigAndTypes({ background: false });
    if (!loaded) return;

    const issues = await validateCollection(this.app.vault, loaded.config, loaded.types);
    const nextMap = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) {
      const list = nextMap.get(issue.path) ?? [];
      list.push(issue);
      nextMap.set(issue.path, list);
    }

    this.issueMap = nextMap;
    this.sortedIssuesCache = null;
    this.refreshIssueViews();

    if (showSummary) {
      if (issues.length === 0) {
        new Notice("Collection validation passed with no issues.");
      } else {
        const errors = issues.filter((issue) => issue.severity === "error").length;
        const warnings = issues.length - errors;
        new Notice(`Collection validation: ${errors} error(s), ${warnings} warning(s)`);
        await this.openIssuesView();
      }
    }
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath).replace(/\/+$/, "");
    if (!normalized) return;

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async writeTypeDefinition(
    config: MdbaseConfig,
    model: TypeEditorModel,
    existingFile: TFile | null,
    expectedSourceRevision?: string,
  ): Promise<TFile> {
    const typeName = model.name.trim();
    if (!typeName) {
      throw new Error("Type name is required.");
    }

    if (!config.spec_version.startsWith("0.3.") || model.specProfile !== "v0.3") {
      throw new Error("mdbase v0.2 type definitions are read-only. Migrate the collection first.");
    }
    const frontmatter = frontmatterFromTypeModel(model);
    const body = model.body.trim() || `# ${typeName}\n\nType definition for ${typeName}.`;
    const content = `${formatMarkdown(frontmatter, body)}\n`;

    const typesFolder = normalizePath(config.settings.types_folder);
    const defaultTargetPath = normalizePath(`${typesFolder}/${typeName}.md`);

    if (!existingFile) {
      await this.ensureFolderExists(typesFolder);

      if (await this.app.vault.adapter.exists(defaultTargetPath)) {
        throw new Error(`Type already exists: ${defaultTargetPath}`);
      }

      const created = await this.app.vault.create(defaultTargetPath, content);
      this.invalidateSchemaCache();
      return created;
    }

    const originalPath = existingFile.path;
    const originalContent = await this.app.vault.cachedRead(existingFile);
    if (expectedSourceRevision && sourceRevision(originalContent) !== expectedSourceRevision) {
      throw new Error(
        `The source changed after this draft was opened: ${originalPath}. Reopen the type and review both versions before saving.`,
      );
    }
    const slashIndex = existingFile.path.lastIndexOf("/");
    const parentFolder = slashIndex >= 0 ? existingFile.path.slice(0, slashIndex) : "";
    const renamedPath = normalizePath(`${parentFolder ? `${parentFolder}/` : ""}${typeName}.md`);
    const targetPath = renamedPath || defaultTargetPath;

    if (targetPath !== existingFile.path && (await this.app.vault.adapter.exists(targetPath))) {
      throw new Error(`Cannot rename type file to ${targetPath}; file already exists.`);
    }

    let renamed = false;
    try {
      if (targetPath !== existingFile.path) {
        await this.app.fileManager.renameFile(existingFile, targetPath);
        renamed = true;
      }

      const updatedFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!(updatedFile instanceof TFile)) {
        throw new Error(`Unable to access updated type file: ${targetPath}`);
      }

      await this.app.vault.modify(updatedFile, content);
      this.invalidateSchemaCache();
      return updatedFile;
    } catch (error) {
      try {
        const current = this.app.vault.getAbstractFileByPath(renamed ? targetPath : originalPath);
        if (current instanceof TFile) {
          await this.app.vault.modify(current, originalContent);
          if (renamed) await this.app.fileManager.renameFile(current, originalPath);
        }
      } catch (rollbackError) {
        throw new Error(
          `Saving the type failed and automatic recovery also failed. Review '${originalPath}' and '${targetPath}'. `
          + `${error instanceof Error ? error.message : String(error)}; recovery: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    }
  }
}
