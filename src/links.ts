// Links between typed notes: which fields link and to what, the notes a link
// can point at, and the note a new or missing link asks for. No UI here.
import {
  type CollectionRecord,
  type MdbaseConfig,
  type MdbaseIssue,
  type MdbaseTypeDef,
} from "./mdbaseCore";
import { isExcluded } from "./collectionConfig";
import { normalizeSafeRelativePath, resolveFolderForType } from "./noteCreation";
import { getTypesForFile } from "./typeMatching";

/** A note a link can point at. */
export interface LinkTarget {
  path: string;
  /** What the note is called: its type's display name, else its file name. */
  name: string;
  types: string[];
}

/** One row of a link suggestion list. */
export type LinkRow =
  | { kind: "note"; target: LinkTarget }
  | { kind: "create"; type: MdbaseTypeDef; name: string }
  /** Create a note of a type that has no row of its own. */
  | { kind: "other"; name: string };

const NOTE_ROWS = 8;
const CREATE_ROWS = 4;

export function displayNameKey(type: MdbaseTypeDef): string {
  return type.display_name_key ?? "title";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

/** The target of a wikilink, Markdown link or bare path, without alias, heading or brackets. */
export function parseLinkReference(raw: string): string {
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

export function isWebLink(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * Whether a field holds one link, and the type it must point at. `type` is
 * absent when any note will do. Null for fields that aren't a single link.
 */
export function linkField(type: MdbaseTypeDef, fieldName: string): { type?: string } | null {
  const field = type.fields[fieldName];
  if (!field || field.type === "list") return null;
  const rule = type.collection?.links?.[fieldName];
  if (!rule && field.type !== "link") return null;
  const target = rule ? rule.target_type : field.target;
  return target && target !== "any" ? { type: target } : {};
}

/** Every note a link can point at, named by its type's display field. */
export function linkTargets(
  records: Iterable<CollectionRecord>,
  config: MdbaseConfig,
  types: Map<string, MdbaseTypeDef>,
): LinkTarget[] {
  const targets: LinkTarget[] = [];
  for (const record of records) {
    const names = getTypesForFile(record.path, record.frontmatter, config, types).filter((name) => types.has(name));
    let name = "";
    for (const typeName of names) {
      const value = record.frontmatter[displayNameKey(types.get(typeName) as MdbaseTypeDef)];
      if (typeof value === "string" && value.trim()) {
        name = value.trim();
        break;
      }
    }
    targets.push({ path: record.path, name: name || basename(record.path), types: names });
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** Lower is better; null doesn't match. */
function rank(target: LinkTarget, query: string): number | null {
  const name = target.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[\s\-_.,:;/()]+/).some((word) => word.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  return target.path.toLowerCase().includes(query) ? 4 : null;
}

/** Notes matching what was typed, best first. `type` keeps only notes of that type. */
export function searchLinkTargets(targets: readonly LinkTarget[], query: string, type?: string, limit = NOTE_ROWS): LinkTarget[] {
  const lowered = query.trim().toLowerCase();
  const ranked: Array<{ target: LinkTarget; rank: number }> = [];
  for (const target of targets) {
    if (type && !target.types.includes(type)) continue;
    const score = lowered ? rank(target, lowered) : 0;
    if (score !== null) ranked.push({ target, rank: score });
  }
  // `targets` is already in name order, which a stable sort keeps within a rank.
  return ranked.sort((a, b) => a.rank - b.rank).slice(0, limit).map((entry) => entry.target);
}

/**
 * The suggestion list for what was typed: matching notes, then a row to create
 * a note of that name. With `type`, only that type is searched and created.
 * Without it, the most used types get a create row each and the rest share one.
 */
export function linkRows(
  targets: readonly LinkTarget[],
  query: string,
  types: Map<string, MdbaseTypeDef>,
  type?: string,
): LinkRow[] {
  const name = query.trim();
  const rows: LinkRow[] = searchLinkTargets(targets, name, type).map((target) => ({ kind: "note", target }));
  if (!name) return rows;
  const lowered = name.toLowerCase();
  const exists = (typeName: string): boolean =>
    targets.some((target) => target.types.includes(typeName) && target.name.toLowerCase() === lowered);
  if (type) {
    const definition = types.get(type);
    if (definition && !exists(type)) rows.push({ kind: "create", type: definition, name });
    return rows;
  }
  const used = new Map<string, number>();
  for (const target of targets) for (const typeName of target.types) used.set(typeName, (used.get(typeName) ?? 0) + 1);
  const ordered = [...types.values()].sort((a, b) =>
    (used.get(b.name) ?? 0) - (used.get(a.name) ?? 0) || a.name.localeCompare(b.name));
  const shown = ordered.length > CREATE_ROWS + 1 ? ordered.slice(0, CREATE_ROWS) : ordered;
  for (const definition of shown) if (!exists(definition.name)) rows.push({ kind: "create", type: definition, name });
  if (shown.length < ordered.length) rows.push({ kind: "other", name });
  return rows;
}

/** A link as a frontmatter value: a wikilink by full path, with the name when the file is called something else. */
export function wikilink(target: Pick<LinkTarget, "path" | "name">): string {
  const path = target.path.replace(/\.md$/i, "");
  return target.name && target.name !== basename(path) ? `[[${path}|${target.name}]]` : `[[${path}]]`;
}

/** The note a missing link asks for. */
export interface MissingLinkNote {
  type: MdbaseTypeDef;
  name: string;
  /** Where the note has to be for the link to resolve as written. */
  path: string;
}

/**
 * The note that would satisfy a missing-link issue, when its field says which
 * type it must be. A link written with a folder is created there; a bare name
 * goes where notes of the type go.
 */
export function missingLinkNote(
  issue: MdbaseIssue,
  config: MdbaseConfig,
  types: Map<string, MdbaseTypeDef>,
): MissingLinkNote | null {
  if (issue.code !== "link_not_found" && issue.code !== "missing_link_target") return null;
  const link = issue.details?.link;
  const targetType = issue.details?.target_type;
  const type = typeof targetType === "string" ? types.get(targetType) : undefined;
  if (typeof link !== "string" || !type) return null;
  const reference = parseLinkReference(link).replace(/\.md$/i, "");
  if (!reference || isWebLink(reference)) return null;
  const name = basename(reference);
  const folder = reference.includes("/") ? "" : resolveFolderForType(type, { [displayNameKey(type)]: name });
  let path: string;
  try {
    path = normalizeSafeRelativePath(`${folder ? `${folder}/` : ""}${reference}.md`);
  } catch {
    return null;
  }
  if (!name || path.split("/").some((segment) => segment.startsWith(".")) || isExcluded(path, config)) return null;
  return { type, name, path };
}
