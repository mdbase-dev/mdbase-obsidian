// The sync engine's phases, and what the person does about them: sign in, pick
// a collection, unlock it, combine, sign out, start over, hand over.
import { Notice } from "obsidian";
import type { NativePhase } from "./protocol";
import { AWAITING_APPROVAL, HANDED_OVER, NEEDS_APPROVAL, SIGN_IN_STOPPED, STARTING_STALLED, readyText, signOutText, stoppedText, syncOffline, type SignOutResult } from "../words";
import { chooseCollection } from "./choosers";
import type NativeSync from "./plugin";

/** Status text while a Private collection waits for its key, by how the account unlocks. */
const LOCKED_TEXT: Record<string, string> = {
  password: "Enter your encryption password to sync this Private collection.",
  strict: "This Private collection can't be unlocked in Obsidian.",
  none: "Set an encryption password to sync this Private collection.",
};

export async function onPhase(sync: NativeSync, phase: NativePhase) {
  // After a handover the SDK is stopped; its closing notices change nothing here.
  if (sync.phase.kind === "handed_over") return;
  const was = sync.phase; sync.phase = phase;
  if (phase.kind !== "starting") sync.endStartWatch();
  else if (was.kind !== "starting") sync.watchStart();
  // Apply the transition before awaiting select/watch. A ready notification
  // can arrive while the earlier choosing handler is still awaiting select;
  // that older handler must not turn mirroring off again after ready wins.
  if (phase.kind !== "ready") sync.mirroring = false;
  if (["ready", "signed_out", "problem", "closed"].includes(phase.kind)) sync.signInUrl = null;
  const phaseText: Record<string, string> = {
    starting: sync.stalled ? STARTING_STALLED : "Starting sync", signed_out: "Sign in to sync this vault.",
    authorizing: sync.data?.collectionId ? AWAITING_APPROVAL : "Finish signing in in your browser.",
    choosing: "Choose the collection to sync with this vault.", opening: "Getting your collection ready.",
    needs_unlock: phase.unlock?.unlocking ? "Unlocking your collection." : LOCKED_TEXT[phase.unlock?.mode ?? "password"],
    needs_approval: NEEDS_APPROVAL,
    problem: "Sync needs attention. Your files are kept on this device.", closed: "Sync stopped. Your files stay here.",
  };
  // A later notice of the same stop (its sync counts or collection list
  // changed) keeps the words saying why, not the generic problem text.
  const sameStop = phase.kind !== "ready" && phase.kind !== "needs_unlock" && phase.kind === was.kind && phase.problem && JSON.stringify(phase.problem) === JSON.stringify(was.problem);
  if (sync.admitting && sameStop) sync.refreshStatus();
  else if (sync.admitting && !(phase.kind === "ready" && (sync.syncingFiles || sync.startingMirror || sync.reconcileRetryTimer !== null)))
    sync.setStatus(phase.kind === "ready" ? phase.sync ? readyText(phase.sync) : "Checking your files" : phaseText[phase.kind] ?? "Starting sync");
  // A pass in progress keeps its own progress text, but going offline or
  // coming back must still reach the UI; "Uploading 83 of 500" would
  // otherwise stay up for as long as the connection is down (QA2-1).
  else if (sync.admitting && phase.sync?.state !== was.sync?.state) sync.refreshStatus();
  // Names/documents never belong in this log.
  sync.log(`phase ${phase.kind}${phase.problem ? ` ${phase.problem.code ?? ""} ${phase.problem.reason ?? ""}` : ""}${phase.sync ? ` sync=${phase.sync.state} pending=${phase.sync.pending}` : ""}`);
  // A wrong password is shown beside the form; it doesn't stop sync.
  if (sync.admitting && phase.kind !== "needs_unlock" && phase.problem && JSON.stringify(phase.problem) !== JSON.stringify(was.problem))
    sync.fail("sync", phase.problem, sync.needsRestart && sync.canStartOver ? SIGN_IN_STOPPED : stoppedText(phase.problem), true);
  if (syncOffline(phase.sync) && !syncOffline(was.sync))
    new Notice("mdbase: sync service unreachable. Changes are saved on this device and will sync when the connection returns.", 10000);
  if (sync.admitting && (phase.kind === "opening" || phase.kind === "needs_unlock") && phase.collectionId) {
    try { await sync.claim(phase.collectionId ?? undefined); } catch (e) { sync.pauseForOwnership(e); return; }
  }
  if (sync.admitting && phase.kind === "choosing") {
    const bound = phase.collections?.find((c: { id: string }) => c.id === sync.data.collectionId);
    if (bound) await sync.select(bound.id);
    else if (!sync.data.collectionId && !sync.pickManually && phase.collections?.length === 1) await sync.select(phase.collections[0].id);
  }
  // select() can publish opening/ready before its promise settles. The older
  // choosing handler must not subsequently turn off the now-ready mirror.
  if (sync.unloaded || sync.phase !== phase) return;
  if (sync.admitting && phase.kind === "ready" && (was.kind !== "ready" || was.collectionId !== phase.collectionId)) {
    try { await sync.claim(phase.collectionId ?? undefined); } catch (e) { sync.pauseForOwnership(e); return; }
    if (await sync.needsMergeConfirmation(phase)) return;
    await sync.startMirror();
  }
}
export async function select(sync: NativeSync, id: string) { sync.pickManually = false; await sync.claim(id); await sync.call("select", id); }
export async function addCollection(sync: NativeSync) {
  // SDK approval selects the newly added collection. A bound mirror cannot
  // follow that switch without putting its existing files in another collection.
  if (sync.data.collectionId) {
    sync.fail("add collection", { code: "collection_bound" }); return;
  }
  await sync.call("addCollection");
}
/**
 * Before the first sync, a vault with notes and a collection with items would
 * be combined in both directions. That needs the user's say-so: the single
 * collection is picked automatically, so it may not be the one they meant.
 */
