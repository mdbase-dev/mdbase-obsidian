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
      const parsed = Number(trimmed);
      if (!/^[+-]?\d+$/.test(trimmed) || !Number.isSafeInteger(parsed)) throw new Error("Expected a whole integer");
      return parsed;
    }
    case "number": {
      const parsed = Number(trimmed);
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) || !Number.isFinite(parsed)) throw new Error("Expected a finite number");
      return parsed;
    }
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (["true", "1", "yes", "y"].includes(lowered)) return true;
      if (["false", "0", "no", "n"].includes(lowered)) return false;
      throw new Error("Expected boolean input: true/false");
    }
    case "list": {
      if (trimmed.startsWith("[") || /^-\s/.test(trimmed)) {
        const parsed: unknown = parseYaml(trimmed);
        if (!Array.isArray(parsed)) throw new Error("Expected a YAML or JSON list");
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

  // Suggestions must not write folders: cancelling a creation form leaves the vault unchanged.
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
