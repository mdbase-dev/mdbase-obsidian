/**
 * Portable mdbase path globs (spec Chapter 02, "Path Globs").
 *
 * `*` and `?` match within one path component, `[...]` matches one character
 * from a set or range (`[!...]` negates), and `**` as a whole component
 * matches zero or more components. Matching is case-sensitive over Unicode
 * code points and always covers the complete collection-relative path.
 */
export function portableGlobMatch(pattern: string, path: string): boolean {
  return matchComponents(path.split("/"), pattern.split("/"));
}

/** Retry only the most recent wildcard, not every possible suffix recursively. */
function matchComponents(path: string[], pattern: string[]): boolean {
  let text = 0;
  let token = 0;
  let star = -1;
  let retry = 0;
  while (text < path.length) {
    if (pattern[token] === "**") {
      star = token++;
      retry = text;
    } else if (token < pattern.length && matchSegment(path[text], pattern[token])) {
      text++;
      token++;
    } else if (star >= 0) {
      token = star + 1;
      text = ++retry;
    } else return false;
  }
  while (pattern[token] === "**") token++;
  return token === pattern.length;
}

interface CharacterClass {
  negated: boolean;
  ranges: Array<[number, number]>;
}
type SegmentToken = string | CharacterClass;

function matchSegment(value: string, pattern: string): boolean {
  const text = [...value];
  const tokens = segmentTokens([...pattern]);
  let character = 0;
  let token = 0;
  let star = -1;
  let retry = 0;
  while (character < text.length) {
    if (tokens[token] === "*") {
      star = token++;
      retry = character;
    } else if (matchesCharacter(tokens[token], text[character])) {
      character++;
      token++;
    } else if (star >= 0) {
      token = star + 1;
      character = ++retry;
    } else return false;
  }
  while (tokens[token] === "*") token++;
  return token === tokens.length;
}

function matchesCharacter(token: SegmentToken | undefined, character: string): boolean {
  if (token === undefined) return false;
  if (typeof token === "string") return token === "?" || token === character;
  const point = codePoint(character);
  return token.ranges.some(([low, high]) => low <= point && point <= high) !== token.negated;
}

function segmentTokens(pattern: string[]): SegmentToken[] {
  const tokens: SegmentToken[] = [];
  for (let index = 0; index < pattern.length;) {
    const parsed = pattern[index] === "[" ? parseClass(pattern, index + 1) : undefined;
    if (parsed) {
      tokens.push(parsed.token);
      index = parsed.after;
    } else tokens.push(pattern[index++]);
  }
  return tokens;
}

/** Parse after `[`. An incomplete class remains literal, as the spec requires. */
function parseClass(pattern: string[], start: number): { token: CharacterClass; after: number } | undefined {
  const negated = pattern[start] === "!";
  const ranges: Array<[number, number]> = [];
  let index = start + (negated ? 1 : 0);
  let first = true;
  while (index < pattern.length) {
    const c = pattern[index];
    if (c === "]" && !first) return { token: { negated, ranges }, after: index + 1 };
    if (index + 2 < pattern.length && pattern[index + 1] === "-" && pattern[index + 2] !== "]") {
      ranges.push([codePoint(c), codePoint(pattern[index + 2])]);
      index += 3;
    } else {
      ranges.push([codePoint(c), codePoint(c)]);
      index++;
    }
    first = false;
  }
  return undefined;
}

/** The code point of a one-character string produced by spreading a string. */
function codePoint(character: string): number {
  return character.codePointAt(0) ?? 0;
}
