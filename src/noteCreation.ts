import { t } from "@lingui/core/macro";
// Creating notes from a type: initial frontmatter, prompted field input,
// safe collection-relative paths, and the file itself.
import { normalizePath, parseYaml, TFile, Vault } from "obsidian";
import {
  deepClone,
  formatMarkdown,
  isRecord,
  type MdbaseConfig,
  type MdbaseFieldDef,
  type MdbaseTypeDef,
  type V03LifecycleAction,
} from "./mdbaseCore";

export class MdbasePathError extends Error {
  constructor(public readonly code: "invalid_path" | "path_traversal", message: string) {
    super(message);
    this.name = "MdbasePathError";
  }
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
    throw new MdbasePathError("invalid_path", t`Invalid collection-relative path: ${input}`);
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    throw new MdbasePathError("path_traversal", t`Path escapes the collection root: ${input}`);
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

  return `${fileNameFrom(fallbackSource)}.md`;
}

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function padDigits(value: number, width: number): string {
  const text = String(value);
  return text.length >= width ? text : `${"0".repeat(width - text.length)}${text}`;
}

function localDateString(date: Date): string {
  return `${padDigits(date.getFullYear(), 4)}-${padDigits(date.getMonth() + 1, 2)}-${padDigits(date.getDate(), 2)}`;
}

function generateUlid(instantMs: number): string {
  let time = Math.max(0, Math.floor(instantMs));
  const timeChars = new Array<string>(10);
  for (let index = 9; index >= 0; index -= 1) {
    timeChars[index] = CROCKFORD_BASE32[time % 32];
    time = Math.floor(time / 32);
  }
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  let randomChars = "";
  let bits = 0;
  let bitCount = 0;
  for (const byte of randomBytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      randomChars += CROCKFORD_BASE32[(bits >>> bitCount) & 0x1f];
    }
  }
  return `${timeChars.join("")}${randomChars}`;
}

function lifecycleSlugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFieldPath(reference: string): string[] | null {
  if (!reference || reference.includes("[") || reference.includes("]")) return null;
  const segments = reference.split(".");
  if (segments.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) return null;
  return segments;
}

function getFieldByPath(root: Record<string, unknown>, reference: string): { found: boolean; value: unknown } {
  const segments = parseFieldPath(reference);
  if (!segments) return { found: false, value: undefined };
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function setFieldByPath(root: Record<string, unknown>, reference: string, hasValue: boolean, value: unknown): void {
  const segments = parseFieldPath(reference);
  if (!segments) return;
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = current[segment];
    if (next === undefined) {
      if (!hasValue) return;
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    } else if (isRecord(next)) {
      current = next;
    } else {
      return;
    }
  }
  const leaf = segments[segments.length - 1];
  if (hasValue) current[leaf] = value;
  else delete current[leaf];
}

function unconditionalOnCreateActions(typeDef: MdbaseTypeDef): V03LifecycleAction[] {
  const raw = typeDef.lifecycle?.on_create;
  if (!raw) return [];
  const actions = Array.isArray(raw) ? raw : [raw];
  return actions.filter(
    (entry): entry is V03LifecycleAction =>
      isRecord(entry) && isRecord(entry.set) && (entry.if === undefined || entry.if === ""),
  );
}

export function unconditionalOnCreateTopLevelFields(typeDef: MdbaseTypeDef): Set<string> {
  const assigned = new Set<string>();
  for (const action of unconditionalOnCreateActions(typeDef)) {
    for (const fieldRef of Object.keys(action.set)) {
      const segments = parseFieldPath(fieldRef);
      if (segments && segments.length === 1) assigned.add(segments[0]);
    }
  }
  return assigned;
}

export function applyCreateLifecycle(
  typeDef: MdbaseTypeDef,
  frontmatter: Record<string, unknown>,
  options: { derivedOnly?: boolean; now?: Date } = {},
): void {
  const actions = unconditionalOnCreateActions(typeDef);
  if (actions.length === 0) return;

  const now = options.now ?? new Date();
  const isoNow = now.toISOString();
  const today = localDateString(now);

  for (const action of actions) {
    const before = deepClone(frontmatter);
    const updates: Array<{ fieldRef: string; hasValue: boolean; value: unknown }> = [];
    for (const [fieldRef, provider] of Object.entries(action.set)) {
      if (!isRecord(provider)) continue;
      if ("now" in provider && provider.now === true) {
        if (!options.derivedOnly) updates.push({ fieldRef, hasValue: true, value: isoNow });
      } else if ("today" in provider && provider.today === true) {
        if (!options.derivedOnly) updates.push({ fieldRef, hasValue: true, value: today });
      } else if ("uuid" in provider && provider.uuid === true) {
        if (!options.derivedOnly) updates.push({ fieldRef, hasValue: true, value: crypto.randomUUID() });
      } else if ("ulid" in provider && provider.ulid === true) {
        if (!options.derivedOnly) updates.push({ fieldRef, hasValue: true, value: generateUlid(now.getTime()) });
      } else if ("literal" in provider) {
        if (!options.derivedOnly) updates.push({ fieldRef, hasValue: true, value: deepClone(provider.literal) });
      } else if ("copy" in provider && typeof provider.copy === "string") {
        const source = getFieldByPath(before, provider.copy);
        if (source.found) updates.push({ fieldRef, hasValue: true, value: deepClone(source.value) });
        else updates.push({ fieldRef, hasValue: false, value: undefined });
      } else if ("slugify" in provider && typeof provider.slugify === "string") {
        const source = getFieldByPath(before, provider.slugify);
        if (source.found && typeof source.value === "string") {
          updates.push({ fieldRef, hasValue: true, value: lifecycleSlugify(source.value) });
        } else {
          updates.push({ fieldRef, hasValue: false, value: undefined });
        }
      }
    }
    for (const update of updates) {
      setFieldByPath(frontmatter, update.fieldRef, update.hasValue, update.value);
    }
  }
}

