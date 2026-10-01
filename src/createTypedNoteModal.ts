import { App, Modal } from "obsidian";
import {
  buildInitialFrontmatter, buildUniqueNotePath, coerceFieldInput, getPromptFields,
  validateRecordAgainstType, isExcluded, type MdbaseConfig, type MdbaseFieldDef, type MdbaseTypeDef,
} from "./mdbaseCore";

export function safeNotePath(value: string): string {
  const path = value.trim();
  if (!path || path.startsWith("/") || path.includes("\\") || Array.from(path).some(char => char.charCodeAt(0) < 32)
    || path.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("Choose a visible, vault-relative note path without .. or empty folders.");
  }
  return path.endsWith(".md") ? path : `${path}.md`;
}

export class CreateTypedNoteModal extends Modal {
  private frontmatter: Record<string, unknown>;
  private inputs = new Map<string, { input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; definition: MdbaseFieldDef; error: HTMLElement }>();
  private pathInput: HTMLInputElement;
  private problem: HTMLElement;
  private submit: HTMLButtonElement;
  private customPath = false;
  private suggestionVersion = 0;
  private creating = false;
  private dismissed = false;

  constructor(app: App, private readonly type: MdbaseTypeDef, private readonly config: MdbaseConfig,
    private readonly types: Map<string, MdbaseTypeDef>,
    private readonly create: (path: string, frontmatter: Record<string, unknown>) => Promise<void>) {
    super(app);
    this.frontmatter = buildInitialFrontmatter(type, config);
  }

  onOpen(): void {
    this.titleEl.setText(`New ${this.type.name}`);
    this.contentEl.addClass("mdbase-create-note");
    const fields = getPromptFields(this.type, this.frontmatter);
    const displayKey = this.type.display_name_key ?? "title";
    if (!fields.some(([name]) => name === displayKey) && this.frontmatter[displayKey] == null) {
      fields.unshift([displayKey, this.type.fields[displayKey] ?? { type: "string", description: "Used for the file name." }]);
    }
    for (const [name, definition] of fields) {
      const row = this.contentEl.createDiv({ cls: "mdbase-form-row" });
      const label = row.createEl("label", { text: `${name}${definition.required ? " *" : ""}` });
      if (definition.description) row.createDiv({ cls: "mdbase-form-description", text: definition.description });
      let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (definition.type === "boolean" || definition.type === "enum") {
        const select = row.createEl("select");
        input = select;
        select.createEl("option", { value: "", text: "Choose…" });
        const values = definition.type === "boolean" ? [true, false] : definition.values ?? [];
        values.forEach((value, index) => select.createEl("option", { value: String(index), text: String(value) }));
      } else if (["object", "list", "any"].includes(definition.type ?? "")) {
        input = row.createEl("textarea");
        input.placeholder = definition.type === "object" ? "YAML object" : definition.type === "list" ? "YAML list or comma-separated values" : "Value";
      } else {
        const inputType = definition.type === "date" ? "date" : definition.type === "datetime" ? "datetime-local" : definition.type === "time" ? "time" : "text";
        input = row.createEl("input", { type: inputType });
        if (["integer", "number"].includes(definition.type ?? "")) input.inputMode = "decimal";
        if (definition.type === "link") {
          const list = row.createEl("datalist");
          list.id = `mdbase-links-${this.inputs.size}`;
          this.app.vault.getMarkdownFiles().slice(0, 500).forEach(file => list.createEl("option", { value: `[[${file.path.replace(/\.md$/, "")}]]` }));
          input.setAttr("list", list.id);
        }
      }
      label.htmlFor = input.id = `mdbase-note-${name}`;
      const error = row.createDiv({ cls: "mdbase-inline-error", attr: { "aria-live": "polite" } });
      input.addEventListener("input", () => { this.readInputs(); void this.suggestPath(); });
      input.addEventListener("change", () => { this.readInputs(); void this.suggestPath(); });
      this.inputs.set(name, { input, definition, error });
    }
    const location = this.contentEl.createDiv({ cls: "mdbase-form-row" });
    const label = location.createEl("label", { text: "Location" });
    this.pathInput = location.createEl("input", { type: "text" });
    label.htmlFor = this.pathInput.id = "mdbase-note-location";
    this.pathInput.addEventListener("input", () => { this.customPath = true; this.problem.textContent = ""; });
    const reset = location.createEl("button", { text: "Use suggested location" });
    reset.onclick = () => { this.customPath = false; void this.suggestPath(); };
    this.problem = this.contentEl.createDiv({ cls: "mdbase-inline-error", attr: { role: "alert" } });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "Cancel" }).onclick = () => { if (!this.creating) this.close(); };
    this.submit = actions.createEl("button", { text: "Create note", cls: "mod-cta" });
    this.submit.onclick = () => void this.save();
    void this.suggestPath();
    this.inputs.values().next().value?.input.focus();
  }

  private readInputs(): boolean {
    let valid = true;
    for (const [name, { input, definition, error }] of this.inputs) {
      error.textContent = "";
      try {
        if (!input.value.trim()) {
          delete this.frontmatter[name];
          if (definition.required) throw new Error("Required");
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
      if (!this.dismissed && version === this.suggestionVersion && !this.customPath) this.pathInput.value = path;
    } catch (error) {
      if (!this.dismissed && version === this.suggestionVersion) this.problem.textContent = String(error);
    }
  }

  private async save(): Promise<void> {
    if (this.creating || !this.readInputs()) return;
    try {
      const path = safeNotePath(this.pathInput.value);
      if (isExcluded(path, this.config)) throw new Error("Choose a location included in this collection, not a definition or excluded folder.");
      if (this.app.vault.getAbstractFileByPath(path)) throw new Error("A file already exists at this location. Choose another path.");
      const issues = [...this.types.values()].flatMap(type => type.name === this.type.name || this.type.extends === type.name
        ? validateRecordAgainstType(path, this.frontmatter, type) : []);
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

  onClose(): void { this.dismissed = true; }
}
