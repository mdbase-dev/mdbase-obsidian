import {
  normalizePath,
  parseYaml,
  stringifyYaml,
  TFile,
  TFolder,
  Vault,
} from "obsidian";
import { portableMirrorRuntime } from "@mdbase-dev/connect-sync/mirror";
import {
  fieldsFromV03Schema,
  formatMarkdown,
  getTypesForFile,
  parseFrontmatter,
  type MdbaseConfig,
  type MdbaseFieldDef,
  type MdbaseTypeDef,
} from "./mdbaseCore";

type Dict = Record<string, unknown>;

export interface TypeMigrationDiagnostic {
  path: string;
  code: string;
  message: string;
  severity: "warning" | "lossy";
}

export interface TypeMigrationSummary {
  path: string;
  name: string;
  fieldsConverted: number;
  requiredFields: string[];
  defaultsMoved: string[];
  generatedFieldsMoved: string[];
  linksMoved: string[];
  taskNotes: boolean;
}

export interface MigrationOperation {
  path: string;
  sourceDigest: string;
  targetDigest: string;
  source: string;
  target: string;
}

export interface V02MigrationPlan {
  planVersion: 1;
  analysisId: string;
  sourceVersion: string;
  targetVersion: "0.3.0";
  createdAt: string;
  backupLocation: string;
  operations: MigrationOperation[];
  typeSummaries: TypeMigrationSummary[];
  diagnostics: TypeMigrationDiagnostic[];
  applicable: boolean;
  recordFilesRewritten: 0;
  recordsVerified: number;
  recordsSkipped: number;
}

export interface MigrationApplyResult {
  applied: boolean;
  restored: boolean;
  manifestPath: string;
  written: string[];
  error?: string;
}

interface MigrationManifest {
  manifest_version: 1;
  analysis_id: string;
  source_version: string;
  target_version: string;
  status: "prepared" | "applying" | "applied" | "rolled_back" | "recovery_required";
  created_at: string;
  completed_at?: string;
  written: string[];
  files: Array<{
    path: string;
    source_digest: string;
    target_digest: string;
    backup_path: string;
  }>;
  error?: string;
  manual_recovery_paths?: string[];
}

const TARGET_VERSION = "0.3.0" as const;
const KNOWN_TYPE_KEYS = new Set([
  "name",
  "description",
  "display_name_key",
  "strict",
  "path_pattern",
  "filename_pattern",
  "match",
  "fields",
  "extends",
]);
const KNOWN_FIELD_KEYS = new Set([
  "type",
  "required",
  "default",
  "description",
  "values",
  "items",
  "fields",
  "min",
  "max",
  "min_length",
  "max_length",
  "pattern",
  "unique",
  "deprecated",
  "generated",
  "computed",
  "target",
  "validate_exists",
  "tn_role",
  "tn_completed_values",
]);

