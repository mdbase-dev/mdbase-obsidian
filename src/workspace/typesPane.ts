import { DiscardChangesModal, TypeChangeConfirmationModal } from "../modals";
import { Notice, Platform, setIcon } from "obsidian";
import type { MdbaseTypeDef } from "../mdbaseCore";
import { formatMarkdown } from "../mdbaseCore";
import type { StoredTypeDraft, TypeEditorModel } from "../typeEditorTypes";
import type { TypeStats } from "../typeImpact";
import { createDefaultTypeModel } from "../typeModel";
import {
  describeTypeChanges,
  typeModelsEqual,
  validateTypeDraft,
  type TypeDraftDiagnostic,
} from "../typeDraft";
import { WorkspaceContext, EditorMode, clone } from "./shared";
import { renderDesignForm } from "./types/designForm";
import { frontmatterFromReadableModel, renderStaleDrafts } from "./types/drafts";
import { FieldEditor } from "./types/fieldEditor";
import { TypeImpact } from "./types/impact";
import { MigrationReview, renderSetup } from "./types/setup";
import { renderTypeList } from "./types/typeList";
import { TypeYamlSource } from "./types/yamlSource";

/**
 * The Types destination: the type list beside the editor for the selected type.
 * Owns the open type, its draft and the save flow; the pieces it shows live in
 * ./types/.
 */
export class TypesPane {
  private editorMode: EditorMode = "design";
  private query = "";
  private selectedPath: string | null = null;
  private model: TypeEditorModel | null = null;
  private originalModel: TypeEditorModel | null = null;
  dirty = false;
  /** Drafts written during this session; restoring them is expected, not a recovery. */
  private readonly sessionDrafts = new Set<string>();
  private draftSaveTimer: number | null = null;
  private typeSelectionVersion = 0;
  /**
   * A new type opens with an empty name; its "name is required" error waits
   * until the Name box loses focus or Save is tried, so it doesn't greet the
   * person before they have typed anything.
   */
  private holdNameError = false;
  /** Where the Design document was scrolled when YAML was opened. */
  private designScrollTop = 0;
  private readonly fields: FieldEditor;
  private readonly impact: TypeImpact;
  private readonly yaml: TypeYamlSource;
  private readonly migration: MigrationReview;

  constructor(private readonly ctx: WorkspaceContext) {
    this.fields = new FieldEditor(ctx, {
      model: () => this.model,
      markDirty: (render) => this.markDirty(render),
      typeEntries: () => this.typeEntries(),
    });
    this.impact = new TypeImpact(ctx, {
      draft: () => {
        const parsedYaml = this.editorMode === "yaml" ? this.yaml.parse() : null;
        if (parsedYaml && "error" in parsedYaml) return { error: parsedYaml.error };
        return { model: parsedYaml?.model ?? this.model };
      },
      selectedPath: () => this.selectedPath,
      dirty: () => this.dirty,
      onUpdated: () => this.refreshDraftBar(),
    });
    this.yaml = new TypeYamlSource(ctx, {
      model: () => this.model,
      dirty: () => this.dirty,
      markDirty: (render) => this.markDirty(render),
      typeEntries: () => this.typeEntries(),
    });
    this.migration = new MigrationReview(ctx, () => {
      this.model = null;
      this.originalModel = null;
    });
  }

  /** Keep the selection valid for a newly loaded schema and reload the open type when asked. */
  async onSchemaLoaded(forceReload: boolean, isCurrent: () => boolean): Promise<void> {
    if (this.selectedPath && !this.typeEntries().some((entry) => entry.filePath === this.selectedPath)) {
      this.selectedPath = null;
      this.model = null;
      this.originalModel = null;
    }
    if (!this.selectedPath && this.typeEntries().length && !Platform.isMobile) {
      this.selectedPath = this.typeEntries()[0].filePath;
    }
    if (this.selectedPath && (!this.model || forceReload)) {
      // Persist in-progress edits first so the reload restores them.
      if (this.dirty) await this.flushTypeDraft();
      if (!isCurrent()) return;
      await this.selectType(this.selectedPath, false);
    }
  }

  onRecordsLoaded(changed: boolean): void {
    if (changed || !this.impact.result) this.impact.schedule(0);
  }

