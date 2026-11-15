// Resolving which types apply to a note: explicit type keys, then each type's
// match rules (path glob, fields present, structured where).
import picomatch from "picomatch";
import { portableGlobMatch } from "./pathGlob";
import { isRecord, isV03Version, type MdbaseConfig, type MdbaseTypeDef } from "./mdbaseCore";

function getExplicitTypes(frontmatter: Record<string, unknown>, explicitTypeKeys: string[]): string[] | null {
  for (const key of explicitTypeKeys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      const typeNames = value.filter((entry): entry is string => typeof entry === "string");
      return typeNames;
    }
  }

  for (const key of explicitTypeKeys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return [value.trim()];
    }
  }

  return null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function getWhereField(
  frontmatter: Record<string, unknown>,
  path: string,
): { present: boolean; value: unknown } {
  let current: unknown[] = [frontmatter];
  for (const segment of path.split(".").filter(Boolean)) {
    const expandArray = segment.endsWith("[]");
    const key = expandArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of current) {
      if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) continue;
      const child = value[key];
      if (expandArray && Array.isArray(child)) next.push(...child as unknown[]);
      else if (!expandArray) next.push(child);
    }
    if (!next.length) return { present: false, value: undefined };
    current = next;
  }
  return { present: true, value: current[0] };
}

function compareWhere(
  left: unknown,
  right: unknown,
  predicate: (left: number | string, right: number | string) => boolean,
): boolean {
  if (typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)) {
    return predicate(left, right);
  }
  return typeof left === "string" && typeof right === "string" && predicate(left, right);
}

function matchesWhereOperator(
  selected: { present: boolean; value: unknown },
  operator: string,
  expected: unknown,
  specVersion: string,
): boolean {
  const equals = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  switch (operator) {
    case "eq":
    case "const":
      return selected.present && selected.value != null && equals(selected.value, expected);
    case "neq":
      return selected.present && selected.value != null && !equals(selected.value, expected);
    case "gt":
      return compareWhere(selected.value, expected, (left, right) => left > right);
    case "gte":
      return compareWhere(selected.value, expected, (left, right) => left >= right);
    case "lt":
      return compareWhere(selected.value, expected, (left, right) => left < right);
    case "lte":
      return compareWhere(selected.value, expected, (left, right) => left <= right);
    case "exists":
      return specVersion.startsWith("0.3.")
        ? expected === true ? selected.present : !selected.present
        : expected === true
          ? selected.present && selected.value != null
          : !selected.present || selected.value == null;
    case "contains":
      return Array.isArray(selected.value)
        ? selected.value.some((entry) => equals(entry, expected))
        : typeof selected.value === "string" && selected.value.includes(String(expected));
    case "containsAll":
      if (!Array.isArray(selected.value) || !Array.isArray(expected)) return false;
      return expected.every((wanted) => (selected.value as unknown[]).some((entry) => equals(entry, wanted)));
    case "containsAny":
      if (!Array.isArray(selected.value) || !Array.isArray(expected)) return false;
      return expected.some((wanted) => (selected.value as unknown[]).some((entry) => equals(entry, wanted)));
    case "in":
      return selected.value != null && Array.isArray(expected)
        && expected.some((entry) => equals(entry, selected.value));
    case "startsWith":
    case "starts_with":
      return typeof selected.value === "string" && typeof expected === "string"
        && selected.value.startsWith(expected);
    case "endsWith":
    case "ends_with":
      return typeof selected.value === "string" && typeof expected === "string"
        && selected.value.endsWith(expected);
    case "matches":
      try {
        return typeof selected.value === "string" && typeof expected === "string"
          && new RegExp(expected.replace(/\\\\/g, "\\")).test(selected.value);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function matchesStructuredWhere(
  where: Record<string, unknown>,
  frontmatter: Record<string, unknown>,
  specVersion: string,
): boolean {
  if ("and" in where) {
    return Array.isArray(where.and)
      && where.and.every((condition) => isRecord(condition)
        && matchesStructuredWhere(condition, frontmatter, specVersion));
  }
  if ("or" in where) {
    return Array.isArray(where.or)
      && where.or.some((condition) => isRecord(condition)
        && matchesStructuredWhere(condition, frontmatter, specVersion));
  }
  if ("not" in where) {
    return isRecord(where.not) && !matchesStructuredWhere(where.not, frontmatter, specVersion);
  }
  for (const [field, condition] of Object.entries(where)) {
    const selected = getWhereField(frontmatter, field);
    if (!isRecord(condition)) {
      if (!selected.present || canonicalJson(selected.value) !== canonicalJson(condition)) return false;
      continue;
    }
    for (const [operator, expected] of Object.entries(condition)) {
      if (!matchesWhereOperator(selected, operator, expected, specVersion)) return false;
    }
  }
  return true;
}

export function getTypesForFile(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  config: MdbaseConfig,
  types: Map<string, MdbaseTypeDef>,
): string[] {
  const explicit = getExplicitTypes(frontmatter, config.settings.explicit_type_keys);
  if (explicit) return explicit;

  const matched: string[] = [];
  for (const [typeName, typeDef] of types.entries()) {
    const match = typeDef.match;
    if (!match) continue;

    let isMatch = true;

    if (typeof match.path_glob === "string" && !globMatches(match.path_glob, relativePath, config)) {
      isMatch = false;
    }

    if (isMatch && Array.isArray(match.fields_present)) {
      for (const key of match.fields_present) {
        if (!(key in frontmatter)) {
          isMatch = false;
          break;
        }
      }
    }

    if (isMatch && isRecord(match.where)) {
      isMatch = matchesStructuredWhere(match.where, frontmatter, config.spec_version);
    }

    if (isMatch && typeof match.where === "string") {
      // String expressions are not evaluated in this plugin.
      isMatch = false;
    }

    if (isMatch) matched.push(typeName);
  }

  return matched;
}

/** Match a collection path glob; v0.3 uses the portable grammar of Chapter 02. */
function globMatches(pattern: string, relativePath: string, config: MdbaseConfig): boolean {
  return isV03Version(config.spec_version)
    ? portableGlobMatch(pattern, relativePath)
    : picomatch(pattern, { dot: true })(relativePath);
}
