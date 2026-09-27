function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function range(min: number | null, max: number | null, unit = ""): string | null {
  const suffix = unit ? ` ${unit}` : "";
  if (min !== null && max !== null) return min === max ? `${min}${suffix}` : `${min}–${max}${suffix}`;
  if (min !== null) return `≥ ${min}${suffix}`;
  if (max !== null) return `≤ ${max}${suffix}`;
  return null;
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
 * `→ project`. Returns an empty list when the field has no constraints.
 */
export function fieldConstraintSummary(definition: Record<string, unknown>): string[] {
  const type = typeof definition.type === "string" ? definition.type : "any";
  const parts: string[] = [];
  if (type === "enum" && Array.isArray(definition.values)) {
    const values = definition.values.map(shortValue);
    parts.push(values.length > 3 ? `${values.slice(0, 3).join(", ")}, +${values.length - 3}` : values.join(", ") || "no values");
  }
  if (type === "integer" || type === "number") {
    const bounds = range(num(definition.min), num(definition.max));
    if (bounds) parts.push(bounds);
  }
  if (type === "list") {
    const bounds = range(num(definition.min_length), num(definition.max_length), "items");
    if (bounds) parts.push(bounds);
    if (isRecord(definition.items) && typeof definition.items.type === "string") parts.push(`of ${definition.items.type}`);
  } else {
    const bounds = range(num(definition.min_length), num(definition.max_length), "chars");
    if (bounds) parts.push(bounds);
  }
  if (typeof definition.pattern === "string" && definition.pattern) parts.push(`/${shortValue(definition.pattern)}/`);
  if (type === "link" && typeof definition.target === "string" && definition.target) parts.push(`→ ${definition.target}`);
  if (type === "object" && isRecord(definition.fields)) {
    const count = Object.keys(definition.fields).length;
    parts.push(`${count} ${count === 1 ? "field" : "fields"}`);
  }
  if (definition.default !== undefined) parts.push(`default ${shortValue(definition.default)}`);
  if (definition.unique === true) parts.push("unique");
  if (definition.deprecated === true) parts.push("deprecated");
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
    if (!Number.isFinite(parsed)) return { error: "Default must be a number." };
    if (type === "integer" && !Number.isInteger(parsed)) return { error: "Default must be a whole number." };
    return { value: parsed };
  }
  if (type === "boolean") {
    if (text === "true") return { value: true };
    if (text === "false") return { value: false };
    return { error: "Default must be true or false." };
  }
  return { value: text };
}
