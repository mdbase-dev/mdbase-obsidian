import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import type { TypeEditorModel } from "./typeEditorTypes";
import { frontmatterFromTypeModel } from "./typeModel";
import {
  assessMapping,
  contractFields,
  contractKey,
  mappingForContractField,
  typeFieldsForModel,
} from "./typeContracts";

export type TypeDraftSeverity = "error" | "warning";
export type TypeChangeRisk = "safe" | "review" | "high";

export interface TypeDraftDiagnostic {
  code: string;
  severity: TypeDraftSeverity;
  path: string;
  message: string;
}

export interface TypeDraftChange {
  code: string;
  risk: TypeChangeRisk;
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable, synchronous source fingerprint suitable for stale-edit detection. */
export function sourceRevision(source: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `source-${source.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

function comparableModel(model: TypeEditorModel): TypeEditorModel {
  const copy = clone(model);
  delete copy.sourceRevision;
  return copy;
}

export function typeModelsEqual(left: TypeEditorModel | null, right: TypeEditorModel | null): boolean {
  if (left === null || right === null) return left === right;
  return JSON.stringify(comparableModel(left)) === JSON.stringify(comparableModel(right));
}

function fieldMap(model: TypeEditorModel): Map<string, TypeEditorModel["fields"][number]> {
  return new Map(model.fields.map((field) => [field.name, field]));
}

function definitionType(definition: Record<string, unknown>): string {
  return typeof definition.type === "string" ? definition.type : "any";
}

function validateDefinition(
  definition: Record<string, unknown>,
  path: string,
  diagnostics: TypeDraftDiagnostic[],
  knownTypes: ReadonlySet<string>,
): void {
  const type = definitionType(definition);
  if (type === "enum" && (!Array.isArray(definition.values) || definition.values.length === 0)) {
    diagnostics.push({
      code: "enum_without_values",
      severity: "warning",
      path,
      message: "Add at least one allowed value, or use String for an unrestricted value.",
    });
  }
  if (type === "enum" && Array.isArray(definition.values)) {
    const keys = definition.values.map((value) => JSON.stringify(value));
    if (new Set(keys).size !== keys.length) {
      diagnostics.push({
        code: "enum_duplicate_values",
        severity: "error",
        path,
        message: "Allowed values must be unique.",
      });
    }
    if (definition.default !== undefined && !keys.includes(JSON.stringify(definition.default))) {
      diagnostics.push({
        code: "default_not_allowed",
        severity: "error",
        path,
        message: "The default is not one of the allowed values.",
      });
    }
  }
  for (const [lower, upper, label] of [["min", "max", "Minimum"], ["min_length", "max_length", "Minimum length"]] as const) {
    const low = definition[lower];
    const high = definition[upper];
    if (typeof low === "number" && typeof high === "number" && low > high) {
      diagnostics.push({
        code: "constraint_range_inverted",
        severity: "error",
        path,
        message: `${label} is greater than the maximum.`,
      });
    }
  }
  if (typeof definition.pattern === "string") {
    try {
      new RegExp(definition.pattern);
    } catch (error) {
      diagnostics.push({
        code: "invalid_pattern",
        severity: "error",
        path,
        message: `The pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (type === "link") {
    const target = typeof definition.target === "string" ? definition.target.trim() : "";
    if (target && target !== "any" && knownTypes.size && !knownTypes.has(target)) {
      diagnostics.push({
        code: "unknown_link_target",
        severity: "error",
        path,
        message: `The target type '${target}' is not installed in this collection.`,
      });
    }
  }
  if (type === "list") {
    if (!isRecord(definition.items)) {
      diagnostics.push({
        code: "list_items_missing",
        severity: "error",
        path,
        message: "Choose the shape of each list item.",
      });
    } else {
      validateDefinition(definition.items, `${path}[]`, diagnostics, knownTypes);
    }
  }
  if (type === "object") {
    if (!isRecord(definition.fields)) {
      diagnostics.push({
        code: "object_fields_missing",
        severity: "error",
        path,
        message: "Add an object field or change this field's type.",
      });
      return;
    }
    const seen = new Set<string>();
    for (const [name, child] of Object.entries(definition.fields)) {
      const childPath = `${path}.${name || "unnamed"}`;
      if (!name.trim()) {
        diagnostics.push({
          code: "field_name_required",
          severity: "error",
          path: childPath,
          message: "Every nested field needs a name.",
        });
      } else if (seen.has(name)) {
        diagnostics.push({
          code: "duplicate_field_name",
          severity: "error",
          path: childPath,
          message: `The nested field '${name}' is declared more than once.`,
        });
      }
      seen.add(name);
      if (isRecord(child)) validateDefinition(child, childPath, diagnostics, knownTypes);
    }
  }
}

export function validateTypeDraft(
  model: TypeEditorModel,
  options: {
    knownTypes?: Iterable<string>;
    contracts?: Iterable<CollectionContractDescriptor>;
  } = {},
): TypeDraftDiagnostic[] {
  const diagnostics: TypeDraftDiagnostic[] = [];
  const knownTypes = new Set(options.knownTypes ?? []);
  try {
    frontmatterFromTypeModel(model);
  } catch (error) {
    diagnostics.push({
      code: "invalid_type_document",
      severity: "error",
      path: "type",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const seen = new Set<string>();
  for (const field of model.fields) {
    const name = field.name.trim();
    const path = `fields.${name || "unnamed"}`;
    if (!name) {
      diagnostics.push({
        code: "field_name_required",
        severity: "error",
        path,
        message: "Every field needs a name.",
      });
    } else if (seen.has(name)) {
      diagnostics.push({
        code: "duplicate_field_name",
        severity: "error",
        path,
        message: `The field '${name}' is declared more than once.`,
      });
    }
    seen.add(name);
    validateDefinition(field.definition, path, diagnostics, knownTypes);
  }

  if (model.displayNameKey.trim() && !seen.has(model.displayNameKey.trim())) {
    diagnostics.push({
      code: "display_field_missing",
      severity: "error",
      path: "identity.displayNameKey",
      message: `The display field '${model.displayNameKey.trim()}' is not declared.`,
    });
  }

  const contracts = new Map([...options.contracts ?? []].map((contract) => [contractKey(contract), contract]));
  const typeFields = typeFieldsForModel(model);
  for (const implementation of model.implementations) {
    const key = `${implementation.contract}@${implementation.version}`;
    const contract = contracts.get(key);
    if (!contract) {
      diagnostics.push({
        code: "contract_unavailable",
        severity: "error",
        path: `applications.${key}`,
        message: "This exact application contract is not installed.",
      });
      continue;
    }
    for (const field of contractFields(contract)) {
      const source = mappingForContractField(implementation, field);
      const mapped = typeFields.find((candidate) => candidate.reference === source);
      const assessment = assessMapping(field, mapped);
      if (assessment.level === "valid") continue;
      diagnostics.push({
        code: assessment.level === "error" ? "invalid_contract_mapping" : "review_contract_mapping",
        severity: assessment.level === "error" ? "error" : "warning",
        path: `applications.${key}.${field.reference}`,
        message: assessment.message,
      });
    }
  }

  return diagnostics.filter((diagnostic, index, all) =>
    all.findIndex((candidate) =>
      candidate.code === diagnostic.code
      && candidate.path === diagnostic.path
      && candidate.message === diagnostic.message) === index);
}

export function describeTypeChanges(
  original: TypeEditorModel | null,
  current: TypeEditorModel,
): TypeDraftChange[] {
  if (!original) {
    return [{ code: "create_type", risk: "safe", summary: `Create the type '${current.name || "Untitled type"}'.` }];
  }
  const changes: TypeDraftChange[] = [];
  if (original.name !== current.name) {
    changes.push({
      code: "rename_type",
      risk: "high",
      summary: `Rename the type from '${original.name}' to '${current.name}'. Existing type references may need review.`,
    });
  }
  if (original.description !== current.description || original.displayNameKey !== current.displayNameKey) {
    changes.push({ code: "identity", risk: "safe", summary: "Update the type's identity and display metadata." });
  }
  if (
    original.matchPathGlob !== current.matchPathGlob
    || original.matchFieldsPresent !== current.matchFieldsPresent
    || original.matchWhere !== current.matchWhere
  ) {
    changes.push({
      code: "membership",
      risk: "high",
      summary: "Change which records belong to this type.",
    });
  }
  if (original.pathPattern !== current.pathPattern) {
    changes.push({ code: "placement", risk: "review", summary: "Change the suggested path for new records." });
  }
  if (original.strictMode !== current.strictMode) {
    changes.push({
      code: "strictness",
      risk: current.strictMode === true ? "high" : "review",
      summary: current.strictMode === true
        ? "Reject fields that are not declared by this type."
        : "Allow fields that are not declared by this type.",
    });
  }

  const before = fieldMap(original);
  const after = fieldMap(current);
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  if (added.length) {
    changes.push({
      code: "add_fields",
      risk: added.some((name) => after.get(name)?.definition.required === true) ? "high" : "safe",
      summary: `Add ${added.length === 1 ? "field" : "fields"}: ${added.join(", ")}.`,
    });
  }
  if (removed.length) {
    changes.push({
      code: "remove_fields",
      risk: "high",
      summary: `Remove ${removed.length === 1 ? "field" : "fields"}: ${removed.join(", ")}.`,
    });
  }
  for (const [name, next] of after) {
    const previous = before.get(name);
    if (!previous) continue;
    const previousType = definitionType(previous.definition);
    const nextType = definitionType(next.definition);
    if (previousType !== nextType) {
      changes.push({
        code: "change_field_type",
        risk: "high",
        summary: `Change '${name}' from ${previousType} to ${nextType}.`,
      });
    }
    if (previous.definition.required !== true && next.definition.required === true) {
      changes.push({
        code: "require_field",
        risk: "high",
        summary: `Make '${name}' required. Existing records may become invalid.`,
      });
    }
    if (
      previousType === nextType
      && JSON.stringify(previous.definition) !== JSON.stringify(next.definition)
      && previous.definition.required === next.definition.required
    ) {
      changes.push({
        code: "field_rules",
        risk: "review",
        summary: `Update validation or documentation for '${name}'.`,
      });
    }
  }
  const keptBefore = [...before.keys()].filter((name) => after.has(name));
  const keptAfter = [...after.keys()].filter((name) => before.has(name));
  if (keptBefore.join("\u0000") !== keptAfter.join("\u0000")) {
    changes.push({ code: "reorder_fields", risk: "safe", summary: "Reorder fields." });
  }
  if (JSON.stringify(original.implementations) !== JSON.stringify(current.implementations)) {
    changes.push({
      code: "application_compatibility",
      risk: "review",
      summary: "Update application contract mappings or settings.",
    });
  }
  if (!changes.length && !typeModelsEqual(original, current)) {
    changes.push({ code: "type_document", risk: "review", summary: "Update advanced type metadata or documentation." });
  }
  return changes;
}
