import { Notice, TFile } from "obsidian";
import { CreateTypedNoteModal } from "./createTypedNoteModal";
import type MdbasePlugin from "../main";
import {
  getTypesForFile,
  parseFrontmatter,
  type MdbaseTypeDef,
} from "./mdbaseCore";
import { pickType } from "./modals";

/** Commands are deliberately few. Navigation lives in the workspace's own tabs. */
export function registerCommands(plugin: MdbasePlugin): void {
  const { app } = plugin;

  plugin.addCommand({
    id: "mdbase-open",
    name: "Open workspace",
    callback: () => void plugin.openWorkspace(),
  });

  plugin.addCommand({
    id: "mdbase-initialize-collection",
    name: "Initialize collection",
    checkCallback: (checking) => {
      if (app.vault.getAbstractFileByPath("mdbase.yaml")) return false;
      if (!checking) void plugin.initializeCollection();
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
    id: "mdbase-open-sync",
    name: "Open sync",
    callback: () => void plugin.openWorkspace("sync"),
  });
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
    const loaded = await plugin.requireConfigAndTypes();
    if (!loaded) return;

    if (loaded.types.size === 0) {
      new Notice("No type definitions found.");
      return;
    }

    const chosenType = typeName ? loaded.types.get(typeName) : await pickType(plugin.app, Array.from(loaded.types.values()));
    if (!chosenType) return;

    new CreateTypedNoteModal(plugin.app, chosenType, loaded.config, loaded.types, async (path, frontmatter) => {
      const file = await plugin.createTypedNote(path, frontmatter);
      await plugin.app.workspace.getLeaf(true).openFile(file);
      await plugin.validateFileAndStore(file, "manual");
    }).open();
  }
