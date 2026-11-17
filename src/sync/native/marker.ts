import { t } from "@lingui/core/macro";
// Ownership: .mdbase/host.json says which app syncs this folder. .mdbase is
// private, never a mirrored collection path. Another host's marker is never
// removed, and a marker is replaced only when the person asks (takeOver).
import { errorInfo, isObject } from "./protocol";
import type NativeSync from "./plugin";

/**
 * How old a plugin marker's heartbeat must be before Sync offers to set up
 * sync here instead. A running plugin rewrites it every 5 s; Chromium throttles
 * a hidden window's timers to about once a minute, and a laptop asleep or a
 * phone in the background writes nothing at all. Ten minutes is far beyond any
 * running host's gap and beyond the few minutes a file-sync service usually
 * takes to carry the file from another device. It is still only a hint: a
 * phone suspended for hours looks the same, which is why taking over always
 * needs the person's click and is never automatic.
 */
export const MARKER_STALE_MS = 10 * 60_000;

/** Who holds this folder, in terms the Sync tab can put into plain words. */
/** `copied`: this vault's sync settings came from another vault or device. */
export type FolderOwner = "desktop" | "obsidian" | "unknown" | "unreadable" | "copied";

/** Startup or a check found the folder held by someone else. */
export interface OwnershipBlock {
  owner: FolderOwner;
  /** The marker looks like an earlier install of this plugin: offer Set up sync here. */
  takeover: boolean;
}

export class FolderOwned extends Error {
  readonly code = "folder_owned";
  constructor(readonly owner: FolderOwner, readonly takeover: boolean, readonly marker: string | null) {
    super(ownerText({ owner, takeover }));
  }
}

/** What the Sync tab and notices say. Never "marker" or "host". */
export function ownerText(block: OwnershipBlock): string {
  if (block.owner === "copied") return t`This vault's sync settings came from another vault or device, so sync is off here. Set up sync here to start fresh. Your notes here are untouched.`;
  if (block.takeover) return t`This vault was set up for sync before, maybe by an earlier install of this plugin. Your notes here are untouched.`;
  switch (block.owner) {
    case "desktop": return t`Another app is already syncing this vault: the mdbase desktop app. Turn sync off there first. Your notes here are untouched.`;
    case "obsidian": return t`Another copy of Obsidian is already syncing this vault, on this device or another one. Turn sync off there first. If you just reinstalled this plugin, you can set up sync here in a few minutes.`;
    case "unreadable": return t`Sync can't tell whether another app is already syncing this vault, so it's waiting. Your notes here are untouched.`;
    default: return t`Another app is already syncing this vault. Turn sync off there first. Your notes here are untouched.`;
  }
}

/**
 * Who a marker that isn't this host's own belongs to, and whether it may be
 * offered for takeover. Only a plugin marker (`host: "obsidian"`) ever is:
 * one whose heartbeat is older than MARKER_STALE_MS, or one written by this
 * same desktop process (a plugin instance unloaded by an uninstall or reload;
 * a live one in this process would be this host). A pid means nothing across
 * devices, so a marker carried here by a file-sync service relies on the
 * heartbeat alone. The desktop app's marker is never offered, however old.
 */
export function classifyMarker(m: unknown, now: number, pid?: number): OwnershipBlock {
  if (!isObject(m)) return { owner: "unreadable", takeover: false };
  if (m.host === "daemon") return { owner: "desktop", takeover: false };
  if (m.host !== "obsidian") return { owner: "unknown", takeover: false };
  const beat = typeof m.heartbeat_ms === "number" && Number.isFinite(m.heartbeat_ms) ? m.heartbeat_ms : null;
  const stale = beat !== null && now - beat > MARKER_STALE_MS;
  const sameProcess = pid !== undefined && m.pid === pid;
  return { owner: "obsidian", takeover: stale || sameProcess };
}

function parseMarker(text: string | null): unknown {
  if (text === null) return null;
  try {
    const marker: unknown = JSON.parse(text);
    if (!isObject(marker)) throw new Error("Invalid marker");
    return marker;
  } catch { throw new FolderOwned("unreadable", false, text); }
}

