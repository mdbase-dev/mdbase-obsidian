// Ownership: .mdbase/host.json says which app syncs this folder. .mdbase is
// private, never a mirrored collection path. Another host's marker is never removed.
import { errorInfo, isObject } from "./protocol";
import type NativeSync from "./plugin";

export async function readMarker(sync: NativeSync): Promise<unknown> {
  sync.assertDiskPath(".mdbase/host.json");
  try {
    const marker: unknown = JSON.parse(await sync.host.readText(sync.markerPath));
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("Invalid marker");
    return marker;
  } catch (e: unknown) { if (errorInfo(e).code === "ENOENT") return null; throw new Error("Unreadable ownership marker; waiting for desktop/manual recovery"); }
}
export async function ownsMarker(sync: NativeSync, m?: unknown) {
  if (m === undefined) m = await sync.readMarker();
  return sync.markerMatches(m);
}
export function markerMatches(sync: NativeSync, m: unknown) {
  return isObject(m) && Number.isSafeInteger(sync.data.markerSince) && m.host === "obsidian" && m.collection_id === (sync.data.collectionId ?? null) && m.since_ms === sync.data.markerSince;
}
export function checkOwnership(sync: NativeSync) {
  return sync.host.checkOwnership(text => {
    let marker: unknown = null;
    try {
      marker = text === null ? null : JSON.parse(text);
      if (text !== null && (!marker || typeof marker !== "object" || Array.isArray(marker))) throw new Error("Invalid marker");
    } catch { throw new Error("Unreadable ownership marker; waiting for desktop/manual recovery"); }
    if ((marker && !sync.markerMatches(marker)) || (!marker && sync.mirroring)) throw new Error("Folder owned elsewhere (or ownership marker missing); waiting. Never remove another host's marker.");
  });
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
export function pauseForOwnership(sync: NativeSync, e: unknown) {
  if (!sync.admitting) return;
  sync.admitting = false; sync.mirroring = false;
  sync.setStatus("Another app is syncing this folder. Waiting for it."); sync.fail("ownership", e);
  void sync.call("stop").catch(() => {}); // never removes the competing marker
}
