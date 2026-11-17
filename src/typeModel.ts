import { t } from "@lingui/core/macro";
import { parseYaml, stringifyYaml } from "obsidian";
import type { MdbaseFieldDef } from "./mdbaseCore";
import { fieldsFromV03Schema, schemaFromV03Fields } from "./typeDefinitions";
import type {
  TypeEditorContractImplementation,
  TypeEditorField,
  TypeEditorModel,
} from "./typeEditorTypes";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const RESERVED_TYPE_NAMES = new Set(["file", "formula", "this"]);

export class TypeNameRequiredError extends Error {}

export function validateMdbaseTypeName(input: string): string {
  const name = input.trim();
  if (!name) throw new TypeNameRequiredError(t`Type name is required.`);
  if (!/^[A-Za-z]/.test(name)) throw new Error(t`Type name must start with a letter.`);
  if (name.length >= 64) throw new Error(t`Type name must be shorter than 64 characters.`);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(t`Type name may contain only letters, numbers, hyphens, and underscores.`);
  }
  if (RESERVED_TYPE_NAMES.has(name.toLowerCase())) {
    throw new Error(t`Type name '${name}' is reserved.`);
  }
  return name;
}

export function createDefaultTypeModel(): TypeEditorModel {
  return {
    specProfile: "v0.3",
    originalFrontmatter: {},
    name: "",
    description: "",
    extendsType: "",
    displayNameKey: "",
    strictMode: false,
    pathPattern: "",
    filenamePattern: "",
    matchPathGlob: "",
    matchFieldsPresent: "",
    matchWhere: "",
    fields: [
      {
        name: "title",
        definition: {
          type: "string",
          required: true,
        },
      },
    ],
    implementations: [],
    body: "# Type\n\nDescribe the type and intended usage.",
    extraFrontmatter: {},
  };
}

function toFields(value: unknown): TypeEditorField[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, definition]) => ({ name, definition: clone(definition) }));
}

function toImplementations(value: unknown): TypeEditorContractImplementation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.contract !== "string" || typeof candidate.version !== "string") {
      return [];
    }
    const fields = isRecord(candidate.fields)
      ? Object.fromEntries(
        Object.entries(candidate.fields).filter(([, field]) => typeof field === "string"),
      ) as Record<string, string>
      : {};
    const binding = isRecord(candidate.binding) ? clone(candidate.binding) : undefined;
    return [{ contract: candidate.contract, version: candidate.version, fields, ...(binding ? { binding } : {}) }];
  });
}

function fieldsRecord(fields: TypeEditorField[]): Record<string, MdbaseFieldDef> {
  return Object.fromEntries(fields.map((field) => [field.name, field.definition as MdbaseFieldDef]));
}