export async function readMarker(sync: NativeSync): Promise<unknown> {
  return parseMarker(await readMarkerText(sync));
}
/** The marker file's text, or null when there is none. */
export async function readMarkerText(sync: NativeSync): Promise<string | null> {
  sync.assertDiskPath(".mdbase/host.json");
  try { return await sync.host.readText(sync.markerPath); }
  catch (e: unknown) { if (errorInfo(e).code === "ENOENT") return null; throw new FolderOwned("unreadable", false, null); }
}
export async function ownsMarker(sync: NativeSync, m?: unknown) {
  if (m === undefined) m = await sync.readMarker();
  return sync.markerMatches(m);
}
export function markerMatches(sync: NativeSync, m: unknown) {
  return isObject(m) && Number.isSafeInteger(sync.data.markerSince) && m.host === "obsidian" && m.collection_id === (sync.data.collectionId ?? null) && m.since_ms === sync.data.markerSince;
}
export async function checkOwnership(sync: NativeSync) {
  try {
    await sync.host.checkOwnership(text => {
      const marker = parseMarker(text);
      if (marker && !sync.markerMatches(marker)) {
        const { owner, takeover } = classifyMarker(marker, Date.now(), sync.host.processId);
        throw new FolderOwned(owner, takeover, text);
      }
      // Our own marker went while syncing: someone else may be taking over.
      if (!marker && sync.mirroring) throw new FolderOwned("unknown", false, null);
    });
  } catch (e: unknown) {
    if (e instanceof FolderOwned) throw e;
    // The desktop app's folder lock, or a marker that can't be read.
    if (errorInfo(e).code === "folder_locked") throw new FolderOwned("desktop", false, null);
    throw new FolderOwned("unreadable", false, null);
  }
}
export async function claim(sync: NativeSync, id?: string) {
  await sync.checkOwnership();
  if (sync.data.collectionId && sync.data.collectionId !== id) throw Object.assign(new Error("Folder is bound to another collection; drain it before reconfiguration"), { code: "collection_bound" });
  sync.data.collectionId = id; sync.data.markerSince ??= Date.now(); await sync.persist();
  await sync.writeMarker(); await sync.checkOwnership();
  if (!await sync.ownsMarker()) throw new Error("Ownership changed while claiming folder");
}
export async function writeMarker(sync: NativeSync) {
  if (sync.unloaded) return;
  sync.assertDiskPath(".mdbase/host.json");
  await sync.host.mkdir(sync.host.dirname(sync.markerPath));
  if (sync.unloaded) return;
  await sync.host.writeAtomic(sync.markerPath, JSON.stringify({ host: "obsidian", pid: sync.host.processId, collection_id: sync.data.collectionId ?? null, since_ms: sync.data.markerSince, heartbeat_ms: Date.now() }), true);
}
/**
 * Set up sync here, after the person chose to: replace a plugin marker that
 * looks like an earlier install's (see classifyMarker) with this host's own.
 * The marker is read again first; anything but the same takeover-eligible
 * marker (or none at all) refuses, so a live host that wrote meanwhile keeps
 * its folder. The desktop app's marker and a live plugin's are never replaced.
 * The caller restarts the host, which then claims the folder as usual.
 */
export async function takeOver(sync: NativeSync, seen: string | null) {
  const text = await readMarkerText(sync);
  if (text !== null) {
    if (text !== seen) throw new FolderOwned(...classify(text, sync));
    const block = classifyMarker(parseMarker(text), Date.now(), sync.host.processId);
    if (!block.takeover) throw new FolderOwned(block.owner, false, text);
  }
  // The desktop app's folder lock is separate from the marker: it always wins.
  try { await sync.host.checkLock(); }
  catch { throw new FolderOwned("desktop", false, text); }
  sync.data.markerSince = Date.now();
  await sync.persist();
  await sync.writeMarker();
  sync.log("set up sync here: replaced an earlier install's marker at the person's request");
}
export function classify(text: string, sync: NativeSync): [FolderOwner, boolean, string] {
  try {
    const { owner, takeover } = classifyMarker(parseMarker(text), Date.now(), sync.host.processId);
    return [owner, takeover, text];
  } catch { return ["unreadable", false, text]; }
}
export function pauseForOwnership(sync: NativeSync, e: unknown) {
  if (!sync.admitting) return;
  sync.admitting = false; sync.mirroring = false;
  const words = e instanceof FolderOwned ? ownerText({ owner: e.owner, takeover: false }) : ownerText({ owner: "unknown", takeover: false });
  sync.setStatus(words); sync.fail("ownership", e, words, true);
  void sync.call("stop").catch(() => {}); // never removes the competing marker
}
