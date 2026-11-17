import { plural, t } from "@lingui/core/macro";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Bounds in words, e.g. `1–3 items`, `At least 1 character`, `At most 80 characters`. */
function range(min: number | null, max: number | null, unit?: "item" | "character"): string | null {
  if (min !== null && max !== null && min !== max) {
    if (unit === "item") return t`${min}–${plural(max, { one: "# item", other: "# items" })}`;
    if (unit === "character") return t`${min}–${plural(max, { one: "# character", other: "# characters" })}`;
    return `${min}–${max}`;
  }
  const count = min ?? max;
  if (count === null) return null;
  if (min !== null && max !== null) {
    if (unit === "item") return plural(count, { one: "# item", other: "# items" });
    if (unit === "character") return plural(count, { one: "# character", other: "# characters" });
    return String(count);
  }
  if (min !== null) {
    if (unit === "item") return t`At least ${plural(count, { one: "# item", other: "# items" })}`;
    if (unit === "character") return t`At least ${plural(count, { one: "# character", other: "# characters" })}`;
    return t`At least ${count}`;
  }
  if (unit === "item") return t`At most ${plural(count, { one: "# item", other: "# items" })}`;
  if (unit === "character") return t`At most ${plural(count, { one: "# character", other: "# characters" })}`;
  return t`At most ${count}`;
}

/** The label for a field's data shape, as shown in the editor. */
export function fieldTypeLabel(type: string): string {
  if (type === "any") return t`Any value`;
  if (type === "string") return t`Text`;
  if (type === "enum") return t`Choice`;
  if (type === "datetime") return t`Date and time`;
  if (type === "integer") return t`Integer`;
  if (type === "number") return t`Number`;
  if (type === "boolean") return t`Boolean`;
  if (type === "date") return t`Date`;
  if (type === "time") return t`Time`;
  if (type === "list") return t`List`;
  if (type === "object") return t`Object`;
  if (type === "link") return t`Link`;
  return type ? type[0].toUpperCase() + type.slice(1) : type;
}

/** Display text for a YAML scalar (or JSON for anything structured). */
export function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? "";
}

function shortValue(value: unknown): string {
  const text = scalarText(value);
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

/**
 * Compact, human-readable rules for a field row, e.g. `1–3`, `open, done, +2`,
 * `→ project`, `Always note`. Returns an empty list when the field has no constraints.
 */
export function fieldConstraintSummary(definition: Record<string, unknown>): string[] {
  const type = typeof definition.type === "string" ? definition.type : "any";
  const parts: string[] = [];
  if ("const" in definition) { const value = shortValue(definition.const); parts.push(t`Always ${value}`); }
  if (type === "enum" && Array.isArray(definition.values)) {
    const values = definition.values.map(shortValue);
    parts.push(values.length > 3 ? `${values.slice(0, 3).join(", ")}, +${values.length - 3}` : values.join(", ") || t`no values`);
  }
  if (type === "integer" || type === "number") {
    const bounds = range(num(definition.min), num(definition.max));
    if (bounds) parts.push(bounds);
  }
  if (type === "list") {
    const bounds = range(num(definition.min_length), num(definition.max_length), "item");
    if (bounds) parts.push(bounds);
    if (isRecord(definition.items) && typeof definition.items.type === "string") {
      const itemType = fieldTypeLabel(definition.items.type).toLowerCase();
      parts.push(t`of ${itemType}`);
    }
  } else {
    const bounds = range(num(definition.min_length), num(definition.max_length), "character");
    if (bounds) parts.push(bounds);
  }
  if (typeof definition.pattern === "string" && definition.pattern) parts.push(`/${shortValue(definition.pattern)}/`);
  if (type === "link" && typeof definition.target === "string" && definition.target) parts.push(`→ ${definition.target}`);
  if (type === "object" && isRecord(definition.fields)) {
    const count = Object.keys(definition.fields).length;
    parts.push(plural(count, { one: "# field", other: "# fields" }));
  }
  if (definition.default !== undefined) { const value = shortValue(definition.default); parts.push(t`default ${value}`); }
  if (definition.unique === true) parts.push(t`unique`);
  if (definition.deprecated === true) parts.push(t`deprecated`);
  return parts;
}

/**
 * Interpret edited enum text without silently changing value types. A value
 * keeps its own type while the text still parses as that type (so editing `1`
 * to `3` stays a number); a new or string value only becomes a number or
 * boolean when every other value already is one.
 */
export function parseEnumValue(text: string, previous: unknown, others: readonly unknown[]): unknown {
  if (previous !== undefined && scalarText(previous) === text) return previous;
  const numeric = text.trim() !== "" && Number.isFinite(Number(text));
  const boolean = text === "true" || text === "false";
  const siblingsAre = (kind: string) => others.length > 0 && others.every((value) => typeof value === kind);
  if (numeric && (typeof previous === "number" || (typeof previous !== "boolean" && siblingsAre("number")))) return Number(text);
  if (boolean && (typeof previous === "boolean" || (typeof previous !== "number" && siblingsAre("boolean")))) return text === "true";
  return text;
}

/** Parse a default value typed into a text box according to the field type. */
export function parseDefaultValue(text: string, type: string): { value?: unknown; error?: string } {
  if (text === "") return {};
  if (type === "integer" || type === "number") {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return { error: t`Default must be a number.` };
    if (type === "integer" && !Number.isInteger(parsed)) return { error: t`Default must be a whole number.` };
    return { value: parsed };
  }
  if (type === "boolean") {
    if (text === "true") return { value: true };
    if (text === "false") return { value: false };
    return { error: t`Default must be true or false.` };
  }
  return { value: text };
}

// A path glob in plain words where that is simple, e.g. `Library/**/*.md` is
// "Notes in Library and its subfolders"; null when it is not.
export function describePathGlob(glob: string): string | null {
  const pattern = glob.trim().replace(/^\.\//, "");
  if (pattern === "**/*.md" || pattern === "**") return t`All notes`;
  if (pattern === "*.md") return t`Notes at the top of the vault`;
  const folder = /^([^*?[\]{}]+)\/(\*\*\/\*\.md|\*\*)$/.exec(pattern);
  if (folder) { const folderName = folder[1]; return t`Notes in ${folderName} and its subfolders`; }
  const direct = /^([^*?[\]{}]+)\/\*\.md$/.exec(pattern);
  if (direct) { const folderName = direct[1]; return t`Notes in ${folderName}`; }
  return null;
}