  /** Scroll to and highlight a field requested before the render. */
  afterRender(root: HTMLElement): void {
    this.fields.afterRender(root);
  }

  getState(): Record<string, unknown> {
    return { selectedPath: this.selectedPath, editorMode: this.editorMode, query: this.query, fieldQuery: this.fields.query };
  }

  async setState(state: Record<string, unknown>): Promise<void> {
    if (typeof state.query === "string") this.query = state.query.slice(0, 2000);
    if (typeof state.fieldQuery === "string") this.fields.query = state.fieldQuery.slice(0, 2000);
    if (typeof state.selectedPath === "string" && state.selectedPath !== this.selectedPath) {
      await this.leaveCurrentType();
      this.selectedPath = state.selectedPath;
      this.model = null;
      this.originalModel = null;
    }
  }

  restoreEditorMode(mode: unknown): void {
    if (mode === "yaml" && this.editorMode !== "yaml") this.switchEditorMode("yaml");
  }

  async dispose(): Promise<void> {
    this.impact.dispose();
    this.yaml.cancelProblemCheck();
    await this.flushTypeDraft();
    this.yaml.destroyEditor();
  }

  /** Open a type with one field (a dotted or `[]` path) expanded and in view. */
  async openTypeField(typePath: string, fieldPath: string | undefined): Promise<void> {
    this.ctx.destination = "types";
    if (typePath !== this.selectedPath || !this.model) await this.selectType(typePath);
    if (!this.model || this.selectedPath !== typePath) return;
    if (fieldPath) this.revealField(fieldPath);
    this.ctx.render();
  }

  private revealField(fieldPath: string): void {
    if (this.model && this.fields.reveal(this.model, fieldPath)) this.editorMode = "design";
  }

  currentStats(): { recordTypes: Map<string, string[]>; stats: Map<string, TypeStats> } {
    return this.impact.currentStats();
  }

  createNewType(): void {
    this.ctx.destination = "types";
    void this.createType();
  }

  async editType(path: string): Promise<void> {
    this.ctx.destination = "types";
    await this.selectType(path);
  }

  private typeEntries(): MdbaseTypeDef[] {
    return this.ctx.schema
      ? [...this.ctx.schema.types.values()].sort((a, b) => a.name.localeCompare(b.name))
      : [];
  }

  render(container: HTMLElement): void {
    if (!this.ctx.schema) {
      renderSetup(container, this.ctx);
      return;
    }

    if (this.ctx.schema.config.spec_version.startsWith("0.2.")) {
      this.migration.renderBanner(container);
    }

    if (!this.typeEntries().length && !this.model) {
      const welcome = container.createDiv({ cls: "mdbase-empty-state" });
      welcome.createEl("h2", { text: "Add your first type" });
      welcome.createEl("p", { text: "Start from a ready-made type, such as tasks, people or daily notes, or design your own." });
      const actions = welcome.createDiv({ cls: "mdbase-actions" });
      const install = actions.createEl("button", { text: "Browse ready-made types", cls: "mod-cta" });
      install.disabled = this.ctx.busy || this.ctx.schema.config.spec_version.startsWith("0.2.");
      install.onclick = () => void this.ctx.perform(() => this.ctx.host.openContractCatalog());
      const custom = actions.createEl("button", { text: "Design a custom type" });
      custom.disabled = this.ctx.schema.config.spec_version.startsWith("0.2.");
      custom.onclick = () => void this.createType();
      return;
    }
    const layout = container.createDiv({ cls: "mdbase-types-layout" });
    if (this.model) layout.addClass("has-selection");
    renderTypeList(layout, {
      ctx: this.ctx,
      query: this.query,
      setQuery: (query) => { this.query = query; },
      typeEntries: () => this.typeEntries(),
      selectedPath: this.selectedPath,
      dirty: this.dirty,
      currentStats: () => this.currentStats(),
      createType: () => this.createType(),
      selectType: (path) => this.selectType(path),
    });
    this.renderTypeEditor(layout);
  }