export async function needsMergeConfirmation(sync: NativeSync, phase: NativePhase): Promise<boolean> {
  if (sync.data.cursor !== undefined || Object.keys(sync.data.paths).length || sync.data.mergeConfirmed === phase.collectionId) return false;
  const remotes = await sync.remoteAll(); // also reads the layout
  if (sync.unloaded || sync.phase !== phase) return true;
  const remote = [...remotes.values()].filter(r => r.kind !== "resource").length;
  const local = (await sync.localPaths()).filter(p => sync.kindOf(p) !== "resource").length;
  if (!remote || !local) return false;
  const name = phase.collections?.find((c: { id: string }) => c.id === phase.collectionId)?.name ?? "this collection";
  if (!phase.collectionId) throw new Error("Missing collection identity");
  sync.merge = { collectionId: phase.collectionId, name, local, remote };
  sync.log(`waiting for merge confirmation: local=${local} remote=${remote}`);
  sync.setStatus(`Waiting for you: this vault and “${name}” both have notes.`);
  return true;
}
/**
 * Unlock the Private collection this vault is waiting on. The secret goes to
 * the sync engine for this one call and is kept nowhere here. A wrong one
 * comes back on the phase (`phase.problem`), not as an error.
 */
export async function unlock(sync: NativeSync, secret: { password: string } | { recoveryKey: string }) {
  const phase = sync.phase;
  if (phase.kind !== "needs_unlock" || phase.unlock?.unlocking || !phase.collectionId) return;
  await sync.call("unlock", phase.collectionId, secret);
}
/** Read again how the account unlocks (after setting a password elsewhere). */
export async function recheckLock(sync: NativeSync) {
  if (sync.phase.kind === "needs_unlock" && sync.phase.collectionId) await sync.select(sync.phase.collectionId);
}
export async function confirmMerge(sync: NativeSync) {
  const m = sync.merge, phase = sync.phase;
  if (!m || phase.kind !== "ready" || phase.collectionId !== m.collectionId) return;
  sync.data.mergeConfirmed = m.collectionId; sync.merge = null; await sync.persist();
  await sync.startMirror();
}
/** Only before anything has synced: release the collection and pick again. */
/** Whether this vault can still be pointed at a different collection. */
export function canChooseAnother(sync: NativeSync): boolean {
  return (sync.merge !== null || sync.phase.kind === "needs_unlock") && sync.data.cursor === undefined && !Object.keys(sync.data.paths).length;
}
export async function chooseAnother(sync: NativeSync) {
  if (!sync.canChooseAnother) return;
  const current = sync.merge?.collectionId ?? sync.phase.collectionId;
  const select = (id: string) => sync.select(id);
  const addCollection = () => sync.call("addCollection");
  const reset = async () => { sync.data.collectionId = undefined; sync.merge = null; await sync.persist(); await sync.writeMarker(); sync.setStatus("Getting your collection ready."); };
  const failed = (error: unknown) => sync.fail("select", error);
  const items: { id: string | null; name: string; private?: boolean }[] = [
    ...(sync.phase.collections ?? []).filter((c: { id: string }) => c.id !== current),
    { id: null, name: "New collection…" },
  ];
  chooseCollection(sync.app, items, c => {
    void (async () => {
      await reset();
      await (c.id ? select(c.id) : addCollection());
    })().catch(failed);
  });
}
export function choose(sync: NativeSync) {
  const items = sync.phase.collections ?? [];
  const select = (id: string) => { void sync.select(id).catch(error => sync.fail("select", error)); };
  chooseCollection(sync.app, items, c => select(c.id));
}
export async function signIn(sync: NativeSync) {
  if (sync.phase.kind === "authorizing" && sync.signInUrl) {
    sync.openSignIn(sync.signInUrl);
    new Notice("mdbase: sign-in is still pending. Reopened the existing approval link; finish or cancel it in your browser.");
    return;
  }
  await sync.call("signIn");
}
export function openSignIn(sync: NativeSync, url: string) {
  sync.signInUrl = url;
  void sync.host.openExternal(url)
    .then(() => sync.log("sign-in opened in system browser"), (e: Error) => sync.fail("open sign-in", e));
}
/**
 * The sync engine's suggested way back when this app's access was removed:
 * approve this collection again in the browser. Only for a stop that asks for it.
 */
