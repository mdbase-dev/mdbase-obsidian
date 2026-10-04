import { ContractCatalogModal, recoverPackInstall } from "./src/contractCatalog";
import { ValidationState } from "./src/validationState";
import { MdbaseMutationBackend } from "./src/mdbaseMutationBackend";
import { createNoteFromTypeCommand } from "./src/commands";
import { applyQuickFixToDocument, quickFixLabel } from "./src/quickFix";
import {
  App,
  addIcon,
  apiVersion,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { ObsidianInteropBridge, type MdbaseObsidianInteropApi } from "./src/interopBridge";
import {
  MdbaseConfig,
  MdbaseIssue,
  MdbaseTypeDef,
  type CollectionRecord,
  ensureCollectionInitialized,
  formatMarkdown,
  getTopLevelFieldFromIssuePath,
  getTypesForFile,
  isExcluded,
  loadMdbaseConfig,
  loadContractDefinitions,
  loadTypeDefinitions,
  parseFrontmatter,
  readCollectionRecords,
  validateCollection,
  validateFile,
} from "./src/mdbaseCore";
import type { StoredTypeDraft, TypeEditorModel } from "./src/typeEditorTypes";
import {
  ConnectSyncController,
  normalizeMirrorProfile,
  type MirrorProfile,
} from "./src/connectSync";
import {
  analyzeV02Migration,
  applyV02Migration,
  type V02MigrationPlan,
} from "./src/migration";
import { frontmatterFromTypeModel, typeModelFromDocument } from "./src/typeModel";
import { sourceRevision } from "./src/typeDraft";
import {
  MDBASE_WORKSPACE_VIEW,
  MdbaseWorkspaceView,
  type MdbaseWorkspaceSchema,
} from "./src/workspaceView";
import { MDBASE_ICON_ID, MDBASE_ICON_SVG } from "./src/mdbaseIcon";
import { KeyedTrailingDebouncer } from "./src/trailingDebouncer";
import { historyEvent, SyncHistoryStore } from "./src/syncHistory";
import { NoteSyncHistoryModal } from "./src/syncHistoryModal";
import { registerCommands } from "./src/commands";
import { MdbaseSettingTab } from "./src/settingsTab";
import { SyncSession } from "./src/syncSession";
import { SyncScheduler } from "./src/syncScheduler";
import { syncDiagnostics } from "./src/syncDiagnostics";
import { normalizeActivity, syncIndicator, type SyncActivityEntry } from "./src/syncUx";

interface MdbasePluginSettings {
  validateOnSave: boolean;
  validateOnOpen: boolean;
  showNoticeOnSave: boolean;
  interopEnabled: boolean;
  mirrorProfile: MirrorProfile | null;
  typeDrafts: Record<string, StoredTypeDraft>;
  archivedTypeDrafts: StoredTypeDraft[];
  /** Apply routine sync plans in the background; risky plans still wait for review. */
  autoSync: boolean;
  /** 2: automatic sync became the default. */
  syncSettingsVersion?: number;
  /** Pre-0.4 activity log, migrated into sync history on load. */
  syncActivity?: SyncActivityEntry[];
}

const DEFAULT_SETTINGS: MdbasePluginSettings = {
  validateOnSave: true,
  validateOnOpen: true,
  showNoticeOnSave: false,
  interopEnabled: false,
  mirrorProfile: null,
  typeDrafts: {},
  archivedTypeDrafts: [],
  autoSync: true,
  syncSettingsVersion: 2,
};

/** Vault-scoped device storage key; Obsidian keeps it out of the vault and out of plugin data. */
const DEVICE_ID_KEY = "mdbase-sync-device-id";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  private mutationBackend: MdbaseMutationBackend | null = null;
  settings: MdbasePluginSettings;
  private issueMap = new Map<string, MdbaseIssue[]>();
  private readonly validation = new ValidationState();
  private validationAbort: AbortController | null = null;
  private sortedIssuesCache: MdbaseIssue[] | null = null;
  private statusBarEl: HTMLElement | undefined;
  private ribbonEl: HTMLElement | undefined;
  private noteStatusEl: HTMLElement;
  private noteStatusVersion = 0;
  sync: SyncSession;
  private syncScheduler: SyncScheduler | null = null;
  private recordCache: Map<string, CollectionRecord> | null = null;
  private recordCacheSettings = "";
  private recordCacheEpoch = 0;
  private recordList: CollectionRecord[] | null = null;
  private recordLoadPromise: Promise<CollectionRecord[]> | null = null;
  private readonly dirtyRecordPaths = new Set<string>();
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
        if (!profile) this.sync?.reset();
        else this.requestSync();
      },
      deviceId: () => this.deviceId(),
    }, { assertLegacyRuntime: () => this.assertLegacyOperation("Old Connect operations") });
    this.interopBridge = new ObsidianInteropBridge(app, () => this.settings?.interopEnabled === true);
    this.api = {
      apiVersion: 1,
      interop: this.interopBridge,
      getInteropStatus: () => ({
        enabled: this.settings?.interopEnabled === true,
        profileVersion: "0.1",
      }),
    };
  }

  /** Internal seam only; runtime attachment/activation is a separate follow-up. */
  setMdbaseMutationBackend(backend: MdbaseMutationBackend | null): void {
    this.connectSync.assertIdle();
    if (backend && (this.getMirrorProfile() || this.connectSync.getAdoptionMarker())) {
      throw new Error("Disconnect or complete migration from the old Connect runtime before attaching mdbase next.");
    }
    this.mutationBackend = backend;
  }

  private assertLegacyOperation(operation: string): void {
    if (this.mutationBackend) throw new Error(`${operation} is not yet available through the shared runtime.`);
  }

  async createTypedNote(path: string, frontmatter: Record<string, unknown>): Promise<TFile> {
    if (this.mutationBackend) {
      return this.mutationBackend.create(this.app.vault, path, `${formatMarkdown(frontmatter, "")}\n`);
    }
    this.connectSync.assertLocalAuthorityWritable();
    if (this.getMirrorProfile()?.mode === "read_only") throw new Error("This mirror has read-only access.");
    const { createNoteFromType } = await import("./src/mdbaseCore");
    return createNoteFromType(this.app.vault, path, frontmatter);
  }

  private async transformRecord(file: TFile, transform: (raw: string) => string): Promise<void> {
    if (this.mutationBackend) {
      await this.mutationBackend.transform(file.path, transform);
    } else {
      await this.app.vault.process(file, transform);
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.connectSync.initialize();
    await this.createSyncSession();
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
    this.noteStatusEl = this.addStatusBarItem();
    this.noteStatusEl.addClass("mdbase-note-status");
    this.noteStatusEl.setAttr("role", "button");
    this.noteStatusEl.setAttr("tabindex", "0");
    this.noteStatusEl.hide();
    this.registerDomEvent(this.noteStatusEl, "click", () => void this.openNoteStatusDestination());
    this.registerDomEvent(this.noteStatusEl, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void this.openNoteStatusDestination();
    });
    this.updateStatusBar();

    this.registerView(MDBASE_WORKSPACE_VIEW, (leaf) => new MdbaseWorkspaceView(leaf, this));
    this.addSettingTab(new MdbaseSettingTab(this.app, this));
    this.ribbonEl = this.addRibbonIcon(MDBASE_ICON_ID, "Open mdbase", () => void this.onRibbonClick());
    this.ribbonEl.addClass("mdbase-ribbon");
    this.updateStatusBar();

    registerCommands(this);

    this.registerVaultEvents();

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.validateOnOpen) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.validateFileAndStore(file, "open");
      }),
    );

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.updateNoteStatus()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file.path === this.app.workspace.getActiveFile()?.path) void this.updateNoteStatus();
    }));

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

    try { await recoverPackInstall(this.app); } catch (error) { new Notice(`Contract pack recovery needs attention: ${String(error)}`, 0); }
    const active = this.app.workspace.getActiveFile();
    if (active && this.settings.validateOnOpen) {
      void this.validateFileAndStore(active, "open");
    }
    this.startSyncScheduler();
  }

  /**
   * Sync runs when local edits settle, when Connect has hosted changes, when the
   * app returns to the front or the network comes back, and retries with backoff.
   */
  private startSyncScheduler(): void {
    this.syncScheduler = new SyncScheduler({
      connected: () => this.getMirrorProfile() !== null,
      automatic: () => this.settings.autoSync,
      problemKind: () => this.sync.state.paused ? "paused" : this.sync.state.problem?.kind ?? null,
      autoSync: () => this.sync.autoSync(),
      refreshStatus: () => this.sync.refreshStatus(),
      remoteChangesWaiting: () => this.connectSync.remoteChangesWaiting(),
      reportProblem: (error) => {
        this.sync.reportProblem(error);
      },
      setRetryAt: (at) => this.sync.setRetryAt(at),
    });
    this.registerDomEvent(window, "online", () => this.syncScheduler?.noteOnline());
    this.registerDomEvent(window, "focus", () => this.syncScheduler?.noteVisibility(true));
    // The main window's visibility is the app's: hidden on mobile when backgrounded.
    const appDocument = window.document;
    this.registerDomEvent(appDocument, "visibilitychange", () => {
      this.syncScheduler?.noteVisibility(appDocument.visibilityState === "visible");
    });
    this.syncScheduler.start();
  }

  /** Run the scheduler's decision soon, e.g. after connecting or changing sync settings. */
  requestSync(): void {
    this.syncScheduler?.requestSoon();
  }

  /** Vault-scoped and device-local: a copied vault or synced plugin data gets its own. */
  private deviceId(): string {
    const stored: unknown = this.app.loadLocalStorage(DEVICE_ID_KEY);
    if (typeof stored === "string" && stored) return stored;
    const created = crypto.randomUUID();
    this.app.saveLocalStorage(DEVICE_ID_KEY, created);
    return created;
  }

  onunload(): void {
    this.validationAbort?.abort();
    this.syncScheduler?.stop();
    this.connectSync.dispose();
    void this.interopBridge.dispose().catch((error: unknown) => {
      console.error("mdbase: failed to dispose the interoperability bridge", error);
    });
    this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW).forEach((leaf) => leaf.detach());
    this.saveValidations.clear();
    this.schemaRefreshes.clear();
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<MdbasePluginSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    // Before version 2 automatic sync was off by default and stopped for most
    // plans, so a stored `false` is almost always the old default, not a choice.
    const version = typeof stored?.syncSettingsVersion === "number"
      && Number.isSafeInteger(stored.syncSettingsVersion) && stored.syncSettingsVersion >= 1
      ? stored.syncSettingsVersion : 1;
    this.settings.syncSettingsVersion = Math.max(2, version);
    this.settings.autoSync = version < 2 || typeof stored?.autoSync !== "boolean"
      ? DEFAULT_SETTINGS.autoSync : stored.autoSync;
    this.settings.mirrorProfile = normalizeMirrorProfile(this.settings.mirrorProfile);
    if (!this.settings.typeDrafts || typeof this.settings.typeDrafts !== "object" || Array.isArray(this.settings.typeDrafts)) {
      this.settings.typeDrafts = {};
    }
    this.settings.archivedTypeDrafts = Array.isArray(this.settings.archivedTypeDrafts) ? this.settings.archivedTypeDrafts : [];
  }

  async saveSettings(): Promise<void> {
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

  /**
   * Other tools that also move this vault's files. Two sync services on the
   * same files can duplicate notes or bring deleted ones back, and cloud
   * folders can evict files that then look deleted.
   */
  otherSyncServices(): string[] {
    const services: string[] = [];
    const app = this.app as unknown as {
      internalPlugins?: { getEnabledPluginById?(id: string): { vaultId?: unknown } | null };
      plugins?: { enabledPlugins?: Set<string> };
    };
    // The Sync core plugin is enabled by default; it only syncs once a remote vault is chosen.
    const obsidianSync = app.internalPlugins?.getEnabledPluginById?.("sync");
    if (typeof obsidianSync?.vaultId === "string" && obsidianSync.vaultId) services.push("Obsidian Sync");
    const community: Record<string, string> = {
      "obsidian-livesync": "Self-hosted LiveSync",
      "remotely-save": "Remotely Save",
      "obsidian-git": "Obsidian Git",
    };
    for (const [id, name] of Object.entries(community)) {
      if (app.plugins?.enabledPlugins?.has(id)) services.push(name);
    }
    const adapter = this.app.vault.adapter;
    const base = typeof FileSystemAdapter === "function" && adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
    const folders: Array<[RegExp, string]> = [
      [/Mobile Documents|iCloud/i, "iCloud Drive"],
      [/[\\/]Dropbox[\\/]/i, "Dropbox"],
      [/[\\/]OneDrive/i, "OneDrive"],
      [/Google ?Drive|GoogleDrive/i, "Google Drive"],
    ];
    for (const [pattern, name] of folders) if (pattern.test(base)) services.push(name);
    return services;
  }

  /** Copies a support report; the person sees it in the clipboard before sharing it. */
  async copySyncDiagnostics(): Promise<void> {
    const profile = this.getMirrorProfile();
    let checkpoint = null;
    try {
      checkpoint = await this.connectSync.checkpointSummary();
    } catch (error) {
      console.error("mdbase: could not read the sync checkpoint for diagnostics", error);
    }
    const report = syncDiagnostics({
      generatedAt: new Date().toISOString(),
      pluginVersion: this.manifest.version,
      obsidianVersion: apiVersion,
      platform: Platform.isIosApp ? "iOS" : Platform.isAndroidApp ? "Android" : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "unknown",
      profile,
      otherDevice: this.connectSync.isOtherDevice(profile),
      automatic: this.settings.autoSync,
      otherSyncServices: this.otherSyncServices(),
      state: this.sync.state,
      checkpoint,
      history: this.sync.historyRuns(),
    });
    await navigator.clipboard.writeText(report);
    new Notice("Copied sync diagnostics. They name the collection and recent files but contain no note text or credentials.");
  }

  openNoteSyncHistory(path: string): void {
    new NoteSyncHistoryModal(this.app, path, this.sync.historyRuns()).open();
  }

  openSettings(): void {
    // Obsidian exposes the settings modal on app but not in its public typings.
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** Sync state lives in one session; the status bar and views subscribe to it. */
  private async createSyncSession(): Promise<void> {
    const folder = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const history = new SyncHistoryStore(this.app.vault.adapter, normalizePath(`${folder}/sync-history.jsonl`));
    try {
      await history.load();
      await this.migrateSyncActivity(history);
    } catch (error) {
      // History is a convenience; an unreadable log must not block sync.
      console.error("mdbase: could not load sync history", error);
    }
    this.sync = new SyncSession(this.connectSync, () => this.getMirrorProfile(), history, (message) => {
      new Notice(`mdbase: ${message}`, 10_000);
    });
    this.register(this.sync.subscribe(() => this.updateStatusBar()));
  }

  /** Before 0.4 events were kept in plugin data; they now share the history log. */
  private async migrateSyncActivity(history: SyncHistoryStore): Promise<void> {
    const legacy = normalizeActivity(this.settings.syncActivity);
    const collectionId = this.settings.mirrorProfile?.collectionId;
    if (collectionId) {
      for (const entry of legacy) {
        await history.append(historyEvent(collectionId, {
          summary: entry.summary,
          tone: entry.tone,
          ...(entry.detail ? { message: entry.detail } : {}),
          ...(entry.path ? { path: entry.path } : {}),
          ...(entry.requiresAcknowledgement ? { needsAcknowledgement: true } : {}),
        }, entry.occurredAt));
      }
    }
    if (this.settings.syncActivity !== undefined) {
      delete this.settings.syncActivity;
      await this.saveSettings();
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
    const prior = this.loadTypeDraft(draft.path);
    if (prior && prior.sourceRevision !== draft.sourceRevision) this.settings.archivedTypeDrafts.push(prior);
    this.settings.typeDrafts[draft.path ?? "__new__"] = JSON.parse(JSON.stringify(draft)) as StoredTypeDraft;
    await this.saveSettings();
  }

  getArchivedTypeDrafts(path: string): StoredTypeDraft[] {
    return this.settings.archivedTypeDrafts.filter(draft => draft.path === path);
  }

  async discardArchivedTypeDraft(draft: StoredTypeDraft): Promise<void> {
    this.settings.archivedTypeDrafts = this.settings.archivedTypeDrafts.filter(candidate =>
      candidate.path !== draft.path || candidate.updatedAt !== draft.updatedAt || candidate.sourceRevision !== draft.sourceRevision);
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

  getValidationSummary(): string {
    const config = this.schemaCache?.config;
    const paths = this.app.vault.getMarkdownFiles().filter(file => !config || !isExcluded(file.path, config)).map(file => file.path);
    return this.validation.summary(paths);
  }

  isValidating(): boolean { return this.validationAbort !== null; }

  cancelValidation(): void { this.validationAbort?.abort(); }

  async openContractCatalog(): Promise<void> {
    this.assertLegacyOperation("Installing packs");
    if (this.getMirrorProfile()) throw new Error("Install packs at the hosted collection authority using mdbase editor.");
    const loaded = await this.getConfigAndTypes();
    if (!loaded || !loaded.config.spec_version.startsWith("0.3.")) throw new Error("Initialize or migrate this collection first.");
    if (loaded.config.settings.types_folder !== "_types" || (loaded.config.settings.contracts_folder ?? "_contracts") !== "_contracts") throw new Error("Catalog packs require the standard _types and _contracts folders. Use mdbase editor for custom target mappings.");
    new ContractCatalogModal(this.app, () => {
      this.connectSync.assertLocalAuthorityWritable();
      if (this.getMirrorProfile()) throw new Error("The vault role changed. Install at the collection authority instead.");
    }, async primary => {
      this.invalidateSchemaCache();
      const view = await this.openWorkspace("types");
      await view.refresh(true);
      const schema = await this.getConfigAndTypes();
      const type = primary ? schema?.types.get(primary) : null;
      if (type) await view.editType(type.filePath);
      new Notice("Installed contract pack. Edit its type or create a note to try it.");
    }).open();
  }

  async createNoteFromType(typeName?: string): Promise<void> {
    await createNoteFromTypeCommand(this, typeName);
  }

  async initializeCollection(): Promise<void> {
    this.assertLegacyOperation("Initializing collections");
    this.connectSync.assertLocalAuthorityWritable();
    const { created } = await ensureCollectionInitialized(this.app.vault, { seedNoteType: false });
    this.invalidateSchemaCache();
    new Notice(created.length ? `Initialized mdbase collection: ${created.join(", ")}` : "mdbase collection already initialized.");
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
    this.assertLegacyOperation("Migrating v0.2 collections");
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
    await this.transformRecord(file, (raw) => {
      this.connectSync.assertLocalAuthorityWritable();
      const result = applyQuickFixToDocument(raw, issue);
      changed = result.changed;
      return result.content;
    });
    new Notice(changed ? `Updated '${issue.field ?? "field"}' in ${file.basename}` : "The field changed or no safe quick fix is available. Revalidate the note.");
    await this.validateFileAndStore(file, "manual");
  }

  async applyQuickFixes(issues: MdbaseIssue[]): Promise<{ changed: number; skipped: number }> {
    this.connectSync.assertLocalAuthorityWritable();
    if (this.getMirrorProfile()?.mode === "read_only") throw new Error("This mirror has read-only access.");
    let changed = 0;
    let skipped = 0;
    const touched = new Map<string, TFile>();
    for (const issue of issues) {
      const file = this.app.vault.getAbstractFileByPath(issue.path);
      if (!(file instanceof TFile)) {
        skipped += 1;
        continue;
      }
      let applied = false;
      await this.transformRecord(file, (raw) => {
        this.connectSync.assertLocalAuthorityWritable();
        const result = applyQuickFixToDocument(raw, issue);
        applied = result.changed;
        return result.content;
      });
      if (applied) {
        changed += 1;
        touched.set(file.path, file);
      } else skipped += 1;
    }
    for (const file of touched.values()) await this.validateFileAndStore(file, "manual");
    return { changed, skipped };
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

  private async onRibbonClick(): Promise<void> {
    const indicator = this.syncIndicator(this.getIssues().length);
    // Mobile has no status bar. Its ribbon is the direct way to inspect pending
    // sync; a settled/local collection keeps Types as the primary destination.
    if (Platform.isMobile && !["local", "synced"].includes(indicator.state)) await this.openStatusDestination();
    else await this.openWorkspace();
  }

  private updateStatusBar(): void {
    // The sync session can report before onload has created either indicator.
    if (!this.statusBarEl && !this.ribbonEl) return;
    const indicator = this.syncIndicator(this.getIssues().length);
    if (this.statusBarEl) {
      this.statusBarEl.setText(indicator.label);
      this.statusBarEl.setAttr("aria-label", `${indicator.detail}. Open mdbase ${indicator.destination}.`);
      this.statusBarEl.setAttr("title", indicator.detail);
      this.statusBarEl.setAttr("data-state", indicator.state);
    }
    if (this.ribbonEl) {
      const destination = Platform.isMobile && !["local", "synced"].includes(indicator.state) ? indicator.destination : "types";
      this.ribbonEl.setAttr("aria-label", `${indicator.label}. Open mdbase ${destination}.`);
      this.ribbonEl.setAttr("title", indicator.detail);
      this.ribbonEl.setAttr("data-state", indicator.state);
    }
    if (this.noteStatusEl) void this.updateNoteStatus();
  }

  /** Type and issue count for the active note, beside the collection status. */
  private async updateNoteStatus(): Promise<void> {
    const version = ++this.noteStatusVersion;
    const file = this.app.workspace.getActiveFile();
    const loaded = file?.extension === "md" ? this.schemaCache ?? await this.getConfigAndTypes() : null;
    if (version !== this.noteStatusVersion) return;
    const types = file && loaded && !isExcluded(file.path, loaded.config)
      ? getTypesForFile(file.path, this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}, loaded.config, loaded.types)
      : [];
    if (!file || !types.length) {
      this.noteStatusEl.hide();
      this.noteStatusEl.removeAttribute("data-path");
      return;
    }
    const issues = this.issueMap.get(file.path) ?? [];
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const checked = this.validation.isChecked(file.path);
    const issueText = !checked ? " · not checked" : issues.length ? ` · ${issues.length} ${issues.length === 1 ? "issue" : "issues"}` : " · checked";
    this.noteStatusEl.setText(`${types.join(", ")}${issueText}`);
    this.noteStatusEl.setAttr("data-state", !checked ? "unchecked" : errors ? "error" : issues.length ? "warning" : "valid");
    this.noteStatusEl.setAttr("data-path", file.path);
    const detail = issues.length
      ? `${file.basename}: ${issues.length} ${issues.length === 1 ? "issue" : "issues"}. Open issues for this note.`
      : `${file.basename} is a ${types.join(", ")} note. Edit the type.`;
    this.noteStatusEl.setAttr("aria-label", detail);
    this.noteStatusEl.setAttr("title", detail);
    this.noteStatusEl.show();
  }

  private async openNoteStatusDestination(): Promise<void> {
    const path = this.noteStatusEl.getAttr("data-path");
    if (!path) return;
    if (this.issueMap.get(path)?.length) {
      const view = await this.openWorkspace("issues");
      view.showIssuesForPath(path);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    const loaded = await this.getConfigAndTypes();
    if (!(file instanceof TFile) || !loaded) return;
    const [typeName] = getTypesForFile(path, this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}, loaded.config, loaded.types);
    const typeDef = typeName ? loaded.types.get(typeName) : undefined;
    if (!typeDef) return;
    const view = await this.openWorkspace("types");
    await view.editType(typeDef.filePath);
  }

  private markRecordChanged(path: string): void {
    this.validation.changed(path);
    // A yielded initial scan can already have read this path. Keep its change
    // even before the completed cache is installed, then reconcile it below.
    if (!this.recordCache && !this.recordLoadPromise) return;
    this.dirtyRecordPaths.add(normalizePath(path));
    this.recordList = null;
  }

  /**
   * Parsed frontmatter for every collection record. Built once, then refreshed
   * incrementally for files the vault reports as changed.
   */
  loadCollectionRecords(): Promise<CollectionRecord[]> {
    this.recordLoadPromise ??= this.readRecords().finally(() => {
      this.recordLoadPromise = null;
    });
    return this.recordLoadPromise;
  }

  private async readRecords(): Promise<CollectionRecord[]> {
    const epoch = this.recordCacheEpoch;
    const loaded = await this.getConfigAndTypes();
    if (!loaded) return [];
    const settingsKey = JSON.stringify(loaded.config.settings);
    if (!this.recordCache || settingsKey !== this.recordCacheSettings) {
      this.dirtyRecordPaths.clear();
      const records = await readCollectionRecords(this.app.vault, loaded.config);
      if (epoch !== this.recordCacheEpoch) return this.readRecords();
      this.recordCache = new Map(records.map((record) => [record.path, record]));
      this.recordCacheSettings = settingsKey;
      this.recordList = null;
    }
    const cache = this.recordCache;
    if (this.dirtyRecordPaths.size) {
      const paths = [...this.dirtyRecordPaths];
      this.dirtyRecordPaths.clear();
      for (const path of paths) {
        cache.delete(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension !== "md" || isExcluded(path, loaded.config)) continue;
        const parsed = parseFrontmatter(await this.app.vault.cachedRead(file));
        if (!parsed.error) cache.set(path, { path, frontmatter: parsed.frontmatter });
      }
      this.recordList = null;
    }
    if (epoch !== this.recordCacheEpoch) return this.readRecords();
    this.recordList ??= [...cache.values()].sort((a, b) => a.path.localeCompare(b.path));
    return this.recordList;
  }

  private syncIndicator(validationIssues: number) {
    const state = this.sync.state;
    const safety = this.sync.safety();
    return syncIndicator({
      connected: this.getMirrorProfile() !== null,
      status: state.status,
      progress: state.progress,
      fileProgress: state.fileProgress,
      problem: state.problem,
      validationIssues,
      localChangeObserved: state.localChangeObserved,
      paused: state.paused,
      busy: state.busy,
      reviewChanges: safety && !safety.safe ? state.preview?.plan.actions.length ?? 0 : 0,
    });
  }

  private async openStatusDestination(): Promise<void> {
    await this.openWorkspace(this.syncIndicator(this.getIssues().length).destination);
  }

  async openIssuesView(): Promise<void> {
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
    await leaf.setViewState({ type: MDBASE_WORKSPACE_VIEW, active: true, state: { destination } });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as MdbaseWorkspaceView;
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

  invalidateSchemaCache(): void {
    this.validation.changed();
    this.schemaCache = null;
    this.schemaLoadPromise = null;
  }

  private async getConfigAndTypes(forceReload = false): Promise<LoadedSchema | null> {
    if (forceReload) {
      this.invalidateSchemaCache();
    }

    if (this.schemaCache) return this.schemaCache;
    if (this.schemaLoadPromise) return this.schemaLoadPromise;

    // Store the fenced promise itself: all coalesced callers must reject a
    // result invalidated while its asynchronous config/type reads were running.
    const loading: Promise<LoadedSchema | null> = Promise.resolve().then(async () => {
      try {
        const config = await loadMdbaseConfig(this.app.vault);
        const loaded = config ? {
          config,
          types: await loadTypeDefinitions(this.app.vault, config),
          contracts: await loadContractDefinitions(this.app.vault, config),
        } : null;
        if (this.schemaLoadPromise !== loading) return this.getConfigAndTypes();
        if (loaded) this.schemaCache = loaded;
        return loaded;
      } catch (error) {
        if (this.schemaLoadPromise !== loading) return this.getConfigAndTypes();
        throw error;
      }
    });
    this.schemaLoadPromise = loading;

    try {
      return await loading;
    } finally {
      if (this.schemaLoadPromise === loading) this.schemaLoadPromise = null;
    }
  }

  async requireConfigAndTypes(options: { background?: boolean; forceReload?: boolean } = {}): Promise<LoadedSchema | null> {
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

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.onVaultModify(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.onVaultRename(file, oldPath);
      else if (file instanceof TFolder) this.onVaultFolderChange(oldPath, file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) this.onVaultDelete(file);
      else if (file instanceof TFolder) this.onVaultFolderChange(file.path);
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) this.onVaultCreate(file);
    }));
  }

  private onVaultFolderChange(...paths: string[]): void {
    for (const path of paths) this.observeLocalMirrorChange(path);
    // A folder event need not be accompanied by child-file events. The old
    // descendant paths are no longer a valid incremental record/schema cache.
    // An older in-flight read must not reinstall those invalidated paths.
    this.recordCacheEpoch++;
    this.recordCache = null;
    this.recordList = null;
    this.dirtyRecordPaths.clear();
    this.refreshSchemaNow();
  }

  private onVaultModify(file: TFile): void {
    this.observeLocalMirrorChange(file.path);
    this.markRecordChanged(file.path);
    if (this.isSchemaRelevantPath(file.path)) {
      this.scheduleSchemaRefresh();
    }

    if (!this.settings.validateOnSave) return;
    if (file.extension !== "md") return;
    this.scheduleSaveValidation(file);
  }

  private onVaultRename(file: TFile, oldPath: string): void {
    this.observeLocalMirrorChange(oldPath);
    this.markRecordChanged(oldPath);
    this.markRecordChanged(file.path);
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
    this.markRecordChanged(file.path);
    if (this.isSchemaRelevantPath(file.path)) {
      this.refreshSchemaNow();
    }

    if (file.extension !== "md") return;
    this.clearPendingSaveValidation(file.path);
    this.clearFileIssues(file.path);
  }

  private onVaultCreate(file: TFile): void {
    this.observeLocalMirrorChange(file.path);
    this.markRecordChanged(file.path);
    if (this.isSchemaRelevantPath(file.path)) {
      this.refreshSchemaNow();
    }
  }

  /**
   * Edits made while a sync runs still count; only the mirror's own writes are
   * echoes. The scheduler syncs once the burst of edits settles.
   */
  private observeLocalMirrorChange(path: string): void {
    if (!this.getMirrorProfile() || this.connectSync.consumeEngineWrite(path)) return;
    const normalized = normalizePath(path);
    const reservedFolders = [this.app.vault.configDir, ".mdbase", ".trash", ".git"];
    if (reservedFolders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`))) return;
    this.sync.observeLocalChange();
    this.syncScheduler?.noteLocalChange();
  }

  async validateFileAndStore(
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

    const revision = this.validation.revision;
    const issues = await validateFile(this.app.vault, file, loaded.config, loaded.types);
    if (!isCurrent() || revision !== this.validation.revision) return issues;
    this.validation.markChecked(file.path);
    this.setFileIssues(file.path, issues);

    if (reason === "save" && this.settings.showNoticeOnSave && issues.length > 0) {
      new Notice(`mdbase: ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${file.basename}`);
    }

    return issues;
  }

  async runCollectionValidation(showSummary: boolean): Promise<void> {
    if (this.validationAbort) return;
    const loaded = await this.requireConfigAndTypes({ background: false });
    if (!loaded || this.validationAbort) return;
    const abort = new AbortController();
    this.validationAbort = abort;
    this.validation.cancelled = false;
    const revision = this.validation.revision;
    const nextMap = new Map<string, MdbaseIssue[]>();
    try {
      const issues = await validateCollection(this.app.vault, loaded.config, loaded.types, {
        signal: abort.signal,
        onProgress: (progress) => {
          this.validation.progress = progress;
          if (progress.completed === 0) {
            // Do not wait for the type workbench's record scan before exposing Stop.
            for (const leaf of this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW)) (leaf.view as MdbaseWorkspaceView).refreshValidationControls();
          }
          else if (progress.completed % 25 === 0 || progress.phase === "uniqueness") {
            for (const leaf of this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW)) (leaf.view as MdbaseWorkspaceView).updateValidationProgress();
          }
        },
        onFile: (file, fileIssues) => {
          if (revision !== this.validation.revision) return;
          this.validation.markChecked(file.path);
          nextMap.set(file.path, fileIssues);
          if (fileIssues.length) this.issueMap.set(file.path, fileIssues);
          else this.issueMap.delete(file.path);
          this.sortedIssuesCache = null;
        },
      });
      if (revision !== this.validation.revision) {
        new Notice("Files changed during validation. Validate again for a complete result.");
        return;
      }
      nextMap.clear();
      for (const issue of issues) nextMap.set(issue.path, [...(nextMap.get(issue.path) ?? []), issue]);
      this.issueMap = nextMap;
      this.validation.lastCompletedAt = new Date().toISOString();
      this.validation.completedRevision = revision;
      if (showSummary) {
        new Notice(issues.length ? `Collection validation: ${issues.length} issues` : "Collection validation passed with no issues.");
        if (issues.length) await this.openIssuesView();
      }
    } catch (error) {
      this.validation.cancelled = true;
      // A stopped scan must not erase unchecked files' existing diagnostics.
      if (revision === this.validation.revision) for (const [path, issues] of nextMap) {
        if (issues.length) this.issueMap.set(path, issues);
        else this.issueMap.delete(path);
      }
      new Notice(abort.signal.aborted ? "Validation stopped. Results are incomplete." : `Validation could not finish: ${String(error)}. Results are incomplete.`);
    } finally {
      this.validation.progress = null;
      this.validationAbort = null;
      this.sortedIssuesCache = null;
      for (const leaf of this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW)) (leaf.view as MdbaseWorkspaceView).refreshValidationControls();
      this.refreshIssueViews();
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
      if (this.mutationBackend) {
        const created = await this.mutationBackend.putResource(this.app.vault, defaultTargetPath, content, null);
        this.invalidateSchemaCache();
        return created;
      }
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

    if (this.mutationBackend) {
      if (targetPath !== originalPath) throw new Error("Type renames need the shared runtime's rename planner; no files were changed.");
      const updated = await this.mutationBackend.putResource(this.app.vault, originalPath, content, originalContent);
      this.invalidateSchemaCache();
      return updated;
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
