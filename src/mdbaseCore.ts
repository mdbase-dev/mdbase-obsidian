// The collection data model shared by every module: config, type and issue
// shapes, frontmatter parsing and formatting, and small value helpers.
import { getFrontMatterInfo, normalizePath, parseYaml, stringifyYaml } from "obsidian";

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
  /** v0.2 only. */
  default_strict?: boolean;
  /** v0.2 only; v0.3 expresses a flat collection as an exclusion of every nested path. */
  include_subfolders?: boolean;
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
  lifecycle?: V03Lifecycle;
  originalFrontmatter?: Record<string, unknown>;
}

export type V03LifecycleValue =
  | { now: true }
  | { today: true }
  | { uuid: true }
  | { ulid: true }
  | { slugify: string }
  | { copy: string }
  | { literal: unknown };

export interface V03LifecycleAction {
  if?: string;
  set: Record<string, V03LifecycleValue>;
}

export interface V03Lifecycle {
  on_create?: V03LifecycleAction | V03LifecycleAction[];
  on_update?: V03LifecycleAction | V03LifecycleAction[];
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

interface FrontmatterParse {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  error?: string;
}

export interface CollectionRecord {
  path: string;
  frontmatter: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isV03Version(specVersion: unknown): boolean {
  return typeof specVersion === "string" && specVersion.startsWith("0.3.");
}

export function getRelativeFolder(path: string): string {
  const normalized = normalizePath(path);
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : "";
}

export function resolveJsonPointer(document: unknown, pointer: string): unknown {
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
    const parsed: unknown = parseYaml(yamlSource);
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
