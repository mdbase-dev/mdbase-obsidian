import { TypeChangeConfirmationModal } from "../modals";
import {
  Menu,
  Notice,
  Platform,
  setIcon,
} from "obsidian";
import type {
  CollectionRecord,
  MdbaseIssue,
  MdbaseTypeDef,
} from "../mdbaseCore";
import type { CollectionContractDescriptor, JsonObject } from "@mdbase-dev/connect-protocol";
import { formatMarkdown, parseFrontmatter } from "../mdbaseCore";
import type { V02MigrationPlan } from "../migration";
import type { StoredTypeDraft, TypeEditorField, TypeEditorModel } from "../typeEditorTypes";
import { fieldConstraintSummary, parseDefaultValue, parseEnumValue, scalarText } from "../fieldSummary";
import {
  analyzeTypeImpact,
  indexRecordTypes,
  typeStats,
  type TypeImpactResult,
  type TypeStats,
} from "../typeImpact";
import { YamlSourceEditor, yamlErrorLine, yamlKeyLine, type YamlProblem } from "../yamlEditor";
import {
  createDefaultTypeModel,
  frontmatterFromTypeModel,
  typeModelFromDocument,
} from "../typeModel";
import {
  addImplementation,
  assessMapping,
  contractFields,
  contractKey,
  mappingForContractField,
  removeImplementation,
  schemaInitialValue,
  schemaType,
  schemaTypeLabel,
  setBinding,
  setFieldMapping,
  typeFieldsForModel,
} from "../typeContracts";

import {
  describeTypeChanges,
  typeModelsEqual,
  validateTypeDraft,
} from "../typeDraft";

import {
  WorkspaceContext,
  EditorMode,
  FIELD_TYPES,
  isRecord,
  clone,
  fieldTypeLabel,
  definitionType,
  nextNestedFieldName,
  setOwnField,
  inputRow,
  renderStatus,
} from "./shared";