function isRecord(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function digest(value: string): string {
  return portableMirrorRuntime.digest(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (!isRecord(value)) return value;
  const result: Dict = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = prune(entry);
    if (next === undefined || next === null) continue;
    if (Array.isArray(next) && next.length === 0) continue;
    if (isRecord(next) && Object.keys(next).length === 0) continue;
    result[key] = next;
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function detectTaskNotes(type: Dict): boolean {
  if (!isRecord(type.fields)) return false;
  return Object.values(type.fields).some((value) =>
    isRecord(value)
    && (typeof value.tn_role === "string" || Array.isArray(value.tn_completed_values)));
}

interface FieldConversion {
  schema: Dict;
  links: Dict;
  legacy: Dict;
  unsupported: string[];
}

function convertField(selector: string, input: unknown, taskNotes: boolean): FieldConversion {
  const field = isRecord(input) ? input : {};
  const links: Dict = {};
  const legacy: Dict = {};
  const unsupported: string[] = [];
  let schema: Dict;
  switch (field.type) {
    case "any":
      schema = {};
      break;
    case "string":
    case "integer":
    case "number":
    case "boolean":
      schema = { type: field.type };
      break;
    case "date":
    case "datetime":
    case "time":
      schema = { type: "string", format: field.type === "datetime" ? "date-time" : field.type };
      break;
    case "enum":
      schema = { enum: Array.isArray(field.values) ? clone(field.values) : [] };
      break;
    case "link":
      schema = { type: "string" };
      links[selector] = {
        target_type: typeof field.target === "string"
          ? field.target
          : selector.endsWith("Parent") || selector.endsWith("uid") ? "task" : "any",
        validate_exists: field.validate_exists === true,
      };
      break;
    case "list": {
      const item = convertField(`${selector}[]`, field.items, taskNotes);
      schema = { type: "array", items: item.schema };
      Object.assign(links, item.links);
      Object.assign(legacy, item.legacy);
      unsupported.push(...item.unsupported);
      break;
    }
    case "object": {
      const properties: Dict = {};
      const required: string[] = [];
      for (const [name, child] of Object.entries(isRecord(field.fields) ? field.fields : {})) {
        const converted = convertField(`${selector}.${name}`, child, taskNotes);
        properties[name] = converted.schema;
        Object.assign(links, converted.links);
        Object.assign(legacy, converted.legacy);
        unsupported.push(...converted.unsupported);
        if (isRecord(child) && child.required === true) required.push(name);
      }
      if (taskNotes && selector === "blockedBy[]") required.push("uid");
      schema = {
        type: "object",
        additionalProperties: Object.keys(properties).length === 0,
        properties,
        ...(required.length ? { required: unique(required) } : {}),
      };
      break;
    }
    default:
      schema = {};
      unsupported.push(`${selector}.type`);
      break;
  }

  if (taskNotes && selector === "title") {
    schema.minLength = 1;
    schema.description = "Short summary of the task.";
  }
  if (typeof field.description === "string") schema.description = field.description;
  if (typeof field.min === "number") {
    if (field.type === "string") schema.minLength = field.min;
    else if (field.type === "list") schema.minItems = field.min;
    else schema.minimum = field.min;
  }
  if (typeof field.max === "number") {
    if (field.type === "string") schema.maxLength = field.max;
    else if (field.type === "list") schema.maxItems = field.max;
    else schema.maximum = field.max;
  }
  if (typeof field.min_length === "number") {
    if (field.type === "list") schema.minItems = field.min_length;
    else schema.minLength = field.min_length;
  }
  if (typeof field.max_length === "number") {
    if (field.type === "list") schema.maxItems = field.max_length;
    else schema.maxLength = field.max_length;
  }
  if (typeof field.pattern === "string") schema.pattern = field.pattern;
  if (field.deprecated === true) schema.deprecated = true;
  if (field.default !== undefined) schema.default = clone(field.default);
  if (field.computed !== undefined) unsupported.push(`${selector}.computed`);

  for (const [key, value] of Object.entries(field)) {
    const handledTaskNotes = taskNotes && (key === "tn_role" || key === "tn_completed_values");
    if (!KNOWN_FIELD_KEYS.has(key) || ((key === "tn_role" || key === "tn_completed_values") && !handledTaskNotes)) {
      legacy[`${selector}.${key}`] = clone(value);
    }
  }
  return { schema, links, legacy, unsupported };
}

function lifecycleSet(lifecycle: Dict, event: "on_create" | "on_update", field: string, value: Dict): void {
  const action = isRecord(lifecycle[event]) ? lifecycle[event] : {};
  const set = isRecord(action.set) ? action.set : {};
  set[field] = value;
  action.set = set;
  lifecycle[event] = action;
}

function addGenerated(lifecycle: Dict, field: string, generated: unknown): boolean {
  if (generated === "now") lifecycleSet(lifecycle, "on_create", field, { now: true });
  else if (generated === "now_on_write") lifecycleSet(lifecycle, "on_update", field, { now: true });
  else if (generated === "uuid") lifecycleSet(lifecycle, "on_create", field, { uuid: true });
  else if (generated === "ulid") lifecycleSet(lifecycle, "on_create", field, { ulid: true });
  else if (isRecord(generated) && generated.transform === "slugify" && typeof generated.from === "string") {
    lifecycleSet(lifecycle, "on_create", field, { slugify: generated.from });
  } else {
    return false;
  }
  return true;
}

function taskNotesPathPolicy(pattern: string): Dict {
  const match = pattern.match(/^(.*\/)?\{title\}\.md$/);
  if (match) {
    return {
      runtime: "tasknotes",
      template: "{{title}}",
      folder: (match[1] ?? "").replace(/\/$/, ""),
      generated_by: "tasknotes.filename.create",
    };
  }
  return {
    runtime: "tasknotes",
    template: pattern,
    generated_by: "tasknotes.filename.create",
  };
}

function migrateType(path: string, sourceVersion: string, frontmatter: Dict): {
  target: Dict;
  summary: TypeMigrationSummary;
  diagnostics: TypeMigrationDiagnostic[];
} {
  if (frontmatter.kind === "mdbase.type" || frontmatter.schema !== undefined) {
    throw new Error(`${path} already looks like a v0.3 type.`);
  }
  if (typeof frontmatter.name !== "string" || !isRecord(frontmatter.fields)) {
    throw new Error(`${path} is not a v0.2 type with a name and fields.`);
  }

  const taskNotes = detectTaskNotes(frontmatter);
  const name = frontmatter.name.trim().toLowerCase();
  const properties: Dict = { type: { const: name } };
  const required: string[] = [];
  const readDefaults: Dict = {};
  const links: Dict = {};
  const uniqueFields: unknown[] = [];
  const lifecycle: Dict = {};
  const legacyFields: Dict = {};
  const unsupported: string[] = [];
  const generatedFields: string[] = [];
  const fieldRoles: Record<string, string> = {};
  const taskNotesStatus: Dict = {};
  const taskNotesPriority: Dict = {};

  for (const [fieldName, raw] of Object.entries(frontmatter.fields)) {
    const field = isRecord(raw) ? raw : {};
    const converted = convertField(fieldName, field, taskNotes);
    properties[fieldName] = converted.schema;
    Object.assign(links, converted.links);
    Object.assign(legacyFields, converted.legacy);
    unsupported.push(...converted.unsupported);
    if (field.required === true) required.push(fieldName);
    if (field.default !== undefined) readDefaults[fieldName] = clone(field.default);
    if (field.unique === true) uniqueFields.push({ field: fieldName, scope: "collection" });
    if (field.generated !== undefined) {
      if (addGenerated(lifecycle, fieldName, field.generated)) {
        generatedFields.push(fieldName);
      } else {
        legacyFields[`${fieldName}.generated`] = clone(field.generated);
        unsupported.push(`${fieldName}.generated`);
      }
    }
    if (typeof field.tn_role === "string") fieldRoles[field.tn_role] = fieldName;
    if (Array.isArray(field.tn_completed_values)) taskNotesStatus.completed_values = clone(field.tn_completed_values);
  }
  if (readDefaults.status !== undefined) taskNotesStatus.default = clone(readDefaults.status);
  if (readDefaults.priority !== undefined) taskNotesPriority.default = clone(readDefaults.priority);

  const displayKey = typeof frontmatter.display_name_key === "string"
    && Object.prototype.hasOwnProperty.call(frontmatter.fields, frontmatter.display_name_key)
    ? frontmatter.display_name_key
    : undefined;
  const collection: Dict = {
    ...(displayKey ? { display: { name_field: displayKey } } : {}),
    read_defaults: readDefaults,
    links,
    unique: uniqueFields,
  };
  if (typeof frontmatter.path_pattern === "string") {
    collection.path = taskNotes ? taskNotesPathPolicy(frontmatter.path_pattern) : { pattern: frontmatter.path_pattern };
  }

  const legacyTop: Dict = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_TYPE_KEYS.has(key)) legacyTop[key] = clone(value);
  }
  if (Object.keys(legacyFields).length) legacyTop.fields = legacyFields;

  const target = prune({
    kind: "mdbase.type",
    name,
    version: 1,
    description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
    match: isRecord(frontmatter.match) ? clone(frontmatter.match) : undefined,
    schema: {
      dialect: "json-schema-2020-12",
      value: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: frontmatter.strict !== true,
        properties,
        ...(required.length ? { required: unique(required) } : {}),
      },
    },
    collection,
    lifecycle,
    ...(taskNotes ? {
      "x-tasknotes": {
        contract: "tasknotes.task",
        version: 1,
        field_roles: fieldRoles,
        status: taskNotesStatus,
        priority: taskNotesPriority,
        archive: {
          tags_field: fieldRoles.tags ?? "tags",
          archived_tag: "archived",
        },
      },
    } : {}),
    ...(Object.keys(legacyTop).length ? { "x-legacy-v0.2": legacyTop } : {}),
  }) as Dict;

  const diagnostics: TypeMigrationDiagnostic[] = [];
  if (frontmatter.extends !== undefined) unsupported.push("extends");
  for (const feature of unique(unsupported).sort()) {
    diagnostics.push({
      path,
      code: "migration_lossy",
      message: `${feature} cannot be expressed as canonical v0.3 write behavior and was retained as legacy metadata where possible.`,
      severity: "lossy",
    });
  }
  if (taskNotes) {
    diagnostics.push({
      path,
      code: "path_policy_runtime_owned",
      message: "TaskNotes filename behavior is recorded as TaskNotes runtime metadata.",
      severity: "warning",
    });
  }
  if (frontmatter.strict !== true) {
    diagnostics.push({
      path,
      code: "additional_properties_true",
      message: "The migrated schema allows additional properties because the source type was not strict.",
      severity: "warning",
    });
  }
  if (typeof frontmatter.display_name_key === "string" && !displayKey) {
    diagnostics.push({
      path,
      code: "display_field_missing",
      message: `The display field '${frontmatter.display_name_key}' is not declared, so collection.display was omitted.`,
      severity: "warning",
    });
  }

  return {
    target,
    summary: {
      path,
      name,
      fieldsConverted: Object.keys(frontmatter.fields).length,
      requiredFields: unique(required),
      defaultsMoved: Object.keys(readDefaults),
      generatedFieldsMoved: unique(generatedFields),
      linksMoved: Object.keys(links),
      taskNotes,
    },
    diagnostics,
  };
}

