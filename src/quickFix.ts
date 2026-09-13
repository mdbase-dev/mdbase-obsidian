import { stringifyYaml } from "obsidian";
import { parseFrontmatter, type MdbaseIssue } from "./mdbaseCore";

export function applyQuickFixToDocument(raw: string, issue: MdbaseIssue): { content: string; changed: boolean } {
  const parsed = parseFrontmatter(raw);
  if (parsed.error) throw new Error(`Invalid frontmatter: ${parsed.error}`);
  if (!applyFieldQuickFix(parsed.frontmatter, issue)) return { content: raw, changed: false };
  // Generic Markdown formatting normalizes body whitespace. Quick fixes must
  // replace only frontmatter and preserve every byte following its delimiter.
  const yaml = stringifyYaml(parsed.frontmatter).trimEnd();
  return { content: `---\n${yaml}\n---\n${parsed.body}`, changed: true };
}

function target(issue: MdbaseIssue): string[] | null {
  if (!issue.field) return null;
  if (["unknown_field", "missing_required"].includes(issue.code)) {
    // Legacy nested paths are ambiguous; only offer unambiguous fixes.
    return /[.[\]]/.test(issue.field) ? null : [issue.field];
  }
  if (!["schema_additional_properties", "schema_required"].includes(issue.code)) return null;
  const pointer = issue.details?.instance_path;
  const property = issue.details?.property;
  if (typeof pointer !== "string" || typeof property !== "string") return null;
  return [...(pointer === "" ? [] : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))), property];
}

export function quickFixLabel(issue: MdbaseIssue): string | null {
  if (!target(issue)) return null;
  return ["unknown_field", "schema_additional_properties"].includes(issue.code) ? "Remove field" : "Add placeholder";
}

/** Mutate only an own property of the exact parent identified by validation. */
export function applyFieldQuickFix(frontmatter: Record<string, unknown>, issue: MdbaseIssue): boolean {
  const path = target(issue);
  if (!path?.length) return false;
  let parent: unknown = frontmatter;
  for (const segment of path.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, segment)) return false;
    parent = (parent as Record<string, unknown>)[segment];
  }
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return false;
  const object = parent as Record<string, unknown>;
  const key = path[path.length - 1];
  const exists = Object.prototype.hasOwnProperty.call(object, key);
  if (["unknown_field", "schema_additional_properties"].includes(issue.code)) {
    if (!exists) return false;
    delete object[key];
  } else {
    if (exists) return false;
    Object.defineProperty(object, key, { value: "TODO", enumerable: true, configurable: true, writable: true });
  }
  return true;
}
