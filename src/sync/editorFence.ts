/**
 * The editor fence (replica-client-api §14): changes from other devices reach an
 * open note through its editor, not its file.
 *
 * Obsidian saves the whole buffer about 2 s after the first unsaved keystroke,
 * so a file write landing in that window would be reverted. While a note is
 * open, mdbase sends the change here and it goes in as one minimal CodeMirror
 * transaction; Obsidian's own save then writes it. An edit is applied only to a
 * buffer whose content hashes to the change's base; if the person typed in the
 * meantime the answer is `buffer_changed` and mdbase holds or replans.
 *
 * Adapted from the mdbase obsidian-runtime package's `ObsidianEditorFence`.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** The parts of Obsidian's `Editor` used. Offsets are UTF-16 code units. */
export interface EditorLike {
  getValue(): string;
  offsetToPos(offset: number): { line: number; ch: number };
  transaction(tx: { changes: { from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }[] }, origin?: string): void;
}

/** The parts of a `MarkdownView` used, including its private save state. */
export interface MarkdownViewLike {
  file: { path: string } | null;
  editor: EditorLike;
  dirty?: unknown;
  saving?: unknown;
  lastSavedData?: unknown;
}

export interface WorkspaceLike {
  getLeavesOfType(type: "markdown"): { view: unknown }[];
}

/** One `fence_report` entry. `buffer` is `sha256:<hex>`. */
export interface FenceEntry {
  path: string;
  dirty: boolean;
  buffer: string;
}

/** One `fence_apply` request: `[start, end, insert]` edits in Unicode scalar offsets. */
export interface FenceRequest {
  path: string;
  base: string;
  edits: [number, number, string][];
  expected: string;
}

export type FenceOutcome = { outcome: "applied" } | { outcome: "not_open" } | { outcome: "buffer_changed"; buffer: string };

export const hashText = (text: string): string => `sha256:${bytesToHex(sha256(utf8ToBytes(text)))}`;

function asView(value: unknown): MarkdownViewLike | null {
  const view = value as MarkdownViewLike;
  return view && typeof view === "object" && view.editor && typeof view.editor.getValue === "function" && view.file ? view : null;
}

/** Convert Unicode-scalar offsets in `text` to UTF-16 offsets. */
export function scalarToUtf16(text: string, offsets: readonly number[]): number[] {
  const order = offsets.map((offset, index) => [offset, index] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(offsets.length);
  let scalar = 0;
  let unit = 0;
  let k = 0;
  while (k < order.length) {
    const [want, index] = order[k];
    if (want === scalar) {
      out[index] = unit;
      k++;
      continue;
    }
    if (unit >= text.length) throw new RangeError(`offset ${want} is beyond the document`);
    const code = text.charCodeAt(unit);
    unit += code >= 0xd800 && code <= 0xdbff && unit + 1 < text.length ? 2 : 1;
    scalar++;
  }
  return out;
}

/** Apply scalar-offset edits to a string. */
export function applyScalarEdits(text: string, edits: readonly (readonly [number, number, string])[]): string {
  const sorted = [...edits].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) if (sorted[i][0] < sorted[i - 1][1]) throw new RangeError("overlapping edits");
  const units = scalarToUtf16(text, sorted.flatMap((edit) => [edit[0], edit[1]]));
  let out = "";
  let at = 0;
  sorted.forEach((edit, i) => {
    out += text.slice(at, units[2 * i]) + edit[2];
    at = units[2 * i + 1];
  });
  return out + text.slice(at);
}

/** The single replacement turning `a` into `b` (common prefix and suffix), in UTF-16 offsets. */
export function minimalChange(a: string, b: string): { from: number; to: number; text: string } | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHigh(a.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  if (suffix > 0 && isLow(a.charCodeAt(a.length - suffix))) suffix--;
  return { from: prefix, to: a.length - suffix, text: b.slice(prefix, b.length - suffix) };
}
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The fence for one vault. `prefix` is the collection's folder inside the vault
 * ("" when the vault is the collection); fence paths are collection paths.
 */
export class EditorFence {
  constructor(private readonly workspace: WorkspaceLike, private readonly prefix: string) {}

  private toVault(path: string): string {
    return this.prefix ? `${this.prefix}/${path}` : path;
  }

  private toCollection(path: string): string | null {
    if (!this.prefix) return path;
    return path.startsWith(`${this.prefix}/`) ? path.slice(this.prefix.length + 1) : null;
  }

  private views(vaultPath?: string): MarkdownViewLike[] {
    const out: MarkdownViewLike[] = [];
    for (const leaf of this.workspace.getLeavesOfType("markdown")) {
      const view = asView(leaf.view);
      if (view && (vaultPath === undefined || view.file?.path === vaultPath)) out.push(view);
    }
    return out;
  }

  /**
   * Unsaved changes, read from Obsidian's private save state. When that state
   * doesn't look as expected, report dirty, so mdbase waits rather than writes.
   */
  private dirty(view: MarkdownViewLike): boolean {
    if (typeof view.lastSavedData !== "string") return true;
    return view.dirty === true || view.saving === true || view.editor.getValue() !== view.lastSavedData;
  }

  /** Every open note in the collection with its dirty flag and buffer hash. */
  report(): FenceEntry[] {
    const out = new Map<string, FenceEntry>();
    for (const view of this.views()) {
      const path = view.file ? this.toCollection(view.file.path) : null;
      if (path === null) continue;
      const entry = out.get(path);
      const dirty = this.dirty(view) || (entry?.dirty ?? false);
      out.set(path, { path, dirty, buffer: entry?.buffer ?? hashText(view.editor.getValue()) });
    }
    return [...out.values()];
  }

  /** Apply a change to every open buffer of the note whose content is the change's base. */
  apply(request: FenceRequest): FenceOutcome {
    const views = this.views(this.toVault(request.path));
    if (!views.length) return { outcome: "not_open" };
    for (const view of views) {
      const before = view.editor.getValue();
      const hash = hashText(before);
      if (hash === request.expected) continue; // a split view of the same note already has it
      if (hash !== request.base) return { outcome: "buffer_changed", buffer: before };
      let next: string;
      try {
        next = applyScalarEdits(before, request.edits);
      } catch {
        return { outcome: "buffer_changed", buffer: before };
      }
      if (hashText(next) !== request.expected) return { outcome: "buffer_changed", buffer: before };
      const change = minimalChange(before, next);
      if (change) {
        view.editor.transaction({ changes: [{ from: view.editor.offsetToPos(change.from), to: view.editor.offsetToPos(change.to), text: change.text }] }, "mdbase.sync");
      }
    }
    return { outcome: "applied" };
  }
}