  private renderTypeEditor(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-editor-pane" });
    pane.setAttr("data-scroll-key", "type-editor");
    if (!this.model) {
      const empty = pane.createDiv({ cls: "mdbase-empty-state" });
      empty.createEl("p", { text: "Select a type" });
      return;
    }
    const readOnly = this.model.specProfile === "v0.2" || Boolean(this.model.readOnlyReason);
    const readOnlyReason = this.model.readOnlyReason ?? "Migrate this v0.2 collection to edit types.";
    const header = pane.createDiv({ cls: "mdbase-editor-header" });
    const back = this.ctx.iconButton(header, "arrow-left", "Back to type list");
    back.addClass("mdbase-mobile-back");
    back.onclick = () => void this.leaveCurrentType().then(() => {
      this.selectedPath = null;
      this.model = null;
      this.originalModel = null;
      this.ctx.render();
    });
    const heading = header.createDiv({ cls: "mdbase-editor-heading" });
    const titleLine = heading.createDiv({ cls: "mdbase-editor-title-line" });
    titleLine.createEl("h2", { text: this.model.name || "Untitled type" });
    if (this.dirty && !readOnly) {
      const unsaved = titleLine.createSpan({ cls: "mdbase-editor-dirty" });
      setIcon(unsaved.createSpan({ cls: "mdbase-editor-dirty-icon" }), "circle-dot");
      unsaved.createSpan({ text: this.selectedPath ? "Unsaved changes" : "Not saved yet" });
    }
    heading.createDiv({ cls: "mdbase-editor-path", text: this.selectedPath ?? "New type" });

    const headerActions = header.createDiv({ cls: "mdbase-editor-actions" });
    if (this.selectedPath) {
      const selectedPath = this.selectedPath;
      const source = this.ctx.iconButton(headerActions, "file-code", "Open source");
      source.onclick = () => void this.ctx.host.openFileByPath(selectedPath);
    }

    if (this.selectedPath) {
      const name = this.model.name;
      const create = headerActions.createEl("button", { text: "New note" });
      create.disabled = readOnly || this.ctx.busy;
      create.onclick = () => void this.ctx.host.createNoteFromType(name);
      renderStaleDrafts(this.ctx, pane, this.selectedPath, {
        originalModel: () => this.originalModel,
        yamlDraft: () => this.yaml.text,
      });
    }
    if (readOnly) {
      pane.createDiv({
        cls: "mdbase-readonly-note",
        text: readOnlyReason,
      });
    }
    const mode = pane.createDiv({ cls: "mdbase-mode-switch" });
    mode.setAttr("role", "tablist");
    for (const [value, label] of [["design", "Design"], ["yaml", "YAML"]] as const) {
      const button = mode.createEl("button", { text: label });
      button.id = `mdbase-mode-${value}`;
      button.setAttr("role", "tab");
      button.setAttr("aria-selected", String(this.editorMode === value));
      if (this.editorMode === value) button.addClass("is-active");
      button.onclick = () => this.switchEditorMode(value);
    }

    const editor = pane.createDiv({ cls: "mdbase-editor-document" });
    // One scroll position per mode: YAML opens at its top, not at Design's offset.
    editor.setAttr("data-scroll-key", `type-document-${this.editorMode}`);
    if (this.editorMode === "design") {
      renderDesignForm(editor, this.model, readOnly, {
        ctx: this.ctx,
        fields: this.fields,
        impact: this.impact,
        typeEntries: () => this.typeEntries(),
        dirty: () => this.dirty,
        originalModel: () => this.originalModel,
        markDirty: (render) => this.markDirty(render),
        diagnostics: (draft) => this.diagnostics(draft),
        onNameBlur: () => this.releaseNameError(),
      });
    } else this.yaml.render(editor, readOnly);
    if (this.dirty && !readOnly) this.renderDraftBar(pane, this.model);
  }

