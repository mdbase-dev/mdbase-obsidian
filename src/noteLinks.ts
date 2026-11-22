import { t } from "@lingui/core/macro";
// The plugin's side of linking: the notes a link can point at, creating the
// note a link asks for, and settling a link whose note is missing.
import { type App, Notice, type TFile } from "obsidian";
import type { CollectionRecord, MdbaseConfig, MdbaseIssue, MdbaseTypeDef } from "./mdbaseCore";
import { isExcluded } from "./collectionConfig";
import { createLinkedNote } from "./createTypedNoteModal";
import { linkTargets, type LinkTarget, missingLinkNote } from "./links";
import type { LinkSuggestHost } from "./linkSuggest";
import { pickType } from "./modals";

interface Schema {
  config: MdbaseConfig;
  types: Map<string, MdbaseTypeDef>;
}

/** What linking needs from the plugin. */
export interface NoteLinksPlugin {
  readonly app: App;
  readonly settings: { linkSuggestions: boolean };
  loadWorkspaceSchema(): Promise<Schema | null>;
  loadCollectionRecords(): Promise<CollectionRecord[]>;
  createTypedNote(path: string, frontmatter: Record<string, unknown>): Promise<TFile>;
}

export class NoteLinks implements LinkSuggestHost {
  // The record list keeps its identity until a note changes, and the types until a definition does.
  private cache: { records: CollectionRecord[]; types: Schema["types"]; targets: LinkTarget[] } | null = null;

  constructor(private readonly plugin: NoteLinksPlugin) {}

  get app(): App { return this.plugin.app; }

  suggestsLinks(): boolean { return this.plugin.settings.linkSuggestions; }

  async linkTypes(path: string): Promise<Schema | null> {
    const loaded = await this.plugin.loadWorkspaceSchema();
    return loaded && !isExcluded(path, loaded.config) ? loaded : null;
  }

  async targets(): Promise<LinkTarget[]> {
    const loaded = await this.plugin.loadWorkspaceSchema();
    if (!loaded) return [];
    const records = await this.plugin.loadCollectionRecords();
    if (this.cache?.records !== records || this.cache.types !== loaded.types) {
      this.cache = { records, types: loaded.types, targets: linkTargets(records, loaded.config, loaded.types) };
    }
    return this.cache.targets;
  }

  async create(type: MdbaseTypeDef, name: string, path?: string): Promise<LinkTarget | null> {
    const loaded = await this.plugin.loadWorkspaceSchema();
    if (!loaded) return null;
    const target = await createLinkedNote(this.plugin, type, name, loaded.config, loaded.types, { path, links: this });
    if (target) {
      const created = target.path;
      new Notice(t`Created ${created}`);
    }
    return target;
  }

  async chooseType(): Promise<MdbaseTypeDef | null> {
    const loaded = await this.plugin.loadWorkspaceSchema();
    return loaded ? pickType(this.app, [...loaded.types.values()]) : null;
  }

  /** What creating the note a missing link points at would be called, or null when the issue isn't one. */
  missingLinkLabel(issue: MdbaseIssue, schema: Schema | null): string | null {
    const note = schema ? missingLinkNote(issue, schema.config, schema.types) : null;
    if (!note) return null;
    const typeName = note.type.name;
    const name = note.name;
    return t`Create ${typeName} “${name}”`;
  }

  /** Create the note a missing link points at. Resolves to whether the link now has its note. */
  async createMissingLink(issue: MdbaseIssue): Promise<boolean> {
    const loaded = await this.plugin.loadWorkspaceSchema();
    const note = loaded ? missingLinkNote(issue, loaded.config, loaded.types) : null;
    if (!note) {
      new Notice(t`The link or its type changed. Revalidate the note.`);
      return false;
    }
    // Another note with the same link may already have had this one created.
    if (this.app.vault.getAbstractFileByPath(note.path)) return true;
    return (await this.create(note.type, note.name, note.path)) !== null;
  }
}
