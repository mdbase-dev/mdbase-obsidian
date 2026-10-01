import { Notice, TFile } from "obsidian";
import { CreateTypedNoteModal } from "./createTypedNoteModal";
import type MdbasePlugin from "../main";
import {
  ensureCollectionInitialized,
  getTypesForFile,
  parseFrontmatter,
  type MdbaseTypeDef,
} from "./mdbaseCore";
import { pickType } from "./modals";

/**
 * Commands are deliberately few. Navigation lives in the workspace's own tabs;
 * sync commands appear only when this vault is a mirror, and situational ones
 * (cancel, conflicts, reconnect) only when they can do something.
 */
export function registerCommands(plugin: MdbasePlugin): void {
  const { app } = plugin;
  const connected = () => plugin.getMirrorProfile() !== null;

  plugin.addCommand({
    id: "mdbase-open",
    name: "Open workspace",
    callback: () => void plugin.openWorkspace(),
  });

  plugin.addCommand({
    id: "mdbase-initialize-collection",
    name: "Initialize collection",
    checkCallback: (checking) => {
      if (connected() || app.vault.getAbstractFileByPath("mdbase.yaml")) return false;
      if (!checking) void initializeCollection(plugin);
      return true;
    },
  });

  plugin.addCommand({
    id: "mdbase-create-type",
    name: "Create type definition",
    callback: () => void plugin.openWorkspace("types").then((view) => view.createNewType()),
  });

  plugin.addCommand({
    id: "mdbase-edit-type",
    name: "Edit type definition",
    callback: () => void editTypeDefinition(plugin),
  });

  plugin.addCommand({
    id: "mdbase-create-note-from-type",
    name: "Create note from type",
    callback: () => void createNoteFromTypeCommand(plugin),
  });

  plugin.addCommand({
    id: "mdbase-validate-current-note",
    name: "Validate current note",
    checkCallback: (checking) => {
      const file = app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== "md") return false;
      if (!checking) void validateCurrentNote(plugin, file);
      return true;
    },
  });

  plugin.addCommand({
    id: "mdbase-validate-collection",
    name: "Validate collection",
    callback: () => void plugin.runCollectionValidation(true),
  });

  plugin.addCommand({
    id: "mdbase-sync-now",
    name: "Sync now",
    checkCallback: (checking) => {
      if (!connected()) return false;
      if (!checking) void syncNow(plugin);
      return true;
    },
  });

  plugin.addCommand({
    id: "mdbase-cancel-sync",
    name: "Cancel current sync",
    checkCallback: (checking) => {
      if (!plugin.sync.isSyncing()) return false;
      if (!checking) plugin.sync.cancel();
      return true;
    },
  });

  plugin.addCommand({
    id: "mdbase-resolve-conflicts",
    name: "Resolve sync conflicts",
    checkCallback: (checking) => {
      if (!connected() || !plugin.sync.state.status?.conflicts.length) return false;
      if (!checking) void plugin.openWorkspace("sync").then((view) => view.focusSyncSection("conflicts"));
      return true;
    },
  });

  plugin.addCommand({
    id: "mdbase-reconnect",
    name: "Reconnect collection",
    checkCallback: (checking) => {
      const problem = plugin.sync.state.problem;
      if (!connected() || !problem || problem.action !== "reauthorize") return false;
      if (!checking) void plugin.openWorkspace("sync").then((view) => view.reconnectCollection());
      return true;
    },
  });

  plugin.addCommand({
    id: "mdbase-copy-sync-diagnostics",
    name: "Copy sync diagnostics",
    checkCallback: (checking) => {
      if (!connected()) return false;
      if (!checking) void plugin.copySyncDiagnostics();
      return true;
    },
  });

  plugin.addCommand({
    id: "mdbase-note-sync-history",
    name: "Show sync history for current note",
    checkCallback: (checking) => {
      const file = app.workspace.getActiveFile();
      if (!file || !connected()) return false;
      if (!checking) plugin.openNoteSyncHistory(file.path);
      return true;
    },
  });

  plugin.registerEvent(
    app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || !connected()) return;
      menu.addItem((item) => item
        .setTitle("Sync history")
        .setIcon("history")
        .onClick(() => plugin.openNoteSyncHistory(file.path)));
    }),
  );
}