  private renderDraftBar(container: HTMLElement, model: TypeEditorModel): void {
    const changes = describeTypeChanges(this.originalModel, model);
    const diagnostics = this.diagnostics(model);
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const highRiskCount = changes.filter((change) => change.risk === "high").length;
    const failing = this.impact.newlyFailing();
    const yamlErrors = this.editorMode === "yaml"
      ? this.yaml.problems().filter((problem) => problem.severity === "error").length
      : 0;
    const bar = container.createDiv({ cls: "mdbase-draft-bar" });
    const summary = bar.createDiv({ cls: "mdbase-draft-summary" });
    const shownErrors = this.editorMode === "yaml" ? yamlErrors : errorCount;
    summary.setAttr("data-tone", shownErrors ? "error" : failing || highRiskCount ? "warning" : "normal");
    summary.createSpan({
      text: shownErrors ? `${shownErrors} ${shownErrors === 1 ? "error" : "errors"}`
        : failing ? `${failing} ${failing === 1 ? "note" : "notes"} would fail`
          : highRiskCount ? `${highRiskCount} high-impact ${highRiskCount === 1 ? "change" : "changes"}`
            : "Unsaved changes",
    });
    const actions = bar.createDiv({ cls: "mdbase-actions" });
    if (this.editorMode === "design") {
      const review = actions.createEl("button", { text: "Review" });
      review.onclick = () => {
        const target = this.ctx.containerEl.querySelector<HTMLElement>("#mdbase-section-review");
        const details = target?.closest("details");
        if (details) details.open = true;
        this.ctx.render();
        this.ctx.containerEl.querySelector("#mdbase-section-review")?.scrollIntoView({ block: "nearest" });
      };
    }
    const discard = actions.createEl("button", { text: "Discard" });
    discard.onclick = () => void this.confirmDiscard();
    const save = actions.createEl("button", { text: "Save" });
    save.addClass("mod-cta", "mdbase-draft-save");
    save.disabled = (this.editorMode === "design" ? errorCount > 0 : yamlErrors > 0) || this.ctx.busy;
    save.onclick = () => void this.saveCurrentType();
  }