function migrateConfig(source: Dict): Dict {
  const target = clone(source);
  target.spec_version = TARGET_VERSION;
  const settings = isRecord(target.settings) ? target.settings : {};
  target.settings = settings;
  if (!Array.isArray(settings.record_extensions)) {
    const extensions = Array.isArray(settings.extensions)
      ? settings.extensions.map(String).map((entry) => entry.replace(/^\./, ""))
      : [];
    settings.record_extensions = unique(["md", ...extensions]);
  }
  if (!Array.isArray(settings.explicit_type_keys)) settings.explicit_type_keys = ["type", "types"];
  if (typeof settings.include_subfolders !== "boolean") settings.include_subfolders = true;
  if (settings.validation === undefined && typeof settings.default_validation === "string") {
    settings.validation = settings.default_validation;
  }
  if (settings.validation === undefined && typeof target.default_validation === "string") {
    settings.validation = target.default_validation;
  }
  delete settings.default_validation;
  delete settings.extensions;
  delete target.default_validation;
  return target;
}

function configForMatching(raw: Dict, version: string): MdbaseConfig {
  const settings = isRecord(raw.settings) ? raw.settings : {};
  return {
    spec_version: version,
    name: typeof raw.name === "string" ? raw.name : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    settings: {
      types_folder: typeof settings.types_folder === "string" ? settings.types_folder : "_types",
      explicit_type_keys: Array.isArray(settings.explicit_type_keys)
        ? settings.explicit_type_keys.filter((value): value is string => typeof value === "string")
        : ["type", "types"],
      default_strict: settings.default_strict === true,
      include_subfolders: settings.include_subfolders !== false,
      exclude: Array.isArray(settings.exclude)
        ? settings.exclude.filter((value): value is string => typeof value === "string")
        // This is collection configuration data, not Obsidian's runtime config path.
        // eslint-disable-next-line obsidianmd/hardcoded-config-path -- Preserve the v0.2 collection-format default during migration.
        : ["_types", ".obsidian", ".git", ".mdbase"],
    },
  };
}

