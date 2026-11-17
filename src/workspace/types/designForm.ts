import type { MdbaseTypeDef } from "../../mdbaseCore";
import type { TypeEditorModel } from "../../typeEditorTypes";
import { describeTypeChanges, type TypeDraftDiagnostic } from "../../typeDraft";
import { describePathGlob } from "../../fieldSummary";
import { inputRow, type WorkspaceContext } from "../shared";
import { renderContractEditor } from "./contractEditor";
import type { FieldEditor } from "./fieldEditor";
import type { TypeImpact } from "./impact";
import { typesDisclosure } from "./disclosure";

/** What the design form reads from the Types pane. */
export interface DesignFormEnv {
  ctx: WorkspaceContext;
  fields: FieldEditor;
  impact: TypeImpact;
  typeEntries(): MdbaseTypeDef[];
  dirty(): boolean;
  /** The saved type, or null for a new one. */
  originalModel(): TypeEditorModel | null;
  markDirty(render?: boolean): void;
  /** The draft's errors and warnings, as the save bar counts them. */
  diagnostics(model: TypeEditorModel): TypeDraftDiagnostic[];
  /** The Name box lost focus. */
  onNameBlur(): void;
}

/**
 * The Design tab of the type editor: name and description, fields, matching,
 * options, applications, and a review of the unsaved changes.
 */
export function renderDesignForm(container: HTMLElement, model: TypeEditorModel, readOnly: boolean, env: DesignFormEnv): void {
  const { ctx, impact } = env;
  const diagnostics = env.diagnostics(model);
  const identity = container.createEl("section", { cls: "mdbase-editor-section" });
  identity.id = "mdbase-section-identity";
  const name = inputRow(identity, "Name", model.name, (value) => {
    model.name = value;
    env.markDirty();
  }, { focusKey: "name" });
  name.disabled = readOnly;
  const nameError = name.parentElement?.createDiv({ cls: "mdbase-constraint-error mdbase-name-error" });
  nameError?.setAttr("aria-live", "polite");
  const nameRequired = () => {
    if (nameError) nameError.textContent = name.value.trim() ? "" : "Give the type a name.";
  };
  if (diagnostics.some((diagnostic) => /name is required/i.test(diagnostic.message))) nameRequired();
  name.addEventListener("input", () => { if (name.value.trim() && nameError) nameError.textContent = ""; });
  name.addEventListener("blur", () => {
    // Re-renders replace the box; only a real move of focus counts.
    if (!name.isConnected || readOnly) return;
    env.onNameBlur();
    nameRequired();
  });
  const description = inputRow(identity, "Description", model.description, (value) => {
    model.description = value;
    env.markDirty();
  }, { focusKey: "description", multiline: true });
  description.disabled = readOnly;
  const options = typesDisclosure(ctx, container, "type-options", "Options");
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
    env.markDirty();
  };
  display.disabled = readOnly;
  const strictRow = options.createEl("label", { cls: "mdbase-checkbox-row" });
  const strict = strictRow.createEl("input", { type: "checkbox" });
  strict.checked = model.strictMode === true;
  strict.disabled = readOnly;
  strict.onchange = () => {
    model.strictMode = strict.checked;
    env.markDirty();
  };
  strictRow.createSpan({ text: "Reject undeclared fields" });

  const membership = typesDisclosure(ctx, container, "type-matching", impact.matchingLabel());
  membership.id = "mdbase-section-membership";
  impact.fillMatchPreview(membership.createDiv({ cls: "mdbase-match-preview" }));
  // The pattern stays editable as written; plain words lead where they can be worked out.
  const globMeaning = (value: string) => value.trim()
    ? describePathGlob(value) ?? "Notes whose path matches this pattern"
    : "Any folder";
  const glob = inputRow(membership, "Path", model.matchPathGlob, (value) => {
    model.matchPathGlob = value;
    globHint.textContent = globMeaning(value);
    env.markDirty();
  }, { focusKey: "path", description: globMeaning(model.matchPathGlob), placeholder: "Projects/**/*.md" });
  const globHint = glob.parentElement?.querySelector<HTMLElement>(".mdbase-form-description") ?? glob;
  glob.disabled = readOnly;
  const present = inputRow(membership, "Has fields", model.matchFieldsPresent, (value) => {
    model.matchFieldsPresent = value;
    env.markDirty();
  }, { focusKey: "has-fields", description: "Property names, separated by commas." });
  present.disabled = readOnly;
  const where = inputRow(membership, "Field values", model.matchWhere, (value) => {
    model.matchWhere = value;
    env.markDirty();
  }, {
    focusKey: "field-values",
    multiline: true,
    description: "Conditions written in YAML.",
    placeholder: "tags:\n  contains: task",
  });
  where.disabled = readOnly;

  env.fields.renderSection(container, model, readOnly);

  // Keep the common editing surface (name, description, fields) first.
  if (membership.parentElement) container.appendChild(membership.parentElement);
  if (options.parentElement) container.appendChild(options.parentElement);
  const placement = options;
  const path = inputRow(placement, "New note location", model.pathPattern, (value) => {
    model.pathPattern = value;
    env.markDirty();
  }, { focusKey: "new-note-location", placeholder: "Notes/{title}.md" });
  path.disabled = readOnly;

  renderContractEditor(ctx, container, model, readOnly, (render) => env.markDirty(render));

  if (!env.dirty() && !diagnostics.length) return;
  const review = typesDisclosure(ctx, container, "type-review", "Changes", diagnostics.some((item) => item.severity === "error"));
  review.id = "mdbase-section-review";
  if (env.dirty()) impact.fillImpact(review.createDiv({ cls: "mdbase-impact" }));
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
  if (env.dirty()) {
    const list = review.createEl("ul");
    for (const change of describeTypeChanges(env.originalModel(), model)) {
      const item = list.createEl("li", { text: change.summary });
      item.setAttr("data-risk", change.risk);
    }
  }
}
