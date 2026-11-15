// Loading type and contract definitions from the vault, v0.2 inheritance, and
// conversion between v0.3 JSON Schema and editable field definitions.
import { normalizePath, TFile, Vault } from "obsidian";
import type { CollectionContractDescriptor } from "./contractTypes";
import {
  deepClone,
  getRelativeFolder,
  isRecord,
  parseFrontmatter,
  resolveJsonPointer,
  type MdbaseConfig,
  type MdbaseFieldDef,
  type MdbaseTypeDef,
  type StrictMode,
  type V03CollectionSemantics,
} from "./mdbaseCore";

function parseStrictMode(value: unknown): StrictMode | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (value === "warn") return "warn";
  return undefined;
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

function schemaTypeToFieldDefinition(
  schemaValue: unknown,
  required: boolean,
): MdbaseFieldDef {
  const schema = isRecord(schemaValue) ? schemaValue : {};
  const schemaTypes: unknown = schema.type;
  const rawType = Array.isArray(schemaTypes)
    ? (schemaTypes as unknown[]).find((value) => value !== "null")
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
    const document: unknown = JSON.parse(await vault.cachedRead(file));
    const selected = resolveJsonPointer(document, fragment);
    return isRecord(selected) ? selected : null;
  } catch {
    return null;
  }
}

/** Build a v0.3 type definition from canonical type frontmatter and its resolved schema. */
export function v03TypeDefFromFrontmatter(
  fm: Record<string, unknown>,
  filePath: string,
  schema: Record<string, unknown>,
): MdbaseTypeDef {
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
  return {
    name: String(fm.name),
    version: typeof fm.version === "number" ? fm.version : undefined,
    description: typeof fm.description === "string" ? fm.description : undefined,
    display_name_key: collection?.display?.name_field,
    path_pattern: collection?.path?.pattern,
    strict: schema.additionalProperties === false,
    match: isRecord(fm.match) ? (fm.match) : undefined,
    fields,
    filePath,
    specProfile: "v0.3",
    schema: deepClone(schema),
    collection,
    originalFrontmatter: deepClone(fm),
  };
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
      rawTypeMap.set(fm.name, v03TypeDefFromFrontmatter(fm, file.path, schema));
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