function definitionForSelector(
  fields: Record<string, MdbaseFieldDef>,
  selector: string,
): MdbaseFieldDef | null {
  const segments = selector.split(".");
  let available = fields;
  let current: MdbaseFieldDef | undefined;
  for (const [index, rawSegment] of segments.entries()) {
    const match = rawSegment.match(/^([^[]+)((?:\[\])*)$/);
    if (!match) return null;
    current = available[match[1]];
    if (!current) return null;
    const arrayDepth = match[2].length / 2;
    for (let depth = 0; depth < arrayDepth; depth += 1) {
      if (current.type !== "list" || !current.items) return null;
      current = current.items;
    }
    if (index < segments.length - 1) {
      if (current.type !== "object" || !current.fields) return null;
      available = current.fields;
    }
  }
  return current ?? null;
}

function applyCollectionLinks(
  fields: TypeEditorField[],
  links: unknown,
): void {
  if (!isRecord(links)) return;
  const record = fieldsRecord(fields);
  for (const [selector, value] of Object.entries(links)) {
    if (!isRecord(value)) continue;
    const definition = definitionForSelector(record, selector);
    if (!definition) continue;
    definition.type = "link";
    if (typeof value.target_type === "string") definition.target = value.target_type;
    if (typeof value.validate_exists === "boolean") definition.validate_exists = value.validate_exists;
  }
}

interface CollectedLinkState {
  selectors: Set<string>;
  links: Map<string, { target_type: string; validate_exists: boolean }>;
}

function collectLinkState(fields: Record<string, MdbaseFieldDef>): CollectedLinkState {
  const state: CollectedLinkState = {
    selectors: new Set<string>(),
    links: new Map(),
  };
  const visit = (definition: MdbaseFieldDef, selector: string): void => {
    state.selectors.add(selector);
    if (definition.type === "link") {
      state.links.set(selector, {
        target_type: typeof definition.target === "string" && definition.target.trim()
          ? definition.target.trim()
          : "any",
        validate_exists: definition.validate_exists === true,
      });
    }
    if (definition.type === "list" && definition.items) {
      visit(definition.items, `${selector}[]`);
    }
    if (definition.type === "object" && definition.fields) {
      for (const [name, child] of Object.entries(definition.fields)) {
        visit(child, `${selector}.${name}`);
      }
    }
  };
  for (const [name, definition] of Object.entries(fields)) visit(definition, name);
  return state;
}

export function typeModelFromDocument(
  frontmatter: Record<string, unknown>,
  body: string,
  fallbackName: string,
): TypeEditorModel {
  const isV03 = frontmatter.kind === "mdbase.type";
  const schemaWrapper = isV03 && isRecord(frontmatter.schema) ? frontmatter.schema : {};
  const schema = isRecord(schemaWrapper.value) ? schemaWrapper.value : {};
  const schemaReference = typeof schemaWrapper.ref === "string" ? schemaWrapper.ref : "";
  const collection = isV03 && isRecord(frontmatter.collection) ? frontmatter.collection : {};
  const display = isRecord(collection.display) ? collection.display : {};
  const pathPolicy = isRecord(collection.path) ? collection.path : {};
  const fields = toFields(isV03 ? fieldsFromV03Schema(schema) : frontmatter.fields);
  if (isV03) applyCollectionLinks(fields, collection.links);
  // Show a fixed (`const`) value in the editor. Saving keeps the schema's own
  // `const`, so this copy is for display only.
  if (isV03 && isRecord(schema.properties)) {
    for (const field of fields) {
      const property = schema.properties[field.name];
      if (isRecord(property) && "const" in property) field.definition.const = clone(property.const);
    }
  }
  const match = isRecord(frontmatter.match) ? frontmatter.match : {};
  const strict = isV03 ? schema.additionalProperties === false : frontmatter.strict;
  const known = new Set([
    "name",
    "description",
    "extends",
    "display_name_key",
    "strict",
    "path_pattern",
    "filename_pattern",
    "match",
    "fields",
  ]);
  const extraFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!known.has(key)) extraFrontmatter[key] = clone(value);
  }
  let matchWhere = "";
  if (match.where !== undefined) {
    try {
      matchWhere = stringifyYaml(match.where).trim();
    } catch {
      matchWhere = "";
    }
  }
  return {
    specProfile: isV03 ? "v0.3" : "v0.2",
    originalFrontmatter: clone(frontmatter),
    name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name : fallbackName,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    extendsType: typeof frontmatter.extends === "string" ? frontmatter.extends : "",
    displayNameKey: isV03
      ? typeof display.name_field === "string" ? display.name_field : ""
      : typeof frontmatter.display_name_key === "string" ? frontmatter.display_name_key : "",
    strictMode: strict === "warn" ? "warn" : strict === true,
    pathPattern: isV03
      ? typeof pathPolicy.pattern === "string" ? pathPolicy.pattern : ""
      : typeof frontmatter.path_pattern === "string" ? frontmatter.path_pattern : "",
    filenamePattern: isV03 ? "" : typeof frontmatter.filename_pattern === "string" ? frontmatter.filename_pattern : "",
    matchPathGlob: typeof match.path_glob === "string" ? match.path_glob : "",
    matchFieldsPresent: Array.isArray(match.fields_present)
      ? match.fields_present.map(String).join(", ")
      : "",
    matchWhere,
    fields: fields.length || schemaReference ? fields : createDefaultTypeModel().fields,
    implementations: toImplementations(frontmatter.implements),
    body: body.trim() || `# ${fallbackName}\n\nType definition for ${fallbackName}.`,
    extraFrontmatter,
    ...(schemaReference ? {
      readOnlyReason: t`This type uses schema.ref (${schemaReference}). Edit the referenced JSON Schema file directly.`,
    } : {}),
  };
}

