import { t } from "@lingui/core/macro";
import { Menu, Notice, setIcon } from "obsidian";
import type { MdbaseTypeDef } from "../../mdbaseCore";
import type { TypeEditorField, TypeEditorModel } from "../../typeEditorTypes";
import { fieldConstraintSummary, parseDefaultValue, parseEnumValue, scalarText } from "../../fieldSummary";
import {
  FIELD_TYPES,
  definitionType,
  fieldTypeLabel,
  isRecord,
  nextNestedFieldName,
  setOwnField,
  type WorkspaceContext,
} from "../shared";

/**
 * The Fields section of the design form: one collapsible row per field, nested
 * list items and object fields, each field's rules, and the field filter. Keeps
 * which fields are expanded across renders.
 */
export class FieldEditor {
  /** The field filter text. */
  query = "";
  private pendingFieldReveal: string | null = null;
  private readonly expandedFields = new Set<string>();
  private readonly fieldIds = new WeakMap<Record<string, unknown>, string>();
  private nextFieldId = 1;

  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly deps: {
      /** The type being edited. */
      model(): TypeEditorModel | null;
      markDirty(render?: boolean): void;
      typeEntries(): MdbaseTypeDef[];
    },
  ) {}

  /** Scroll to and highlight a field revealed before the render. */
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

  /** Expand a field (a dotted or `[]` path) and its parents; false when its top-level field is missing. */
  reveal(model: TypeEditorModel, fieldPath: string): boolean {
    const segments = fieldPath.split(".").filter(Boolean);
    const top = segments.shift()?.replace(/\[\]$/g, "") ?? "";
    let definition = model.fields.find((field) => field.name === top)?.definition;
    if (!definition) return false;
    this.query = "";
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
    return true;
  }

  /** The Fields section: the field tree with its add, collapse and filter controls. */
  renderSection(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const fields = container.createEl("section", { cls: "mdbase-editor-section" });
    fields.id = "mdbase-section-fields";
    const fieldsHeader = fields.createDiv({ cls: "mdbase-section-header" });
    fieldsHeader.createEl("h3", { text: t`Fields` });
    const headerActions = fieldsHeader.createDiv({ cls: "mdbase-section-actions" });
    if (this.expandedFields.size) {
      const collapse = this.ctx.iconButton(headerActions, "fold-vertical", t`Collapse all fields`);
      collapse.onclick = () => {
        this.expandedFields.clear();
        this.ctx.render();
      };
    }
    const addField = this.ctx.iconButton(headerActions, "plus", t`Add field`);
    addField.disabled = readOnly;
    addField.onclick = () => {
      const definition: Record<string, unknown> = { type: "string" };
      model.fields.push({ name: "", definition });
      this.expandedFields.add(this.fieldId(definition));
      this.deps.markDirty(true);
    };
    if (model.fields.length > 6 || this.query) {
      const fieldToolbar = fields.createDiv({ cls: "mdbase-field-toolbar" });
      const fieldActions = fieldToolbar.createDiv({ cls: "mdbase-field-toolbar-actions" });
      const fieldSearch = fieldActions.createEl("input", { type: "search" });
      fieldSearch.placeholder = t`Filter fields`;
      fieldSearch.setAttr("aria-label", t`Filter fields`);
      fieldSearch.setAttr("data-focus-key", "field-search");
      fieldSearch.value = this.query;
      fieldSearch.oninput = () => {
        this.query = fieldSearch.value;
        this.ctx.render();
      };
    }
    const fieldList = fields.createDiv({ cls: "mdbase-fields" });
    const normalizedFieldQuery = this.query.trim().toLowerCase();
    const visibleFields = model.fields.filter((field) =>
      !normalizedFieldQuery || this.fieldMatches(field.name, field.definition, normalizedFieldQuery));
    for (const field of visibleFields) {
      const index = model.fields.indexOf(field);
      this.renderFieldRow(fieldList, field, index, readOnly);
    }
    if (!visibleFields.length) {
      fieldList.createDiv({
        cls: "mdbase-empty-list",
        text: model.fields.length ? t`No fields match this filter.` : t`No fields declared.`,
      });
    }
  }

  private renderFieldRow(container: HTMLElement, field: TypeEditorField, index: number, readOnly: boolean): void {
    const fields = this.deps.model()?.fields ?? [];
    const fieldNumber = index + 1;
    this.renderFieldDefinition(container, field.definition, {
      name: field.name,
      nameLabel: t`Field ${fieldNumber} name`,
      onNameInput: (value) => {
        field.name = value;
        this.deps.markDirty();
      },
      required: field.definition.required === true,
      onRequiredChange: (value) => {
        field.definition.required = value;
        this.deps.markDirty();
      },
      onRemove: () => {
        this.deps.model()?.fields.splice(index, 1);
        this.deps.markDirty(true);
      },
      onMove: (offset) => {
        const target = index + offset;
        if (target < 0 || target >= fields.length) return;
        [fields[index], fields[target]] = [fields[target], fields[index]];
        this.pendingFieldReveal = this.fieldId(field.definition);
        this.deps.markDirty(true);
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
    const queryMatch = Boolean(this.query.trim())
      && this.fieldMatches(
        options.name ?? options.staticLabel ?? "",
        definition,
        this.query.trim().toLowerCase(),
      );
    node.open = this.expandedFields.has(fieldId) || queryMatch;
    node.ontoggle = () => {
      if (node.open) this.expandedFields.add(fieldId);
      else this.expandedFields.delete(fieldId);
    };
    const label = options.name || options.staticLabel || t`Unnamed field`;
    const summary = node.createEl("summary", { cls: "mdbase-field-summary" });
    summary.setAttr("data-focus-key", `field-${fieldId}-summary`);
    const chevron = summary.createSpan({ cls: "mdbase-field-chevron" });
    chevron.setAttr("aria-hidden", "true");
    setIcon(chevron, "chevron-right");
    summary.createSpan({ cls: "mdbase-field-summary-name", text: label });
    const fixed = "const" in definition;
    summary.createSpan({
      cls: "mdbase-field-summary-type",
      text: fixed && definitionType(definition) === "any" ? t`Fixed value` : fieldTypeLabel(definitionType(definition)),
    });
    const rules = summary.createSpan({ cls: "mdbase-field-summary-rules" });
    const refreshSummary = () => {
      rules.textContent = fieldConstraintSummary(definition).join(" · ");
    };
    refreshSummary();
    if (options.required) summary.createSpan({ cls: "mdbase-field-summary-rule", text: t({ message: "Required", context: "field constraint" }) });
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
      const nameCell = row.createDiv({ cls: "mdbase-field-cell mdbase-field-name-cell" });
      const nameLabel = nameCell.createEl("label", { text: t({ message: "Name", context: "field property label" }) });
      const name = nameCell.createEl("input", { type: "text", cls: "mdbase-field-name-control" });
      name.id = `mdbase-${fieldId}-name`;
      nameLabel.htmlFor = name.id;
      name.setAttr("data-focus-key", `field-${fieldId}-name`);
      name.setAttr("aria-label", options.nameLabel);
      name.value = options.name ?? "";
      name.disabled = options.readOnly;
      if (options.onNameInput) name.oninput = () => options.onNameInput?.(name.value);
      if (options.onNameCommit) name.onchange = () => options.onNameCommit?.(name.value, name);
    }

    const typeCell = row.createDiv({ cls: "mdbase-field-cell mdbase-field-type-cell" });
    const typeLabel = typeCell.createEl("label", { text: t({ message: "Type", context: "field property label" }) });
    const type = typeCell.createEl("select", { cls: "mdbase-field-type-control" });
    type.id = `mdbase-${fieldId}-type`;
    typeLabel.htmlFor = type.id;
    type.setAttr("data-focus-key", `field-${fieldId}-type`);
    const fieldLabel = options.name || options.staticLabel || t`Field`;
    type.setAttr("aria-label", t`${fieldLabel} type`);
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
      this.deps.markDirty(true);
    };

    const descriptionCell = row.createDiv({ cls: "mdbase-field-cell mdbase-field-description-cell" });
    const descriptionLabel = descriptionCell.createEl("label", { text: t`Description` });
    const description = descriptionCell.createEl("input", { type: "text", cls: "mdbase-field-description-control" });
    description.id = `mdbase-${fieldId}-description`;
    descriptionLabel.htmlFor = description.id;
    description.setAttr("data-focus-key", `field-${fieldId}-description`);
    description.setAttr("aria-label", t`${fieldLabel} description`);
    description.value = typeof definition.description === "string" ? definition.description : "";
    description.disabled = options.readOnly;
    description.oninput = () => {
      if (description.value) definition.description = description.value;
      else delete definition.description;
      this.deps.markDirty();
    };

    if (fixed) {
      const value = scalarText(definition.const);
      row.createDiv({
        cls: "mdbase-field-fixed mdbase-form-description",
        text: t`Always ${value}. Change the fixed value in YAML.`,
      });
    }

    if (options.onRequiredChange) {
      const required = row.createEl("label", { cls: "mdbase-field-required" });
      const checkbox = required.createEl("input", { type: "checkbox" });
      checkbox.setAttr("data-focus-key", `field-${fieldId}-required`);
      checkbox.checked = options.required === true;
      checkbox.disabled = options.readOnly;
      checkbox.onchange = () => options.onRequiredChange?.(checkbox.checked);
      required.createSpan({ text: t({ message: "Required", context: "field constraint" }) });
    }

    if (options.onRemove || options.onMove) {
      const more = this.ctx.iconButton(row, "more-horizontal", t`${label} actions`);
      more.addClass("mdbase-field-menu");
      more.setAttr("data-focus-key", `field-${fieldId}-menu`);
      more.disabled = options.readOnly;
      more.onclick = (event) => {
        const menu = new Menu();
        if (options.onMove) {
          menu.addItem((item) => item.setTitle(t`Move up`).setIcon("arrow-up")
            .setDisabled(!options.canMoveUp).onClick(() => options.onMove?.(-1)));
          menu.addItem((item) => item.setTitle(t`Move down`).setIcon("arrow-down")
            .setDisabled(!options.canMoveDown).onClick(() => options.onMove?.(1)));
        }
        if (options.onRemove) {
          if (options.onMove) menu.addSeparator();
          menu.addItem((item) => {
            item.setTitle(t`Remove field`).setIcon("trash-2").onClick(() => options.onRemove?.());
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
      ? [["min", t`Minimum`], ["max", t`Maximum`]]
      : typeName === "string"
        ? [["min_length", t`Min length`], ["max_length", t`Max length`]]
        : typeName === "list"
          ? [["min_length", t`Min items`], ["max_length", t`Max items`]]
          : [];
    const supportsDefault = !["list", "object", "any", "link"].includes(typeName);
    if (!controls.length && typeName !== "string" && !supportsDefault) return;
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-constraints" });
    const fieldLabel = options.name || options.staticLabel || t`Field`;
    const fieldId = this.fieldId(definition);
    for (const [key, label] of controls) {
      const cell = details.createDiv({ cls: "mdbase-constraint" });
      const labelEl = cell.createEl("label", { text: label });
      const input = cell.createEl("input", { type: "number" });
      input.id = `mdbase-${fieldId}-${key}`;
      labelEl.htmlFor = input.id;
      input.setAttr("data-focus-key", `field-${fieldId}-${key}`);
      const constraintLabel = label.toLowerCase();
      input.setAttr("aria-label", t`${fieldLabel} ${constraintLabel}`);
      if (key.endsWith("length") || typeName === "integer") input.step = "1";
      if (key.endsWith("length")) input.min = "0";
      input.value = typeof definition[key] === "number" ? String(definition[key]) : "";
      input.disabled = options.readOnly;
      input.oninput = () => {
        const value = input.value.trim() === "" ? NaN : Number(input.value);
        if (Number.isFinite(value)) definition[key] = value;
        else delete definition[key];
        refreshSummary();
        this.deps.markDirty();
      };
    }
    if (typeName === "string") {
      const cell = details.createDiv({ cls: "mdbase-constraint mdbase-constraint-wide" });
      const labelEl = cell.createEl("label", { text: t`Pattern` });
      const input = cell.createEl("input", { type: "text" });
      input.id = `mdbase-${fieldId}-pattern`;
      labelEl.htmlFor = input.id;
      input.setAttr("data-focus-key", `field-${fieldId}-pattern`);
      input.setAttr("aria-label", t`${fieldLabel} pattern`);
      input.placeholder = t`Regular expression`;
      input.spellcheck = false;
      input.value = typeof definition.pattern === "string" ? definition.pattern : "";
      input.disabled = options.readOnly;
      input.oninput = () => {
        if (input.value) definition.pattern = input.value;
        else delete definition.pattern;
        refreshSummary();
        this.deps.markDirty();
      };
    }
    if (!supportsDefault) return;
    const cell = details.createDiv({ cls: "mdbase-constraint mdbase-constraint-wide" });
    const labelEl = cell.createEl("label", { text: t`Default` });
    const controlId = `mdbase-${fieldId}-default`;
    labelEl.htmlFor = controlId;
    if (typeName === "enum" || typeName === "boolean") {
      const select = cell.createEl("select");
      select.id = controlId;
      select.setAttr("data-focus-key", `field-${fieldId}-default`);
      select.createEl("option", { value: "", text: t`None` });
      const choices = typeName === "boolean" ? [true, false] : Array.isArray(definition.values) ? definition.values : [];
      for (const [index, choice] of choices.entries()) select.createEl("option", { value: String(index), text: scalarText(choice) });
      const current = choices.findIndex((choice) => JSON.stringify(choice) === JSON.stringify(definition.default));
      if (definition.default !== undefined && current === -1) {
        const defaultValue = scalarText(definition.default);
        select.createEl("option", { value: "missing", text: t`${defaultValue} · not allowed` });
        select.value = "missing";
      } else select.value = current === -1 ? "" : String(current);
      select.disabled = options.readOnly;
      select.onchange = () => {
        if (select.value === "") delete definition.default;
        else if (select.value !== "missing") definition.default = choices[Number(select.value)];
        refreshSummary();
        this.deps.markDirty();
      };
      return;
    }
    const input = cell.createEl("input", { type: "text" });
    input.id = controlId;
    input.setAttr("data-focus-key", `field-${fieldId}-default`);
    input.setAttr("aria-label", t`${fieldLabel} default`);
    const dateFormat = "YYYY-MM-DD";
    const timeFormat = "HH:MM";
    input.placeholder = typeName === "date" ? dateFormat : typeName === "time" ? timeFormat : t`None`;
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
      this.deps.markDirty();
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
    const fieldLabel = options.name || options.staticLabel || t`Choice`;
    const fieldId = this.fieldId(definition);
    details.createDiv({ cls: "mdbase-field-children-label", text: t`Allowed values` });
    const values: unknown[] = Array.isArray(definition.values) ? definition.values : [];
    if (!Array.isArray(definition.values) && !options.readOnly) definition.values = values;
    const list = details.createDiv({ cls: "mdbase-enum-list" });
    list.setAttr("role", "list");
    const mixedTypes = new Set(values.map((value) => typeof value)).size > 1;
    for (const [index, value] of values.entries()) {
      const row = list.createDiv({ cls: "mdbase-enum-row" });
      row.setAttr("role", "listitem");
      const input = row.createEl("input", { type: "text" });
      input.setAttr("data-focus-key", `field-${fieldId}-value-${index}`);
      const valueNumber = index + 1;
      input.setAttr("aria-label", t`${fieldLabel} allowed value ${valueNumber}`);
      input.value = scalarText(value);
      input.disabled = options.readOnly;
      input.oninput = () => {
        values[index] = parseEnumValue(input.value, value, values.filter((_, other) => other !== index));
        refreshSummary();
        this.deps.markDirty();
      };
      input.onkeydown = (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        values.splice(index + 1, 0, "");
        this.ctx.pendingFocusKey = `field-${fieldId}-value-${index + 1}`;
        this.deps.markDirty(true);
      };
      // Types only need calling out when a list mixes them, e.g. `1` beside `"1"`.
      if (mixedTypes) {
        const kind = typeof value;
        row.createSpan({ cls: "mdbase-enum-kind", text: kind === "string" ? t`string` : kind === "number" ? t`number` : kind === "boolean" ? t`boolean` : kind === "object" ? t`object` : kind });
      }
      for (const [icon, label, offset] of [["arrow-up", t`Move value up`, -1], ["arrow-down", t`Move value down`, 1]] as const) {
        const valueText = scalarText(value);
        const move = this.ctx.iconButton(row, icon, t`${label}: ${valueText}`);
        move.disabled = options.readOnly || index + offset < 0 || index + offset >= values.length;
        move.onclick = () => {
          [values[index], values[index + offset]] = [values[index + offset], values[index]];
          this.deps.markDirty(true);
        };
      }
      const valueText = scalarText(value);
      const remove = this.ctx.iconButton(row, "x", t`Remove value ${valueText}`);
      remove.disabled = options.readOnly;
      remove.onclick = () => {
        values.splice(index, 1);
        this.deps.markDirty(true);
      };
    }
    const add = details.createEl("button", { cls: "mdbase-link-button", text: t`Add value` });
    add.disabled = options.readOnly;
    add.onclick = () => {
      values.push("");
      this.ctx.pendingFocusKey = `field-${fieldId}-value-${values.length - 1}`;
      this.deps.markDirty(true);
    };
  }

  private renderLinkFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-options" });
    const fieldId = this.fieldId(definition);
    const targetLabel = details.createEl("label", { text: t`Target type` });
    const target = details.createEl("select");
    target.setAttr("data-focus-key", `field-${fieldId}-target`);
    const fieldLabel = options.name || options.staticLabel || t`Link`;
    target.setAttr("aria-label", t`${fieldLabel} target type`);
    target.createEl("option", { value: "", text: t`Any type` });
    const currentTarget = typeof definition.target === "string" ? definition.target : "";
    for (const type of this.deps.typeEntries()) target.createEl("option", { value: type.name, text: type.name });
    if (currentTarget && !this.deps.typeEntries().some((type) => type.name === currentTarget)) {
      target.createEl("option", { value: currentTarget, text: t`${currentTarget} · missing` });
    }
    target.value = currentTarget;
    target.disabled = options.readOnly;
    target.onchange = () => {
      if (target.value) definition.target = target.value;
      else delete definition.target;
      this.deps.markDirty();
    };
    targetLabel.htmlFor = target.id = `mdbase-${fieldId}-target`;
    const existsLabel = details.createEl("label", { cls: "mdbase-field-required" });
    const exists = existsLabel.createEl("input", { type: "checkbox" });
    exists.setAttr("data-focus-key", `field-${fieldId}-exists`);
    exists.checked = definition.validate_exists === true;
    exists.disabled = options.readOnly;
    exists.onchange = () => {
      definition.validate_exists = exists.checked;
      this.deps.markDirty();
    };
    existsLabel.createSpan({ text: t`Validate target exists` });
  }

  private renderListFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { readOnly: boolean; depth: number },
  ): void {
    const children = node.createDiv({ cls: "mdbase-field-children" });
    children.createDiv({ cls: "mdbase-field-children-label", text: t`List items` });
    const items = isRecord(definition.items) ? definition.items : { type: "any" };
    if (!isRecord(definition.items) && !options.readOnly) definition.items = items;
    this.renderFieldDefinition(children, items, {
      staticLabel: t`Item`,
      nameLabel: t`List item`,
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
    children.createDiv({ cls: "mdbase-field-children-label", text: t`Object fields` });
    const fields = isRecord(definition.fields) ? definition.fields : {};
    if (!isRecord(definition.fields) && !options.readOnly) definition.fields = fields;
    const list = children.createDiv({ cls: "mdbase-nested-fields" });
    const add = children.createEl("button", { cls: "mdbase-link-button", text: t`Add nested field` });
    add.disabled = options.readOnly;
    add.onclick = () => {
      const name = nextNestedFieldName(fields);
      setOwnField(fields, name, { type: "string" });
      this.expandedFields.add(this.fieldId(fields[name] as Record<string, unknown>));
      this.deps.markDirty(true);
    };
    const entries = Object.entries(fields).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: t`No nested fields.` });
      return;
    }
    for (const [position, [initialName, childDefinition]] of entries.entries()) {
      let currentName = initialName;
      this.renderFieldDefinition(list, childDefinition, {
        name: currentName,
        nameLabel: t`${currentName} nested field name`,
        onNameCommit: (value, input) => {
          const nextName = value.trim();
          if (!nextName) {
            new Notice(t`Nested field name is required.`);
            input.value = currentName;
            return;
          }
          if (
            nextName !== currentName
            && Object.prototype.hasOwnProperty.call(fields, nextName)
          ) {
            new Notice(t`Nested field already exists: ${nextName}`);
            input.value = currentName;
            return;
          }
          if (nextName === currentName) return;
          delete fields[currentName];
          setOwnField(fields, nextName, childDefinition);
          currentName = nextName;
          this.deps.markDirty();
        },
        required: childDefinition.required === true,
        onRequiredChange: (value) => {
          childDefinition.required = value;
          this.deps.markDirty();
        },
        onRemove: () => {
          delete fields[currentName];
          this.deps.markDirty(true);
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
          this.deps.markDirty(true);
        },
        canMoveUp: position > 0,
        canMoveDown: position < entries.length - 1,
        readOnly: options.readOnly,
        depth: options.depth + 1,
      });
    }
  }
}