/** Applies routine changes at once; anything needing consent opens the review. */
export async function syncNow(plugin: MdbasePlugin): Promise<void> {
  const result = await plugin.sync.syncNow();
  const { message, problem } = plugin.sync.state;
  if (result === "needs_review") {
    const reasons = plugin.sync.safety()?.reasons ?? [];
    new Notice(`Review before syncing: ${reasons.join(", ").toLowerCase() || "changes need attention"}.`);
    await plugin.openWorkspace("sync");
  } else if (result === "busy") {
    new Notice("A sync is already running.");
  } else if (result === "paused") {
    new Notice("Sync is paused.");
  } else if (result === "failed") {
    new Notice(problem?.message ?? (message || "Sync failed."));
  } else if (message) {
    new Notice(message);
  }
}

async function initializeCollection(plugin: MdbasePlugin): Promise<void> {
  plugin.connectSync.assertLocalAuthorityWritable();
  const { created } = await ensureCollectionInitialized(plugin.app.vault, { seedNoteType: false });
  plugin.invalidateSchemaCache();
  new Notice(created.length ? `Initialized mdbase collection: ${created.join(", ")}` : "mdbase collection already initialized.");
}

/** Edits the type of the open note (or the open type file); otherwise asks which type. */
async function editTypeDefinition(plugin: MdbasePlugin): Promise<void> {
  const loaded = await plugin.requireConfigAndTypes();
  if (!loaded) return;
  if (loaded.types.size === 0) {
    new Notice("No type definitions found.");
    return;
  }
  const file = plugin.app.workspace.getActiveFile();
  let candidates: MdbaseTypeDef[] = [];
  if (file instanceof TFile && file.extension === "md") {
    const definition = [...loaded.types.values()].find((type) => type.filePath === file.path);
    if (definition) candidates = [definition];
    else {
      const parsed = parseFrontmatter(await plugin.app.vault.cachedRead(file));
      if (!parsed.error) {
        candidates = getTypesForFile(file.path, parsed.frontmatter, loaded.config, loaded.types)
          .flatMap((name) => loaded.types.get(name) ?? []);
      }
    }
  }
  const chosen = candidates.length === 1
    ? candidates[0]
    : await pickType(plugin.app, candidates.length ? candidates : [...loaded.types.values()]);
  if (!chosen) return;
  const view = await plugin.openWorkspace("types");
  await view.editType(chosen.filePath);
}

async function validateCurrentNote(plugin: MdbasePlugin, file: TFile): Promise<void> {
  const issues = await plugin.validateFileAndStore(file, "manual");
  if (issues.length === 0) {
    new Notice("No issues in current note.");
    return;
  }
  new Notice(`Found ${issues.length} issue${issues.length === 1 ? "" : "s"} in current note.`);
  const view = await plugin.openWorkspace("issues");
  view.showIssuesForPath(file.path);
}

export async function createNoteFromTypeCommand(plugin: MdbasePlugin, typeName?: string): Promise<void> {
    plugin.connectSync.assertLocalAuthorityWritable();
    const loaded = await plugin.requireConfigAndTypes();
    if (!loaded) return;

    if (loaded.types.size === 0) {
      new Notice("No type definitions found.");
      return;
    }

    if (plugin.getMirrorProfile()?.mode === "read_only") throw new Error("This mirror has read-only access.");
    const chosenType = typeName ? loaded.types.get(typeName) : await pickType(plugin.app, Array.from(loaded.types.values()));
    if (!chosenType) return;

    new CreateTypedNoteModal(plugin.app, chosenType, loaded.config, loaded.types, async (path, frontmatter) => {
      plugin.connectSync.assertLocalAuthorityWritable();
      if (plugin.getMirrorProfile()?.mode === "read_only") throw new Error("This mirror has read-only access.");
      const { createNoteFromType } = await import("./mdbaseCore");
      const file = await createNoteFromType(plugin.app.vault, path, frontmatter);
      await plugin.app.workspace.getLeaf(true).openFile(file);
      await plugin.validateFileAndStore(file, "manual");
    }).open();
  }