function sourceTypeDefinition(path: string, frontmatter: Dict): MdbaseTypeDef {
  const fields: Record<string, MdbaseFieldDef> = {};
  for (const [name, value] of Object.entries(isRecord(frontmatter.fields) ? frontmatter.fields : {})) {
    if (isRecord(value)) fields[name] = clone(value);
  }
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : path.split("/").pop()?.replace(/\.md$/, "") ?? "type",
    fields,
    match: isRecord(frontmatter.match) ? clone(frontmatter.match) : undefined,
    filePath: path,
    specProfile: "v0.2",
  };
}

function targetTypeDefinition(path: string, frontmatter: Dict): MdbaseTypeDef {
  const wrapper = isRecord(frontmatter.schema) ? frontmatter.schema : {};
  const schema = isRecord(wrapper.value) ? wrapper.value : {};
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : path.split("/").pop()?.replace(/\.md$/, "") ?? "type",
    fields: fieldsFromV03Schema(schema),
    match: isRecord(frontmatter.match) ? clone(frontmatter.match) : undefined,
    collection: isRecord(frontmatter.collection)
      ? clone(frontmatter.collection)
      : undefined,
    schema: clone(schema),
    filePath: path,
    specProfile: "v0.3",
  };
}

function effectiveV02(frontmatter: Dict, names: string[], types: Map<string, MdbaseTypeDef>): Dict {
  const result = clone(frontmatter);
  for (const name of names) {
    const type = types.get(name);
    if (!type) continue;
    for (const [field, definition] of Object.entries(type.fields)) {
      if (!(field in result) && definition.default !== undefined) result[field] = clone(definition.default);
    }
  }
  return result;
}