export class TypesPane {
  constructor(private readonly ctx: WorkspaceContext) {}

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
    if (changed || !this.impact) this.scheduleImpact(0);
  }

  /** Scroll to and highlight a field requested before the render. */
  afterRender(root: HTMLElement): void {
    if (!this.pendingFieldReveal) return;
    const node = root.querySelector<HTMLElement>(`[data-field-id="${this.pendingFieldReveal}"]`);
    if (node) {
      node.scrollIntoView({ block: "nearest" });
      if (!root.contains(root.ownerDocument.activeElement) || root.ownerDocument.activeElement === root.ownerDocument.body) {
        node.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
      }
      node.addClass("is-revealed");
    }
    this.pendingFieldReveal = null;
  }

  async dispose(): Promise<void> {
    await this.flushTypeDraft();
    this.yamlEditor?.destroy();
    this.yamlEditor = null;
  }
  private editorMode: EditorMode = "design";
  private query = "";
  private selectedPath: string | null = null;
  private model: TypeEditorModel | null = null;
  private originalModel: TypeEditorModel | null = null;
  private yamlDraft = "";
  dirty = false;
  private migrationPlan: V02MigrationPlan | null = null;
  private allowLossy = false;
  private statsCache: {
    records: CollectionRecord[] | null;
    types: Map<string, MdbaseTypeDef> | null;
    issues: MdbaseIssue[];
    recordTypes: Map<string, string[]>;
    stats: Map<string, TypeStats>;
  } | null = null;
  private impact: TypeImpactResult | null = null;
  private impactVersion = 0;
  private impactTimer: number | null = null;
  private showAllMatches = false;
  private pendingFieldReveal: string | null = null;
  /** Drafts written during this session; restoring them is expected, not a recovery. */
  private readonly sessionDrafts = new Set<string>();
  private yamlEditor: YamlSourceEditor | null = null;
  private yamlProblemTimer: number | null = null;
  private draftSaveTimer: number | null = null;
  private fieldQuery = "";
  private readonly expandedFields = new Set<string>();
  private readonly fieldIds = new WeakMap<Record<string, unknown>, string>();
  private nextFieldId = 1;
  private typeSelectionVersion = 0;

  /** Open a type with one field (a dotted or `[]` path) expanded and in view. */
  async openTypeField(typePath: string, fieldPath: string | undefined): Promise<void> {
    this.ctx.destination = "types";
    if (typePath !== this.selectedPath || !this.model) await this.selectType(typePath);
    if (!this.model || this.selectedPath !== typePath) return;
    if (fieldPath) this.revealField(fieldPath);
    this.ctx.render();
  }

  private revealField(fieldPath: string): void {
    if (!this.model) return;
    const segments = fieldPath.split(".").filter(Boolean);
    const top = segments.shift()?.replace(/\[\]$/g, "") ?? "";
    let definition = this.model.fields.find((field) => field.name === top)?.definition;
    if (!definition) return;
    this.editorMode = "design";
    this.fieldQuery = "";
    this.expandedFields.add(this.fieldId(definition));
    for (const segment of segments) {
      const name = segment.replace(/\[\]$/g, "");
      const container: Record<string, unknown> | undefined = isRecord(definition.items) ? definition.items : definition;
      const child: unknown = isRecord(container.fields) ? container.fields[name] : undefined;
      if (!isRecord(child)) break;
      if (container !== definition) this.expandedFields.add(this.fieldId(container));
      definition = child;
      this.expandedFields.add(this.fieldId(definition));
    }
    this.pendingFieldReveal = this.fieldId(definition);
  }

  currentStats(): { recordTypes: Map<string, string[]>; stats: Map<string, TypeStats> } {
    const issues = this.ctx.host.getIssues();
    const types = this.ctx.schema?.types ?? null;
    const cached = this.statsCache;
    if (cached && cached.records === this.ctx.records && cached.types === types && cached.issues === issues) return cached;
    const recordTypes = this.ctx.records && this.ctx.schema
      ? indexRecordTypes(this.ctx.records, this.ctx.schema.config, this.ctx.schema.types)
      : new Map<string, string[]>();
    this.statsCache = { records: this.ctx.records, types, issues, recordTypes, stats: typeStats(recordTypes, issues) };
    return this.statsCache;
  }

  /** Re-run the draft/record comparison after a pause in editing. */
  private scheduleImpact(delay = 400): void {
    if (this.impactTimer !== null) window.clearTimeout(this.impactTimer);
    this.impactTimer = window.setTimeout(() => {
      this.impactTimer = null;
      void this.computeImpact().then((result) => {
        if (result === undefined) return;
        this.impact = result;
        this.updateImpactRegions();
      });
    }, delay);
  }

  /** undefined when superseded; null when there is nothing to analyze. */
  private async computeImpact(): Promise<TypeImpactResult | null | undefined> {
    const version = ++this.impactVersion;
    const parsedYaml = this.editorMode === "yaml" ? this.modelFromYamlDraft() : null;
    if (parsedYaml && "error" in parsedYaml) return { error: parsedYaml.error };
    const model = parsedYaml?.model ?? this.model;
    if (!model || !this.ctx.schema || !this.ctx.records || model.specProfile !== "v0.3" || model.readOnlyReason) return null;
    const savedName = this.selectedPath
      ? [...this.ctx.schema.types.values()].find((type) => type.filePath === this.selectedPath)?.name ?? null
      : null;
    const result = await analyzeTypeImpact({
      records: this.ctx.records,
      config: this.ctx.schema.config,
      types: this.ctx.schema.types,
      draft: model,
      savedName,
      filePath: this.selectedPath,
      isCurrent: () => version === this.impactVersion,
    });
    return version === this.impactVersion && result !== null ? result : undefined;
  }

  /** Refresh only the regions that show record impact, leaving inputs untouched. */
  private updateImpactRegions(): void {
    const preview = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-match-preview");
    if (preview) {
      preview.empty();
      this.fillMatchPreview(preview);
    }
    const summary = this.ctx.containerEl.querySelector<HTMLElement>("[data-disclosure='type-matching'] > summary");
    if (summary) summary.textContent = this.matchingLabel();
    const effect = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-impact");
    if (effect) {
      effect.empty();
      this.fillImpact(effect);
    }
    const pane = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-type-editor-pane");
    const bar = pane?.querySelector(".mdbase-draft-bar");
    if (pane && bar && this.model) {
      bar.remove();
      this.renderDraftBar(pane, this.model);
    }
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

  /**
   * First run: the one decision is where the collection lives. Starting one
   * here makes this vault its source; copying one from Connect makes this vault
   * a synced mirror. Adoption (moving a local collection to Connect) is offered
   * later, from Sync, once a local collection exists.
   */
  private renderSetup(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "mdbase-empty-state mdbase-setup" });
    if (this.ctx.host.getMirrorProfile()) {
      empty.createEl("h2", { text: "Waiting for the first sync" });
      empty.createEl("p", { text: "Types appear here once the hosted collection has synced." });
      const open = empty.createEl("button", { text: "Open sync", cls: "mod-cta" });
      open.onclick = () => this.ctx.showDestination("sync");
      return;
    }
    empty.createEl("h2", { text: "Set up mdbase" });
    const choices = empty.createDiv({ cls: "mdbase-setup-choices" });
    const choice = (label: string, detail: string, cta: boolean, onClick: () => void) => {
      const row = choices.createDiv({ cls: "mdbase-setup-choice" });
      const text = row.createDiv();
      text.createEl("strong", { text: label });
      text.createDiv({ cls: "mdbase-muted", text: detail });
      const button = row.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
      button.disabled = this.ctx.busy;
      button.onclick = onClick;
    };
    choice("Start a collection", "This vault holds the collection. You can upload it to Connect later.", true, () => {
      void this.ctx.perform(async () => {
        await this.ctx.host.initializeCollection();
        await this.ctx.refresh(true);
      });
    });
    choice("Copy from Connect", "Connect holds the collection. This vault syncs a copy.", false, () => {
      this.ctx.showDestination("sync");
    });
  }

  render(container: HTMLElement): void {
    if (!this.ctx.schema) {
      this.renderSetup(container);
      return;
    }

    if (this.ctx.schema.config.spec_version.startsWith("0.2.")) {
      this.renderLegacyBanner(container);
    }

    const layout = container.createDiv({ cls: "mdbase-types-layout" });
    if (this.model) layout.addClass("has-selection");
    this.renderTypeList(layout);
    this.renderTypeEditor(layout);
  }

  private renderLegacyBanner(container: HTMLElement): void {
    const banner = container.createDiv({ cls: "mdbase-legacy-banner" });
    const text = banner.createDiv();
    text.createEl("strong", { text: "Read-only · v0.2 collection" });
    text.createEl("p", { text: "Migrate to edit types." });
    if (!this.migrationPlan) {
      const button = banner.createEl("button", { text: "Review migration" });
      button.disabled = this.ctx.busy || this.ctx.host.getMirrorProfile() !== null;
      button.onclick = () => void this.ctx.perform(async () => {
        this.migrationPlan = await this.ctx.host.analyzeMigration();
        this.ctx.render();
      });
    }
    if (this.ctx.host.getMirrorProfile()) {
      banner.createDiv({
        cls: "mdbase-form-description",
        text: "Hosted resources must be migrated at the collection authority.",
      });
    }
    if (this.migrationPlan) this.renderMigrationReview(container, this.migrationPlan);
  }

  private renderMigrationReview(container: HTMLElement, plan: V02MigrationPlan): void {
    const review = container.createDiv({ cls: "mdbase-migration-review" });
    const header = review.createDiv({ cls: "mdbase-section-header" });
    header.createEl("h3", { text: "Migration review" });
    header.createSpan({ cls: "mdbase-spec-badge", text: `${plan.sourceVersion} → ${plan.targetVersion}` });
    const summary = review.createDiv({ cls: "mdbase-status-list" });
    renderStatus(summary, "Files replaced", String(plan.operations.length));
    renderStatus(summary, "Type definitions", String(plan.typeSummaries.length));
    renderStatus(summary, "Record reads verified", String(plan.recordsVerified));
    if (plan.recordsSkipped) renderStatus(summary, "Records skipped", String(plan.recordsSkipped));
    renderStatus(summary, "Record files rewritten", "0");
    renderStatus(summary, "Recovery backup", plan.backupLocation);
    const warnings = review.createDiv({ cls: "mdbase-review-list" });
    if (!plan.diagnostics.length) {
      warnings.createDiv({ cls: "mdbase-review-ok", text: "No migration diagnostics." });
    }
    for (const diagnostic of plan.diagnostics.slice(0, 250)) {
      const item = warnings.createDiv({ cls: "mdbase-review-item" });
      item.setAttr("data-severity", diagnostic.severity);
      item.createDiv({ cls: "mdbase-review-code", text: `${diagnostic.severity} · ${diagnostic.path}` });
      item.createDiv({ text: diagnostic.message });
    }
    if (plan.diagnostics.length > 250) {
      warnings.createDiv({
        cls: "mdbase-form-description",
        text: `Showing 250 of ${plan.diagnostics.length} diagnostics.`,
      });
    }
    if (!plan.applicable) {
      const consent = review.createEl("label", { cls: "mdbase-consent" });
      const checkbox = consent.createEl("input", { type: "checkbox" });
      checkbox.checked = this.allowLossy;
      checkbox.onchange = () => {
        this.allowLossy = checkbox.checked;
        this.ctx.render();
      };
      consent.createSpan({ text: "I reviewed the lossy diagnostics and want to apply this migration." });
    }
    const actions = review.createDiv({ cls: "mdbase-actions" });
    const apply = actions.createEl("button", { text: "Apply migration" });
    apply.addClass("mod-warning");
    apply.disabled = this.ctx.busy || (!plan.applicable && !this.allowLossy);
    apply.onclick = () => void this.ctx.perform(async () => {
      await this.ctx.host.applyMigration(plan, this.allowLossy);
      this.migrationPlan = null;
      this.allowLossy = false;
      this.model = null;
      this.originalModel = null;
      await this.ctx.refresh(true);
    });
    const dismiss = actions.createEl("button", { text: "Close review" });
    dismiss.onclick = () => {
      this.migrationPlan = null;
      this.ctx.render();
    };
  }

  private renderTypeList(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-list-pane" });
    const header = pane.createDiv({ cls: "mdbase-pane-header" });
    header.createEl("h2", { text: "Types" });
    const createBlocked = (this.ctx.schema?.config.spec_version.startsWith("0.2.") ?? true)
      ? "Migrate to v0.3 to create types"
      : this.ctx.host.getMirrorProfile()?.mode === "read_only" ? "Read-only mirror" : "";
    const add = this.ctx.iconButton(header, "plus", createBlocked ? `Create type · ${createBlocked}` : "Create type");
    add.disabled = Boolean(createBlocked);
    add.onclick = () => void this.createType();

    const search = pane.createEl("input", { type: "search" });
    search.addClass("mdbase-type-search");
    search.placeholder = "Search types";
    search.setAttr("aria-label", "Search types");
    search.setAttr("data-focus-key", "type-search");
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.ctx.render();
      const next = this.ctx.containerEl.querySelector<HTMLInputElement>(".mdbase-type-search");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    };

    const list = pane.createDiv({ cls: "mdbase-type-list" });
    list.setAttr("data-scroll-key", "type-list");
    const query = this.query.trim().toLowerCase();
    const entries = this.typeEntries().filter((entry) =>
      `${entry.name} ${entry.description ?? ""} ${entry.filePath}`.toLowerCase().includes(query));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: query ? "No matching types." : "No type definitions." });
      return;
    }
    const { stats } = this.currentStats();
    for (const type of entries) {
      const button = list.createEl("button", { cls: "mdbase-type-row" });
      if (type.filePath === this.selectedPath) button.addClass("is-active");
      button.setAttr("aria-current", type.filePath === this.selectedPath ? "true" : "false");
      const nameLine = button.createDiv({ cls: "mdbase-type-name-line" });
      nameLine.createSpan({ cls: "mdbase-type-name", text: type.name });
      const unsaved = type.filePath === this.selectedPath ? this.dirty : this.ctx.host.loadTypeDraft(type.filePath) !== null;
      if (unsaved) {
        const dot = nameLine.createSpan({ cls: "mdbase-unsaved-dot" });
        dot.setAttr("aria-label", "Unsaved changes");
        dot.setAttr("title", "Unsaved changes");
      }
      const typeStat = stats.get(type.name);
      if (this.ctx.records) {
        const meta = button.createDiv({ cls: "mdbase-type-meta" });
        const notes = typeStat?.notes ?? 0;
        meta.createSpan({ text: `${notes.toLocaleString()} ${notes === 1 ? "note" : "notes"}` });
        if (typeStat?.issues) {
          meta.createSpan({
            cls: "mdbase-type-issues",
            text: `${typeStat.issues.toLocaleString()} ${typeStat.issues === 1 ? "issue" : "issues"}`,
          });
        }
      }
      button.onclick = () => void this.selectType(type.filePath);
    }
  }

  private renderTypeEditor(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-editor-pane" });
    pane.setAttr("data-scroll-key", "type-editor");
    if (!this.model) {
      const empty = pane.createDiv({ cls: "mdbase-empty-state" });
      empty.createEl("p", { text: "Select a type" });
      return;
    }
    const mirrorReadOnly = this.ctx.host.getMirrorProfile()?.mode === "read_only";
    const readOnly = this.model.specProfile === "v0.2" || mirrorReadOnly || Boolean(this.model.readOnlyReason);
    const readOnlyReason = this.model.readOnlyReason
      ?? (mirrorReadOnly
        ? "Read-only mirror. Reconnect with write access to edit."
        : "Migrate this v0.2 collection to edit types.");
    const header = pane.createDiv({ cls: "mdbase-editor-header" });
    const back = this.ctx.iconButton(header, "arrow-left", "Back to type list");
    back.addClass("mdbase-mobile-back");
    back.onclick = () => void this.leaveCurrentType().then(() => {
      this.selectedPath = null;
      this.model = null;
      this.originalModel = null;
      this.ctx.render();
    });
    const heading = header.createDiv();
    const titleLine = heading.createDiv({ cls: "mdbase-editor-title-line" });
    titleLine.createEl("h2", { text: this.model.name || "Untitled type" });
    heading.createDiv({ cls: "mdbase-editor-path", text: this.selectedPath ?? "New type" });

    const headerActions = header.createDiv({ cls: "mdbase-editor-actions" });
    if (this.selectedPath) {
      const selectedPath = this.selectedPath;
      const source = this.ctx.iconButton(headerActions, "file-code", "Open source");
      source.onclick = () => void this.ctx.host.openFileByPath(selectedPath);
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
    editor.setAttr("data-scroll-key", "type-document");
    if (this.editorMode === "design") this.renderDesignEditor(editor, this.model, readOnly);
    else this.renderYamlEditor(editor, readOnly);
    if (this.dirty && !readOnly) this.renderDraftBar(pane, this.model);
  }

  private renderDraftBar(container: HTMLElement, model: TypeEditorModel): void {
    const changes = describeTypeChanges(this.originalModel, model);
    const diagnostics = validateTypeDraft(model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.ctx.schema?.contracts.values(),
    });
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const highRiskCount = changes.filter((change) => change.risk === "high").length;
    const failing = this.newlyFailing();
    const yamlErrors = this.editorMode === "yaml"
      ? this.yamlProblems().filter((problem) => problem.severity === "error").length
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
    discard.onclick = () => void this.discardCurrentType();
    const save = actions.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.disabled = (this.editorMode === "design" ? errorCount > 0 : yamlErrors > 0) || this.ctx.busy;
    save.onclick = () => void this.saveCurrentType();
  }

  private newlyFailing(): number {
    if (!this.dirty || !this.impact || "error" in this.impact) return 0;
    return this.impact.impact.failing.filter((record) => record.isNew).length;
  }

  private matchingLabel(): string {
    const count = this.impact && !("error" in this.impact)
      ? this.impact.impact.matched.length
      : this.savedTypeName() ? this.currentStats().stats.get(this.savedTypeName() ?? "")?.notes : undefined;
    return count === undefined || !this.ctx.records
      ? "Matching"
      : `Matching · ${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;
  }

  private savedTypeName(): string | null {
    if (!this.selectedPath || !this.ctx.schema) return null;
    return [...this.ctx.schema.types.values()].find((type) => type.filePath === this.selectedPath)?.name ?? null;
  }

  /** The notes this type (as drafted) matches, with notes gained or lost against the saved type. */
  private fillMatchPreview(container: HTMLElement): void {
    const result = this.impact;
    let matched: string[];
    let added: string[] = [];
    let removed: string[] = [];
    if (result && !("error" in result)) {
      ({ matched, added, removed } = result.impact);
    } else {
      const name = this.savedTypeName();
      if (!this.ctx.records || !name || (result && "error" in result && this.dirty)) {
        container.createDiv({
          cls: "mdbase-muted",
          text: !this.ctx.records ? "Counting notes…" : result && "error" in result ? "Fix errors to preview matching notes." : "Save the type to preview matching notes.",
        });
        return;
      }
      matched = [...this.currentStats().recordTypes].filter(([, names]) => names.includes(name)).map(([path]) => path);
    }
    const summary = container.createDiv({ cls: "mdbase-match-summary" });
    summary.createSpan({ text: `${matched.length.toLocaleString()} ${matched.length === 1 ? "note matches" : "notes match"}` });
    if (added.length) summary.createSpan({ cls: "mdbase-match-added", text: `${added.length} added` });
    if (removed.length) summary.createSpan({ cls: "mdbase-match-removed", text: `${removed.length} no longer match` });
    const addedSet = new Set(added);
    const ordered: Array<{ path: string; change: "added" | "removed" | null }> = [
      ...added.map((path) => ({ path, change: "added" as const })),
      ...removed.map((path) => ({ path, change: "removed" as const })),
      ...matched.filter((path) => !addedSet.has(path)).map((path) => ({ path, change: null })),
    ];
    if (!ordered.length) return;
    const limit = this.showAllMatches ? 200 : 5;
    const list = container.createDiv({ cls: "mdbase-match-list" });
    for (const entry of ordered.slice(0, limit)) {
      const row = list.createEl("button", { cls: "mdbase-match-row" });
      if (entry.change) {
        row.setAttr("data-change", entry.change);
        row.createSpan({
          cls: "mdbase-match-marker",
          text: entry.change === "added" ? "+" : "−",
          attr: { "aria-label": entry.change === "added" ? "Added" : "No longer matches" },
        });
      }
      row.createSpan({ text: entry.path });
      row.setAttr("title", `Open ${entry.path}`);
      row.onclick = () => void this.ctx.host.openFileByPath(entry.path);
    }
    if (ordered.length > 5) {
      const more = container.createEl("button", {
        cls: "mdbase-link-button",
        text: this.showAllMatches
          ? "Show fewer"
          : ordered.length > 200
            ? `Show 200 of ${ordered.length.toLocaleString()}`
            : `Show all ${ordered.length.toLocaleString()}`,
      });
      more.onclick = () => {
        this.showAllMatches = !this.showAllMatches;
        container.empty();
        this.fillMatchPreview(container);
      };
    }
  }

  /** What saving the draft would do to existing notes. */
  private fillImpact(container: HTMLElement): void {
    const result = this.impact;
    if (!result) {
      container.createDiv({ cls: "mdbase-muted", text: this.ctx.records ? "Checking notes…" : "Counting notes…" });
      return;
    }
    if ("error" in result) {
      container.createDiv({ cls: "mdbase-muted", text: "Fix errors to check existing notes." });
      return;
    }
    const { impact } = result;
    const newlyFailing = impact.failing.filter((record) => record.isNew);
    const alreadyFailing = impact.failing.length - newlyFailing.length;
    const heading = container.createDiv({ cls: "mdbase-impact-heading" });
    heading.setAttr("data-tone", newlyFailing.length ? "warning" : "normal");
    heading.createEl("strong", {
      text: newlyFailing.length
        ? `${newlyFailing.length} ${newlyFailing.length === 1 ? "note" : "notes"} would fail`
        : "No notes newly fail",
    });
    const facts = [`${impact.matched.length.toLocaleString()} ${impact.matched.length === 1 ? "note" : "notes"} checked`];
    if (impact.fixed) facts.push(`${impact.fixed} fixed`);
    if (alreadyFailing) facts.push(`${alreadyFailing} already failing`);
    heading.createSpan({ cls: "mdbase-muted", text: facts.join(" · ") });
    if (!newlyFailing.length) return;
    const list = container.createDiv({ cls: "mdbase-impact-list" });
    for (const record of newlyFailing.slice(0, 10)) {
      const row = list.createDiv({ cls: "mdbase-impact-row" });
      const open = row.createEl("button", { cls: "mdbase-link-button", text: record.path });
      open.onclick = () => void this.ctx.host.openFileByPath(record.path, record.issues[0]?.field);
      row.createSpan({
        cls: "mdbase-muted",
        text: `${record.issues[0]?.message ?? ""}${record.issues.length > 1 ? ` · +${record.issues.length - 1} more` : ""}`,
      });
    }
    if (newlyFailing.length > 10) {
      list.createDiv({ cls: "mdbase-muted", text: `${newlyFailing.length - 10} more notes` });
    }
  }

  private renderDesignEditor(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const diagnostics = validateTypeDraft(model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.ctx.schema?.contracts.values(),
    });
    const identity = container.createEl("section", { cls: "mdbase-editor-section" });
    identity.id = "mdbase-section-identity";
    const name = inputRow(identity, "Name", model.name, (value) => {
      model.name = value;
      this.markDirty();
    });
    name.disabled = readOnly;
    const description = inputRow(identity, "Description", model.description, (value) => {
      model.description = value;
      this.markDirty();
    }, { multiline: true });
    description.disabled = readOnly;
    const options = this.ctx.disclosure(container, "type-options", "Options");
    const displayRow = options.createDiv({ cls: "mdbase-form-row" });
    const displayLabel = displayRow.createEl("label", { text: "Display field" });
    const display = displayRow.createEl("select");
    displayLabel.htmlFor = display.id = "mdbase-display-field";
    display.createEl("option", { value: "", text: "Use the file name" });
    for (const field of model.fields) {
      display.createEl("option", { value: field.name, text: field.name || "Unnamed field" });
    }
    if (model.displayNameKey && !model.fields.some((field) => field.name === model.displayNameKey)) {
      display.createEl("option", { value: model.displayNameKey, text: `${model.displayNameKey} · missing` });
    }
    display.value = model.displayNameKey;
    display.onchange = () => {
      model.displayNameKey = display.value;
      this.markDirty();
    };
    display.disabled = readOnly;
    const strictRow = options.createEl("label", { cls: "mdbase-checkbox-row" });
    const strict = strictRow.createEl("input", { type: "checkbox" });
    strict.checked = model.strictMode === true;
    strict.disabled = readOnly;
    strict.onchange = () => {
      model.strictMode = strict.checked;
      this.markDirty();
    };
    strictRow.createSpan({ text: "Reject undeclared fields" });

    const membership = this.ctx.disclosure(container, "type-matching", this.matchingLabel());
    membership.id = "mdbase-section-membership";
    this.fillMatchPreview(membership.createDiv({ cls: "mdbase-match-preview" }));
    const glob = inputRow(membership, "Path glob", model.matchPathGlob, (value) => {
      model.matchPathGlob = value;
      this.markDirty();
    }, { placeholder: "Projects/**/*.md" });
    glob.disabled = readOnly;
    const present = inputRow(membership, "Fields present", model.matchFieldsPresent, (value) => {
      model.matchFieldsPresent = value;
      this.markDirty();
    }, { description: "Comma-separated frontmatter keys." });
    present.disabled = readOnly;
    const where = inputRow(membership, "Where", model.matchWhere, (value) => {
      model.matchWhere = value;
      this.markDirty();
    }, {
      multiline: true,
      description: "YAML predicate, including contains and nested equality conditions.",
      placeholder: "tags:\n  contains: task",
    });
    where.disabled = readOnly;

    const fields = container.createEl("section", { cls: "mdbase-editor-section" });
    fields.id = "mdbase-section-fields";
    const fieldsHeader = fields.createDiv({ cls: "mdbase-section-header" });
    fieldsHeader.createEl("h3", { text: "Fields" });
    const headerActions = fieldsHeader.createDiv({ cls: "mdbase-section-actions" });
    if (this.expandedFields.size) {
      const collapse = this.ctx.iconButton(headerActions, "fold-vertical", "Collapse all fields");
      collapse.onclick = () => {
        this.expandedFields.clear();
        this.ctx.render();
      };
    }
    const addField = this.ctx.iconButton(headerActions, "plus", "Add field");
    addField.disabled = readOnly;
    addField.onclick = () => {
      const definition: Record<string, unknown> = { type: "string" };
      model.fields.push({ name: "", definition });
      this.expandedFields.add(this.fieldId(definition));
      this.markDirty(true);
    };
    if (model.fields.length > 6 || this.fieldQuery) {
      const fieldToolbar = fields.createDiv({ cls: "mdbase-field-toolbar" });
      const fieldActions = fieldToolbar.createDiv({ cls: "mdbase-field-toolbar-actions" });
      const fieldSearch = fieldActions.createEl("input", { type: "search" });
      fieldSearch.placeholder = "Filter fields";
      fieldSearch.setAttr("aria-label", "Filter fields");
      fieldSearch.setAttr("data-focus-key", "field-search");
      fieldSearch.value = this.fieldQuery;
      fieldSearch.oninput = () => {
        this.fieldQuery = fieldSearch.value;
        this.ctx.render();
      };
    }
    const fieldList = fields.createDiv({ cls: "mdbase-fields" });
    const normalizedFieldQuery = this.fieldQuery.trim().toLowerCase();
    const visibleFields = model.fields.filter((field) =>
      !normalizedFieldQuery || this.fieldMatches(field.name, field.definition, normalizedFieldQuery));
    for (const field of visibleFields) {
      const index = model.fields.indexOf(field);
      this.renderFieldRow(fieldList, field, index, readOnly);
    }
    if (!visibleFields.length) {
      fieldList.createDiv({
        cls: "mdbase-empty-list",
        text: model.fields.length ? "No fields match this filter." : "No fields declared.",
      });
    }

    // Keep the common editing surface (name, description, fields) first.
    if (membership.parentElement) container.appendChild(membership.parentElement);
    if (options.parentElement) container.appendChild(options.parentElement);
    const placement = options;
    const path = inputRow(placement, "Path pattern", model.pathPattern, (value) => {
      model.pathPattern = value;
      this.markDirty();
    }, { placeholder: "Notes/{title}.md" });
    path.disabled = readOnly;

    this.renderContractEditor(container, model, readOnly);

    if (!this.dirty && !diagnostics.length) return;
    const review = this.ctx.disclosure(container, "type-review", "Changes", diagnostics.some((item) => item.severity === "error"));
    review.id = "mdbase-section-review";
    if (this.dirty) this.fillImpact(review.createDiv({ cls: "mdbase-impact" }));
    if (diagnostics.length) {
      const diagnosticSummary = review.createDiv({ cls: "mdbase-diagnostic-summary" });
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
      const warnings = diagnostics.length - errors;
      diagnosticSummary.createEl("strong", {
        text: `${errors} ${errors === 1 ? "error" : "errors"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
      });
      for (const diagnostic of diagnostics.slice(0, 12)) {
        const item = diagnosticSummary.createDiv({ cls: "mdbase-diagnostic-item" });
        item.setAttr("data-severity", diagnostic.severity);
        item.createEl("code", { text: diagnostic.path });
        item.createSpan({ text: diagnostic.message });
      }
    }
    if (this.dirty) {
      const list = review.createEl("ul");
      for (const change of describeTypeChanges(this.originalModel, model)) {
        const item = list.createEl("li", { text: change.summary });
        item.setAttr("data-risk", change.risk);
      }
    }
  }

  private renderContractEditor(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const section = this.ctx.disclosure(container, "type-applications", "Applications");
    section.addClass("mdbase-contracts-section");
    section.id = "mdbase-section-applications";

    const contracts = [...(this.ctx.schema?.contracts.values() ?? [])];
    const implemented = new Set(model.implementations.map((implementation) => `${implementation.contract}@${implementation.version}`));
    const available = contracts.filter((contract) => !implemented.has(contractKey(contract)));

    if (!contracts.length) {
      section.createDiv({
        cls: "mdbase-contract-empty",
        text: "No application contracts installed.",
      });
    }

    for (const implementation of model.implementations) {
      const contract = contracts.find((candidate) =>
        candidate.id === implementation.contract && candidate.version === implementation.version);
      this.renderContractImplementation(section, model, implementation, contract, readOnly);
    }

    if (available.length) {
      const add = section.createDiv({ cls: "mdbase-contract-add" });
      const label = add.createEl("label", { text: "Installed contract" });
      const select = add.createEl("select");
      label.htmlFor = select.id = `mdbase-contract-${Math.random().toString(36).slice(2)}`;
      for (const contract of available) {
        select.createEl("option", { value: contractKey(contract), text: `${contract.id} · ${contract.version}` });
      }
      const button = add.createEl("button", { text: "Add contract" });
      button.disabled = readOnly;
      button.onclick = () => {
        const selected = available.find((candidate) => contractKey(candidate) === select.value);
        if (!selected) return;
        try {
          addImplementation(model, selected);
          this.markDirty(true);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      };
    }
  }

  private renderContractImplementation(
    container: HTMLElement,
    model: TypeEditorModel,
    implementation: TypeEditorModel["implementations"][number],
    contract: CollectionContractDescriptor | undefined,
    readOnly: boolean,
  ): void {
    const article = container.createEl("article", { cls: "mdbase-contract-implementation" });
    const header = article.createDiv({ cls: "mdbase-contract-header" });
    const identity = header.createDiv();
    identity.createEl("strong", { text: implementation.contract });
    identity.createSpan({ cls: "mdbase-contract-version", text: implementation.version });
    const remove = header.createEl("button", { text: "Remove" });
    remove.disabled = readOnly;
    remove.onclick = () => {
      removeImplementation(model, implementation.contract, implementation.version);
      this.markDirty(true);
    };

    if (!contract) {
      article.createDiv({
        cls: "mdbase-contract-unavailable",
        text: "This exact contract is not installed in the collection. Restore it or remove this implementation before saving.",
      });
      return;
    }

    const fields = contractFields(contract);
    const typeFields = typeFieldsForModel(model);
    const mapped = fields.filter((field) => mappingForContractField(implementation, field));
    const required = fields.filter((field) => field.required);
    const requiredMapped = required.filter((field) => mappingForContractField(implementation, field)).length;
    const details = article.createEl("details");
    details.open = requiredMapped < required.length;
    const summary = details.createEl("summary");
    summary.createSpan({ text: "Field mappings" });
    summary.createSpan({
      cls: "mdbase-contract-summary",
      text: `${requiredMapped}/${required.length} required · ${mapped.length}/${fields.length} total`,
    });
    const mappingList = details.createDiv({ cls: "mdbase-contract-mapping-list" });
    if (!fields.length) {
      mappingList.createDiv({
        cls: "mdbase-contract-unavailable",
        text: "This contract does not expose simple top-level properties. Configure its field references in YAML.",
      });
    }
    for (const field of fields) {
      const current = mappingForContractField(implementation, field);
      const mappedField = typeFields.find((candidate) => candidate.reference === current);
      const assessment = assessMapping(field, mappedField);
      const row = mappingList.createDiv({ cls: `mdbase-contract-mapping-row ${assessment.level}` });
      const definition = row.createDiv({ cls: "mdbase-contract-field-definition" });
      definition.createEl("code", { text: field.reference });
      definition.createSpan({
        cls: field.required ? "mdbase-contract-required" : "mdbase-contract-optional",
        text: field.required ? "Required" : "Optional",
      });
      definition.createEl("small", { text: field.description || schemaTypeLabel(field.schema) });
      const source = row.createEl("select");
      source.setAttr("aria-label", `${implementation.contract} ${field.reference} source field`);
      source.setAttr("aria-invalid", assessment.level === "error" ? "true" : "false");
      source.disabled = readOnly;
      source.createEl("option", { value: "", text: field.required ? "Choose a source field" : "Not exposed" });
      for (const candidate of typeFields) {
        const optionAssessment = assessMapping(field, candidate);
        const option = source.createEl("option", {
          value: candidate.reference,
          text: `${candidate.reference} · ${candidate.type}${optionAssessment.level === "warning" ? " · review" : ""}`,
        });
        option.disabled = optionAssessment.level === "error";
      }
      source.value = current;
      source.onchange = () => {
        setFieldMapping(implementation, field.reference, source.value || undefined);
        this.markDirty(true);
      };
      const status = row.createDiv({ cls: "mdbase-contract-mapping-status" });
      status.createEl("strong", { text: assessment.label });
      status.createEl("small", { text: assessment.message });
    }

    if (contract.binding_schema) {
      const settings = article.createEl("details", { cls: "mdbase-contract-settings" });
      settings.open = Boolean(implementation.binding);
      const settingsSummary = settings.createEl("summary");
      settingsSummary.createSpan({ text: "Contract settings" });
      settingsSummary.createSpan({
        cls: "mdbase-contract-summary",
        text: implementation.binding ? "Configured" : "Optional",
      });
      const body = settings.createDiv({ cls: "mdbase-contract-settings-body" });
      body.createEl("p", {
        cls: "mdbase-form-description",
        text: "Control how compatible applications interpret this type. Values follow the contract's schema.",
      });
      if (!implementation.binding) {
        const configure = body.createEl("button", { text: "Configure settings" });
        configure.disabled = readOnly;
        configure.onclick = () => {
          const initial = schemaInitialValue(contract.binding_schema);
          if (!isRecord(initial)) return;
          setBinding(implementation, initial);
          this.markDirty(true);
        };
      } else {
        this.renderContractSchemaValue(body, contract.binding_schema, implementation.binding, (value) => {
          if (!isRecord(value)) return;
          setBinding(implementation, value);
          this.markDirty();
        }, "Settings", readOnly);
      }
    }
  }

  private renderContractSchemaValue(
    container: HTMLElement,
    schema: JsonObject,
    value: unknown,
    onChange: (value: unknown) => void,
    label: string,
    readOnly: boolean,
  ): void {
    const type = schemaType(schema);
    if (type === "object") {
      const object = isRecord(value) ? value : {};
      const fieldset = container.createEl("fieldset", { cls: "mdbase-contract-schema-object" });
      fieldset.createEl("legend", { text: label });
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
      const names = [...new Set([...required, ...Object.keys(object).filter((name) => name in properties)])];
      for (const name of names) {
        const childSchema = properties[name];
        if (!isRecord(childSchema)) continue;
        const row = fieldset.createDiv({ cls: "mdbase-contract-schema-field" });
        const description = typeof childSchema.description === "string" ? childSchema.description : undefined;
        row.createEl("label", { text: `${name}${required.has(name) ? " · required" : ""}` });
        if (description) row.createEl("small", { text: description });
        this.renderContractSchemaControl(row, childSchema, object[name], (next) => {
          onChange({ ...object, [name]: next });
        }, name, readOnly);
      }
      if (!names.length) fieldset.createDiv({ cls: "mdbase-empty-list", text: "No settings declared." });
      const optional = Object.keys(properties).filter((name) => !names.includes(name));
      if (optional.length) {
        const add = fieldset.createDiv({ cls: "mdbase-contract-schema-add" });
        const select = add.createEl("select");
        for (const name of optional) select.createEl("option", { value: name, text: name });
        const button = add.createEl("button", { text: "Add optional setting" });
        button.disabled = readOnly;
        button.onclick = () => {
          const name = select.value;
          const childSchema = properties[name];
          if (!isRecord(childSchema)) return;
          onChange({ ...object, [name]: schemaInitialValue(childSchema) });
        };
      }
      return;
    }
    this.renderContractSchemaControl(container, schema, value, onChange, label, readOnly);
  }

  private renderContractSchemaControl(
    container: HTMLElement,
    schema: JsonObject,
    value: unknown,
    onChange: (value: unknown) => void,
    label: string,
    readOnly: boolean,
  ): void {
    const type = schemaType(schema);
    if (Array.isArray(schema.enum)) {
      const select = container.createEl("select");
      select.setAttr("aria-label", label);
      for (const choice of schema.enum) select.createEl("option", { value: JSON.stringify(choice), text: String(choice) });
      select.value = JSON.stringify(value);
      select.disabled = readOnly;
      select.onchange = () => onChange(JSON.parse(select.value));
      return;
    }
    if (type === "array") {
      const itemsSchema = isRecord(schema.items) ? schema.items : { type: "string" };
      const list = Array.isArray(value) ? value : [];
      const listEl = container.createDiv({ cls: "mdbase-contract-schema-array" });
      for (const [index, item] of list.entries()) {
        const itemEl = listEl.createDiv({ cls: "mdbase-contract-schema-array-item" });
        itemEl.createSpan({ text: `${index + 1}.` });
        this.renderContractSchemaControl(itemEl, itemsSchema, item, (next) => {
          onChange(list.map((current, currentIndex) => currentIndex === index ? next : current));
        }, `${label} item ${index + 1}`, readOnly);
        const remove = itemEl.createEl("button", { text: "Remove" });
        remove.disabled = readOnly || list.length <= (typeof schema.minItems === "number" ? schema.minItems : 0);
        remove.onclick = () => onChange(list.filter((_, currentIndex) => currentIndex !== index));
      }
      const add = container.createEl("button", { text: `Add ${label.toLowerCase()} item` });
      add.disabled = readOnly || (typeof schema.maxItems === "number" && list.length >= schema.maxItems);
      add.onclick = () => onChange([...list, schemaInitialValue(itemsSchema)]);
      return;
    }
    if (type === "object") {
      this.renderContractSchemaValue(container, schema, value, onChange, label, readOnly);
      return;
    }
    if (type === "boolean") {
      const checkbox = container.createEl("input", { type: "checkbox" });
      checkbox.checked = value === true;
      checkbox.disabled = readOnly;
      checkbox.setAttr("aria-label", label);
      checkbox.onchange = () => onChange(checkbox.checked);
      return;
    }
    const input = container.createEl("input", { type: type === "number" || type === "integer" ? "number" : "text" });
    input.setAttr("aria-label", label);
    input.value = value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    input.disabled = readOnly;
    input.oninput = () => onChange(type === "number" || type === "integer" ? Number(input.value) : input.value);
  }

  private renderFieldRow(container: HTMLElement, field: TypeEditorField, index: number, readOnly: boolean): void {
    const fields = this.model?.fields ?? [];
    this.renderFieldDefinition(container, field.definition, {
      name: field.name,
      nameLabel: `Field ${index + 1} name`,
      onNameInput: (value) => {
        field.name = value;
        this.markDirty();
      },
      required: field.definition.required === true,
      onRequiredChange: (value) => {
        field.definition.required = value;
        this.markDirty();
      },
      onRemove: () => {
        this.model?.fields.splice(index, 1);
        this.markDirty(true);
      },
      onMove: (offset) => {
        const target = index + offset;
        if (target < 0 || target >= fields.length) return;
        [fields[index], fields[target]] = [fields[target], fields[index]];
        this.pendingFieldReveal = this.fieldId(field.definition);
        this.markDirty(true);
      },
      canMoveUp: index > 0,
      canMoveDown: index < fields.length - 1,
      readOnly,
      depth: 0,
    });
  }

  private renderFieldDefinition(
    container: HTMLElement,
    definition: Record<string, unknown>,
    options: {
      name?: string;
      nameLabel: string;
      staticLabel?: string;
      onNameInput?: (value: string) => void;
      onNameCommit?: (value: string, input: HTMLInputElement) => void;
      required?: boolean;
      onRequiredChange?: (value: boolean) => void;
      onRemove?: () => void;
      onMove?: (offset: -1 | 1) => void;
      canMoveUp?: boolean;
      canMoveDown?: boolean;
      readOnly: boolean;
      depth: number;
    },
  ): void {
    const node = container.createEl("details", { cls: "mdbase-field-node" });
    node.setAttr("data-depth", String(options.depth));
    const fieldId = this.fieldId(definition);
    node.setAttr("data-field-id", fieldId);
    const queryMatch = Boolean(this.fieldQuery.trim())
      && this.fieldMatches(
        options.name ?? options.staticLabel ?? "",
        definition,
        this.fieldQuery.trim().toLowerCase(),
      );
    node.open = this.expandedFields.has(fieldId) || queryMatch;
    node.ontoggle = () => {
      if (node.open) this.expandedFields.add(fieldId);
      else this.expandedFields.delete(fieldId);
    };
    const label = options.name || options.staticLabel || "Unnamed field";
    const summary = node.createEl("summary", { cls: "mdbase-field-summary" });
    summary.setAttr("data-focus-key", `field-${fieldId}-summary`);
    const chevron = summary.createSpan({ cls: "mdbase-field-chevron" });
    chevron.setAttr("aria-hidden", "true");
    setIcon(chevron, "chevron-right");
    summary.createSpan({ cls: "mdbase-field-summary-name", text: label });
    summary.createSpan({ cls: "mdbase-field-summary-type", text: fieldTypeLabel(definitionType(definition)) });
    const rules = summary.createSpan({ cls: "mdbase-field-summary-rules" });
    const refreshSummary = () => {
      rules.textContent = fieldConstraintSummary(definition).join(" · ");
    };
    refreshSummary();
    if (options.required) summary.createSpan({ cls: "mdbase-field-summary-rule", text: "Required" });
    if (options.onMove && !options.readOnly) {
      summary.addEventListener("keydown", (event: KeyboardEvent) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        if (event.key === "ArrowUp" && options.canMoveUp) options.onMove?.(-1);
        if (event.key === "ArrowDown" && options.canMoveDown) options.onMove?.(1);
      });
    }
    const row = node.createDiv({ cls: "mdbase-field-row" });

    if (options.staticLabel) {
      row.createDiv({ cls: "mdbase-field-role", text: options.staticLabel });
    } else {
      const name = row.createEl("input", { type: "text", cls: "mdbase-field-name-control" });
      name.setAttr("data-focus-key", `field-${fieldId}-name`);
      name.setAttr("aria-label", options.nameLabel);
      name.placeholder = "Field name";
      name.value = options.name ?? "";
      name.disabled = options.readOnly;
      if (options.onNameInput) name.oninput = () => options.onNameInput?.(name.value);
      if (options.onNameCommit) name.onchange = () => options.onNameCommit?.(name.value, name);
    }

    const type = row.createEl("select", { cls: "mdbase-field-type-control" });
    type.setAttr("data-focus-key", `field-${fieldId}-type`);
    type.setAttr("aria-label", `${options.name || options.staticLabel || "Field"} type`);
    for (const value of FIELD_TYPES) type.createEl("option", { value, text: fieldTypeLabel(value) });
    type.value = definitionType(definition);
    type.disabled = options.readOnly;
    type.onchange = () => {
      definition.type = type.value;
      if (type.value === "list" && !isRecord(definition.items)) {
        definition.items = { type: "string" };
      }
      if (type.value === "object" && !isRecord(definition.fields)) {
        definition.fields = {};
      }
      if (type.value === "enum" && !Array.isArray(definition.values)) {
        definition.values = [];
      }
      // Rules that do not apply to the new type would be dropped on save; drop them now so the row is honest.
      if (type.value !== "integer" && type.value !== "number") {
        delete definition.min;
        delete definition.max;
      }
      if (type.value !== "string") delete definition.pattern;
      if (!["string", "list"].includes(type.value)) {
        delete definition.min_length;
        delete definition.max_length;
      }
      delete definition.default;
      this.markDirty(true);
    };

    const description = row.createEl("input", { type: "text", cls: "mdbase-field-description-control" });
    description.setAttr("data-focus-key", `field-${fieldId}-description`);
    description.setAttr("aria-label", `${options.name || options.staticLabel || "Field"} description`);
    description.placeholder = "Description";
    description.value = typeof definition.description === "string" ? definition.description : "";
    description.disabled = options.readOnly;
    description.oninput = () => {
      if (description.value) definition.description = description.value;
      else delete definition.description;
      this.markDirty();
    };

    if (options.onRequiredChange) {
      const required = row.createEl("label", { cls: "mdbase-field-required" });
      const checkbox = required.createEl("input", { type: "checkbox" });
      checkbox.setAttr("data-focus-key", `field-${fieldId}-required`);
      checkbox.checked = options.required === true;
      checkbox.disabled = options.readOnly;
      checkbox.onchange = () => options.onRequiredChange?.(checkbox.checked);
      required.createSpan({ text: "Required" });
    }

    if (options.onRemove || options.onMove) {
      const more = this.ctx.iconButton(row, "more-horizontal", `${label} actions`);
      more.addClass("mdbase-field-menu");
      more.setAttr("data-focus-key", `field-${fieldId}-menu`);
      more.disabled = options.readOnly;
      more.onclick = (event) => {
        const menu = new Menu();
        if (options.onMove) {
          menu.addItem((item) => item.setTitle("Move up").setIcon("arrow-up")
            .setDisabled(!options.canMoveUp).onClick(() => options.onMove?.(-1)));
          menu.addItem((item) => item.setTitle("Move down").setIcon("arrow-down")
            .setDisabled(!options.canMoveDown).onClick(() => options.onMove?.(1)));
        }
        if (options.onRemove) {
          if (options.onMove) menu.addSeparator();
          menu.addItem((item) => {
            item.setTitle("Remove field").setIcon("trash-2").onClick(() => options.onRemove?.());
            item.setWarning(true);
          });
        }
        if (event.detail === 0) {
          const rect = more.getBoundingClientRect();
          menu.showAtPosition({ x: rect.left, y: rect.bottom });
        } else menu.showAtMouseEvent(event);
      };
    }

    const typeName = definitionType(definition);
    this.renderConstraintControls(node, definition, typeName, options, refreshSummary);
    if (typeName === "enum") this.renderEnumFieldDetails(node, definition, options, refreshSummary);
    if (typeName === "link") this.renderLinkFieldDetails(node, definition, options);
    if (typeName === "list") this.renderListFieldDetails(node, definition, options);
    if (typeName === "object") this.renderObjectFieldDetails(node, definition, options);
  }

  /** Bounds, pattern and default for the field's type; the rules mdbase validates records against. */
  private renderConstraintControls(
    node: HTMLElement,
    definition: Record<string, unknown>,
    typeName: string,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
    refreshSummary: () => void,
  ): void {
    const numeric = typeName === "integer" || typeName === "number";
    const controls: Array<[key: string, label: string]> = numeric
      ? [["min", "Minimum"], ["max", "Maximum"]]
      : typeName === "string"
        ? [["min_length", "Min length"], ["max_length", "Max length"]]
        : typeName === "list"
          ? [["min_length", "Min items"], ["max_length", "Max items"]]
          : [];
    const supportsDefault = !["list", "object", "any", "link"].includes(typeName);
    if (!controls.length && typeName !== "string" && !supportsDefault) return;
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-constraints" });
    const fieldLabel = options.name || options.staticLabel || "Field";
    const fieldId = this.fieldId(definition);
    for (const [key, label] of controls) {
      const cell = details.createDiv({ cls: "mdbase-constraint" });
      const labelEl = cell.createEl("label", { text: label });
      const input = cell.createEl("input", { type: "number" });
      input.id = `mdbase-${fieldId}-${key}`;
      labelEl.htmlFor = input.id;
      input.setAttr("data-focus-key", `field-${fieldId}-${key}`);
      input.setAttr("aria-label", `${fieldLabel} ${label.toLowerCase()}`);
      if (key.endsWith("length") || typeName === "integer") input.step = "1";
      if (key.endsWith("length")) input.min = "0";
      input.value = typeof definition[key] === "number" ? String(definition[key]) : "";
      input.disabled = options.readOnly;
      input.oninput = () => {
        const value = input.value.trim() === "" ? NaN : Number(input.value);
        if (Number.isFinite(value)) definition[key] = value;
        else delete definition[key];
        refreshSummary();
        this.markDirty();
      };
    }
    if (typeName === "string") {
      const cell = details.createDiv({ cls: "mdbase-constraint mdbase-constraint-wide" });
      const labelEl = cell.createEl("label", { text: "Pattern" });
      const input = cell.createEl("input", { type: "text" });
      input.id = `mdbase-${fieldId}-pattern`;
      labelEl.htmlFor = input.id;
      input.setAttr("data-focus-key", `field-${fieldId}-pattern`);
      input.setAttr("aria-label", `${fieldLabel} pattern`);
      input.placeholder = "Regular expression";
      input.spellcheck = false;
      input.value = typeof definition.pattern === "string" ? definition.pattern : "";
      input.disabled = options.readOnly;
      input.oninput = () => {
        if (input.value) definition.pattern = input.value;
        else delete definition.pattern;
        refreshSummary();
        this.markDirty();
      };
    }
    if (!supportsDefault) return;
    const cell = details.createDiv({ cls: "mdbase-constraint mdbase-constraint-wide" });
    const labelEl = cell.createEl("label", { text: "Default" });
    const controlId = `mdbase-${fieldId}-default`;
    labelEl.htmlFor = controlId;
    if (typeName === "enum" || typeName === "boolean") {
      const select = cell.createEl("select");
      select.id = controlId;
      select.setAttr("data-focus-key", `field-${fieldId}-default`);
      select.createEl("option", { value: "", text: "None" });
      const choices = typeName === "boolean" ? [true, false] : Array.isArray(definition.values) ? definition.values : [];
      for (const [index, choice] of choices.entries()) select.createEl("option", { value: String(index), text: scalarText(choice) });
      const current = choices.findIndex((choice) => JSON.stringify(choice) === JSON.stringify(definition.default));
      if (definition.default !== undefined && current === -1) {
        select.createEl("option", { value: "missing", text: `${scalarText(definition.default)} · not allowed` });
        select.value = "missing";
      } else select.value = current === -1 ? "" : String(current);
      select.disabled = options.readOnly;
      select.onchange = () => {
        if (select.value === "") delete definition.default;
        else if (select.value !== "missing") definition.default = choices[Number(select.value)];
        refreshSummary();
        this.markDirty();
      };
      return;
    }
    const input = cell.createEl("input", { type: "text" });
    input.id = controlId;
    input.setAttr("data-focus-key", `field-${fieldId}-default`);
    input.setAttr("aria-label", `${fieldLabel} default`);
    input.placeholder = typeName === "date" ? "YYYY-MM-DD" : typeName === "time" ? "HH:MM" : "None";
    input.value = definition.default === undefined ? "" : scalarText(definition.default);
    input.disabled = options.readOnly;
    const error = cell.createDiv({ cls: "mdbase-constraint-error" });
    input.oninput = () => {
      const parsed = parseDefaultValue(input.value, typeName);
      error.textContent = parsed.error ?? "";
      input.toggleClass("is-invalid", Boolean(parsed.error));
      if (parsed.error) return;
      if (parsed.value === undefined) delete definition.default;
      else definition.default = parsed.value;
      refreshSummary();
      this.markDirty();
    };
  }

  private fieldId(definition: Record<string, unknown>): string {
    const existing = this.fieldIds.get(definition);
    if (existing) return existing;
    const id = `field-${this.nextFieldId}`;
    this.nextFieldId += 1;
    this.fieldIds.set(definition, id);
    return id;
  }

  private fieldMatches(name: string, definition: Record<string, unknown>, query: string): boolean {
    const own = `${name} ${definitionType(definition)} ${typeof definition.description === "string" ? definition.description : ""}`
      .toLowerCase();
    if (own.includes(query)) return true;
    if (isRecord(definition.items) && this.fieldMatches("item", definition.items, query)) return true;
    if (isRecord(definition.fields)) {
      return Object.entries(definition.fields).some(([childName, child]) =>
        isRecord(child) && this.fieldMatches(childName, child, query));
    }
    return false;
  }

  /** One row per allowed value, so values can contain commas and keep their YAML types. */
  private renderEnumFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
    refreshSummary: () => void,
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-enum-values" });
    const fieldLabel = options.name || options.staticLabel || "Enum";
    const fieldId = this.fieldId(definition);
    details.createDiv({ cls: "mdbase-field-children-label", text: "Allowed values" });
    const values = Array.isArray(definition.values) ? definition.values : [];
    if (!Array.isArray(definition.values) && !options.readOnly) definition.values = values;
    const list = details.createDiv({ cls: "mdbase-enum-list" });
    list.setAttr("role", "list");
    const mixedTypes = new Set(values.map((value) => typeof value)).size > 1;
    for (const [index, value] of values.entries()) {
      const row = list.createDiv({ cls: "mdbase-enum-row" });
      row.setAttr("role", "listitem");
      const input = row.createEl("input", { type: "text" });
      input.setAttr("data-focus-key", `field-${fieldId}-value-${index}`);
      input.setAttr("aria-label", `${fieldLabel} allowed value ${index + 1}`);
      input.value = scalarText(value);
      input.disabled = options.readOnly;
      input.oninput = () => {
        values[index] = parseEnumValue(input.value, value, values.filter((_, other) => other !== index));
        refreshSummary();
        this.markDirty();
      };
      input.onkeydown = (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        values.splice(index + 1, 0, "");
        this.ctx.pendingFocusKey = `field-${fieldId}-value-${index + 1}`;
        this.markDirty(true);
      };
      // Types only need calling out when a list mixes them, e.g. `1` beside `"1"`.
      if (mixedTypes) row.createSpan({ cls: "mdbase-enum-kind", text: typeof value });
      for (const [icon, label, offset] of [["arrow-up", "Move value up", -1], ["arrow-down", "Move value down", 1]] as const) {
        const move = this.ctx.iconButton(row, icon, `${label}: ${scalarText(value)}`);
        move.disabled = options.readOnly || index + offset < 0 || index + offset >= values.length;
        move.onclick = () => {
          [values[index], values[index + offset]] = [values[index + offset], values[index]];
          this.markDirty(true);
        };
      }
      const remove = this.ctx.iconButton(row, "x", `Remove value ${scalarText(value)}`);
      remove.disabled = options.readOnly;
      remove.onclick = () => {
        values.splice(index, 1);
        this.markDirty(true);
      };
    }
    const add = details.createEl("button", { cls: "mdbase-link-button", text: "Add value" });
    add.disabled = options.readOnly;
    add.onclick = () => {
      values.push("");
      this.ctx.pendingFocusKey = `field-${fieldId}-value-${values.length - 1}`;
      this.markDirty(true);
    };
  }

  private renderLinkFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-options" });
    const fieldId = this.fieldId(definition);
    const targetLabel = details.createEl("label", { text: "Target type" });
    const target = details.createEl("select");
    target.setAttr("data-focus-key", `field-${fieldId}-target`);
    target.setAttr("aria-label", `${options.name || options.staticLabel || "Link"} target type`);
    target.createEl("option", { value: "", text: "Any type" });
    const currentTarget = typeof definition.target === "string" ? definition.target : "";
    for (const type of this.typeEntries()) target.createEl("option", { value: type.name, text: type.name });
    if (currentTarget && !this.typeEntries().some((type) => type.name === currentTarget)) {
      target.createEl("option", { value: currentTarget, text: `${currentTarget} · missing` });
    }
    target.value = currentTarget;
    target.disabled = options.readOnly;
    target.onchange = () => {
      if (target.value) definition.target = target.value;
      else delete definition.target;
      this.markDirty();
    };
    targetLabel.htmlFor = target.id = `mdbase-${fieldId}-target`;
    const existsLabel = details.createEl("label", { cls: "mdbase-field-required" });
    const exists = existsLabel.createEl("input", { type: "checkbox" });
    exists.setAttr("data-focus-key", `field-${fieldId}-exists`);
    exists.checked = definition.validate_exists === true;
    exists.disabled = options.readOnly;
    exists.onchange = () => {
      definition.validate_exists = exists.checked;
      this.markDirty();
    };
    existsLabel.createSpan({ text: "Validate target exists" });
  }

  private renderListFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { readOnly: boolean; depth: number },
  ): void {
    const children = node.createDiv({ cls: "mdbase-field-children" });
    children.createDiv({ cls: "mdbase-field-children-label", text: "List items" });
    const items = isRecord(definition.items) ? definition.items : { type: "any" };
    if (!isRecord(definition.items) && !options.readOnly) definition.items = items;
    this.renderFieldDefinition(children, items, {
      staticLabel: "Item",
      nameLabel: "List item",
      readOnly: options.readOnly,
      depth: options.depth + 1,
    });
  }

  private renderObjectFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { readOnly: boolean; depth: number },
  ): void {
    const children = node.createDiv({ cls: "mdbase-field-children" });
    children.createDiv({ cls: "mdbase-field-children-label", text: "Object fields" });
    const fields = isRecord(definition.fields) ? definition.fields : {};
    if (!isRecord(definition.fields) && !options.readOnly) definition.fields = fields;
    const list = children.createDiv({ cls: "mdbase-nested-fields" });
    const add = children.createEl("button", { cls: "mdbase-link-button", text: "Add nested field" });
    add.disabled = options.readOnly;
    add.onclick = () => {
      const name = nextNestedFieldName(fields);
      setOwnField(fields, name, { type: "string" });
      this.expandedFields.add(this.fieldId(fields[name] as Record<string, unknown>));
      this.markDirty(true);
    };
    const entries = Object.entries(fields).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: "No nested fields." });
      return;
    }
    for (const [position, [initialName, childDefinition]] of entries.entries()) {
      let currentName = initialName;
      this.renderFieldDefinition(list, childDefinition, {
        name: currentName,
        nameLabel: `${currentName} nested field name`,
        onNameCommit: (value, input) => {
          const nextName = value.trim();
          if (!nextName) {
            new Notice("Nested field name is required.");
            input.value = currentName;
            return;
          }
          if (
            nextName !== currentName
            && Object.prototype.hasOwnProperty.call(fields, nextName)
          ) {
            new Notice(`Nested field already exists: ${nextName}`);
            input.value = currentName;
            return;
          }
          if (nextName === currentName) return;
          delete fields[currentName];
          setOwnField(fields, nextName, childDefinition);
          currentName = nextName;
          this.markDirty();
        },
        required: childDefinition.required === true,
        onRequiredChange: (value) => {
          childDefinition.required = value;
          this.markDirty();
        },
        onRemove: () => {
          delete fields[currentName];
          this.markDirty(true);
        },
        onMove: (offset) => {
          const keys = Object.keys(fields);
          const from = keys.indexOf(currentName);
          const to = from + offset;
          if (from === -1 || to < 0 || to >= keys.length) return;
          [keys[from], keys[to]] = [keys[to], keys[from]];
          const ordered = keys.map((key) => [key, fields[key]] as const);
          for (const key of keys) delete fields[key];
          for (const [key, value] of ordered) if (isRecord(value)) setOwnField(fields, key, value);
          this.pendingFieldReveal = this.fieldId(childDefinition);
          this.markDirty(true);
        },
        canMoveUp: position > 0,
        canMoveDown: position < entries.length - 1,
        readOnly: options.readOnly,
        depth: options.depth + 1,
      });
    }
  }

  private renderYamlEditor(container: HTMLElement, readOnly: boolean): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-yaml-section" });
    // Problems sit above the editor so they are visible without scrolling past a long type.
    this.fillYamlProblems(section.createDiv({ cls: "mdbase-yaml-problems" }));
    const editor = this.ensureYamlEditor(readOnly);
    if (editor) {
      section.appendChild(editor.dom);
    } else {
      const textarea = section.createEl("textarea", { cls: "mdbase-yaml-editor" });
      textarea.setAttr("aria-label", "Type definition YAML");
      textarea.setAttr("data-focus-key", "yaml-editor");
      textarea.value = this.yamlDraft;
      textarea.disabled = readOnly;
      textarea.spellcheck = false;
      textarea.oninput = () => this.onYamlInput(textarea.value);
    }
  }

  /** One CodeMirror instance per open type, re-attached on every render so history and cursor survive. */
  private ensureYamlEditor(readOnly: boolean): YamlSourceEditor | null {
    try {
      if (!this.yamlEditor) {
        this.yamlEditor = new YamlSourceEditor({
          doc: this.yamlDraft,
          readOnly,
          labelledBy: "mdbase-mode-yaml",
          onChange: (doc) => this.onYamlInput(doc),
        });
      } else {
        this.yamlEditor.setValue(this.yamlDraft);
        this.yamlEditor.setReadOnly(readOnly);
      }
      this.yamlEditor.setProblems(this.yamlProblems());
      return this.yamlEditor;
    } catch (error) {
      // CodeMirror is supplied by Obsidian; a plain textarea keeps YAML editable without it.
      console.error("mdbase: YAML editor unavailable", error);
      this.yamlEditor = null;
      return null;
    }
  }

  private onYamlInput(value: string): void {
    this.yamlDraft = value;
    this.markDirty(false);
    if (this.yamlProblemTimer !== null) window.clearTimeout(this.yamlProblemTimer);
    this.yamlProblemTimer = window.setTimeout(() => {
      this.yamlProblemTimer = null;
      const problems = this.yamlProblems();
      this.yamlEditor?.setProblems(problems);
      const list = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-yaml-problems");
      if (list) {
        list.empty();
        this.fillYamlProblems(list, problems);
      }
    }, 250);
  }

  private fillYamlProblems(container: HTMLElement, problems = this.yamlProblems()): void {
    if (!this.dirty || !problems.length) return;
    for (const problem of problems.slice(0, 20)) {
      const row = container.createEl("button", { cls: "mdbase-yaml-problem" });
      row.setAttr("data-severity", problem.severity);
      row.createSpan({ cls: "mdbase-yaml-problem-line-number", text: problem.line ? `Line ${problem.line}` : "Type" });
      row.createSpan({ text: problem.message });
      row.disabled = problem.line === null;
      if (problem.line !== null) {
        const line = problem.line;
        row.onclick = () => this.yamlEditor?.revealLine(line);
      }
    }
  }

  /** Keep the current draft (if any) so another type can be opened without losing work. */
  private async leaveCurrentType(): Promise<void> {
    if (this.dirty) await this.flushTypeDraft();
    this.yamlEditor?.destroy();
    this.yamlEditor = null;
    this.impact = null;
    this.showAllMatches = false;
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
    this.yamlDraft = canRestore && draft.yamlDraft !== undefined
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
    this.scheduleImpact(0);
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
    this.yamlDraft = draft?.yamlDraft
      ?? "";
    this.dirty = true;
    if (draft && !this.sessionDrafts.has("__new__")) this.ctx.message = "Recovered an unsaved new type.";
    this.editorMode = draft?.editorMode ?? "design";
    this.scheduleImpact(0);
    this.ctx.render();
  }

  private switchEditorMode(mode: EditorMode): void {
    if (!this.model || mode === this.editorMode) return;
    if (mode === "yaml") {
      try {
        this.yamlDraft = `${formatMarkdown(frontmatterFromReadableModel(this.model), this.model.body)}\n`;
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        return;
      }
    } else if (!this.readYamlDraftIntoModel()) {
      return;
    }
    this.editorMode = mode;
    if (mode === "design") {
      this.yamlEditor?.destroy();
      this.yamlEditor = null;
    }
    this.scheduleImpact(0);
    this.ctx.render();
  }

  private modelFromYamlDraft(): { model: TypeEditorModel } | { error: string; line?: number | null } {
    const parsed = parseFrontmatter(this.yamlDraft);
    if (!parsed.hasFrontmatter) return { error: "Type YAML must start with a --- frontmatter block.", line: 1 };
    // Parser messages append a code excerpt; the first line carries the meaning.
    if (parsed.error) {
      // The row shows the editor's line number; the parser's own position counts from the frontmatter.
      const message = parsed.error.split("\n")[0].replace(/:$/, "").replace(/ at line \d+, column \d+$/, "");
      return { error: `Invalid YAML: ${message}`, line: yamlErrorLine(parsed.error) };
    }
    if (parsed.frontmatter.kind !== "mdbase.type") {
      return { error: "Canonical v0.3 type YAML requires kind: mdbase.type.", line: yamlKeyLine(this.yamlDraft, "kind") ?? 2 };
    }
    try {
      const model = typeModelFromDocument(parsed.frontmatter, parsed.body, this.model?.name || "type");
      if (this.model?.sourceRevision) model.sourceRevision = this.model.sourceRevision;
      return { model };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), line: null };
    }
  }

  /** Syntax and type problems in the YAML draft, located by line where possible. */
  private yamlProblems(): YamlProblem[] {
    const result = this.modelFromYamlDraft();
    if ("error" in result) return [{ line: result.line ?? null, message: result.error, severity: "error" }];
    return validateTypeDraft(result.model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.ctx.schema?.contracts.values(),
    }).map((diagnostic) => {
      const key = diagnostic.path.startsWith("fields.")
        ? diagnostic.path.slice("fields.".length).split(/[.[]/)[0]
        : diagnostic.path === "identity.displayNameKey" ? "name_field" : diagnostic.path.split(".").pop() ?? "";
      return {
        line: yamlKeyLine(this.yamlDraft, key),
        message: diagnostic.message,
        severity: diagnostic.severity === "error" ? "error" : "warning",
      };
    });
  }

  private readYamlDraftIntoModel(): boolean {
    const result = this.modelFromYamlDraft();
    if ("error" in result) {
      new Notice(result.error);
      if (result.line) this.yamlEditor?.revealLine(result.line);
      return false;
    }
    this.model = result.model;
    return true;
  }

  async saveCurrentType(): Promise<void> {
    if (!this.model || this.model.specProfile !== "v0.3" || this.model.readOnlyReason) return;
    if (this.editorMode === "yaml" && !this.readYamlDraftIntoModel()) return;
    const diagnostics = validateTypeDraft(this.model, {
      knownTypes: this.typeEntries().map((type) => type.name),
      contracts: this.ctx.schema?.contracts.values(),
    });
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
    const fresh = await this.computeImpact();
    if (fresh !== undefined) this.impact = fresh;
    const failingNotes = this.impact && !("error" in this.impact)
      ? this.impact.impact.failing.filter((record) => record.isNew).map((record) => record.path)
      : [];
    if (highImpact.length || failingNotes.length) {
      const changes = highImpact.length
        ? highImpact
        : describeTypeChanges(this.originalModel, this.model).filter((change) => change.risk !== "safe");
      const confirmed = await new TypeChangeConfirmationModal(this.ctx.app).confirm(changes, failingNotes);
      if (!confirmed) return;
    }
    const model = this.model;
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
    this.scheduleImpact();
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
      if (this.ctx.host.loadTypeDraft(this.selectedPath)) await this.ctx.host.clearTypeDraft(this.selectedPath);
      return;
    }
    this.sessionDrafts.add(this.selectedPath ?? "__new__");
    const draft: StoredTypeDraft = {
      version: 1,
      path: this.selectedPath,
      sourceRevision: this.originalModel?.sourceRevision ?? null,
      model: clone(this.model),
      editorMode: this.editorMode,
      yamlDraft: this.editorMode === "yaml" ? this.yamlDraft : undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.ctx.host.saveTypeDraft(draft);
  }

  private async discardCurrentType(): Promise<void> {
    const path = this.selectedPath;
    await this.ctx.host.clearTypeDraft(path);
    if (path) {
      const model = await this.ctx.host.loadTypeModel(path);
      this.model = model;
      this.originalModel = clone(model);
      this.yamlDraft = `${formatMarkdown(frontmatterFromReadableModel(model), model.body)}\n`;
      this.dirty = false;
    } else {
      this.model = null;
      this.originalModel = null;
      this.yamlDraft = "";
      this.dirty = false;
    }
    this.ctx.message = "Unsaved changes discarded.";
    this.ctx.render();
  }

}

function frontmatterFromReadableModel(model: TypeEditorModel): Record<string, unknown> {
  if (model.specProfile === "v0.3" && !model.readOnlyReason) return frontmatterFromTypeModel(model);
  return clone(model.originalFrontmatter ?? {
    name: model.name,
    fields: Object.fromEntries(model.fields.map((field) => [field.name, field.definition])),
  });
}
