import { diff3Merge } from "node-diff3";

export type MergeOutcome =
  | { clean: true; text: string }
  | { clean: false; reason: string };

/** Returns false when merged frontmatter text is not a YAML mapping. */
export type FrontmatterValidator = (yaml: string) => boolean;

/**
 * Three-way merge of a Markdown record edited on two devices since their last
 * common version. Frontmatter merges per top-level field, keeping each field's
 * exact text; the body merges per line. Anything both sides changed in the
 * same place is not merged: the caller keeps both versions instead. A clean
 * result is always one where every change from both sides survives verbatim.
 */
export function mergeDocuments(
  base: string,
  local: string,
  remote: string,
  validFrontmatter: FrontmatterValidator,
): MergeOutcome {
  if (local === remote || remote === base) return { clean: true, text: local };
  if (local === base) return { clean: true, text: remote };

  const parts = [splitDocument(base), splitDocument(local), splitDocument(remote)];
  if (parts.every((part) => part === null)) {
    const merged = mergeLines(base, local, remote);
    return merged === null
      ? { clean: false, reason: "The line edits could not be merged safely." }
      : { clean: true, text: merged };
  }
  const [b, l, r] = parts;
  if (!b || !l || !r || b.open !== l.open || l.open !== r.open) {
    return { clean: false, reason: "Only one version has frontmatter." };
  }
  const close = mergeValue(b.close, l.close, r.close);
  if (close === null) return { clean: false, reason: "Both versions changed the frontmatter fence." };
  const frontmatter = mergeFrontmatter(b.frontmatter, l.frontmatter, r.frontmatter);
  if (frontmatter === null) return { clean: false, reason: "Both versions changed the same field." };
  const body = mergeLines(b.body, l.body, r.body);
  if (body === null) return { clean: false, reason: "The line edits could not be merged safely." };
  if (frontmatter.length && !validFrontmatter(frontmatter.join("\n") + "\n")) {
    return { clean: false, reason: "The combined frontmatter would not be valid YAML." };
  }
  return { clean: true, text: [l.open, ...frontmatter, close].join("\n") + body };
}

interface DocumentParts {
  /** The opening fence line, including any BOM and carriage return. */
  open: string;
  frontmatter: string[];
  close: string;
  /** Everything after the closing fence line, starting with its newline. */
  body: string;
}

function splitDocument(document: string): DocumentParts | null {
  const lines = document.split("\n");
  if (lines[0]?.replace(/^\uFEFF/, "").replace(/\r$/, "") !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, "") === "---");
  if (end < 0) return null;
  const head = lines.slice(0, end + 1).join("\n");
  return {
    open: lines[0],
    frontmatter: lines.slice(1, end),
    close: lines[end],
    body: document.slice(head.length),
  };
}

function mergeLines(base: string, local: string, remote: string): string | null {
  if (local === remote || remote === base) return local;
  if (local === base) return remote;
  const b = base.split("\n");
  const l = local.split("\n");
  const r = remote.split("\n");
  // node-diff3's LCS is quadratic in the worst case (especially repeated
  // lines). Never freeze Obsidian's UI trying to merge a pathological note:
  // the caller keeps both exact documents instead. Ordinary field/body edits
  // above avoid diffing an unchanged body regardless of its size.
  const work = b.length * (l.length + r.length);
  if (work > 4_000_000) return null;
  const regions = diff3Merge(l, b, r, { excludeFalseConflicts: true });
  const merged: string[] = [];
  for (const region of regions) {
    if (region.conflict) return null;
    for (const line of region.ok ?? []) merged.push(line);
  }
  return merged.join("\n");
}

const PREAMBLE = "\u0000preamble";

interface FieldBlocks {
  order: string[];
  blocks: Map<string, string>;
}

/** Splits frontmatter into top-level fields, each with its continuation lines. */
function fieldBlocks(lines: string[]): FieldBlocks | null {
  const order = [PREAMBLE];
  const blocks = new Map<string, string[]>([[PREAMBLE, []]]);
  let current = PREAMBLE;
  for (const line of lines) {
    const key = /^([^\s#-][^:]*):(?:\s|$)/u.exec(line)?.[1];
    if (key !== undefined) {
      if (blocks.has(key)) return null;
      current = key;
      order.push(key);
      blocks.set(key, [line]);
    } else {
      blocks.get(current)?.push(line);
    }
  }
  return { order, blocks: new Map([...blocks].filter(([, value]) => value.length > 0).map(([key, value]) => [key, value.join("\n")])) };
}

function mergeFrontmatter(base: string[], local: string[], remote: string[]): string[] | null {
  const b = fieldBlocks(base);
  const l = fieldBlocks(local);
  const r = fieldBlocks(remote);
  // Field-wise merging cannot represent moves. A line merge either preserves
  // the reordered text or conservatively keeps both versions.
  const reordered = (ancestor: FieldBlocks, changed: FieldBlocks) => {
    const common = new Set(ancestor.order.filter((key) => changed.blocks.has(key)));
    return ancestor.order.filter((key) => common.has(key)).join("\n")
      !== changed.order.filter((key) => common.has(key)).join("\n");
  };
  if (!b || !l || !r || reordered(b, l) || reordered(b, r) || reordered(l, r)) {
    return mergeLines(base.join("\n"), local.join("\n"), remote.join("\n"))?.split("\n") ?? null;
  }
  const merged = new Map<string, string>();
  for (const key of new Set([...l.order, ...r.order, ...b.order])) {
    const value = mergeValue(b.blocks.get(key), l.blocks.get(key), r.blocks.get(key));
    if (value === null) return null;
    if (value !== undefined) merged.set(key, value);
  }
  // Local order first; fields added on the other device follow the field they followed there.
  const order = l.order.filter((key) => merged.has(key));
  for (const [index, key] of r.order.entries()) {
    if (!merged.has(key) || order.includes(key)) continue;
    const before = r.order.slice(0, index).reverse().find((candidate) => order.includes(candidate));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, key);
  }
  // An absent preamble is different from one containing a single blank line.
  return order.flatMap((key) => (merged.get(key) ?? "").split("\n"));
}

/** `undefined` is an absent field; `null` means both sides changed it differently. */
function mergeValue(base: string | undefined, local: string | undefined, remote: string | undefined): string | undefined | null {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;
  return null;
}
