import { t } from "@lingui/core/macro";
// Link suggestions: typing @ in a note, and the link fields of the creation
// form. Both list matching notes with their type, then rows that create one.
import {
  AbstractInputSuggest,
  type App,
  type Editor,
  type EditorPosition,
  EditorSuggest,
  Notice,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  setIcon,
  TFile,
} from "obsidian";
import type { MdbaseConfig, MdbaseTypeDef } from "./mdbaseCore";
import { linkRows, type LinkRow, type LinkTarget, wikilink } from "./links";

/** The notes a link field suggests, and how it creates one. */
export interface LinkSource {
  targets(): Promise<LinkTarget[]>;
  /** Resolves to null when the person backs out. */
  create(type: MdbaseTypeDef, name: string): Promise<LinkTarget | null>;
}

/** What the @ suggester needs from the plugin. */
export interface LinkSuggestHost extends LinkSource {
  readonly app: App;
  suggestsLinks(): boolean;
  /** The collection's types, or null when the vault has none or `path` is outside the collection. */
  linkTypes(path: string): Promise<{ config: MdbaseConfig; types: Map<string, MdbaseTypeDef> } | null>;
  /** Ask which type to create; null when cancelled. */
  chooseType(): Promise<MdbaseTypeDef | null>;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

/** One suggestion, laid out like Obsidian's own: title, a quieter second line, the type at the end. */
export function renderLinkRow(row: LinkRow, el: HTMLElement): void {
  el.addClass("mod-complex", "mdbase-link-row");
  const content = el.createDiv({ cls: "suggestion-content" });
  const title = content.createDiv({ cls: "suggestion-title" });
  if (row.kind === "note") {
    title.setText(row.target.name);
    const folder = folderOf(row.target.path);
    if (folder) content.createDiv({ cls: "suggestion-note", text: folder });
    if (row.target.types.length) {
      el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair", text: row.target.types.join(", ") });
    }
    return;
  }
  el.addClass("mdbase-link-row-create");
  const { name } = row;
  if (row.kind === "create") {
    const typeName = row.type.name;
    title.setText(t`New ${typeName} “${name}”`);
  } else {
    title.setText(t`New “${name}” of another type…`);
  }
  setIcon(el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair" }), "plus");
}

/** A note that could not be created says why, as the creation form does. */
function reportFailure(error: unknown): void {
  new Notice(error instanceof Error ? error.message : String(error));
}

// @ at the start of a line or after a space or an opening bracket, then what
// has been typed since. An address such as name@example.com doesn't count.
const TRIGGER = /(?:^|[\s(])@([^\s@][^@]*)?$/;
const MAX_QUERY = 60;
const MAX_WORDS = 5;

/** The @ query ending at the cursor, or null when this isn't one. */
export function linkTrigger(before: string): { query: string; from: number } | null {
  const match = TRIGGER.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > MAX_QUERY || query.split(/\s+/).length > MAX_WORDS || /\s{2}$/.test(query)) return null;
  // An odd number of backticks before the cursor: inside inline code.
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  return { query, from: before.length - query.length - 1 };
}

/** Typing @ in a note: link to a note, or create one of a type and link to it. */
export class TypedLinkSuggest extends EditorSuggest<LinkRow> {
  constructor(private readonly host: LinkSuggestHost) {
    super(host.app);
    this.limit = 20;
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file || !this.host.suggestsLinks()) return null;
    const trigger = linkTrigger(editor.getLine(cursor.line).slice(0, cursor.ch));
    if (!trigger) return null;
    // Properties and code are not prose: an @ there is not a mention.
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatterPosition && cursor.line <= cache.frontmatterPosition.end.line) return null;
    if (cache?.sections?.some((section) => (section.type === "code" || section.type === "math")
      && cursor.line >= section.position.start.line && cursor.line <= section.position.end.line)) return null;
    return { start: { line: cursor.line, ch: trigger.from }, end: cursor, query: trigger.query };
  }

  async getSuggestions(context: EditorSuggestContext): Promise<LinkRow[]> {
    const loaded = await this.host.linkTypes(context.file.path);
    if (!loaded?.types.size) return [];
    // A note doesn't link to itself.
    return linkRows(await this.host.targets(), context.query, loaded.types)
      .filter((row) => row.kind !== "note" || row.target.path !== context.file.path);
  }

  renderSuggestion(row: LinkRow, el: HTMLElement): void {
    renderLinkRow(row, el);
  }

  selectSuggestion(row: LinkRow): void {
    const context = this.context;
    if (!context) return;
    this.close();
    void this.link(row, context).catch(reportFailure);
  }

  private async link(row: LinkRow, context: EditorSuggestContext): Promise<void> {
    let target: LinkTarget | null;
    if (row.kind === "note") target = row.target;
    else {
      const type = row.kind === "create" ? row.type : await this.host.chooseType();
      target = type ? await this.host.create(type, row.name) : null;
    }
    const file = target ? this.app.vault.getAbstractFileByPath(target.path) : null;
    if (!target || !(file instanceof TFile)) return;
    const link = this.app.fileManager.generateMarkdownLink(
      file, context.file.path, "", target.name === file.basename ? "" : target.name);
    const { editor, start, end } = context;
    // A form may have been open since the @ was typed; replace it only if it is still there.
    if (editor.getRange(start, end) === `@${context.query}`) {
      editor.replaceRange(link, start, end);
      editor.setCursor({ line: start.line, ch: start.ch + link.length });
    } else {
      editor.replaceSelection(link);
    }
  }
}

/** Suggestions for a link field of the creation form, limited to the type the field points at. */
export class LinkFieldSuggest extends AbstractInputSuggest<LinkRow> {
  constructor(
    app: App,
    private readonly fieldEl: HTMLInputElement,
    private readonly links: LinkSource,
    private readonly types: Map<string, MdbaseTypeDef>,
    private readonly type?: string,
  ) {
    super(app, fieldEl);
  }

  protected async getSuggestions(query: string): Promise<LinkRow[]> {
    // The field holds a wikilink once a note is chosen; search by what is inside it.
    const typed = query.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/\|.*$/, "");
    const rows = linkRows(await this.links.targets(), typed, this.types, this.type);
    // A field that takes any note has no type to create.
    return this.type ? rows : rows.filter((row) => row.kind === "note");
  }

  renderSuggestion(row: LinkRow, el: HTMLElement): void {
    renderLinkRow(row, el);
  }

  selectSuggestion(row: LinkRow): void {
    this.close();
    if (row.kind === "note") this.choose(row.target);
    else if (row.kind === "create") {
      void this.links.create(row.type, row.name).then((target) => { if (target) this.choose(target); }).catch(reportFailure);
    }
  }

  private choose(target: LinkTarget): void {
    this.setValue(wikilink(target));
    // The form reads its fields on change; an input event would open the suggestions again.
    this.fieldEl.dispatchEvent(new Event("change"));
  }
}
