import { getFrontMatterInfo, normalizePath, parseYaml, stringifyYaml, TFile, Vault } from "obsidian";
import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020";
import addFormatsImport from "ajv-formats";
import picomatch from "picomatch";

export type IssueSeverity = "error" | "warn";
export type StrictMode = boolean | "warn";

export interface MdbaseIssue {
  path: string;
  code: string;
  message: string;
  severity: IssueSeverity;
  field?: string;
  type?: string;
  schema_location?: string;
  details?: Record<string, unknown>;
}

export interface MdbaseSettings {
  types_folder: string;
  contracts_folder?: string;
  explicit_type_keys: string[];
  default_strict: boolean;
  include_subfolders: boolean;
  exclude: string[];
}

export interface MdbaseConfig {
  spec_version: string;
  name?: string;
  description?: string;
  settings: MdbaseSettings;
  runtime?: {
    profile_version?: string;
    enabled?: boolean;
    policy?: string;
  };
}

export interface MdbaseFieldDef {
  type?: string;
  required?: boolean;
  default?: unknown;
  computed?: string;
  values?: unknown[];
  items?: MdbaseFieldDef;
  fields?: Record<string, MdbaseFieldDef>;
  unique?: boolean;
  unique_scope?: string;
  deprecated?: boolean;
  target?: string;
  validate_exists?: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  generated?: unknown;
  description?: string;
}

export interface MdbaseTypeDef {
  name: string;
  description?: string;
  extends?: string;
  display_name_key?: string;
  path_pattern?: string;
  filename_pattern?: string;
  strict?: StrictMode;
  match?: {
    path_glob?: string;
    fields_present?: string[];
    where?: Record<string, unknown> | string;
  };
  fields: Record<string, MdbaseFieldDef>;
  filePath: string;
  specProfile?: "v0.2" | "v0.3";
  version?: number;
  schema?: Record<string, unknown>;
  collection?: V03CollectionSemantics;
  originalFrontmatter?: Record<string, unknown>;
}

export interface V03LinkRule {
  target_type?: string;
  validate_exists?: boolean;
}

export interface V03CollectionSemantics {
  display?: { name_field?: string };
  read_defaults?: Record<string, unknown>;
  unique?: Array<{ field?: string; scope?: string }>;
  links?: Record<string, V03LinkRule>;
  path?: { pattern?: string };
}

export class MdbasePathError extends Error {
  constructor(public readonly code: "invalid_path" | "path_traversal", message: string) {
    super(message);
    this.name = "MdbasePathError";
  }
}

interface FrontmatterParse {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  error?: string;
}

const DEFAULT_CONFIG: MdbaseConfig = {
  spec_version: "0.3.0",
  name: "My mdbase collection",
  description: "Typed markdown collection",
  settings: {
    types_folder: "_types",
    contracts_folder: "_contracts",
    explicit_type_keys: ["type", "types"],
    default_strict: false,
    include_subfolders: true,
    // This is the portable collection default, not the active Obsidian config path.
    // eslint-disable-next-line obsidianmd/hardcoded-config-path -- Keep generated mdbase.yaml compatible with existing collections.
    exclude: ["_types", ".obsidian", ".git", "node_modules", ".trash", ".mdbase"],
  },
};

let ajv: Ajv2020 | null = null;

function getAjv(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => void;
  addFormats(ajv);
  return ajv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function parseStrictMode(value: unknown): StrictMode | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (value === "warn") return "warn";
  return undefined;
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

function resolveTypeInheritance(rawTypes: Map<string, MdbaseTypeDef>): Map<string, MdbaseTypeDef> {
  const resolved = new Map<string, MdbaseTypeDef>();
  const resolving = new Set<string>();

  const resolveOne = (typeName: string): MdbaseTypeDef | null => {
    const cached = resolved.get(typeName);
    if (cached) return cached;

    const own = rawTypes.get(typeName);
    if (!own) return null;

    if (resolving.has(typeName)) {
      // Circular inheritance; keep the local definition instead of recursing forever.
      const shallow = {
        ...own,
        fields: deepClone(own.fields),
      };
      resolved.set(typeName, shallow);
      return shallow;
    }

    resolving.add(typeName);
    const parent = own.extends ? resolveOne(own.extends) : null;
    resolving.delete(typeName);

    const merged: MdbaseTypeDef = {
      ...own,
      fields: parent ? { ...deepClone(parent.fields), ...deepClone(own.fields) } : deepClone(own.fields),
      display_name_key: own.display_name_key ?? parent?.display_name_key,
      path_pattern: own.path_pattern ?? parent?.path_pattern,
      filename_pattern: own.filename_pattern ?? parent?.filename_pattern,
      strict: own.strict !== undefined ? own.strict : parent?.strict,
      match: own.match ?? parent?.match,
    };

    resolved.set(typeName, merged);
    return merged;
  };

  for (const name of rawTypes.keys()) {
    resolveOne(name);
  }

  return resolved;
}

function getRelativeFolder(path: string): string {
  const normalized = normalizePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : "";
}

function parseLinkReference(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("[[") && value.endsWith("]]")) {
    value = value.slice(2, -2);
  }

  const aliasIndex = value.indexOf("|");
  if (aliasIndex >= 0) value = value.slice(0, aliasIndex);

  const headingIndex = value.indexOf("#");
  if (headingIndex >= 0) value = value.slice(0, headingIndex);

  return value.trim();
}

