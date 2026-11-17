import { plural, t } from "@lingui/core/macro";
import { type App, Modal, SuggestModal } from "obsidian";
import type { MdbaseIssue, MdbaseTypeDef } from "./mdbaseCore";
import type { TypeDraftChange } from "./typeDraft";
import { describePathGlob } from "./fieldSummary";

interface TextPromptOptions {
  title: string;
  label: string;
  description?: string;
  placeholder?: string;
  value?: string;
  submitLabel: string;
  required?: boolean;
}

export class TextPromptModal extends Modal {
  private resolvePromise: ((value: string | null) => void) | null = null;
  private settled = false;

  constructor(app: App, private readonly options: TextPromptOptions) {
    super(app);
  }

  openAndGetValue(): Promise<string | null> {
    return new Promise((resolve) => {
      this.settled = false;
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, options } = this;
    contentEl.empty();
    this.titleEl.setText(options.title);
    const field = contentEl.createDiv({ cls: "mdbase-prompt-field" });
    const label = field.createEl("label", { text: options.label });
    const input = field.createEl("input", { type: "text" });
    label.htmlFor = input.id = "mdbase-prompt-input";
    input.placeholder = options.placeholder ?? "";
    input.value = options.value ?? "";
    input.addClass("prompt-input");
    if (options.description) field.createDiv({ cls: "setting-item-description", text: options.description });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: t`Cancel` });
    const submitButton = actions.createEl("button", { text: options.submitLabel, cls: "mod-cta" });
    // A required value keeps the prompt open instead of failing after it closes.
    const sync = () => { submitButton.disabled = options.required === true && !input.value.trim(); };
    sync();
    input.addEventListener("input", sync);
    const submit = () => {
      if (submitButton.disabled) return;
      this.finish(input.value.trim());
      this.close();
    };

    cancelButton.onclick = () => {
      this.finish(null);
      this.close();
    };
    submitButton.onclick = submit;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
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
    this.setPlaceholder(t`Search types`);
    this.setInstructions([
      { command: "↑↓", purpose: t`navigate` },
      { command: "↵", purpose: t`select` },
      { command: "esc", purpose: t`cancel` },
    ]);
    this.containerEl.addClass("mdbase-type-picker-modal");
    this.titleEl.setText(t`Choose a type`);
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
    const fieldCount = Object.keys(typeDef.fields ?? {}).length;
    meta.createSpan({
      cls: "mdbase-type-picker-path",
      text: typeDef.filePath,
    });
    meta.createSpan({
      cls: "mdbase-type-picker-count",
      text: plural(fieldCount, { one: "# field", other: "# fields" }),
    });

    if (typeDef.match?.path_glob) {
      const match = wrap.createDiv({ cls: "mdbase-type-picker-match" });
      const pathGlob = typeDef.match.path_glob;
      const plain = describePathGlob(pathGlob);
      if (plain) {
        match.createSpan({ text: plain });
        match.appendText(" · ");
        match.createEl("code", { text: pathGlob });
      } else match.createSpan({ text: t`Notes matching ${pathGlob}` });
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

export function pickType(app: App, typeDefs: MdbaseTypeDef[]): Promise<MdbaseTypeDef | null> {
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

export class TypeChangeConfirmationModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  confirm(changes: readonly TypeDraftChange[], failingNotes: readonly string[] = []): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      const failingCount = failingNotes.length;
      this.titleEl.setText(t`Confirm high-impact type changes`);
      this.contentEl.createEl("p", {
        text: failingNotes.length
          ? t`${plural(failingCount, { one: "# existing note", other: "# existing notes" })} would fail validation. Only the type definition will be saved; notes are not changed.`
          : t`These changes may invalidate existing notes. Only the type definition will be saved.`,
      });
      const list = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list" });
      for (const change of changes) list.createEl("li", { text: change.summary });
      if (failingNotes.length) {
        const notes = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list mdbase-confirm-notes" });
        for (const path of failingNotes.slice(0, 5)) notes.createEl("li", { text: path });
        const moreCount = failingNotes.length - 5;
        if (failingNotes.length > 5) notes.createEl("li", { text: t`${moreCount} more` });
      }
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: t`Keep reviewing` });
      cancel.onclick = () => this.finish(false);
      const save = actions.createEl("button", { text: t`Save high-impact changes` });
      save.addClass("mod-warning");
      save.onclick = () => this.finish(true);
      this.open();
    });
  }

  onClose(): void {
    if (!this.settled) this.finish(false, false);
    this.contentEl.empty();
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve?.(confirmed);
    this.resolve = null;
    if (close) this.close();
  }
}

export class BulkFixConfirmationModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  confirm(label: string, issues: readonly MdbaseIssue[]): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      const paths = [...new Set(issues.map((issue) => issue.path))];
      const noteCount = paths.length;
      const field = issues[0]?.field ?? t`affected`;
      this.titleEl.setText(t`${label} in ${plural(noteCount, { one: "# note", other: "# notes" })}?`);
      this.contentEl.createEl("p", {
        text: t`Only the '${field}' frontmatter field changes in each note. Notes that changed since validation are skipped.`,
      });
      const list = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list" });
      for (const path of paths.slice(0, 8)) list.createEl("li", { text: path });
      const moreCount = paths.length - 8;
      if (paths.length > 8) list.createEl("li", { text: t`${moreCount} more` });
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: t`Cancel` });
      cancel.onclick = () => this.finish(false);
      const apply = actions.createEl("button", { text: t`Update ${plural(noteCount, { one: "# note", other: "# notes" })}` });
      apply.addClass("mod-cta");
      apply.onclick = () => this.finish(true);
      this.open();
    });
  }

  onClose(): void {
    if (!this.settled) this.finish(false, false);
    this.contentEl.empty();
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve?.(confirmed);
    this.resolve = null;
    if (close) this.close();
  }
}

/** Ask before throwing away unsaved type edits, naming what would be lost. */
export class DiscardChangesModal extends Modal {
  private resolve: ((confirmed: boolean) => void) | null = null;
  private settled = false;

  confirm(title: string, lost: readonly string[], note: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.titleEl.setText(title);
      if (lost.length) {
        this.contentEl.createEl("p", { text: t`These unsaved changes will be lost:` });
        const list = this.contentEl.createEl("ul", { cls: "mdbase-confirm-change-list" });
        for (const item of lost.slice(0, 8)) list.createEl("li", { text: item });
        const moreCount = lost.length - 8;
        if (lost.length > 8) list.createEl("li", { text: t`${moreCount} more` });
      }
      this.contentEl.createEl("p", { text: note });
      const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
      const cancel = actions.createEl("button", { text: t`Keep editing` });
      cancel.onclick = () => this.finish(false);
      const discard = actions.createEl("button", { text: t`Discard changes` });
      discard.addClass("mod-warning");
      discard.onclick = () => this.finish(true);
      this.open();
      cancel.focus();
    });
  }

  onClose(): void {
    if (!this.settled) this.finish(false, false);
    this.contentEl.empty();
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve?.(confirmed);
    this.resolve = null;
    if (close) this.close();
  }
}
