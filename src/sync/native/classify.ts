// How Connect classifies a collection path (runtime/crates/core/src/types.rs,
// Catalog::is_resource_path / is_excluded / is_record_path). Sending a path as
// the wrong kind is refused (not_a_record_path / not_a_file_path), so the plugin
// must agree with the replica before it sends anything.
//
// - resource: mdbase.yaml, the two lock files, anything in the types or contracts
//   folder. Definitions sync through the SDK's resources API, not as records.
// - excluded: any segment starting with "." or equal to node_modules, or a match
//   for a settings.exclude glob. Never synced in either direction.
// - record: a record extension (settings.record_extensions, default md).
// - file: everything else.

export type PathKind = "record" | "file" | "resource" | "excluded";

export interface CollectionLayout {
  typesFolder: string;
  contractsFolder: string;
  recordExtensions: string[];
  exclude: string[];
}

export const CONFIG_PATH = "mdbase.yaml";
const LOCK_PATHS = ["mdbase.lock.yaml", "mdbase.provisions.yaml"];

export const DEFAULT_LAYOUT: CollectionLayout = {
  typesFolder: "_types", contractsFolder: "_contracts", recordExtensions: ["md"], exclude: [],
};

const folder = (v: unknown, fallback: string) =>
  typeof v === "string" && v.trim() ? v.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "") || fallback : fallback;
const strings = (v: unknown): string[] | undefined => Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? v : undefined;

/** The layout from a parsed mdbase.yaml; anything missing or malformed keeps its default. */
export function layoutFromConfig(config: unknown): CollectionLayout {
  const settings = config && typeof config === "object" && !Array.isArray(config)
    ? (config as { settings?: unknown }).settings : undefined;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return DEFAULT_LAYOUT;
  const s = settings as Record<string, unknown>;
  const extensions = strings(s.record_extensions)?.map(e => e.replace(/^\./, "").toLowerCase()).filter(Boolean);
  return {
    typesFolder: folder(s.types_folder, DEFAULT_LAYOUT.typesFolder),
    contractsFolder: folder(s.contracts_folder, DEFAULT_LAYOUT.contractsFolder),
    recordExtensions: extensions?.length ? extensions : DEFAULT_LAYOUT.recordExtensions,
    exclude: strings(s.exclude) ?? [],
  };
}

const inside = (p: string, dir: string) => p.startsWith(`${dir}/`) && p.length > dir.length + 1;

export function isResourcePath(p: string, layout: CollectionLayout): boolean {
  return p === CONFIG_PATH || LOCK_PATHS.includes(p) || inside(p, layout.typesFolder) || inside(p, layout.contractsFolder);
}

export function isExcludedPath(p: string, layout: CollectionLayout): boolean {
  return p.split("/").some(seg => seg.startsWith(".") || seg === "node_modules")
    || layout.exclude.some(g => globMatches(g, p));
}

export function classifyPath(p: string, layout: CollectionLayout): PathKind {
  if (isResourcePath(p, layout)) return "resource";
  if (isExcludedPath(p, layout)) return "excluded";
  const slash = p.lastIndexOf("/"), dot = p.lastIndexOf(".");
  const ext = dot > slash + 1 ? p.slice(dot + 1).toLowerCase() : "";
  return ext && layout.recordExtensions.includes(ext) ? "record" : "file";
}

// spec 02 "Path Globs": whole-path, case-sensitive; `*` and `?` stay inside one
// component, `[...]`/`[!...]` classes, `**` only as a whole component. An
// invalid glob matches nothing (Connect reports it as a config issue).
type Compiled = (RegExp | "**")[];
const globCache = new Map<string, Compiled | null>();
function compile(glob: string): Compiled | null {
  if (glob.startsWith("/") || /[{}\\]/.test(glob)) return null;
  const out: Compiled = [];
  for (const part of glob.split("/")) {
    if (part === "**") { out.push("**"); continue; }
    if (part.includes("**")) return null;
    let re = "";
    for (let i = 0; i < part.length; i++) {
      const c = part[i];
      if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else if (c === "[") {
        const close = part.indexOf("]", i + 2);
        if (close < 0) return null;
        let body = part.slice(i + 1, close), negated = false;
        if (body.startsWith("!")) { negated = true; body = body.slice(1); }
        re += `[${negated ? "^" : ""}${body.replace(/[\\^\]]/g, m => `\\${m}`)}]`;
        i = close;
      } else re += c.replace(/[.+^$()|[\]]/g, m => `\\${m}`);
    }
    out.push(new RegExp(`^${re}$`, "u"));
  }
  return out;
}
export function globMatches(glob: string, p: string): boolean {
  let cached = globCache.get(glob);
  if (cached === undefined) { cached = compile(glob); globCache.set(glob, cached); }
  if (!cached) return false;
  const compiled = cached, parts = p.split("/");
  const match = (g: number, i: number): boolean => {
    if (g === compiled.length) return i === parts.length;
    const c = compiled[g];
    if (c === "**") { for (let k = i; k <= parts.length; k++) if (match(g + 1, k)) return true; return false; }
    return i < parts.length && c.test(parts[i]) && match(g + 1, i + 1);
  };
  return match(0, 0);
}
