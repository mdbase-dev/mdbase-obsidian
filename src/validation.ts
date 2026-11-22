import { plural, t } from "@lingui/core/macro";
// Validating notes against their types: v0.2 field rules, v0.3 JSON Schema,
// link targets, strict mode and cross-record uniqueness.
import { normalizePath, TFile, Vault } from "obsidian";
import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020";
import addFormatsImport from "ajv-formats";
import { isExcluded } from "./collectionConfig";
import {
  getRelativeFolder,
  isRecord,
  parseFrontmatter,
  resolveJsonPointer,
  type IssueSeverity,
  type MdbaseConfig,
  type MdbaseFieldDef,
  type MdbaseIssue,
  type MdbaseTypeDef,
  type StrictMode,
} from "./mdbaseCore";
import { isWebLink, parseLinkReference } from "./links";
import { getTypesForFile } from "./typeMatching";

let ajv: Ajv2020 | null = null;

function getAjv(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  return ajv;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function stripListAndNestedPath(fieldPath: string): string {
  const dotIndex = fieldPath.indexOf(".");
  const bracketIndex = fieldPath.indexOf("[");
  if (dotIndex === -1 && bracketIndex === -1) return fieldPath;
  if (dotIndex === -1) return fieldPath.slice(0, bracketIndex);
  if (bracketIndex === -1) return fieldPath.slice(0, dotIndex);
  return fieldPath.slice(0, Math.min(dotIndex, bracketIndex));
}

function resolveLinkInVault(vault: Vault, filePath: string, rawReference: string): TFile | null {
  const reference = parseLinkReference(rawReference);
  if (!reference || isWebLink(reference)) return null;

  const candidates = new Set<string>();

  const normalizedReference = normalizePath(reference);
  candidates.add(normalizedReference);
  if (!normalizedReference.endsWith(".md")) {
    candidates.add(`${normalizedReference}.md`);
  }

  const fileFolder = getRelativeFolder(filePath);
  if (fileFolder) {
    const relative = normalizePath(`${fileFolder}/${reference}`);
    candidates.add(relative);
    if (!relative.endsWith(".md")) {
      candidates.add(`${relative}.md`);
    }
  }

  for (const candidate of candidates) {
    const abstractFile = vault.getAbstractFileByPath(candidate);
    if (abstractFile instanceof TFile) return abstractFile;
  }

  const basename = reference.replace(/\.md$/i, "");
  return vault.getMarkdownFiles().find((file) => file.basename === basename) ?? null;
}

function linkExistsInVault(vault: Vault, filePath: string, rawReference: string): boolean {
  return isWebLink(parseLinkReference(rawReference)) || resolveLinkInVault(vault, filePath, rawReference) !== null;
}

/**
 * Validate one record's frontmatter against a single type's own rules. Link
 * existence and cross-record uniqueness need the vault and are not included.
 */
export function validateRecordAgainstType(
  path: string,
  frontmatter: Record<string, unknown>,
  typeDef: MdbaseTypeDef,
): MdbaseIssue[] {
  const issues: MdbaseIssue[] = [];
  validateAgainstType(path, frontmatter, typeDef, issues);
  return issues;
}

function isMissingRequired(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
}

function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isTimeString(value: string): boolean {
  return /^\d{2}:\d{2}(:\d{2})?$/.test(value);
}

function resolveFieldLength(value: unknown): number | null {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  return null;
}

function pushIssue(
  issues: MdbaseIssue[],
  path: string,
  severity: IssueSeverity,
  code: string,
  message: string,
  field?: string,
  details?: Record<string, unknown>,
): void {
  issues.push({
    path,
    code,
    message,
    severity,
    field,
    ...(details ? { details } : {}),
  });
}

function validateConstraintBounds(
  value: unknown,
  fieldDef: MdbaseFieldDef,
  fieldPath: string,
  filePath: string,
  issues: MdbaseIssue[],
): void {
  if (typeof value === "number") {
    if (typeof fieldDef.min === "number" && value < fieldDef.min) {
      const minimum = fieldDef.min;
      pushIssue(
        issues,
        filePath,
        "error",
        "below_min",
        t`''${fieldPath}'' is ${value}; must be at least ${minimum}`,
        fieldPath,
      );
    }

    if (typeof fieldDef.max === "number" && value > fieldDef.max) {
      const maximum = fieldDef.max;
      pushIssue(
        issues,
        filePath,
        "error",
        "above_max",
        t`''${fieldPath}'' is ${value}; must be at most ${maximum}`,
        fieldPath,
      );
    }
  }

  const length = resolveFieldLength(value);
  if (length != null) {
    if (typeof fieldDef.min_length === "number" && length < fieldDef.min_length) {
      const minimum = fieldDef.min_length;
      pushIssue(
        issues,
        filePath,
        "error",
        "below_min_length",
        t`''${fieldPath}'' has length ${length}; needs at least ${minimum}`,
        fieldPath,
      );
    }

    if (typeof fieldDef.max_length === "number" && length > fieldDef.max_length) {
      const maximum = fieldDef.max_length;
      pushIssue(
        issues,
        filePath,
        "error",
        "above_max_length",
        t`''${fieldPath}'' has length ${length}; limit is ${maximum}`,
        fieldPath,
      );
    }
  }

  if (typeof fieldDef.pattern === "string" && typeof value === "string") {
    try {
      const regex = new RegExp(fieldDef.pattern);
      if (!regex.test(value)) {
        const actual = describeValue(value);
        const pattern = fieldDef.pattern;
        pushIssue(
          issues,
          filePath,
          "error",
          "pattern_mismatch",
          t`''${fieldPath}'' is ${actual}; does not match /${pattern}/`,
          fieldPath,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      pushIssue(
        issues,
        filePath,
        "warn",
        "invalid_pattern",
        t`Field ''${fieldPath}'' has invalid regex pattern: ${reason}`,
        fieldPath,
      );
    }
  }
}

function validateFieldValue(
  value: unknown,
  fieldDef: MdbaseFieldDef,
  fieldPath: string,
  filePath: string,
  issues: MdbaseIssue[],
  vault?: Vault,
): void {
  const typeName = fieldDef.type ?? "any";

  if (value === undefined || value === null) return;

  if (fieldDef.deprecated === true) {
    pushIssue(
      issues,
      filePath,
      "warn",
      "deprecated_field",
      t`Field ''${fieldPath}'' is marked deprecated`,
      fieldPath,
    );
  }

  const pushTypeIssue = (expected: string) => {
    pushIssue(issues, filePath, "error", "invalid_type", t`Field ''${fieldPath}'' expected ${expected}`, fieldPath);
  };

  switch (typeName) {
    case "any":
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "string":
      if (typeof value !== "string") {
        pushTypeIssue(t`a string`);
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        pushTypeIssue(t`an integer`);
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        pushTypeIssue(t`a number`);
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        pushTypeIssue(t`a boolean`);
      }
      return;
    case "date":
      if (typeof value !== "string" || !isDateString(value)) {
        pushTypeIssue(t`a date (YYYY-MM-DD)`);
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "datetime":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        pushTypeIssue(t`a datetime string`);
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "time":
      if (typeof value !== "string" || !isTimeString(value)) {
        pushTypeIssue(t`a time string (HH:MM)`);
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "enum": {
      const values = Array.isArray(fieldDef.values) ? fieldDef.values : [];
      if (!values.includes(value)) {
        const allowed = values.map((entry) => String(entry)).join(", ");
        pushIssue(
          issues,
          filePath,
          "error",
          "invalid_enum",
          t`Field ''${fieldPath}'' must be one of: ${allowed}`,
          fieldPath,
        );
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    }
    case "list": {
      if (!Array.isArray(value)) {
        pushTypeIssue(t`a list`);
        return;
      }

      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);

      if (fieldDef.items) {
        value.forEach((item, index) => {
          validateFieldValue(item, fieldDef.items as MdbaseFieldDef, `${fieldPath}[${index}]`, filePath, issues, vault);
        });
      }
      return;
    }
    case "object": {
      if (!isRecord(value)) {
        pushTypeIssue(t`an object`);
        return;
      }

      if (fieldDef.fields && isRecord(fieldDef.fields)) {
        for (const [nestedName, nestedDef] of Object.entries(fieldDef.fields)) {
          if (!isRecord(nestedDef)) continue;
          const nestedFieldDef = nestedDef as MdbaseFieldDef;
          const nestedPath = `${fieldPath}.${nestedName}`;
          const nestedValue = value[nestedName];

          if (nestedFieldDef.required && isMissingRequired(nestedValue)) {
            pushIssue(
              issues,
              filePath,
              "error",
              "missing_required",
              t`Missing required field ''${nestedPath}''`,
              nestedPath,
            );
            continue;
          }

          validateFieldValue(nestedValue, nestedFieldDef, nestedPath, filePath, issues, vault);
        }
      }
      return;
    }
    case "link": {
      if (typeof value !== "string" && !isRecord(value)) {
        pushTypeIssue(t`a link string`);
        return;
      }

      if (fieldDef.validate_exists === true && vault) {
        const raw =
          typeof value === "string"
            ? value
            : typeof value.path === "string"
              ? value.path
              : typeof value.file === "string"
                ? value.file
                : "";

        if (!raw || !linkExistsInVault(vault, filePath, raw)) {
          pushIssue(
            issues,
            filePath,
            "error",
            "missing_link_target",
            t`Field ''${fieldPath}'' references a missing note`,
            fieldPath,
            { link: raw, target_type: fieldDef.target },
          );
        }
      }
      return;
    }
    case "tags":
      if (typeof value === "string") {
        validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
        return;
      }
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
        return;
      }
      pushTypeIssue(t`a tag string or list of strings`);
      return;
    default:
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
  }
}

function jsonPointerToFieldPath(pointer: string): string | undefined {
  const field = pointer
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
  return field || undefined;
}

function snakeCaseKeyword(keyword: string): string {
  return keyword.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function describeValue(value: unknown): string {
  if (value === null) return t`empty`;
  if (typeof value === "string") {
    if (!value.trim()) return t`empty`;
    return `'${value.length > 40 ? `${value.slice(0, 39)}…` : value}'`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const count = value.length;
    return t`a list of ${count}`;
  }
  if (isRecord(value)) return t`an object`;
  return value === undefined ? t`missing` : JSON.stringify(value) ?? t`unknown`;
}

function schemaTypeNames(): Record<string, string> {
  return {
  string: t`text`,
  integer: t`a whole number`,
  number: t`a number`,
  boolean: t`true or false`,
  array: t`a list`,
  object: t`an object`,
  null: t`empty`,
  };
}

function formatNames(): Record<string, string> {
  return {
  date: t`a date (YYYY-MM-DD)`,
  "date-time": t`a date and time`,
  time: t`a time (HH:MM)`,
  email: t`an email address`,
  uri: t`a URI`,
  };
}

/** Plain-language issue text that names the field and, where useful, the actual value. */
function humanSchemaMessage(error: ErrorObject, field: string | undefined, value: unknown, typeName: string): string {
  const params = error.params as Record<string, unknown>;
  const subject = field ? `'${field}'` : t`This note`;
  const actual = describeValue(value);
  const limit = String(params.limit);
  const characterCount = typeof value === "string" ? value.length : 0;
  const itemCount = Array.isArray(value) ? value.length : 0;
  switch (error.keyword) {
    case "required": {
      const fieldName = field ?? String(params.missingProperty);
      return t`Missing required field ''${fieldName}''`;
    }
    case "additionalProperties": {
      const fieldName = field ?? String(params.additionalProperty);
      return t`Field ''${fieldName}'' is not declared by type ''${typeName}''`;
    }
    case "type": {
      const typeParam = Array.isArray(params.type) ? params.type.join(",") : typeof params.type === "string" ? params.type : "";
      const expected = typeParam.split(",").map((name) => schemaTypeNames()[name] ?? name).reduce((previous, next) => t`${previous} or ${next}`);
      return t`${subject} is ${actual}; expected ${expected}`;
    }
    case "enum": {
      const allowed = Array.isArray(params.allowedValues) ? params.allowedValues.map((entry) => String(entry)) : [];
      const listed = allowed.length > 6 ? `${allowed.slice(0, 6).join(", ")}, …` : allowed.join(", ");
      return t`${subject} is ${actual}; expected one of ${listed}`;
    }
    case "const": {
      const expected = describeValue(params.allowedValue);
      return t`${subject} is ${actual}; expected ${expected}`;
    }
    case "maximum":
      return t`${subject} is ${actual}; must be at most ${limit}`;
    case "minimum":
      return t`${subject} is ${actual}; must be at least ${limit}`;
    case "exclusiveMaximum":
      return t`${subject} is ${actual}; must be less than ${limit}`;
    case "exclusiveMinimum":
      return t`${subject} is ${actual}; must be more than ${limit}`;
    case "maxLength":
      return t`${subject} is ${plural(characterCount, { one: "# character", other: "# characters" })}; limit is ${limit}`;
    case "minLength":
      return t`${subject} is ${plural(characterCount, { one: "# character", other: "# characters" })}; needs at least ${limit}`;
    case "maxItems":
      return t`${subject} has ${plural(itemCount, { one: "# item", other: "# items" })}; limit is ${limit}`;
    case "minItems":
      return t`${subject} has ${plural(itemCount, { one: "# item", other: "# items" })}; needs at least ${limit}`;
    case "uniqueItems":
      return t`${subject} contains duplicate items`;
    case "pattern": {
      const pattern = String(params.pattern);
      return t`${subject} is ${actual}; does not match ${pattern}`;
    }
    case "format": {
      const format = String(params.format);
      const expected = formatNames()[format] ?? format;
      return t`${subject} is ${actual}; expected ${expected}`;
    }
    default: {
      const detail = error.message ?? t`invalid value`;
      return t`${subject}: ${detail}`;
    }
  }
}

function ajvErrorToIssue(
  error: ErrorObject,
  filePath: string,
  typeName: string,
  frontmatter: Record<string, unknown> = {},
): MdbaseIssue {
  const params = error.params as Record<string, unknown>;
  const parent = jsonPointerToFieldPath(error.instancePath);
  const child = typeof params.missingProperty === "string"
    ? params.missingProperty
    : typeof params.additionalProperty === "string"
      ? params.additionalProperty
      : undefined;
  const field = parent && child ? `${parent}.${child}` : child ?? parent;
  const code = error.keyword === "format" ? "format_invalid" : `schema_${snakeCaseKeyword(error.keyword)}`;
  const value = resolveJsonPointer(frontmatter, error.instancePath);
  return {
    path: filePath,
    code,
    message: humanSchemaMessage(error, field, value, typeName),
    severity: "error",
    field,
    type: typeName,
    schema_location: `embedded://type/schema#${error.schemaPath}`,
    details: {
      instance_path: error.instancePath,
      schema_path: error.schemaPath,
      technical_message: `JSON Schema ${error.keyword} failed for type ''${typeName}'': ${error.message ?? "invalid value"}`,
      ...(child === undefined ? {} : { property: child }),
    },
  };
}

function findUnsupportedSchemaReference(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUnsupportedSchemaReference(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) return value.$ref;
  for (const child of Object.values(value)) {
    const found = findUnsupportedSchemaReference(child);
    if (found) return found;
  }
  return null;
}

function validateV03Schema(
  filePath: string,
  frontmatter: Record<string, unknown>,
  typeDef: MdbaseTypeDef,
  issues: MdbaseIssue[],
): void {
  if (!typeDef.schema) return;
  const unsupportedRef = findUnsupportedSchemaReference(typeDef.schema);
  if (unsupportedRef) {
    const typeName = typeDef.name;
    issues.push({
      path: filePath,
      code: /^[a-z][a-z0-9+.-]*:/i.test(unsupportedRef) ? "schema_ref_forbidden" : "unsupported_profile",
      message: t`Unsupported JSON Schema reference ''${unsupportedRef}'' for type ''${typeName}''`,
      severity: "error",
      type: typeDef.name,
    });
    return;
  }
  try {
    const validate = getAjv().compile(typeDef.schema);
    if (validate(frontmatter)) return;
    for (const error of validate.errors ?? []) {
      issues.push(ajvErrorToIssue(error, filePath, typeDef.name, frontmatter));
    }
  } catch (error) {
    issues.push({
      path: filePath,
      code: "invalid_embedded_schema",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
      type: typeDef.name,
    });
  }
}

async function validateV03Links(
  vault: Vault,
  filePath: string,
  frontmatter: Record<string, unknown>,
  typeDef: MdbaseTypeDef,
  config: MdbaseConfig,
  typeMap: Map<string, MdbaseTypeDef>,
  issues: MdbaseIssue[],
): Promise<void> {
  for (const [field, rule] of Object.entries(typeDef.collection?.links ?? {})) {
    const rawValue = frontmatter[field];
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") continue;
      const target = resolveLinkInVault(vault, filePath, value);
      if (!target && rule.validate_exists === true) {
        pushIssue(issues, filePath, "error", "link_not_found", t`Field ''${field}'' references a missing note`, field,
          { link: value, target_type: rule.target_type });
        continue;
      }
      if (target && rule.target_type && rule.target_type !== "any") {
        const parsed = parseFrontmatter(await vault.cachedRead(target));
        const targetTypes = getTypesForFile(target.path, parsed.frontmatter, config, typeMap);
        if (!targetTypes.includes(rule.target_type)) {
          const targetType = rule.target_type;
          pushIssue(
            issues,
            filePath,
            "error",
            "link_wrong_type",
            t`Field ''${field}'' must reference type ''${targetType}''`,
            field,
          );
        }
      }
    }
  }
}

function validateAgainstType(
  filePath: string,
  frontmatter: Record<string, unknown>,
  typeDef: MdbaseTypeDef,
  issues: MdbaseIssue[],
  vault?: Vault,
): void {
  if (typeDef.specProfile === "v0.3") {
    validateV03Schema(filePath, frontmatter, typeDef, issues);
    return;
  }
  for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
    if (!isRecord(fieldDefRaw)) continue;
    const fieldDef = fieldDefRaw as MdbaseFieldDef;
    const value = frontmatter[fieldName];

    if (fieldDef.required && isMissingRequired(value)) {
      const typeName = typeDef.name;
      pushIssue(
        issues,
        filePath,
        "error",
        "missing_required",
        t`Missing required field ''${fieldName}'' for type ''${typeName}''`,
        fieldName,
      );
      continue;
    }

    validateFieldValue(value, fieldDef, fieldName, filePath, issues, vault);
  }
}

function mergedFieldNames(typeDefs: MdbaseTypeDef[]): Set<string> {
  const names = new Set<string>();
  for (const typeDef of typeDefs) {
    for (const key of Object.keys(typeDef.fields)) {
      names.add(key);
    }
  }
  return names;
}

function resolveStrictMode(typeDefs: MdbaseTypeDef[], config: MdbaseConfig): StrictMode {
  let hasWarn = false;
  let hasUndefined = false;

  for (const typeDef of typeDefs) {
    if (typeDef.strict === true) return true;
    if (typeDef.strict === "warn") hasWarn = true;
    if (typeDef.strict === undefined) hasUndefined = true;
  }

  if (hasWarn) return "warn";
  if (!hasUndefined) return false;
  return config.settings.default_strict ? "warn" : false;
}

export async function validateFile(
  vault: Vault,
  file: TFile,
  config: MdbaseConfig,
  typeMap: Map<string, MdbaseTypeDef>,
): Promise<MdbaseIssue[]> {
  if (isExcluded(file.path, config)) return [];

  const issues: MdbaseIssue[] = [];
  const raw = await vault.cachedRead(file);
  const parsed = parseFrontmatter(raw);

  if (parsed.error) {
    pushIssue(issues, file.path, "error", "invalid_frontmatter", parsed.error);
    return issues;
  }

  const frontmatter = parsed.frontmatter;
  const typeNames = getTypesForFile(file.path, frontmatter, config, typeMap);

  if (typeNames.length === 0) {
    // An untyped record is valid (spec Chapter 02). Only warn when frontmatter
    // suggests the note was meant to be a record, so a plain note or an app's
    // README such as TaskNotes' `_mdbase/README.md` raises no issue.
    if (parsed.hasFrontmatter) {
      pushIssue(issues, file.path, "warn", "no_matching_type", t`No type could be resolved for this file`);
    }
    return issues;
  }

  const typeDefs = typeNames
    .map((typeName) => typeMap.get(typeName))
    .filter((typeDef): typeDef is MdbaseTypeDef => !!typeDef);
  const unknownTypeNames = typeNames.filter((typeName) => !typeMap.has(typeName));

  if (unknownTypeNames.length > 0) {
    const names = unknownTypeNames.join(", ");
    pushIssue(
      issues,
      file.path,
      "error",
      "unknown_type",
      t`Resolved types are not defined: ${names}`,
    );
  }
  if (typeDefs.length === 0) {
    return issues;
  }

  for (const typeDef of typeDefs) {
    validateAgainstType(file.path, frontmatter, typeDef, issues, vault);
    if (typeDef.specProfile === "v0.3") {
      await validateV03Links(vault, file.path, frontmatter, typeDef, config, typeMap, issues);
    }
  }

  const strictMode = config.spec_version.startsWith("0.3.") ? false : resolveStrictMode(typeDefs, config);
  if (strictMode !== false) {
    const known = mergedFieldNames(typeDefs);
    const typeKeys = new Set(config.settings.explicit_type_keys);
    const severity: IssueSeverity = strictMode === true ? "error" : "warn";

    for (const fieldName of Object.keys(frontmatter)) {
      if (known.has(fieldName) || typeKeys.has(fieldName)) continue;
      pushIssue(
        issues,
        file.path,
        severity,
        "unknown_field",
        t`Unknown field ''${fieldName}'' in strict mode`,
        fieldName,
      );
    }
  }

  return issues;
}

async function collectUniqueFieldIssues(
  vault: Vault,
  config: MdbaseConfig,
  typeMap: Map<string, MdbaseTypeDef>,
  options: CollectionValidationOptions = {},
): Promise<MdbaseIssue[]> {
  interface UniqueValueInstance {
    path: string;
    typeName: string;
    fieldName: string;
    scope: "type" | "collection";
    specProfile?: "v0.2" | "v0.3";
    value: unknown;
    fingerprint: string;
  }

  const byKey = new Map<string, UniqueValueInstance[]>();

  for (const file of vault.getMarkdownFiles()) {
    if (isExcluded(file.path, config)) continue;

    options.signal?.throwIfAborted();
    const raw = await vault.cachedRead(file);
    const parsed = parseFrontmatter(raw);
    if (parsed.error) continue;

    const typeNames = getTypesForFile(file.path, parsed.frontmatter, config, typeMap);
    const typeDefs = typeNames
      .map((typeName) => typeMap.get(typeName))
      .filter((typeDef): typeDef is MdbaseTypeDef => !!typeDef);

    for (const typeDef of typeDefs) {
      for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
        if (!isRecord(fieldDefRaw)) continue;
        const fieldDef = fieldDefRaw as MdbaseFieldDef;
        if (fieldDef.unique !== true) continue;

        const value = parsed.frontmatter[fieldName];
        if (value === undefined || value === null) continue;

        const fingerprint = stableStringify(value);
        const scope = fieldDef.unique_scope === "collection" ? "collection" : "type";
        const dedupeKey = `${scope === "collection" ? "*" : typeDef.name}::${fieldName}::${fingerprint}`;
        const list = byKey.get(dedupeKey) ?? [];
        if (list.some((entry) => entry.path === file.path)) continue;
        list.push({
          path: file.path,
          typeName: typeDef.name,
          fieldName,
          scope,
          specProfile: typeDef.specProfile,
          value,
          fingerprint,
        });
        byKey.set(dedupeKey, list);
      }
    }
  }

  const issues: MdbaseIssue[] = [];
  for (const entries of byKey.values()) {
    if (entries.length <= 1) continue;

    for (const entry of entries) {
      const otherPaths = entries
        .filter((item) => item.path !== entry.path)
        .map((item) => item.path)
        .join(", ");

      const { fieldName, typeName } = entry;
      pushIssue(
        issues,
        entry.path,
        "error",
        entry.specProfile === "v0.3" ? "duplicate_value" : "duplicate_unique",
        entry.scope === "collection"
          ? t`Field ''${fieldName}'' must be unique across the collection. Duplicate found in: ${otherPaths}`
          : t`Field ''${fieldName}'' must be unique for type ''${typeName}''. Duplicate found in: ${otherPaths}`,
        entry.fieldName,
      );
    }
  }

  return issues;
}

export interface CollectionValidationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number; phase: "notes" | "uniqueness" }) => void;
  onFile?: (file: TFile, issues: MdbaseIssue[]) => void;
}