function isWebLink(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
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

export function parseFrontmatter(content: string): FrontmatterParse {
  const info = getFrontMatterInfo(content);
  if (!info.exists) {
    return {
      hasFrontmatter: false,
      frontmatter: {},
      body: content,
    };
  }

  try {
    const yamlSource = info.frontmatter;
    const parsed = parseYaml(yamlSource);
    if (parsed == null && yamlSource.trim() !== "") {
      return {
        hasFrontmatter: true,
        frontmatter: {},
        body: content.slice(info.contentStart),
        error: "Frontmatter must be a YAML object",
      };
    }
    if (parsed != null && !isRecord(parsed)) {
      return {
        hasFrontmatter: true,
        frontmatter: {},
        body: content.slice(info.contentStart),
        error: "Frontmatter must be a YAML object",
      };
    }

    return {
      hasFrontmatter: true,
      frontmatter: (parsed as Record<string, unknown>) ?? {},
      body: content.slice(info.contentStart),
    };
  } catch (error) {
    return {
      hasFrontmatter: true,
      frontmatter: {},
      body: content.slice(info.contentStart),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatMarkdown(frontmatter: Record<string, unknown>, body = ""): string {
  if (Object.keys(frontmatter).length === 0) return body;
  const yaml = stringifyYaml(frontmatter).trimEnd();
  const normalizedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n\n${normalizedBody}`;
}

export async function loadMdbaseConfig(vault: Vault): Promise<MdbaseConfig | null> {
  const configFile = vault.getAbstractFileByPath("mdbase.yaml");
  if (!(configFile instanceof TFile)) {
    return null;
  }

  try {
    const raw = await vault.cachedRead(configFile);
    const parsed = parseYaml(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    const settings = isRecord(parsed.settings) ? parsed.settings : {};
    const runtime = isRecord(parsed.runtime) ? parsed.runtime : undefined;

    return {
      spec_version: typeof parsed.spec_version === "string" ? parsed.spec_version : DEFAULT_CONFIG.spec_version,
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_CONFIG.name,
      description: typeof parsed.description === "string" ? parsed.description : DEFAULT_CONFIG.description,
      runtime: runtime ? {
        profile_version: typeof runtime.profile_version === "string" ? runtime.profile_version : undefined,
        enabled: typeof runtime.enabled === "boolean" ? runtime.enabled : undefined,
        policy: typeof runtime.policy === "string" ? runtime.policy : undefined,
      } : undefined,
      settings: {
        types_folder:
          typeof settings.types_folder === "string"
            ? settings.types_folder
            : DEFAULT_CONFIG.settings.types_folder,
        contracts_folder:
          typeof settings.contracts_folder === "string"
            ? settings.contracts_folder
            : DEFAULT_CONFIG.settings.contracts_folder,
        explicit_type_keys: Array.isArray(settings.explicit_type_keys)
          ? settings.explicit_type_keys.filter((value): value is string => typeof value === "string")
          : [...DEFAULT_CONFIG.settings.explicit_type_keys],
        default_strict:
          typeof settings.default_strict === "boolean"
            ? settings.default_strict
            : DEFAULT_CONFIG.settings.default_strict,
        include_subfolders:
          typeof settings.include_subfolders === "boolean"
            ? settings.include_subfolders
            : DEFAULT_CONFIG.settings.include_subfolders,
        exclude: Array.isArray(settings.exclude)
          ? settings.exclude.filter((value): value is string => typeof value === "string")
          : [...DEFAULT_CONFIG.settings.exclude],
      },
    };
  } catch {
    return null;
  }
}

export async function ensureCollectionInitialized(vault: Vault): Promise<{ created: string[] }> {
  const created: string[] = [];

  const mdbaseFile = vault.getAbstractFileByPath("mdbase.yaml");
  if (!(mdbaseFile instanceof TFile)) {
    const configYaml = stringifyYaml(DEFAULT_CONFIG).trimEnd() + "\n";
    await vault.create("mdbase.yaml", configYaml);
    created.push("mdbase.yaml");
  }

  const config = (await loadMdbaseConfig(vault)) ?? DEFAULT_CONFIG;
  const typesFolder = config.settings.types_folder;

  const typesFolderExists = await vault.adapter.exists(typesFolder);
  if (!typesFolderExists) {
    await vault.createFolder(typesFolder);
    created.push(typesFolder);
  }

  const noteTypePath = normalizePath(`${typesFolder}/note.md`);
  const noteTypeExists = await vault.adapter.exists(noteTypePath);
  if (!noteTypeExists) {
    const content = buildTypeTemplate("note", undefined, config.spec_version);
    await vault.create(noteTypePath, content);
    created.push(noteTypePath);
  }

  return { created };
}

function schemaTypeToFieldDefinition(
  schemaValue: unknown,
  required: boolean,
): MdbaseFieldDef {
  const schema = isRecord(schemaValue) ? schemaValue : {};
  const rawType = Array.isArray(schema.type)
    ? schema.type.find((value) => value !== "null")
    : schema.type;
  const field: MdbaseFieldDef = { required };

  if (Array.isArray(schema.enum)) {
    field.type = "enum";
    field.values = deepClone(schema.enum);
  } else if (rawType === "array") {
    field.type = "list";
    field.items = schemaTypeToFieldDefinition(schema.items, false);
  } else if (rawType === "object") {
    field.type = "object";
    field.fields = fieldsFromV03Schema(schema);
  } else if (rawType === "string" && schema.format === "date") {
    field.type = "date";
  } else if (rawType === "string" && schema.format === "date-time") {
    field.type = "datetime";
  } else if (rawType === "string" && schema.format === "time") {
    field.type = "time";
  } else if (typeof rawType === "string") {
    field.type = rawType;
  } else {
    field.type = "any";
  }

  if (schema.default !== undefined) field.default = deepClone(schema.default);
  if (typeof schema.description === "string") (field as Record<string, unknown>).description = schema.description;
  if (typeof schema.minimum === "number") field.min = schema.minimum;
  if (typeof schema.maximum === "number") field.max = schema.maximum;
  if (typeof schema.minLength === "number") field.min_length = schema.minLength;
  if (typeof schema.maxLength === "number") field.max_length = schema.maxLength;
  if (typeof schema.pattern === "string") field.pattern = schema.pattern;
  if (typeof schema.minItems === "number") field.min_length = schema.minItems;
  if (typeof schema.maxItems === "number") field.max_length = schema.maxItems;
  return field;
}

export function fieldsFromV03Schema(schema: Record<string, unknown>): Record<string, MdbaseFieldDef> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      schemaTypeToFieldDefinition(value, required.has(name)),
    ]),
  );
}

function fieldDefinitionToSchema(
  field: MdbaseFieldDef,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const schema = { ...deepClone(existing) };
  const typeName = field.type ?? "string";
  const clearObjectShape = (): void => {
    delete schema.properties;
    delete schema.required;
    delete schema.additionalProperties;
  };
  const clearArrayShape = (): void => {
    delete schema.items;
  };
  if (typeName === "enum") {
    delete schema.type;
    schema.enum = deepClone(field.values ?? []);
    delete schema.format;
    clearObjectShape();
    clearArrayShape();
  } else if (typeName === "list") {
    schema.type = "array";
    delete schema.enum;
    delete schema.format;
    clearObjectShape();
    schema.items = fieldDefinitionToSchema(field.items ?? { type: "any" }, isRecord(schema.items) ? schema.items : {});
  } else if (typeName === "object") {
    schema.type = "object";
    delete schema.enum;
    delete schema.format;
    clearArrayShape();
    const nested = schemaFromV03Fields(field.fields ?? {}, isRecord(schema) ? schema : {}, false);
    schema.properties = nested.properties;
    if (nested.required) schema.required = nested.required;
    else delete schema.required;
  } else if (typeName === "link") {
    schema.type = "string";
    delete schema.enum;
    delete schema.format;
    clearObjectShape();
    clearArrayShape();
  } else if (["date", "datetime", "time"].includes(typeName)) {
    schema.type = "string";
    schema.format = typeName === "datetime" ? "date-time" : typeName;
    delete schema.enum;
    clearObjectShape();
    clearArrayShape();
  } else if (["string", "integer", "number", "boolean"].includes(typeName)) {
    schema.type = typeName;
    delete schema.format;
    delete schema.enum;
    clearObjectShape();
    clearArrayShape();
  } else {
    delete schema.type;
    delete schema.enum;
    delete schema.format;
    clearObjectShape();
    clearArrayShape();
  }

  if (field.default !== undefined) schema.default = deepClone(field.default);
  else delete schema.default;
  if (typeof field.description === "string" && field.description.trim()) {
    schema.description = field.description;
  } else {
    delete schema.description;
  }
  const supportsNumericBounds = typeName === "integer" || typeName === "number";
  if (supportsNumericBounds && typeof field.min === "number") schema.minimum = field.min;
  else delete schema.minimum;
  if (supportsNumericBounds && typeof field.max === "number") schema.maximum = field.max;
  else delete schema.maximum;

  const supportsStringBounds = ["string", "link", "date", "datetime", "time"].includes(typeName);
  if (typeName === "list" && typeof field.min_length === "number") schema.minItems = field.min_length;
  else delete schema.minItems;
  if (typeName === "list" && typeof field.max_length === "number") schema.maxItems = field.max_length;
  else delete schema.maxItems;
  if (supportsStringBounds && typeof field.min_length === "number") schema.minLength = field.min_length;
  else delete schema.minLength;
  if (supportsStringBounds && typeof field.max_length === "number") schema.maxLength = field.max_length;
  else delete schema.maxLength;
  if (supportsStringBounds && typeof field.pattern === "string") schema.pattern = field.pattern;
  else delete schema.pattern;
  return schema;
}

export function schemaFromV03Fields(
  fields: Record<string, MdbaseFieldDef>,
  existing: Record<string, unknown> = {},
  strict = false,
): Record<string, unknown> {
  const existingProperties = isRecord(existing.properties) ? existing.properties : {};
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const required: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    properties[name] = fieldDefinitionToSchema(field, isRecord(existingProperties[name]) ? existingProperties[name] : {});
    if (field.required === true) required.push(name);
  }
  const schema: Record<string, unknown> = {
    ...deepClone(existing),
    type: "object",
    properties,
    additionalProperties: !strict,
  };
  if (required.length > 0) schema.required = required;
  else delete schema.required;
  return schema;
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (!pointer) return document;
  if (!pointer.startsWith("/")) return undefined;
  let current = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current) && segment in current) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

async function resolveV03SchemaRef(
  vault: Vault,
  typeFilePath: string,
  reference: string,
): Promise<Record<string, unknown> | null> {
  const [pathPart, fragment = ""] = reference.split("#", 2);
  if (!pathPart || /^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith("/")) return null;
  const folder = getRelativeFolder(typeFilePath);
  const segments: string[] = [];
  for (const segment of `${folder}/${pathPart}`.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const schemaPath = normalizePath(segments.join("/"));
  const file = vault.getAbstractFileByPath(schemaPath);
  if (!(file instanceof TFile)) return null;
  try {
    const document = JSON.parse(await vault.cachedRead(file));
    const selected = resolveJsonPointer(document, fragment);
    return isRecord(selected) ? selected : null;
  } catch {
    return null;
  }
}

export async function loadTypeDefinitions(vault: Vault, config: MdbaseConfig): Promise<Map<string, MdbaseTypeDef>> {
  const rawTypeMap = new Map<string, MdbaseTypeDef>();
  const typesFolderPrefix = `${normalizePath(config.settings.types_folder)}/`;

  for (const file of vault.getMarkdownFiles()) {
    if (!file.path.startsWith(typesFolderPrefix)) continue;

    const content = await vault.cachedRead(file);
    const parsed = parseFrontmatter(content);
    if (!parsed.hasFrontmatter || parsed.error) continue;

    const fm = parsed.frontmatter;
    if (config.spec_version.startsWith("0.3.")) {
      if (fm.kind !== "mdbase.type" || typeof fm.name !== "string" || !isRecord(fm.schema)) continue;
      const schemaWrapper = fm.schema;
      let schema = isRecord(schemaWrapper.value) ? schemaWrapper.value : null;
      if (!schema && typeof schemaWrapper.ref === "string") {
        schema = await resolveV03SchemaRef(vault, file.path, schemaWrapper.ref);
      }
      if (!schema) continue;

      const collection = isRecord(fm.collection)
        ? (deepClone(fm.collection) as V03CollectionSemantics)
        : undefined;
      const fields = fieldsFromV03Schema(schema);
      for (const rule of collection?.unique ?? []) {
        if (typeof rule.field === "string" && fields[rule.field]) {
          fields[rule.field].unique = true;
          fields[rule.field].unique_scope = rule.scope;
        }
      }
      for (const [fieldName, rule] of Object.entries(collection?.links ?? {})) {
        if (!fields[fieldName]) continue;
        fields[fieldName].target = rule.target_type;
        fields[fieldName].validate_exists = rule.validate_exists;
      }
      rawTypeMap.set(fm.name, {
        name: fm.name,
        version: typeof fm.version === "number" ? fm.version : undefined,
        description: typeof fm.description === "string" ? fm.description : undefined,
        display_name_key: collection?.display?.name_field,
        path_pattern: collection?.path?.pattern,
        strict: schema.additionalProperties === false,
        match: isRecord(fm.match) ? (fm.match) : undefined,
        fields,
        filePath: file.path,
        specProfile: "v0.3",
        schema: deepClone(schema),
        collection,
        originalFrontmatter: deepClone(fm),
      });
      continue;
    }
    if (!isRecord(fm.fields)) continue;

    const name = typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : file.basename;
    const fields: Record<string, MdbaseFieldDef> = {};

    for (const [fieldName, value] of Object.entries(fm.fields)) {
      if (isRecord(value)) {
        fields[fieldName] = value;
      }
    }

    rawTypeMap.set(name, {
      name,
      extends: typeof fm.extends === "string" ? fm.extends : undefined,
      display_name_key: typeof fm.display_name_key === "string" ? fm.display_name_key : undefined,
      path_pattern: typeof fm.path_pattern === "string" ? fm.path_pattern : undefined,
      filename_pattern: typeof fm.filename_pattern === "string" ? fm.filename_pattern : undefined,
      strict: parseStrictMode(fm.strict),
      match: isRecord(fm.match) ? (fm.match) : undefined,
      fields,
      filePath: file.path,
      specProfile: "v0.2",
      originalFrontmatter: deepClone(fm),
    });
  }

  return resolveTypeInheritance(rawTypeMap);
}

export async function loadContractDefinitions(
  vault: Vault,
  config: MdbaseConfig,
): Promise<Map<string, CollectionContractDescriptor>> {
  const contracts = new Map<string, CollectionContractDescriptor>();
  const folderPrefix = `${normalizePath(config.settings.contracts_folder || "_contracts")}/`;
  for (const file of vault.getMarkdownFiles()) {
    if (!file.path.startsWith(folderPrefix)) continue;
    const parsed = parseFrontmatter(await vault.cachedRead(file));
    if (!parsed.hasFrontmatter || parsed.error) continue;
    const frontmatter = parsed.frontmatter;
    if (frontmatter.kind !== "mdbase.contract" || frontmatter.contract_type !== "record") continue;
    if (typeof frontmatter.id !== "string" || typeof frontmatter.version !== "string") continue;
    const recordSchema = isRecord(frontmatter.record_schema) ? frontmatter.record_schema : {};
    const bindingSchema = isRecord(frontmatter.binding_schema) ? frontmatter.binding_schema : undefined;
    const schema = await resolveContractSchema(vault, file.path, recordSchema);
    if (!schema) continue;
    const binding = bindingSchema ? await resolveContractSchema(vault, file.path, bindingSchema) : null;
    const key = `${frontmatter.id}@${frontmatter.version}`;
    contracts.set(key, {
      contract_type: "record",
      id: frontmatter.id,
      version: frontmatter.version,
      digest: typeof frontmatter.digest === "string" ? frontmatter.digest : "",
      schema,
      ...(binding ? { binding_schema: binding } : {}),
      implementations: [],
    });
  }
  return contracts;
}

async function resolveContractSchema(
  vault: Vault,
  contractPath: string,
  wrapper: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (isRecord(wrapper.value)) return deepClone(wrapper.value);
  if (typeof wrapper.ref !== "string") return null;
  return resolveV03SchemaRef(vault, contractPath, wrapper.ref);
}

function getExplicitTypes(frontmatter: Record<string, unknown>, explicitTypeKeys: string[]): string[] | null {
  for (const key of explicitTypeKeys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      const typeNames = value.filter((entry): entry is string => typeof entry === "string");
      return typeNames;
    }
  }

  for (const key of explicitTypeKeys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
  }

  return null;
}

function applyPathTemplate(template: string, frontmatter: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = frontmatter[key];
    if (value == null) return "";
    if (Array.isArray(value)) {
      return value
        .filter((entry): entry is string | number | boolean => ["string", "number", "boolean"].includes(typeof entry))
        .map(String)
        .join("-");
    }
    return typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  });
}

export function normalizeSafeRelativePath(input: string): string {
  const path = input.replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\0")) {
    throw new MdbasePathError("invalid_path", `Invalid collection-relative path: ${input}`);
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    throw new MdbasePathError("path_traversal", `Path escapes the collection root: ${input}`);
  }
  return normalizePath(segments.filter((segment) => segment && segment !== ".").join("/"));
}

function extractBaseFolderFromGlob(globPattern: string): string {
  const wildcardIndex = globPattern.search(/[*?]|\[/);
  const prefix = wildcardIndex === -1 ? globPattern : globPattern.slice(0, wildcardIndex);
  const folder = prefix.replace(/\/+$/, "");
  if (folder.endsWith(".md")) {
    const slashIndex = folder.lastIndexOf("/");
    return slashIndex >= 0 ? folder.slice(0, slashIndex) : "";
  }
  return folder;
}

export function resolveFolderForType(typeDef: MdbaseTypeDef, frontmatter: Record<string, unknown>): string {
  if (typeDef.path_pattern) {
    const templated = normalizePath(applyPathTemplate(typeDef.path_pattern, frontmatter));
    if (templated.endsWith(".md")) {
      const slashIndex = templated.lastIndexOf("/");
      return slashIndex >= 0 ? templated.slice(0, slashIndex) : "";
    }
    return templated.replace(/\/+$/, "");
  }

  if (typeDef.match?.path_glob) {
    return extractBaseFolderFromGlob(typeDef.match.path_glob);
  }

  return "";
}

export function resolveFilenameForType(typeDef: MdbaseTypeDef, frontmatter: Record<string, unknown>): string {
  const displayFieldName = typeDef.display_name_key ?? "title";
  const displayValue = frontmatter[displayFieldName];

  const fallback = `${typeDef.name}-${new Date().toISOString().slice(0, 10)}`;
  const fallbackSource = typeof displayValue === "string" && displayValue.trim().length > 0 ? displayValue : fallback;

  if (typeDef.filename_pattern && typeDef.filename_pattern.trim().length > 0) {
    const rendered = normalizePath(applyPathTemplate(typeDef.filename_pattern, frontmatter));
    const filename = rendered.split("/").pop() ?? rendered;
    const withoutExt = filename.replace(/\.md$/i, "").trim();
    if (withoutExt.length > 0) {
      return `${slugify(withoutExt)}.md`;
    }
  }

  return `${slugify(fallbackSource)}.md`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function getWhereField(
  frontmatter: Record<string, unknown>,
  path: string,
): { present: boolean; value: unknown } {
  let current: unknown[] = [frontmatter];
  for (const segment of path.split(".").filter(Boolean)) {
    const expandArray = segment.endsWith("[]");
    const key = expandArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of current) {
      if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) continue;
      const child = value[key];
      if (expandArray && Array.isArray(child)) next.push(...child);
      else if (!expandArray) next.push(child);
    }
    if (!next.length) return { present: false, value: undefined };
    current = next;
  }
  return { present: true, value: current[0] };
}

function compareWhere(
  left: unknown,
  right: unknown,
  predicate: (left: number | string, right: number | string) => boolean,
): boolean {
  if (typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)) {
    return predicate(left, right);
  }
  return typeof left === "string" && typeof right === "string" && predicate(left, right);
}

function matchesWhereOperator(
  selected: { present: boolean; value: unknown },
  operator: string,
  expected: unknown,
  specVersion: string,
): boolean {
  const equals = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  switch (operator) {
    case "eq":
    case "const":
      return selected.present && selected.value != null && equals(selected.value, expected);
    case "neq":
      return selected.present && selected.value != null && !equals(selected.value, expected);
    case "gt":
      return compareWhere(selected.value, expected, (left, right) => left > right);
    case "gte":
      return compareWhere(selected.value, expected, (left, right) => left >= right);
    case "lt":
      return compareWhere(selected.value, expected, (left, right) => left < right);
    case "lte":
      return compareWhere(selected.value, expected, (left, right) => left <= right);
    case "exists":
      return specVersion.startsWith("0.3.")
        ? expected === true ? selected.present : !selected.present
        : expected === true
          ? selected.present && selected.value != null
          : !selected.present || selected.value == null;
    case "contains":
      return Array.isArray(selected.value)
        ? selected.value.some((entry) => equals(entry, expected))
        : typeof selected.value === "string" && selected.value.includes(String(expected));
    case "containsAll":
      if (!Array.isArray(selected.value) || !Array.isArray(expected)) return false;
      return expected.every((wanted) => (selected.value as unknown[]).some((entry) => equals(entry, wanted)));
    case "containsAny":
      if (!Array.isArray(selected.value) || !Array.isArray(expected)) return false;
      return expected.some((wanted) => (selected.value as unknown[]).some((entry) => equals(entry, wanted)));
    case "in":
      return selected.value != null && Array.isArray(expected)
        && expected.some((entry) => equals(entry, selected.value));
    case "startsWith":
    case "starts_with":
      return typeof selected.value === "string" && typeof expected === "string"
        && selected.value.startsWith(expected);
    case "endsWith":
    case "ends_with":
      return typeof selected.value === "string" && typeof expected === "string"
        && selected.value.endsWith(expected);
    case "matches":
      try {
        return typeof selected.value === "string" && typeof expected === "string"
          && new RegExp(expected.replace(/\\\\/g, "\\")).test(selected.value);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function matchesStructuredWhere(
  where: Record<string, unknown>,
  frontmatter: Record<string, unknown>,
  specVersion: string,
): boolean {
  if ("and" in where) {
    return Array.isArray(where.and)
      && where.and.every((condition) => isRecord(condition)
        && matchesStructuredWhere(condition, frontmatter, specVersion));
  }
  if ("or" in where) {
    return Array.isArray(where.or)
      && where.or.some((condition) => isRecord(condition)
        && matchesStructuredWhere(condition, frontmatter, specVersion));
  }
  if ("not" in where) {
    return isRecord(where.not) && !matchesStructuredWhere(where.not, frontmatter, specVersion);
  }
  for (const [field, condition] of Object.entries(where)) {
    const selected = getWhereField(frontmatter, field);
    if (!isRecord(condition)) {
      if (!selected.present || canonicalJson(selected.value) !== canonicalJson(condition)) return false;
      continue;
    }
    for (const [operator, expected] of Object.entries(condition)) {
      if (!matchesWhereOperator(selected, operator, expected, specVersion)) return false;
    }
  }
  return true;
}

export function getTypesForFile(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  config: MdbaseConfig,
  types: Map<string, MdbaseTypeDef>,
): string[] {
  const explicit = getExplicitTypes(frontmatter, config.settings.explicit_type_keys);
  if (explicit) return explicit;

  const matched: string[] = [];
  for (const [typeName, typeDef] of types.entries()) {
    const match = typeDef.match;
    if (!match) continue;

    let isMatch = true;

    if (typeof match.path_glob === "string") {
      const matcher = picomatch(match.path_glob, { dot: true });
      if (!matcher(relativePath)) isMatch = false;
    }

    if (isMatch && Array.isArray(match.fields_present)) {
      for (const key of match.fields_present) {
        if (!(key in frontmatter)) {
          isMatch = false;
          break;
        }
      }
    }

    if (isMatch && isRecord(match.where)) {
      isMatch = matchesStructuredWhere(match.where, frontmatter, config.spec_version);
    }

    if (isMatch && typeof match.where === "string") {
      // String expressions are not evaluated in this plugin.
      isMatch = false;
    }

    if (isMatch) matched.push(typeName);
  }

  return matched;
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
): void {
  issues.push({
    path,
    code,
    message,
    severity,
    field,
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
      pushIssue(
        issues,
        filePath,
        "error",
        "below_min",
        `Field '${fieldPath}' must be >= ${fieldDef.min}`,
        fieldPath,
      );
    }

    if (typeof fieldDef.max === "number" && value > fieldDef.max) {
      pushIssue(
        issues,
        filePath,
        "error",
        "above_max",
        `Field '${fieldPath}' must be <= ${fieldDef.max}`,
        fieldPath,
      );
    }
  }

  const length = resolveFieldLength(value);
  if (length != null) {
    if (typeof fieldDef.min_length === "number" && length < fieldDef.min_length) {
      pushIssue(
        issues,
        filePath,
        "error",
        "below_min_length",
        `Field '${fieldPath}' length must be >= ${fieldDef.min_length}`,
        fieldPath,
      );
    }

    if (typeof fieldDef.max_length === "number" && length > fieldDef.max_length) {
      pushIssue(
        issues,
        filePath,
        "error",
        "above_max_length",
        `Field '${fieldPath}' length must be <= ${fieldDef.max_length}`,
        fieldPath,
      );
    }
  }

  if (typeof fieldDef.pattern === "string" && typeof value === "string") {
    try {
      const regex = new RegExp(fieldDef.pattern);
      if (!regex.test(value)) {
        pushIssue(
          issues,
          filePath,
          "error",
          "pattern_mismatch",
          `Field '${fieldPath}' must match pattern /${fieldDef.pattern}/`,
          fieldPath,
        );
      }
    } catch (error) {
      pushIssue(
        issues,
        filePath,
        "warn",
        "invalid_pattern",
        `Field '${fieldPath}' has invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
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
      `Field '${fieldPath}' is marked deprecated`,
      fieldPath,
    );
  }

  const pushTypeIssue = (expected: string) => {
    pushIssue(issues, filePath, "error", "invalid_type", `Field '${fieldPath}' expected ${expected}`, fieldPath);
  };

  switch (typeName) {
    case "any":
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "string":
      if (typeof value !== "string") {
        pushTypeIssue("a string");
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        pushTypeIssue("an integer");
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        pushTypeIssue("a number");
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        pushTypeIssue("a boolean");
      }
      return;
    case "date":
      if (typeof value !== "string" || !isDateString(value)) {
        pushTypeIssue("a date (YYYY-MM-DD)");
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "datetime":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        pushTypeIssue("a datetime string");
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "time":
      if (typeof value !== "string" || !isTimeString(value)) {
        pushTypeIssue("a time string (HH:MM)");
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    case "enum": {
      const values = Array.isArray(fieldDef.values) ? fieldDef.values : [];
      if (!values.includes(value)) {
        pushIssue(
          issues,
          filePath,
          "error",
          "invalid_enum",
          `Field '${fieldPath}' must be one of: ${values.map((entry) => String(entry)).join(", ")}`,
          fieldPath,
        );
        return;
      }
      validateConstraintBounds(value, fieldDef, fieldPath, filePath, issues);
      return;
    }
    case "list": {
      if (!Array.isArray(value)) {
        pushTypeIssue("a list");
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
        pushTypeIssue("an object");
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
              `Missing required field '${nestedPath}'`,
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
        pushTypeIssue("a link string");
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
            `Field '${fieldPath}' references a missing note`,
            fieldPath,
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
      pushTypeIssue("a tag string or list of strings");
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

function ajvErrorToIssue(error: ErrorObject, filePath: string, typeName: string): MdbaseIssue {
  const params = error.params as Record<string, unknown>;
  const parent = jsonPointerToFieldPath(error.instancePath);
  const child = typeof params.missingProperty === "string"
    ? params.missingProperty
    : typeof params.additionalProperty === "string"
      ? params.additionalProperty
      : undefined;
  const field = parent && child ? `${parent}.${child}` : child ?? parent;
  const code = error.keyword === "format" ? "format_invalid" : `schema_${snakeCaseKeyword(error.keyword)}`;
  return {
    path: filePath,
    code,
    message: `JSON Schema ${error.keyword} failed for type '${typeName}': ${error.message ?? "invalid value"}`,
    severity: "error",
    field,
    type: typeName,
    schema_location: `embedded://type/schema#${error.schemaPath}`,
    details: {
      instance_path: error.instancePath,
      schema_path: error.schemaPath,
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
    issues.push({
      path: filePath,
      code: /^[a-z][a-z0-9+.-]*:/i.test(unsupportedRef) ? "schema_ref_forbidden" : "unsupported_profile",
      message: `Unsupported JSON Schema reference '${unsupportedRef}' for type '${typeDef.name}'`,
      severity: "error",
      type: typeDef.name,
    });
    return;
  }
  try {
    const validate = getAjv().compile(typeDef.schema);
    if (validate(frontmatter)) return;
    for (const error of validate.errors ?? []) {
      issues.push(ajvErrorToIssue(error, filePath, typeDef.name));
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
        pushIssue(issues, filePath, "error", "link_not_found", `Field '${field}' references a missing note`, field);
        continue;
      }
      if (target && rule.target_type && rule.target_type !== "any") {
        const parsed = parseFrontmatter(await vault.cachedRead(target));
        const targetTypes = getTypesForFile(target.path, parsed.frontmatter, config, typeMap);
        if (!targetTypes.includes(rule.target_type)) {
          pushIssue(
            issues,
            filePath,
            "error",
            "link_wrong_type",
            `Field '${field}' must reference type '${rule.target_type}'`,
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
      pushIssue(
        issues,
        filePath,
        "error",
        "missing_required",
        `Missing required field '${fieldName}' for type '${typeDef.name}'`,
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

export function isExcluded(path: string, config: MdbaseConfig): boolean {
  const normalizedPath = normalizePath(path);
  const typesFolder = normalizePath(config.settings.types_folder);
  if (normalizedPath.startsWith(`${typesFolder}/`) || normalizedPath === typesFolder) return true;

  if (!config.settings.include_subfolders && normalizedPath.includes("/")) {
    return true;
  }

  for (const pattern of config.settings.exclude) {
    const matcher = picomatch(pattern, { dot: true, matchBase: !pattern.includes("/") });
    if (matcher(normalizedPath)) return true;

    if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("/") && normalizedPath.startsWith(`${pattern}/`)) {
      return true;
    }
  }

  return false;
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
    pushIssue(issues, file.path, "warn", "no_matching_type", "No type could be resolved for this file");
    return issues;
  }

  const typeDefs = typeNames
    .map((typeName) => typeMap.get(typeName))
    .filter((typeDef): typeDef is MdbaseTypeDef => !!typeDef);
  const unknownTypeNames = typeNames.filter((typeName) => !typeMap.has(typeName));

  if (unknownTypeNames.length > 0) {
    pushIssue(
      issues,
      file.path,
      "error",
      "unknown_type",
      `Resolved types are not defined: ${unknownTypeNames.join(", ")}`,
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
        `Unknown field '${fieldName}' in strict mode`,
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

      pushIssue(
        issues,
        entry.path,
        "error",
        entry.specProfile === "v0.3" ? "duplicate_value" : "duplicate_unique",
        entry.scope === "collection"
          ? `Field '${entry.fieldName}' must be unique across the collection. Duplicate found in: ${otherPaths}`
          : `Field '${entry.fieldName}' must be unique for type '${entry.typeName}'. Duplicate found in: ${otherPaths}`,
        entry.fieldName,
      );
    }
  }

  return issues;
}

export function applyReadDefaults(
  frontmatter: Record<string, unknown>,
  typeDefs: MdbaseTypeDef[],
): Record<string, unknown> {
  const effective = deepClone(frontmatter);
  for (const typeDef of typeDefs) {
    for (const [field, value] of Object.entries(typeDef.collection?.read_defaults ?? {})) {
      if (!(field in effective)) effective[field] = deepClone(value);
    }
  }
  return effective;
}

export async function validateCollection(
  vault: Vault,
  config: MdbaseConfig,
  typeMap: Map<string, MdbaseTypeDef>,
): Promise<MdbaseIssue[]> {
  const all: MdbaseIssue[] = [];
  for (const file of vault.getMarkdownFiles()) {
    if (isExcluded(file.path, config)) continue;
    const issues = await validateFile(vault, file, config, typeMap);
    all.push(...issues);
  }

  const uniqueIssues = await collectUniqueFieldIssues(vault, config, typeMap);
  all.push(...uniqueIssues);
  return all;
}

export function buildTypeTemplate(
  name: string,
  pathGlob?: string,
  specVersion = DEFAULT_CONFIG.spec_version,
): string {
  if (specVersion.startsWith("0.3.")) {
    const frontmatter: Record<string, unknown> = {
      kind: "mdbase.type",
      name,
      version: 1,
      description: `${name} type`,
      schema: {
        dialect: "json-schema-2020-12",
        value: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["title"],
          additionalProperties: true,
          properties: {
            title: { type: "string", minLength: 1 },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
    };
    if (pathGlob && pathGlob.trim()) {
      frontmatter.match = { path_glob: pathGlob.trim() };
    }
    return `${formatMarkdown(frontmatter, `# ${name}\n\nType definition for ${name}.`)}\n`;
  }
  const frontmatter: Record<string, unknown> = {
    name,
    description: `${name} type`,
    strict: false,
    fields: {
      title: {
        type: "string",
        required: true,
      },
    },
  };

  if (pathGlob && pathGlob.trim().length > 0) {
    frontmatter.match = {
      path_glob: pathGlob.trim(),
    };
  }

  return `${formatMarkdown(frontmatter, `# ${name}\n\nType definition for ${name}.`)}\n`;
}

export async function createTypeDefinition(
  vault: Vault,
  config: MdbaseConfig,
  typeName: string,
  pathGlob?: string,
): Promise<string> {
  const safeName = typeName.trim();
  const typePath = normalizePath(`${config.settings.types_folder}/${safeName}.md`);

  if (await vault.adapter.exists(typePath)) {
    throw new Error(`Type already exists: ${typePath}`);
  }

  const content = buildTypeTemplate(safeName, pathGlob, config.spec_version);
  await vault.create(typePath, content);
  return typePath;
}

export function buildInitialFrontmatter(typeDef: MdbaseTypeDef, config: MdbaseConfig): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  const primaryTypeKey = config.settings.explicit_type_keys[0] ?? "type";
  frontmatter[primaryTypeKey] = primaryTypeKey === "types" ? [typeDef.name] : typeDef.name;

  for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
    if (!isRecord(fieldDefRaw)) continue;
    const fieldDef = fieldDefRaw as MdbaseFieldDef;
    if (fieldDef.default !== undefined) {
      frontmatter[fieldName] = deepClone(fieldDef.default);
    }
  }

  return frontmatter;
}

export function getPromptFields(
  typeDef: MdbaseTypeDef,
  currentFrontmatter: Record<string, unknown>,
): Array<[string, MdbaseFieldDef]> {
  const fields: Array<[string, MdbaseFieldDef]> = [];

  for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
    if (!isRecord(fieldDefRaw)) continue;
    const fieldDef = fieldDefRaw as MdbaseFieldDef;
    if (fieldDef.computed) continue;
    if (!fieldDef.required) continue;
    if (currentFrontmatter[fieldName] !== undefined) continue;
    fields.push([fieldName, fieldDef]);
  }

  return fields;
}

export function coerceFieldInput(rawInput: string, fieldDef: MdbaseFieldDef): unknown {
  const trimmed = rawInput.trim();
  const typeName = fieldDef.type ?? "string";

  switch (typeName) {
    case "string":
    case "date":
    case "datetime":
    case "time":
    case "link":
    case "enum":
    case "any":
      return trimmed;
    case "integer": {
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isInteger(parsed)) throw new Error("Expected integer input");
      return parsed;
    }
    case "number": {
      const parsed = Number.parseFloat(trimmed);
      if (Number.isNaN(parsed)) throw new Error("Expected numeric input");
      return parsed;
    }
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (["true", "1", "yes", "y"].includes(lowered)) return true;
      if (["false", "0", "no", "n"].includes(lowered)) return false;
      throw new Error("Expected boolean input: true/false");
    }
    case "list": {
      const values = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (!fieldDef.items) return values;
      return values.map((entry) => coerceFieldInput(entry, fieldDef.items as MdbaseFieldDef));
    }
    case "object": {
      const parsed = parseYaml(trimmed);
      if (!isRecord(parsed)) {
        throw new Error("Expected YAML object value");
      }
      return parsed;
    }
    case "tags":
      return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    default:
      return trimmed;
  }
}

export function slugify(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return value.length > 0 ? value : "note";
}

async function ensureFolderExists(vault: Vault, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath).replace(/\/+$/, "");
  if (!normalized) return;

  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await vault.adapter.exists(current))) {
      await vault.createFolder(current);
    }
  }
}

function resolvePathPatternFilePath(typeDef: MdbaseTypeDef, frontmatter: Record<string, unknown>): string | null {
  if (!typeDef.path_pattern || typeDef.path_pattern.trim().length === 0) return null;
  const templated = normalizePath(applyPathTemplate(typeDef.path_pattern, frontmatter));
  if (!templated.endsWith(".md")) return null;
  return templated;
}

export async function buildUniqueNotePath(
  vault: Vault,
  typeDef: MdbaseTypeDef,
  frontmatter: Record<string, unknown>,
): Promise<string> {
  const explicitPath = resolvePathPatternFilePath(typeDef, frontmatter);
  const folder = resolveFolderForType(typeDef, frontmatter);
  const filename = explicitPath ? explicitPath.split("/").pop() ?? explicitPath : resolveFilenameForType(typeDef, frontmatter);
  const basePath = explicitPath
    ? normalizeSafeRelativePath(explicitPath)
    : normalizeSafeRelativePath(`${folder ? `${folder}/` : ""}${filename.endsWith(".md") ? filename : `${filename}.md`}`);

  let candidate = basePath;
  let index = 2;
  while (vault.getAbstractFileByPath(candidate)) {
    candidate = basePath.replace(/\.md$/, `-${index}.md`);
    index += 1;
  }

  const slashIndex = candidate.lastIndexOf("/");
  if (slashIndex > 0) {
    await ensureFolderExists(vault, candidate.slice(0, slashIndex));
  }

  return candidate;
}

export async function createNoteFromType(
  vault: Vault,
  path: string,
  frontmatter: Record<string, unknown>,
  body = "",
): Promise<TFile> {
  const normalized = normalizeSafeRelativePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex > 0) {
    await ensureFolderExists(vault, normalized.slice(0, slashIndex));
  }

  if (await vault.adapter.exists(normalized)) {
    throw new Error(`File already exists: ${normalized}`);
  }

  const content = `${formatMarkdown(frontmatter, body)}\n`;
  return vault.create(normalized, content);
}

export function getTopLevelFieldFromIssuePath(fieldPath: string): string {
  return stripListAndNestedPath(fieldPath);
}
