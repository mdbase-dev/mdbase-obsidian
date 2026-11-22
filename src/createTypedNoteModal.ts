import { t } from "@lingui/core/macro";
import { App, Modal, type TFile } from "obsidian";
import type { MdbaseConfig, MdbaseFieldDef, MdbaseIssue, MdbaseTypeDef } from "./mdbaseCore";
import { buildInitialFrontmatter, buildUniqueNotePath, coerceFieldInput, getPromptFields } from "./noteCreation";
import { validateRecordAgainstType } from "./validation";
import { isExcluded } from "./collectionConfig";
import { displayNameKey, linkField, type LinkTarget } from "./links";
import { LinkFieldSuggest, type LinkSource } from "./linkSuggest";

export function safeNotePath(value: string): string {
  const path = value.trim();
  if (!path || path.startsWith("/") || path.includes("\\") || Array.from(path).some(char => char.charCodeAt(0) < 32)
    || path.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error(t`Choose a visible, vault-relative note path without .. or empty folders.`);
  }
  return path.endsWith(".md") ? path : `${path}.md`;
}

/** What a new note of a type breaks in that type's rules, and in the type it extends. */
function newNoteIssues(path: string, frontmatter: Record<string, unknown>, type: MdbaseTypeDef, types: Map<string, MdbaseTypeDef>): MdbaseIssue[] {
  return [...types.values()].flatMap(candidate => candidate.name === type.name || type.extends === candidate.name
    ? validateRecordAgainstType(path, frontmatter, candidate) : []);
}

export interface CreateNoteOptions {
  /** What the form starts with, by field name. */
  values?: Record<string, string>;
  /** Where the note has to go. The location is shown but can't be changed. */
  path?: string;
  /** The notes link fields suggest. Without it, a link field is a plain text box. */
  links?: LinkSource;
  /** Called once the form has closed, whether or not a note was created. */
  closed?: () => void;
}

/** What creating a note for a link needs from the plugin. */
export interface LinkedNoteHost {
  readonly app: App;
  createTypedNote(path: string, frontmatter: Record<string, unknown>): Promise<TFile>;
}

/**
 * Create the note a link points at. A type that asks only for a name gets its
 * note straight away; anything more opens the creation form with the name
 * filled in. Resolves to null when the form is closed without creating.
 */
export async function createLinkedNote(
  host: LinkedNoteHost,
  type: MdbaseTypeDef,
  name: string,
  config: MdbaseConfig,
  types: Map<string, MdbaseTypeDef>,
  options: { path?: string; links?: LinkSource } = {},
): Promise<LinkTarget | null> {
  const key = displayNameKey(type);
  const frontmatter = { ...buildInitialFrontmatter(type, config), [key]: name };
  const path = options.path ?? await buildUniqueNotePath(host.app.vault, type, frontmatter);
  const made = (file: TFile, written: Record<string, unknown>): LinkTarget => {
    const title = written[key];
    return { path: file.path, name: typeof title === "string" && title.trim() ? title.trim() : file.basename, types: [type.name] };
  };
  if (!getPromptFields(type, frontmatter).length && !isExcluded(path, config) && !host.app.vault.getAbstractFileByPath(path)
    && !newNoteIssues(path, frontmatter, type, types).some(issue => issue.severity === "error")) {
    return made(await host.createTypedNote(path, frontmatter), frontmatter);
  }
  return new Promise(resolve => {
    let created: LinkTarget | null = null;
    new CreateTypedNoteModal(host.app, type, config, types, async (target, written) => {
      created = made(await host.createTypedNote(target, written), written);
    }, { values: { [key]: name }, path: options.path, links: options.links, closed: () => resolve(created) }).open();
  });
}

export class CreateTypedNoteModal extends Modal {
  private frontmatter: Record<string, unknown>;
  private inputs = new Map<string, { input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; definition: MdbaseFieldDef; error: HTMLElement }>();
  private pathInput: HTMLInputElement;
  private problem: HTMLElement;
  private submit: HTMLButtonElement;
  private customPath = false;
  private suggestedPath = "";
  private reset: HTMLButtonElement;
  private suggestionVersion = 0;
  private creating = false;
  private dismissed = false;

  constructor(app: App, private readonly type: MdbaseTypeDef, private readonly config: MdbaseConfig,
    private readonly types: Map<string, MdbaseTypeDef>,
    private readonly create: (path: string, frontmatter: Record<string, unknown>) => Promise<void>,
    private readonly options: CreateNoteOptions = {}) {
    super(app);
    this.frontmatter = buildInitialFrontmatter(type, config);
  }

