import { t } from "@lingui/core/macro";
import { Notice } from "obsidian";
import type { MdbaseTypeDef } from "../../mdbaseCore";
import { parseFrontmatter } from "../../mdbaseCore";
import type { TypeEditorModel } from "../../typeEditorTypes";
import { YamlSourceEditor, yamlErrorLine, yamlKeyLine, type YamlProblem } from "../../yamlEditor";
import { typeModelFromDocument } from "../../typeModel";
import { validateTypeDraft } from "../../typeDraft";
import type { WorkspaceContext } from "../shared";

/**
 * The YAML tab of the type editor: the draft source text, its CodeMirror editor
 * (or a textarea fallback), and the problems found in it.
 */
export class TypeYamlSource {
  /** The type definition as edited in the YAML tab. */
  text = "";
  private editor: YamlSourceEditor | null = null;
  private problemTimer: number | null = null;

  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly deps: {
      /** The type being edited. */
      model(): TypeEditorModel | null;
      dirty(): boolean;
      markDirty(render?: boolean): void;
      typeEntries(): MdbaseTypeDef[];
    },
  ) {}

  /** Drop the editor so the next YAML render starts a fresh one. */
  destroyEditor(): void {
    this.editor?.destroy();
    this.editor = null;
  }

  /** Cancel a pending problem check. */
  cancelProblemCheck(): void {
    if (this.problemTimer !== null) window.clearTimeout(this.problemTimer);
  }

  render(container: HTMLElement, readOnly: boolean): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-yaml-section" });
    // Problems sit above the editor so they are visible without scrolling past a long type.
    this.fillProblems(section.createDiv({ cls: "mdbase-yaml-problems" }));
    const editor = this.ensureEditor(readOnly);
    if (editor) {
      section.appendChild(editor.dom);
    } else {
      const textarea = section.createEl("textarea", { cls: "mdbase-yaml-editor" });
      textarea.setAttr("aria-label", t`Type definition YAML`);
      textarea.setAttr("data-focus-key", "yaml-editor");
      textarea.value = this.text;
      textarea.disabled = readOnly;
      textarea.spellcheck = false;
      textarea.oninput = () => this.onInput(textarea.value);
    }
  }

  /** One CodeMirror instance per open type, re-attached on every render so history and cursor survive. */
  private ensureEditor(readOnly: boolean): YamlSourceEditor | null {
    try {
      if (!this.editor) {
        this.editor = new YamlSourceEditor({
          doc: this.text,
          readOnly,
          labelledBy: "mdbase-mode-yaml",
          onChange: (doc) => this.onInput(doc),
        });
      } else {
        this.editor.setValue(this.text);
        this.editor.setReadOnly(readOnly);
      }
      this.editor.setProblems(this.problems());
      return this.editor;
    } catch (error) {
      // CodeMirror is supplied by Obsidian; a plain textarea keeps YAML editable without it.
      console.error("mdbase: YAML editor unavailable", error);
      this.editor = null;
      return null;
    }
  }

  private onInput(value: string): void {
    this.text = value;
    this.deps.markDirty(false);
    if (this.problemTimer !== null) window.clearTimeout(this.problemTimer);
    this.problemTimer = window.setTimeout(() => {
      this.problemTimer = null;
      const problems = this.problems();
      this.editor?.setProblems(problems);
      const list = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-yaml-problems");
      if (list) {
        list.empty();
        this.fillProblems(list, problems);
      }
    }, 250);
  }

  private fillProblems(container: HTMLElement, problems = this.problems()): void {
    if (!this.deps.dirty() || !problems.length) return;
    for (const problem of problems.slice(0, 20)) {
      const row = container.createEl("button", { cls: "mdbase-yaml-problem" });
      row.setAttr("data-severity", problem.severity);
      const line = problem.line;
      row.createSpan({ cls: "mdbase-yaml-problem-line-number", text: line ? t`Line ${line}` : t({ message: "Type", context: "YAML problem location" }) });
      row.createSpan({ text: problem.message });
      row.disabled = problem.line === null;
      if (problem.line !== null) {
        const line = problem.line;
        row.onclick = () => this.editor?.revealLine(line);
      }
    }
  }

  /** The YAML draft as a type model, or the first problem that stops it parsing. */
  parse(): { model: TypeEditorModel } | { error: string; line?: number | null } {
    const parsed = parseFrontmatter(this.text);
    if (!parsed.hasFrontmatter) return { error: t`Type YAML must start with a --- frontmatter block.`, line: 1 };
    // Parser messages append a code excerpt; the first line carries the meaning.
    if (parsed.error) {
      // The row shows the editor's line number; the parser's own position counts from the frontmatter.
      const message = parsed.error.split("\n")[0].replace(/:$/, "").replace(/ at line \d+, column \d+$/, "");
      return { error: t`Invalid YAML: ${message}`, line: yamlErrorLine(parsed.error) };
    }
    if (parsed.frontmatter.kind !== "mdbase.type") {
      return { error: t`Canonical v0.3 type YAML requires kind: mdbase.type.`, line: yamlKeyLine(this.text, "kind") ?? 2 };
    }
    try {
      const current = this.deps.model();
      const model = typeModelFromDocument(parsed.frontmatter, parsed.body, current?.name || "type");
      if (current?.sourceRevision) model.sourceRevision = current.sourceRevision;
      return { model };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), line: null };
    }
  }

  /** Syntax and type problems in the YAML draft, located by line where possible. */
  problems(): YamlProblem[] {
    const result = this.parse();
    if ("error" in result) return [{ line: result.line ?? null, message: result.error, severity: "error" }];
    return validateTypeDraft(result.model, {
      knownTypes: this.deps.typeEntries().map((type) => type.name),
      contracts: this.ctx.schema?.contracts.values(),
    }).map((diagnostic) => {
      const key = diagnostic.path.startsWith("fields.")
        ? diagnostic.path.slice("fields.".length).split(/[.[]/)[0]
        : diagnostic.path === "identity.displayNameKey" ? "name_field" : diagnostic.path.split(".").pop() ?? "";
      return {
        line: yamlKeyLine(this.text, key),
        message: diagnostic.message,
        severity: diagnostic.severity === "error" ? "error" : "warning",
      };
    });
  }

  /** The YAML draft as a type model; on a problem, reports it, shows its line and returns null. */
  readModel(): TypeEditorModel | null {
    const result = this.parse();
    if ("error" in result) {
      new Notice(result.error);
      if (result.line) this.editor?.revealLine(result.line);
      return null;
    }
    return result.model;
  }
}