  /** Draft diagnostics, less a new type's empty-name error while it is held. */
  private diagnostics(model: TypeEditorModel): TypeDraftDiagnostic[] {
    const diagnostics = validateTypeDraft(model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.ctx.schema?.contracts.values(),
    });
    if (!this.holdNameError || model.name.trim()) return diagnostics;
    return diagnostics.filter((diagnostic) => diagnostic.code !== "type_name_required");
  }

  /**
   * Stop holding the empty-name error. Runs on blur, often from a mousedown on
   * a button, so it updates the save bar's text and Save state in place:
   * replacing the buttons now would swallow that click.
   */
  private releaseNameError(): void {
    if (!this.holdNameError) return;
    this.holdNameError = false;
    const pane = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-type-editor-pane");
    const bar = pane?.querySelector<HTMLElement>(".mdbase-draft-bar");
    if (!pane || !bar || !this.model) return;
    const scratch = pane.ownerDocument.createElement("div");
    this.renderDraftBar(scratch, this.model);
    const summary = scratch.querySelector(".mdbase-draft-summary");
    if (summary) bar.querySelector(".mdbase-draft-summary")?.replaceWith(summary);
    const save = bar.querySelector<HTMLButtonElement>(".mdbase-draft-save");
    const nextSave = scratch.querySelector<HTMLButtonElement>(".mdbase-draft-save");
    if (save && nextSave) save.disabled = nextSave.disabled;
  }

  /** Show a new impact result in the draft bar. */
  private refreshDraftBar(): void {
    const pane = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-type-editor-pane");
    const bar = pane?.querySelector(".mdbase-draft-bar");
    if (pane && bar && this.model) {
      bar.remove();
      this.renderDraftBar(pane, this.model);
    }
  }

  /** Keep the current draft (if any) so another type can be opened without losing work. */
  private async leaveCurrentType(): Promise<void> {
    if (this.dirty) await this.flushTypeDraft();
    this.yaml.destroyEditor();
    this.impact.reset();
  }

  private async selectType(path: string, keepCurrentDraft = true): Promise<void> {
    if (keepCurrentDraft && path !== this.selectedPath) await this.leaveCurrentType();
    const version = ++this.typeSelectionVersion;
    const sourceModel = await this.ctx.host.loadTypeModel(path);
    if (version !== this.typeSelectionVersion) return;
    const draft = this.ctx.host.loadTypeDraft(path);
    const canRestore = draft?.version === 1 && draft.sourceRevision === (sourceModel.sourceRevision ?? null);
    const model = canRestore ? clone(draft.model) : sourceModel;
    this.selectedPath = path;
    this.model = model;
    this.originalModel = clone(sourceModel);
    // Design drafts may be incomplete; serialize only the valid saved source.
    // Switching to YAML will validate/serialize the edited model explicitly.
    this.yaml.text = canRestore && draft.yamlDraft !== undefined
      ? draft.yamlDraft
      : `${formatMarkdown(frontmatterFromReadableModel(sourceModel), sourceModel.body)}\n`;
    this.dirty = !typeModelsEqual(this.originalModel, model);
    this.editorMode = canRestore && draft.editorMode === "yaml" ? "yaml" : "design";
    if (this.editorMode === "yaml") this.dirty = true;
    if (canRestore && this.dirty) {
      if (!this.sessionDrafts.has(path)) this.ctx.message = `Recovered unsaved changes for ${path}.`;
    } else if (draft && !canRestore) {
      this.ctx.message = `An older draft for ${path} was kept, but the source changed. The current file is shown.`;
    }
    this.impact.schedule(0);
    this.ctx.render();
  }

  private async createType(): Promise<void> {
    await this.leaveCurrentType();
    this.typeSelectionVersion += 1;
    const draft = this.ctx.host.loadTypeDraft(null);
    const model = draft?.version === 1 ? clone(draft.model) : createDefaultTypeModel();
    this.selectedPath = null;
    this.model = model;
    this.originalModel = null;
    this.yaml.text = draft?.yamlDraft
      ?? "";
    this.dirty = true;
    if (draft && !this.sessionDrafts.has("__new__")) this.ctx.message = "Recovered an unsaved new type.";
    this.editorMode = draft?.editorMode ?? "design";
    this.holdNameError = !model.name.trim();
    if (this.editorMode === "design") this.ctx.pendingFocusKey = "form-name";
    this.impact.schedule(0);
    this.ctx.render();
  }

  private switchEditorMode(mode: EditorMode): void {
    if (!this.model || mode === this.editorMode) return;
    if (mode === "yaml") {
      try {
        this.yaml.text = `${formatMarkdown(frontmatterFromReadableModel(this.model), this.model.body)}\n`;
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        return;
      }
    } else if (!this.readYamlDraftIntoModel()) {
      return;
    }
    const documentEl = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-editor-document");
    if (mode === "yaml" && documentEl) this.designScrollTop = documentEl.scrollTop;
    this.editorMode = mode;
    if (mode === "design") this.yaml.destroyEditor();
    this.impact.schedule(0);
    this.ctx.render();
    // YAML always opens at the top; Design returns to where it was.
    const next = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-editor-document");
    if (next) next.scrollTop = mode === "design" ? this.designScrollTop : 0;
  }

  private readYamlDraftIntoModel(): boolean {
    const model = this.yaml.readModel();
    if (!model) return false;
    this.model = model;
    return true;
  }

  async saveCurrentType(): Promise<void> {
    if (!this.model || this.model.specProfile !== "v0.3" || this.model.readOnlyReason) return;
    if (this.editorMode === "yaml" && !this.readYamlDraftIntoModel()) return;
    this.holdNameError = false;
    const diagnostics = this.diagnostics(this.model);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length) {
      this.ctx.message = `${errors.length} ${errors.length === 1 ? "error must" : "errors must"} be fixed before saving.`;
      this.ctx.render();
      new Notice(errors[0].message);
      return;
    }
    const highImpact = describeTypeChanges(this.originalModel, this.model)
      .filter((change) => change.risk === "high");
    // Check notes against exactly what is about to be saved, not a debounced result.
    const fresh = await this.impact.compute();
    if (fresh !== undefined) this.impact.result = fresh;
    const failingNotes = this.impact.result && !("error" in this.impact.result)
      ? this.impact.result.impact.failing.filter((record) => record.isNew).map((record) => record.path)
      : [];
    if (highImpact.length || failingNotes.length) {
      const changes = highImpact.length
        ? highImpact
        : describeTypeChanges(this.originalModel, this.model).filter((change) => change.risk !== "safe");
      const confirmed = await new TypeChangeConfirmationModal(this.ctx.app).confirm(changes, failingNotes);
      if (!confirmed) return;
    }
    const model = this.model;
    await this.flushTypeDraft();
    await this.ctx.perform(async () => {
      const previousPath = this.selectedPath;
      const file = await this.ctx.host.saveTypeModel(model, previousPath, this.originalModel?.sourceRevision);
      await this.ctx.host.clearTypeDraft(previousPath);
      if (previousPath !== file.path) await this.ctx.host.clearTypeDraft(file.path);
      this.selectedPath = file.path;
      this.originalModel = clone(model);
      this.dirty = false;
      this.ctx.message = `Saved ${file.path}.`;
      await this.ctx.refresh(true);
    });
  }

  private markDirty(render = false): void {
    const wasDirty = this.dirty;
    this.dirty = this.editorMode === "yaml"
      ? true
      : !typeModelsEqual(this.originalModel, this.model);
    this.scheduleTypeDraftSave();
    this.impact.schedule();
    if (this.dirty && !wasDirty) this.ctx.message = "";
    if (render || wasDirty !== this.dirty) {
      this.ctx.render();
      return;
    }
    // Update validation/save state without replacing the input being edited.
    const pane = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-type-editor-pane");
    const bar = pane?.querySelector(".mdbase-draft-bar");
    if (pane && bar && this.model) {
      bar.remove();
      this.renderDraftBar(pane, this.model);
      const title = pane.querySelector(".mdbase-editor-title-line h2");
      if (title) title.textContent = this.model.name || "Untitled type";
    }
  }

  private scheduleTypeDraftSave(): void {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.flushTypeDraft();
    }, 2_000);
  }

  private async flushTypeDraft(): Promise<void> {
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    if (!this.model) return;
    if (!this.dirty) {
      const draft = this.ctx.host.loadTypeDraft(this.selectedPath);
      if (draft && draft.sourceRevision === (this.originalModel?.sourceRevision ?? null)) await this.ctx.host.clearTypeDraft(this.selectedPath);
      return;
    }
    this.sessionDrafts.add(this.selectedPath ?? "__new__");
    const draft: StoredTypeDraft = {
      version: 1,
      path: this.selectedPath,
      sourceRevision: this.originalModel?.sourceRevision ?? null,
      model: clone(this.model),
      editorMode: this.editorMode,
      yamlDraft: this.editorMode === "yaml" ? this.yaml.text : undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.ctx.host.saveTypeDraft(draft);
  }

  /** Discard only after saying what would be lost; there is no undo. */
  private async confirmDiscard(): Promise<void> {
    const model = this.model;
    if (!model) return;
    const isNew = !this.selectedPath;
    const name = model.name.trim();
    const lost = this.editorMode === "yaml"
      ? ["Your edits in YAML"]
      : describeTypeChanges(this.originalModel, model).map((change) => change.summary);
    const confirmed = await new DiscardChangesModal(this.ctx.app).confirm(
      isNew
        ? name ? `Discard the new type ${name}?` : "Discard this new type?"
        : `Discard changes to ${name || "this type"}?`,
      isNew ? [] : lost,
      isNew
        ? "It hasn't been saved, so it will be gone. This can't be undone."
        : `${this.selectedPath} goes back to how it was last saved. This can't be undone.`,
    );
    if (confirmed) await this.discardCurrentType();
  }

  private async discardCurrentType(): Promise<void> {
    const path = this.selectedPath;
    const draft = this.ctx.host.loadTypeDraft(path);
    if (!draft || draft.sourceRevision === (this.originalModel?.sourceRevision ?? null)) await this.ctx.host.clearTypeDraft(path);
    if (path) {
      const model = await this.ctx.host.loadTypeModel(path);
      this.model = model;
      this.originalModel = clone(model);
      this.yaml.text = `${formatMarkdown(frontmatterFromReadableModel(model), model.body)}\n`;
      this.dirty = false;
    } else {
      this.model = null;
      this.originalModel = null;
      this.yaml.text = "";
      this.dirty = false;
      this.holdNameError = false;
    }
    this.ctx.message = "Unsaved changes discarded.";
    this.ctx.render();
  }

}