function effectiveV03(frontmatter: Dict, names: string[], types: Map<string, MdbaseTypeDef>): Dict {
  const result = clone(frontmatter);
  for (const name of names) {
    const type = types.get(name);
    if (!type) continue;
    for (const [field, value] of Object.entries(type.collection?.read_defaults ?? {})) {
      if (!(field in result)) result[field] = clone(value);
    }
  }
  return result;
}

async function ensureFolder(vault: Vault, folder: string): Promise<void> {
  const normalized = normalizePath(folder).replace(/\/+$/, "");
  if (!normalized) return;
  let current = "";
  for (const segment of normalized.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const existing = vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`A file blocks folder ${current}.`);
    if (await vault.adapter.exists(current)) continue;
    await vault.createFolder(current);
  }
}

async function writeFile(vault: Vault, path: string, content: string): Promise<void> {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  if (slash >= 0) await ensureFolder(vault, normalized.slice(0, slash));
  if (normalized.startsWith(".mdbase/")) {
    await vault.adapter.write(normalized, content);
    return;
  }
  const existing = vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFolder) throw new Error(`A folder blocks file ${normalized}.`);
  if (existing instanceof TFile) await vault.modify(existing, content);
  else await vault.create(normalized, content);
}

async function readRequired(vault: Vault, path: string): Promise<string> {
  const normalized = normalizePath(path);
  const file = vault.getAbstractFileByPath(normalized);
  if (file instanceof TFile) return vault.cachedRead(file);
  if (await vault.adapter.exists(normalized)) return vault.adapter.read(normalized);
  throw new Error(`File not found: ${path}`);
}