export function frontmatterFromTypeModel(model: TypeEditorModel): Record<string, unknown> {
  if (model.specProfile !== "v0.3") {
      throw new Error(t`mdbase v0.2 type definitions are read-only. Migrate the collection before editing.`);
  }
  if (model.readOnlyReason) throw new Error(model.readOnlyReason);
  const original = model.originalFrontmatter ? clone(model.originalFrontmatter) : {};
  const originalSchemaWrapper = isRecord(original.schema) ? original.schema : {};
  const originalSchema = isRecord(originalSchemaWrapper.value) ? originalSchemaWrapper.value : {};
  const fields: Record<string, MdbaseFieldDef> = Object.create(null) as Record<string, MdbaseFieldDef>;
  for (const field of model.fields) {
    const name = field.name.trim();
    if (!name) throw new Error(t`Every field needs a name.`);
    if (Object.prototype.hasOwnProperty.call(fields, name)) throw new Error(t`Duplicate field name: ${name}`);
    fields[name] = clone(field.definition);
  }
  const typeName = validateMdbaseTypeName(model.name);
  const frontmatter: Record<string, unknown> = {
    ...original,
    kind: "mdbase.type",
    name: typeName,
    version: typeof original.version === "number" ? original.version : 1,
    schema: {
      ...originalSchemaWrapper,
      dialect: "json-schema-2020-12",
      value: schemaFromV03Fields(fields, originalSchema, model.strictMode === true),
    },
  };
  delete (frontmatter.schema as Record<string, unknown>).ref;
  if (model.description.trim()) frontmatter.description = model.description.trim();
  else delete frontmatter.description;

  const match: Record<string, unknown> = isRecord(frontmatter.match) ? clone(frontmatter.match) : {};
  if (model.matchPathGlob.trim()) match.path_glob = model.matchPathGlob.trim();
  else delete match.path_glob;
  const present = model.matchFieldsPresent.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (present.length) match.fields_present = present;
  else delete match.fields_present;
  if (model.matchWhere.trim()) {
    const where: unknown = parseYaml(model.matchWhere);
    if (!isRecord(where)) throw new Error(t`Match where must be a YAML mapping.`);
    match.where = where;
  } else delete match.where;
  if (Object.keys(match).length) frontmatter.match = match;
  else delete frontmatter.match;

  const collection = isRecord(frontmatter.collection) ? clone(frontmatter.collection) : {};
  const display = isRecord(collection.display) ? clone(collection.display) : {};
  if (model.displayNameKey.trim()) display.name_field = model.displayNameKey.trim();
  else delete display.name_field;
  if (Object.keys(display).length) collection.display = display;
  else delete collection.display;
  if (model.pathPattern.trim()) {
    const existingPath = isRecord(collection.path) ? collection.path : {};
    collection.path = { ...existingPath, pattern: model.pathPattern.trim() };
  } else if (isRecord(collection.path) && typeof collection.path.pattern === "string") {
    const path = { ...collection.path };
    delete path.pattern;
    if (Object.keys(path).length) collection.path = path;
    else delete collection.path;
  }
  const originalLinks = isRecord(collection.links) ? clone(collection.links) : {};
  const links = clone(originalLinks);
  const linkState = collectLinkState(fields);
  const originalLinkState = collectLinkState(fieldsFromV03Schema(originalSchema));
  for (const selector of new Set([...originalLinkState.selectors, ...linkState.selectors])) {
    delete links[selector];
  }
  for (const [selector, rule] of linkState.links) {
    links[selector] = {
      ...(isRecord(originalLinks[selector]) ? originalLinks[selector] : {}),
      target_type: rule.target_type,
      validate_exists: rule.validate_exists,
    };
  }
  if (Object.keys(links).length) collection.links = links;
  else delete collection.links;
  if (Object.keys(collection).length) frontmatter.collection = collection;
  else delete frontmatter.collection;

  if (model.implementations.length) {
    frontmatter.implements = model.implementations.map((implementation) => ({
      contract: implementation.contract,
      version: implementation.version,
      fields: clone(implementation.fields),
      ...(implementation.binding && Object.keys(implementation.binding).length
        ? { binding: clone(implementation.binding) }
        : {}),
    }));
  } else {
    delete frontmatter.implements;
  }

  for (const legacy of ["fields", "strict", "extends", "display_name_key", "path_pattern", "filename_pattern"]) {
    delete frontmatter[legacy];
  }
  return frontmatter;
}
