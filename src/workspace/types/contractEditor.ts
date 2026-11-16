import { Notice } from "obsidian";
import type { CollectionContractDescriptor, JsonObject } from "../../contractTypes";
import type { TypeEditorModel } from "../../typeEditorTypes";
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
} from "../../typeContracts";
import { isRecord, type WorkspaceContext } from "../shared";
import { addChevron, typesDisclosure } from "./disclosure";

/**
 * The Applications section of the design form: the contracts a type implements,
 * how its fields map onto each contract, and each contract's settings.
 */
export function renderContractEditor(
  ctx: WorkspaceContext,
  container: HTMLElement,
  model: TypeEditorModel,
  readOnly: boolean,
  markDirty: (render?: boolean) => void,
): void {
  const section = typesDisclosure(ctx, container, "type-applications", "Applications");
  section.addClass("mdbase-contracts-section");
  section.id = "mdbase-section-applications";

  const contracts = [...(ctx.schema?.contracts.values() ?? [])];
  const implemented = new Set(model.implementations.map((implementation) => `${implementation.contract}@${implementation.version}`));
  const available = contracts.filter((contract) => !implemented.has(contractKey(contract)));

  if (!contracts.length) {
    section.createDiv({
      cls: "mdbase-contract-empty",
      text: "No app formats installed. Ready-made types add them.",
    });
  }

  for (const implementation of model.implementations) {
    const contract = contracts.find((candidate) =>
      candidate.id === implementation.contract && candidate.version === implementation.version);
    renderContractImplementation(section, model, implementation, contract, readOnly, markDirty);
  }

  if (available.length) {
    const add = section.createDiv({ cls: "mdbase-contract-add" });
    const label = add.createEl("label", { text: "App format" });
    const select = add.createEl("select");
    label.htmlFor = select.id = `mdbase-contract-${Math.random().toString(36).slice(2)}`;
    for (const contract of available) {
      select.createEl("option", { value: contractKey(contract), text: `${contract.id} · ${contract.version}` });
    }
    const button = add.createEl("button", { text: "Add format" });
    button.disabled = readOnly;
    button.onclick = () => {
      const selected = available.find((candidate) => contractKey(candidate) === select.value);
      if (!selected) return;
      try {
        addImplementation(model, selected);
        markDirty(true);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    };
  }
}

function renderContractImplementation(
  container: HTMLElement,
  model: TypeEditorModel,
  implementation: TypeEditorModel["implementations"][number],
  contract: CollectionContractDescriptor | undefined,
  readOnly: boolean,
  markDirty: (render?: boolean) => void,
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
    markDirty(true);
  };

  if (!contract) {
    article.createDiv({
      cls: "mdbase-contract-unavailable",
      text: "This app format isn't installed in the collection. Install it again or remove it before saving.",
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
    text: `${requiredMapped} of ${required.length} required · ${mapped.length} of ${fields.length} mapped`,
  });
  addChevron(summary);
  const mappingList = details.createDiv({ cls: "mdbase-contract-mapping-list" });
  if (!fields.length) {
    mappingList.createDiv({
      cls: "mdbase-contract-unavailable",
      text: "This format's fields can only be mapped in YAML.",
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
      markDirty(true);
    };
    const status = row.createDiv({ cls: "mdbase-contract-mapping-status" });
    status.createEl("strong", { text: assessment.label });
    status.createEl("small", { text: assessment.message });
  }

  if (contract.binding_schema) {
    const settings = article.createEl("details", { cls: "mdbase-contract-settings" });
    settings.open = Boolean(implementation.binding);
    const settingsSummary = settings.createEl("summary");
    settingsSummary.createSpan({ text: "Settings" });
    settingsSummary.createSpan({
      cls: "mdbase-contract-summary",
      text: implementation.binding ? "Configured" : "Optional",
    });
    addChevron(settingsSummary);
    const body = settings.createDiv({ cls: "mdbase-contract-settings-body" });
    body.createEl("p", {
      cls: "mdbase-form-description",
      text: "How apps that read this format treat this type.",
    });
    if (!implementation.binding) {
      const configure = body.createEl("button", { text: "Configure settings" });
      configure.disabled = readOnly;
      configure.onclick = () => {
        const initial = schemaInitialValue(contract.binding_schema);
        if (!isRecord(initial)) return;
        setBinding(implementation, initial);
        markDirty(true);
      };
    } else {
      renderContractSchemaValue(body, contract.binding_schema, implementation.binding, (value) => {
        if (!isRecord(value)) return;
        setBinding(implementation, value);
        markDirty();
      }, "Settings", readOnly);
    }
  }
}

function renderContractSchemaValue(
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
      row.createEl("label", { text: `${name}${required.has(name) ? " (required)" : ""}` });
      if (description) row.createEl("small", { text: description });
      renderContractSchemaControl(row, childSchema, object[name], (next) => {
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
  renderContractSchemaControl(container, schema, value, onChange, label, readOnly);
}

function renderContractSchemaControl(
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
    const list: unknown[] = Array.isArray(value) ? value : [];
    const listEl = container.createDiv({ cls: "mdbase-contract-schema-array" });
    for (const [index, item] of list.entries()) {
      const itemEl = listEl.createDiv({ cls: "mdbase-contract-schema-array-item" });
      itemEl.createSpan({ text: `${index + 1}.` });
      renderContractSchemaControl(itemEl, itemsSchema, item, (next) => {
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
    renderContractSchemaValue(container, schema, value, onChange, label, readOnly);
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