export async function analyzeV02Migration(vault: Vault): Promise<V02MigrationPlan> {
  const configSource = await readRequired(vault, "mdbase.yaml");
  const rawConfig = parseYaml(configSource);
  if (!isRecord(rawConfig)) throw new Error("mdbase.yaml must contain a YAML mapping.");
  const sourceVersion = typeof rawConfig.spec_version === "string" ? rawConfig.spec_version : "";
  if (!/^0\.2(?:\.\d+)?$/.test(sourceVersion)) {
    throw new Error(
      sourceVersion === TARGET_VERSION
        ? "This collection is already mdbase v0.3."
        : `Expected an mdbase v0.2.x collection, found ${JSON.stringify(sourceVersion)}.`,
    );
  }
  const settings = isRecord(rawConfig.settings) ? rawConfig.settings : {};
  const typesFolder = typeof settings.types_folder === "string" ? normalizePath(settings.types_folder) : "_types";
  const prefix = `${typesFolder}/`;
  const operations: MigrationOperation[] = [];
  const summaries: TypeMigrationSummary[] = [];
  const diagnostics: TypeMigrationDiagnostic[] = [];
  const migratedConfig = migrateConfig(rawConfig);
  const configTarget = `${stringifyYaml(migratedConfig).trimEnd()}\n`;
  operations.push({
    path: "mdbase.yaml",
    sourceDigest: digest(configSource),
    targetDigest: digest(configTarget),
    source: configSource,
    target: configTarget,
  });
  const sourceTypes = new Map<string, MdbaseTypeDef>();
  const targetTypes = new Map<string, MdbaseTypeDef>();
  for (const file of vault.getMarkdownFiles().filter((entry) => entry.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path))) {
    const source = await vault.cachedRead(file);
    const parsed = parseFrontmatter(source);
    if (!parsed.hasFrontmatter || parsed.error) {
      throw new Error(`Cannot migrate ${file.path}: ${parsed.error ?? "frontmatter is missing"}.`);
    }
    const migrated = migrateType(file.path, sourceVersion, parsed.frontmatter);
    const sourceType = sourceTypeDefinition(file.path, parsed.frontmatter);
    const targetType = targetTypeDefinition(file.path, migrated.target);
    sourceTypes.set(sourceType.name, sourceType);
    targetTypes.set(targetType.name, targetType);
    const target = `${formatMarkdown(migrated.target, parsed.body)}\n`;
    operations.push({
      path: file.path,
      sourceDigest: digest(source),
      targetDigest: digest(target),
      source,
      target,
    });
    summaries.push(migrated.summary);
    diagnostics.push(...migrated.diagnostics);
  }
  if (!summaries.length) throw new Error(`No v0.2 type files were found in ${typesFolder}.`);

  let recordsVerified = 0;
  let recordsSkipped = 0;
  const sourceConfig = configForMatching(rawConfig, sourceVersion);
  const targetConfig = configForMatching(migratedConfig, TARGET_VERSION);
  const recordFiles = vault.getMarkdownFiles()
    .filter((file) => !file.path.startsWith(prefix))
    .filter((file) => !file.path.startsWith(".mdbase/"))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const [index, file] of recordFiles.entries()) {
    const parsed = parseFrontmatter(await vault.cachedRead(file));
    if (parsed.error) {
      recordsSkipped += 1;
      continue;
    }
    const sourceNames = getTypesForFile(file.path, parsed.frontmatter, sourceConfig, sourceTypes);
    const targetNames = getTypesForFile(file.path, parsed.frontmatter, targetConfig, targetTypes);
    const sourceRead = effectiveV02(parsed.frontmatter, sourceNames, sourceTypes);
    const targetRead = effectiveV03(parsed.frontmatter, targetNames, targetTypes);
    if (stableStringify(sourceNames.slice().sort()) !== stableStringify(targetNames.slice().sort())
      || stableStringify(sourceRead) !== stableStringify(targetRead)) {
      diagnostics.push({
        path: file.path,
        code: "effective_read_changed",
        message: "The proposed v0.3 types would change this record's resolved types or effective default values.",
        severity: "lossy",
      });
    }
    recordsVerified += 1;
    if (index > 0 && index % 250 === 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  const analysisId = digest(stableStringify({
    sourceVersion,
    operations: operations.map(({ path, sourceDigest, targetDigest }) => ({ path, sourceDigest, targetDigest })),
    diagnostics,
  }));
  return {
    planVersion: 1,
    analysisId,
    sourceVersion,
    targetVersion: TARGET_VERSION,
    createdAt: new Date().toISOString(),
    backupLocation: `.mdbase/migrations/v02-to-v03-${analysisId.slice(0, 12)}`,
    operations,
    typeSummaries: summaries,
    diagnostics,
    applicable: !diagnostics.some((entry) => entry.severity === "lossy"),
    recordFilesRewritten: 0,
    recordsVerified,
    recordsSkipped,
  };
}

async function writeManifest(vault: Vault, path: string, manifest: MigrationManifest): Promise<void> {
  await writeFile(vault, path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function applyV02Migration(
  vault: Vault,
  plan: V02MigrationPlan,
  options: { allowLossy?: boolean } = {},
): Promise<MigrationApplyResult> {
  if (plan.planVersion !== 1 || plan.targetVersion !== TARGET_VERSION) {
    throw new Error("Unsupported migration plan.");
  }
  if (!plan.applicable && !options.allowLossy) {
    throw new Error("This migration has lossy diagnostics. Review them and explicitly allow lossy migration.");
  }
  for (const operation of plan.operations) {
    const current = await readRequired(vault, operation.path);
    if (digest(current) !== operation.sourceDigest) {
      throw new Error(`${operation.path} changed after migration analysis. Run the review again.`);
    }
  }

  const manifestPath = `${plan.backupLocation}/manifest.json`;
  const manifest: MigrationManifest = {
    manifest_version: 1,
    analysis_id: plan.analysisId,
    source_version: plan.sourceVersion,
    target_version: plan.targetVersion,
    status: "prepared",
    created_at: new Date().toISOString(),
    written: [],
    files: plan.operations.map((operation) => ({
      path: operation.path,
      source_digest: operation.sourceDigest,
      target_digest: operation.targetDigest,
      backup_path: `${plan.backupLocation}/files/${operation.path}`,
    })),
  };

  // Every backup must be durable before the first collection file changes.
  for (const operation of plan.operations) {
    await writeFile(vault, `${plan.backupLocation}/files/${operation.path}`, operation.source);
  }
  await writeManifest(vault, manifestPath, manifest);
  manifest.status = "applying";
  await writeManifest(vault, manifestPath, manifest);

  try {
    for (const operation of plan.operations) {
      const current = await readRequired(vault, operation.path);
      if (digest(current) !== operation.sourceDigest) {
        throw new Error(`${operation.path} changed during migration.`);
      }
      // Journal the path before touching it so a successful-but-corrupt write
      // is included in rollback even when verification fails.
      manifest.written.push(operation.path);
      await writeManifest(vault, manifestPath, manifest);
      await writeFile(vault, operation.path, operation.target);
      const verified = await readRequired(vault, operation.path);
      if (digest(verified) !== operation.targetDigest) {
        throw new Error(`${operation.path} did not verify after write.`);
      }
    }
    manifest.status = "applied";
    manifest.completed_at = new Date().toISOString();
    await writeManifest(vault, manifestPath, manifest);
    return {
      applied: true,
      restored: false,
      manifestPath,
      written: [...manifest.written],
    };
  } catch (error) {
    const manual: string[] = [];
    for (const path of [...manifest.written].reverse()) {
      const operation = plan.operations.find((entry) => entry.path === path);
      if (!operation) {
        manual.push(path);
        continue;
      }
      try {
        await writeFile(vault, path, operation.source);
        if (digest(await readRequired(vault, path)) !== operation.sourceDigest) manual.push(path);
      } catch {
        manual.push(path);
      }
    }
    manifest.status = manual.length ? "recovery_required" : "rolled_back";
    manifest.error = error instanceof Error ? error.message : String(error);
    manifest.manual_recovery_paths = manual.length ? manual : undefined;
    manifest.completed_at = new Date().toISOString();
    try {
      await writeManifest(vault, manifestPath, manifest);
    } catch {
      // Backups remain the recovery source of truth even if the journal update fails.
    }
    return {
      applied: false,
      restored: manual.length === 0,
      manifestPath,
      written: [...manifest.written],
      error: manifest.error,
    };
  }
}

export async function restoreV02Migration(vault: Vault, plan: V02MigrationPlan): Promise<string[]> {
  const restored: string[] = [];
  for (const operation of [...plan.operations].reverse()) {
    const backupPath = `${plan.backupLocation}/files/${operation.path}`;
    const source = await readRequired(vault, backupPath);
    if (digest(source) !== operation.sourceDigest) {
      throw new Error(`Backup digest mismatch for ${operation.path}.`);
    }
    await writeFile(vault, operation.path, source);
    restored.push(operation.path);
  }
  return restored;
}