function coerceDatetimeInput(trimmed: string): string {
  const match = LOCAL_DATETIME_RE.exec(trimmed);
  if (!match) return trimmed;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  const ms = match[7] ? Number(`${match[7]}${"0".repeat(3 - match[7].length)}`) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return trimmed;
  }
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, ms);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return trimmed;
  }
  return date.toISOString();
}

export function buildInitialFrontmatter(
  typeDef: MdbaseTypeDef,
  config: MdbaseConfig,
  options: { applyLifecycle?: boolean } = {},
): Record<string, unknown> {
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

  if (options.applyLifecycle !== false) {
    applyCreateLifecycle(typeDef, frontmatter);
  }
  return frontmatter;
}

export function getPromptFields(
  typeDef: MdbaseTypeDef,
  currentFrontmatter: Record<string, unknown>,
): Array<[string, MdbaseFieldDef]> {
  const fields: Array<[string, MdbaseFieldDef]> = [];
  const autoFields = unconditionalOnCreateTopLevelFields(typeDef);

  for (const [fieldName, fieldDefRaw] of Object.entries(typeDef.fields)) {
    if (!isRecord(fieldDefRaw)) continue;
    const fieldDef = fieldDefRaw as MdbaseFieldDef;
    if (fieldDef.computed) continue;
    if (!fieldDef.required) continue;
    if (currentFrontmatter[fieldName] !== undefined) continue;
    if (autoFields.has(fieldName)) continue;
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
    case "time":
    case "link":
    case "enum":
    case "any":
      return trimmed;
    case "datetime":
      return coerceDatetimeInput(trimmed);
    case "integer": {
      const parsed = Number(trimmed);
      if (!/^[+-]?\d+$/.test(trimmed) || !Number.isSafeInteger(parsed)) throw new Error(t`Expected a whole integer`);
      return parsed;
    }
    case "number": {
      const parsed = Number(trimmed);
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) || !Number.isFinite(parsed)) throw new Error(t`Expected a finite number`);
      return parsed;
    }
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (["true", "1", "yes", "y"].includes(lowered)) return true;
      if (["false", "0", "no", "n"].includes(lowered)) return false;
      throw new Error(t`Expected boolean input: true/false`);
    }
    case "list": {
      if (trimmed.startsWith("[") || /^-\s/.test(trimmed)) {
        const parsed: unknown = parseYaml(trimmed);
        if (!Array.isArray(parsed)) throw new Error(t`Expected a YAML or JSON list`);
        return parsed;
      }
      const values = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (!fieldDef.items) return values;
      return values.map((entry) => coerceFieldInput(entry, fieldDef.items as MdbaseFieldDef));
    }
    case "object": {
      const parsed: unknown = parseYaml(trimmed);
      if (!isRecord(parsed)) {
        throw new Error(t`Expected YAML object value`);
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

/**
 * A file name from a note's name, kept as written so the note reads the same
 * in the file list and in links. Only what a file system or a wikilink can't
 * hold is dropped.
 */
export function fileNameFrom(input: string): string {
  const value = input
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim()
    .replace(/^\.+|[. ]+$/g, "");

  return value.length > 0 ? value : "note";
}

/** The file name a v0.2 `filename_pattern` renders to. */
function slugify(input: string): string {
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

  // Suggestions must not write folders: cancelling a creation form leaves the vault unchanged.
  return candidate;
}

export async function createNoteFromContent(
  vault: Vault,
  path: string,
  content: string,
): Promise<TFile> {
  const normalized = normalizeSafeRelativePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex > 0) {
    await ensureFolderExists(vault, normalized.slice(0, slashIndex));
  }

  if (await vault.adapter.exists(normalized)) {
    throw new Error(t`File already exists: ${normalized}`);
  }

  return vault.create(normalized, content);
}

export async function createNoteFromType(
  vault: Vault,
  path: string,
  frontmatter: Record<string, unknown>,
  body = "",
): Promise<TFile> {
  return createNoteFromContent(vault, path, `${formatMarkdown(frontmatter, body)}\n`);
}