export async function validateCollection(
  vault: Vault,
  config: MdbaseConfig,
  typeMap: Map<string, MdbaseTypeDef>,
  options: CollectionValidationOptions = {},
): Promise<MdbaseIssue[]> {
  const all: MdbaseIssue[] = [];
  const files = vault.getMarkdownFiles().filter(file => !isExcluded(file.path, config));
  options.onProgress?.({ completed: 0, total: files.length, phase: "notes" });
  for (const [index, file] of files.entries()) {
    options.signal?.throwIfAborted();
    const issues = await validateFile(vault, file, config, typeMap);
    options.signal?.throwIfAborted();
    options.onFile?.(file, issues);
    all.push(...issues);
    options.onProgress?.({ completed: index + 1, total: files.length, phase: "notes" });
    // Give touch/keyboard cancellation and paint a chance even with cached reads.
    // This core also runs in Node-based profiling and unit tests.
    if (index % 25 === 0) await new Promise(resolve => window.setTimeout(resolve, 0));
  }

  options.signal?.throwIfAborted();
  options.onProgress?.({ completed: files.length, total: files.length, phase: "uniqueness" });
  const uniqueIssues = await collectUniqueFieldIssues(vault, config, typeMap, options);
  options.signal?.throwIfAborted();
  all.push(...uniqueIssues);
  return all;
}

export function getTopLevelFieldFromIssuePath(fieldPath: string): string {
  return stripListAndNestedPath(fieldPath);
}