export async function requestAccess(sync: NativeSync) {
  const phase = sync.phase;
  if ((phase.problem?.action !== "approve" && phase.kind !== "needs_approval") || !phase.collectionId) return;
  await sync.call("approve", phase.collectionId);
}
/**
 * Ask the sync engine to try again after a stop: its start() restarts a
 * blocked sign-in and reopens a blocked collection. Nothing is reset.
 */
export async function retry(sync: NativeSync) {
  if (sync.phase.kind !== "problem") return;
  const before = JSON.stringify(sync.phase.problem);
  await sync.call("start");
  // Phase notices arrive before the call's reply. The same stop means nothing changed: say so.
  if (sync.phase.kind === "problem" && JSON.stringify(sync.phase.problem) === before)
    throw Object.assign(new Error("Tried again, but sync still can't continue."), { code: "still_stopped" });
}
/**
 * Whether signing this vault out of mdbase loses nothing: no collection is
 * bound, nothing has synced, and nothing is waiting to be sent or preserved.
 * Only then can a stuck or waiting sign-in be abandoned (see startOver).
 */
export function canStartOver(sync: NativeSync): boolean {
  const d = sync.data;
  if (!d || !["problem", "authorizing"].includes(sync.phase.kind) || sync.mirroring || sync.merge !== null) return false;
  const empty = (o?: object) => !o || Object.keys(o).length === 0;
  return !d.collectionId && d.cursor === undefined && empty(d.paths) && empty(d.uploads) && empty(d.pendingPaths)
    && empty(d.sending) && empty(d.handledRejections) && empty(d.conflictCopies) && empty(d.pathFailures);
}
/**
 * Abandon an unfinished sign-in: the SDK's signOut erases this vault's own
 * sign-in data (installation, keys) so the next Sign in starts a new one, with
 * any account. It refuses by itself if writes are unsent. This vault's journal
 * and its own ownership marker stay as they are; no other app's is touched.
 */