  onOpen(): void {
    const typeName = this.type.name;
    this.titleEl.setText(t`New ${typeName}`);
    this.contentEl.addClass("mdbase-create-note");
    const fields = getPromptFields(this.type, this.frontmatter);
    const displayKey = displayNameKey(this.type);
    if (!fields.some(([name]) => name === displayKey) && this.frontmatter[displayKey] == null) {
      fields.unshift([displayKey, this.type.fields[displayKey] ?? { type: "string", description: t`Used for the file name.` }]);
    }
    for (const [name, definition] of fields) {
      const row = this.contentEl.createDiv({ cls: "mdbase-form-row" });
      const label = row.createEl("label", { cls: "mdbase-create-note-label", text: name });
      if (definition.required) label.createSpan({ cls: "mdbase-required-tag", text: t({ message: "Required", context: "field indicator" }) });
      if (definition.description) row.createDiv({ cls: "mdbase-form-description", text: definition.description });
      let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (definition.type === "boolean" || definition.type === "enum") {
        const select = row.createEl("select");
        input = select;
        select.createEl("option", { value: "", text: t`Choose…` });
        const values = definition.type === "boolean" ? [true, false] : definition.values ?? [];
        values.forEach((value, index) => select.createEl("option", { value: String(index), text: String(value) }));
      } else if (["object", "list", "any"].includes(definition.type ?? "")) {
        input = row.createEl("textarea");
        input.placeholder = definition.type === "object" ? t`YAML object` : definition.type === "list" ? t`YAML list or comma-separated values` : t({ message: "Value", context: "field placeholder" });
      } else {
        const inputType = definition.type === "date" ? "date" : definition.type === "datetime" ? "datetime-local" : definition.type === "time" ? "time" : "text";
        input = row.createEl("input", { type: inputType });
        if (["integer", "number"].includes(definition.type ?? "")) input.inputMode = "decimal";
        const link = this.options.links ? linkField(this.type, name) : null;
        if (link && this.options.links) {
          input.placeholder = t`Search notes`;
          new LinkFieldSuggest(this.app, input, this.options.links, this.types, link.type);
        }
      }
      const initial = this.options.values?.[name];
      if (initial !== undefined && input.tagName !== "SELECT") input.value = initial;
      label.htmlFor = input.id = `mdbase-note-${name}`;
      if (definition.required) input.setAttr("aria-required", "true");
      const error = row.createDiv({ cls: "mdbase-inline-error", attr: { "aria-live": "polite" } });
      // A field left empty is reported on Create, not while another is being filled in.
      input.addEventListener("input", () => { this.readInputs(false); void this.suggestPath(); });
      input.addEventListener("change", () => { this.readInputs(false); void this.suggestPath(); });
      this.inputs.set(name, { input, definition, error });
    }
    const location = this.contentEl.createDiv({ cls: "mdbase-form-row" });
    const label = location.createEl("label", { text: t`Location` });
    this.pathInput = location.createEl("input", { type: "text" });
    label.htmlFor = this.pathInput.id = "mdbase-note-location";
    if (this.options.path) {
      this.customPath = true;
      this.pathInput.value = this.options.path;
      this.pathInput.readOnly = true;
    }
    this.pathInput.addEventListener("input", () => {
      this.customPath = true;
      this.problem.textContent = "";
      this.syncReset();
    });
    // Offered only once the location differs from the suggestion.
    this.reset = location.createEl("button", { cls: "mdbase-location-reset", text: t`Use suggested location` });
    this.reset.onclick = () => { this.customPath = false; void this.suggestPath(); };
    this.syncReset();
    this.readInputs(false);
    this.problem = this.contentEl.createDiv({ cls: "mdbase-inline-error", attr: { role: "alert" } });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: t`Cancel` }).onclick = () => { if (!this.creating) this.close(); };
    this.submit = actions.createEl("button", { text: t`Create note`, cls: "mod-cta" });
    this.submit.onclick = () => void this.save();
    void this.suggestPath();
    // What the form was opened with is already filled in: start at the first thing still to give.
    // Obsidian focuses a modal's first control once it has opened, so this waits for that.
    const inputs = [...this.inputs.values()].map(entry => entry.input);
    window.setTimeout(() => { if (!this.dismissed) (inputs.find(input => !input.value) ?? inputs[0])?.focus(); }, 0);
  }

  /** Reads the form into the note. Empty required fields are reported only when `report` is set. */
  private readInputs(report = true): boolean {
    let valid = true;
    for (const [name, { input, definition, error }] of this.inputs) {
      error.textContent = "";
      try {
        if (!input.value.trim()) {
          delete this.frontmatter[name];
          if (definition.required && report) throw new Error(t({ message: "Required", context: "field indicator" }));
          continue;
        }
        const values = definition.type === "boolean" ? [true, false] : definition.values ?? [];
        this.frontmatter[name] = ["boolean", "enum"].includes(definition.type ?? "")
          ? values[Number(input.value)] : coerceFieldInput(input.value, definition);
      } catch (problem) {
        valid = false;
        error.textContent = problem instanceof Error ? problem.message : String(problem);
      }
    }
    return valid;
  }

  private async suggestPath(): Promise<void> {
    const version = ++this.suggestionVersion;
    try {
      const path = await buildUniqueNotePath(this.app.vault, this.type, this.frontmatter);
      if (this.dismissed || version !== this.suggestionVersion) return;
      this.suggestedPath = path;
      if (!this.customPath) this.pathInput.value = path;
      this.syncReset();
    } catch (error) {
      if (!this.dismissed && version === this.suggestionVersion) this.problem.textContent = String(error);
    }
  }

  private syncReset(): void {
    this.reset.toggleClass("mdbase-hidden", Boolean(this.options.path) || !this.suggestedPath || this.pathInput.value === this.suggestedPath);
  }

  private async save(): Promise<void> {
    if (this.creating || !this.readInputs()) return;
    try {
      const path = safeNotePath(this.pathInput.value);
      if (isExcluded(path, this.config)) throw new Error(t`Choose a location included in this collection, not a definition or excluded folder.`);
      if (this.app.vault.getAbstractFileByPath(path)) throw new Error(t`A file already exists at this location. Choose another path.`);
      const issues = newNoteIssues(path, this.frontmatter, this.type, this.types);
      if (issues.some(issue => issue.severity === "error")) {
        for (const issue of issues) {
          const target = issue.field ? this.inputs.get(issue.field) : undefined;
          if (target) target.error.textContent = issue.message;
        }
        throw new Error(issues.filter(issue => issue.severity === "error").map(issue => issue.message).join(" · "));
      }
      this.creating = true;
      this.submit.disabled = true;
      await this.create(path, structuredClone(this.frontmatter));
      this.close();
    } catch (error) {
      this.problem.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.creating = false;
      this.submit.disabled = false;
    }
  }

  onClose(): void {
    this.dismissed = true;
    this.options.closed?.();
  }
}