export async function startOver(sync: NativeSync) {
  if (!sync.canStartOver) return;
  sync.signInUrl = null;
  sync.log("start over: signing out of an unfinished sign-in (nothing bound)");
  const { signOutResult } = await sync.call("signOut");
  sync.reportSignOut(signOutResult);
  if (sync.phase.kind === "problem" || sync.phase.kind === "authorizing")
    throw Object.assign(new Error("Start over didn't finish. Choose Restart sync, then Start over again."), { code: "still_stopped" });
}
/**
 * Stop syncing this vault and sign this device out of mdbase. The SDK refuses
 * while changes it holds haven't reached mdbase (`sign_out_pending_writes`);
 * then nothing changes here. Notes stay in the vault; the vault is released
 * from its collection, so signing in again starts with a fresh comparison.
 */
export async function signOut(sync: NativeSync) {
  if (!sync.data || sync.phase.kind === "signed_out" || sync.phase.kind === "handed_over") return;
  sync.signInUrl = null;
  await sync.jobs;
  sync.log("sign out requested");
  const { signOutResult } = await sync.call("signOut");
  await sync.releaseCollection();
  sync.reportSignOut(signOutResult);
  new Notice("mdbase: signed out. Your notes stay in this vault.");
}
export function reportSignOut(sync: NativeSync, result: SignOutResult | null | undefined) {
  sync.log(`signed out: server=${result?.server ?? "unknown"} local=${result?.local ?? "unknown"}`);
  const text = signOutText(result);
  if (text) new Notice(`mdbase: ${text}`, 0);
}
/** Whether a stop asks for another collection: deleted, access removed, unavailable. */
export function canChooseAgain(sync: NativeSync): boolean {
  return sync.phase.kind === "problem" && sync.phase.problem?.action === "choose_collection";
}
/**
 * After a stop that asks for another collection, release this vault from the
 * one it synced with and list the collections. The notes stay as they are;
 * the next collection compares them afresh, asking first if it has notes too.
 */
export async function chooseAgain(sync: NativeSync) {
  if (!sync.canChooseAgain) return;
  sync.log("choose another collection after a stop");
  await sync.jobs;
  await sync.releaseCollection();
  await sync.call("chooseAnother");
}
/**
 * Forget everything this vault knew about its collection. Files on disk are
 * not touched; what was unsent is still in them, and the next collection's
 * first pass compares every file again (a differing copy becomes a conflict
 * copy, never a loss). Device choices stay: they are about this device.
 */
export async function releaseCollection(sync: NativeSync) {
  const { version, vaultId, port, vaultLocation, device } = sync.data;
  sync.data = { version, vaultId, paths: {}, ...(port === undefined ? {} : { port }), ...(vaultLocation === undefined ? {} : { vaultLocation }), ...(device === undefined ? {} : { device }) };
  sync.merge = null; sync.totals = null; sync.lastSynced = null; sync.pickManually = true;
  await sync.persist();
  await sync.writeMarker();
}
export async function handover(sync: NativeSync) {
  if (!sync.admitting) return;
  sync.admitting = false;
  try {
    if (sync.data.collectionId && !sync.mirroring) throw new Error("Collection not ready; cannot verify drain");
    await sync.jobs;
    await sync.reconcileAll(); // captures any local edits not yet admitted to the queue
    if (Object.keys(sync.data.pathFailures ?? {}).length) throw new Error("File sync failures remain; local bytes retained and handover blocked");
    await sync.call("unwatch");
    if (sync.data.collectionId) {
      await sync.call("drain");
      sync.log("handover: drain confirmed pending 0, holds 0, unresolved 0");
    }
    sync.mirroring = false;
    await sync.call("stop");
    await sync.checkOwnership();
    if (!await sync.ownsMarker()) throw new Error("Ownership changed during handover");
    await sync.host.remove(sync.markerPath);
    sync.log("handover: SDK stopped; own marker removed");
    if (sync.markerTimer) window.clearInterval(sync.markerTimer);
    // Stopped on purpose: a state of its own, so it reads as done, not as a fault.
    sync.phase = { kind: "handed_over" };
    sync.setStatus(HANDED_OVER);
    new Notice("mdbase: everything is sent. Add this folder in the mdbase app to keep syncing it.", 10000);
  } catch (e) { sync.mirroring = false; sync.fail("handover (marker retained)", e); }
}
