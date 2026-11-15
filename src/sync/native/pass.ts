// One reconciliation pass: compare the vault, the journal and the collection,
// pair moves, then send, fetch, delete or preserve each path. Also what the
// pass counts for the Overview, and definitions (which never get conflict copies).
import { Notice } from "obsidian";
import { errorInfo } from "./protocol";
import { encode, hash } from "./encoding";
import { readyText } from "../words";
import { reconcileDecision, remoteMoveDecision, localMovePairs } from "./reconcile";
import { classifyPath, CONFIG_PATH } from "./classify";
import { collectionExcludes, type ActivityKind } from "./device";
import { isConflict } from "./transfers";
import type { SyncState } from "./journal";
import type NativeSync from "./plugin";
import type { ItemKind, Remote, SyncTotals } from "./plugin";

/** How many plain note sends run at once. The SDK confirms them in batches. */
const SEND_CONCURRENCY = 16;

export async function reconcilePass(sync: NativeSync, defer: boolean, affected: Set<string> | undefined, retryFailed: boolean): Promise<boolean | undefined> {
  if (!sync.mirroring) return;
  await sync.checkOwnership();
  // Recovery journals require the original and preservation copy together.
  if (sync.deferredRemoteMoves.size || Object.keys(sync.data.handledRejections ?? {}).length || Object.keys(sync.data.conflictCopies ?? {}).length || Object.keys(sync.data.pathFailures ?? {}).length) affected = undefined;
  if (!affected || sync.inclusion === undefined) await sync.readInclusion();
  await sync.forgetSkipped();
  await sync.resumeUploads();
  let remotes = await sync.remoteAll(affected);
  await sync.acknowledgeHandled(false, remotes);
  const failedBefore = new Set(Object.keys(sync.data.pathFailures ?? {}));
  // One path's failure is recorded for the Sync tab; the pass carries on.
  const notSynced = async (p: string, signature: string, e: unknown): Promise<ActivityKind> => {
    if (!sync.mirroring || sync.unloaded) throw e;
    await sync.checkOwnership();
    (sync.data.pathFailures ??= Object.create(null) as NonNullable<SyncState["pathFailures"]>)[p] = { signature, code: errorInfo(e).code, reason: errorInfo(e).reason, unknown: /unknown/.test(`${errorInfo(e).code} ${errorInfo(e).reason}`), ...(Array.isArray(errorInfo(e).issues) ? { issues: errorInfo(e).issues } : {}) };
    await sync.persist();
    sync.log(`not synced: ${JSON.stringify(p)} ${[errorInfo(e).code, errorInfo(e).reason].filter(Boolean).join(" ")}`);
    return "not_synced";
  };
  if (affected) {
    // Remote definition changes arrive only through this listing.
    for (const r of remotes.values()) if (r.kind === "resource" && sync.data.paths[r.path]?.revision !== r.revision) affected.add(r.path);
    for (const [p, k] of Object.entries(sync.data.paths)) if (k.kind === "resource" && !remotes.has(p)) affected.add(p);
  }
  // Records validate against the definitions. Folding their revisions into a
  // record's failure signature retries an invalid_record once types change.
  const definitions = hash(encode(JSON.stringify([...remotes.values()].filter(r => r.kind === "resource").map(r => [r.path, r.revision]).sort())));
  let definitionsChanged = false;
  // Index once, rather than allocating/scanning all remotes for every path.
  const byId = new Map([...remotes.values()].map(r => [`${r.kind}:${r.id}`, r]));
  const previousMoves = sync.deferredRemoteMoves;
  sync.deferredRemoteMoves = new Map();
  const blockedSources = new Set<string>(), blockedTargets = new Set<string>();
  let retryMoves = false, refreshRemotes = false;
  // Join by stable identity BEFORE treating a new path as a new remote item.
  for (const [from, k] of Object.entries(sync.data.paths)) {
    const r = byId.get(`${k.kind}:${k.id}`);
    // A move into a folder this device skips reads as a removal at `from`.
    if (!r || r.path === from || !sync.accessiblePath(from) || !sync.accessiblePath(r.path) || sync.skipped(r.path) || (affected && !affected.has(from) && !affected.has(r.path))) continue;
    affected?.add(from); affected?.add(r.path);
    const signature = `remote-move:${JSON.stringify([k.id, k.kind, r.path, r.revision])}`;
    try {
    const l = await sync.local(from);
    const tracked = sync.data.paths[r.path];
    let occupied = !!tracked || !!sync.app.vault.getAbstractFileByPath(sync.vaultPath(r.path)) || await sync.host.exists(sync.host.join(sync.root, r.path));
    if (!tracked && occupied && k.id === r.id && k.kind === r.kind) {
      if (l && !l.f) throw Object.assign(new Error("Waiting for vault index before remote rename"), { code: "vault_index_pending" });
      const occupant = await sync.local(r.path);
      if (occupant) {
        refreshRemotes = true;
        const copy = await sync.preserveConflict(r.path, occupant);
        affected?.add(copy);
        await sync.removeLocal(r.path, occupant.hash);
        occupied = false;
        sync.note("conflict", r.path);
      }
    }
    const decision = remoteMoveDecision(k, l?.hash, r, occupied);
    if (decision === "blocked") {
      blockedSources.add(from); blockedTargets.add(r.path);
      sync.deferredRemoteMoves.set(from, signature);
      if (previousMoves.get(from) === signature || sync.data.pathFailures?.[from]?.signature === signature) {
        await notSynced(from, signature, { code: "remote_move_blocked", reason: k.id !== r.id || k.kind !== r.kind ? "identity_mismatch" : "destination_occupied", issues: [{ message: `Destination: ${r.path}` }] });
      } else retryMoves = true;
      continue;
    }
    if (decision === "rename") {
      await sync.ensureFolder(sync.vaultPath(r.path)); await sync.assertMirror();
      if (!l!.f) throw Object.assign(new Error("Waiting for vault index before remote rename"), { code: "vault_index_pending" });
      await sync.app.vault.rename(l!.f, sync.vaultPath(r.path));
      sync.data.paths[r.path] = k;
      sync.note("moved", from, { to: r.path, from: "remote" });
      sync.log(`remote ${r.kind} move: renamed locally (no download)`);
    }
    delete sync.data.pathFailures?.[from];
    delete sync.data.paths[from]; await sync.persist();
    } catch (e: unknown) {
      blockedSources.add(from); blockedTargets.add(r.path);
      await notSynced(from, signature, e);
    }
  }
  if (refreshRemotes) remotes = await sync.remoteAll(affected);
  for (const [p, failure] of Object.entries(sync.data.pathFailures ?? {})) if (failure.signature.startsWith("remote-move:") && !blockedSources.has(p)) {
    delete sync.data.pathFailures![p]; await sync.persist();
  }
  const paths = new Set([...(affected ?? [...Object.keys(sync.data.paths), ...remotes.keys()])].filter(p => sync.accessiblePath(p) && sync.kindOf(p) !== "excluded"));
  if (!affected) for (const p of await sync.localPaths()) paths.add(p);
  // Pairing needs hashes, not payloads. Keeping every byte here retained an
  // entire vault (including large attachments) throughout slow network IO.
  const locals = new Map<string, { hash: string; unsupportedEncoding?: boolean }>();
  const unreadable = new Set<string>();
  for (const p of paths) {
    try { const l = await sync.local(p); if (l) locals.set(p, { hash: l.hash, unsupportedEncoding: l.unsupportedEncoding }); }
    catch (e: unknown) {
      await sync.assertMirror(); unreadable.add(p);
      (sync.data.pathFailures ??= Object.create(null) as NonNullable<SyncState["pathFailures"]>)[p] = { signature: "unreadable", code: errorInfo(e).code ?? "unreadable" };
      await sync.persist(); sync.log(`read failed: ${JSON.stringify(p)} ${errorInfo(e).code ?? ""}`);
    }
  }
  if (!affected) for (const p of Object.keys(sync.data.pathFailures ?? {})) if (!paths.has(p)) { delete sync.data.pathFailures![p]; await sync.persist(); }
  const missing = Object.entries(sync.data.paths).filter(([p]) => paths.has(p) && !blockedSources.has(p) && !blockedTargets.has(p) && !unreadable.has(p) && !locals.has(p)).map(([p, known]) => ({ path: p, known, remote: remotes.get(p) }));
  const added = [...locals].filter(([p, l]) => !blockedSources.has(p) && !blockedTargets.has(p) && !l.unsupportedEncoding && !sync.data.paths[p] && !remotes.has(p)).map(([p, l]) => ({ path: p, kind: sync.kindOf(p) as ItemKind, hash: l.hash, disk: sync.diskIdentity(p) }));
  // A content event can race disk moves whose create/delete watcher has not
  // arrived yet. Topology needs the whole disk for conservative move pairing.
  if (affected && (missing.length || added.length)) return sync.reconcileAll(defer, undefined, retryFailed);
  // Moving a note into a folder this device skips is still a move for every
  // other device. Pair those by inode only: skipped files are never hashed.
  const intoSkipped = missing.length && !affected ? (await sync.localPaths(true)).filter(p => !sync.data.paths[p] && !remotes.has(p)).map(p => ({ path: p, kind: classifyPath(p, sync.layout) as ItemKind, hash: "", disk: sync.diskIdentity(p) })) : [];
  // A definition's path is its identity: moving one is a delete plus a create.
  for (const pair of localMovePairs(missing.filter(m => m.known.kind !== "resource"), [...added, ...intoSkipped].filter(a => a.kind !== "resource"))) {
    // Recheck disk state after async IO; never move a now-occupied source.
    const skippedTarget = sync.skipped(pair.to);
    const signature = `local-move:${JSON.stringify([pair.from, pair.to, locals.get(pair.to)?.hash, remotes.get(pair.from)?.revision])}`;
    if (sync.data.pathFailures?.[pair.to]?.signature === signature && !retryFailed) {
      blockedSources.add(pair.from); blockedTargets.add(pair.to); continue;
    }
    try {
      if (await sync.local(pair.from) || !(skippedTarget ? await sync.host.exists(sync.host.join(sync.root, pair.to)) : await sync.local(pair.to))) continue;
      const moved = await sync.moveLocal(pair.from, pair.to, sync.data.paths[pair.from], remotes.get(pair.from)!);
      remotes.delete(pair.from);
      if (skippedTarget) { delete sync.data.paths[pair.to]; await sync.persist(); }
      else remotes.set(pair.to, moved);
      sync.log(`external move paired by ${pair.via}`);
    } catch (e) {
      if (isConflict(e)) remotes = await sync.remoteAll();
      else {
        blockedSources.add(pair.from); blockedTargets.add(pair.to);
        await notSynced(pair.to, signature, e);
      }
    }
  }
  const pending = sync.data.pendingPaths ??= Object.create(null) as NonNullable<SyncState["pendingPaths"]>;
  const unsettled = new Set([...missing.map(m => m.path), ...added.map(a => a.path)].filter(p =>
    (!sync.data.paths[p] && locals.has(p) && !remotes.has(p)) || (!!sync.data.paths[p] && !locals.has(p))));
  let pendingChanged = false;
  for (const p of Object.keys(pending)) if (paths.has(p) && (!unsettled.has(p) || !defer)) { delete pending[p]; pendingChanged = true; }
  if (defer) for (const p of unsettled) {
    // A wall-clock correction must not turn a two-second move window into
    // hours of stalled work. Startup still consumes persisted intent at once.
    const due = Math.min(pending[p] ?? Date.now() + 2000, Date.now() + 2000);
    if (due !== pending[p]) { pending[p] = due; pendingChanged = true; }
  }
  if (pendingChanged) await sync.persist();
  sync.scheduleSettle();
  // What happened to one path: its activity line, and its settle deadline.
  const settled = (p: string, outcome: ActivityKind | null) => {
    if (outcome) sync.note(outcome, p, outcome === "deleted_remote" ? { from: "here" } : outcome === "deleted_here" ? { from: "remote" } : {});
    if (Object.prototype.hasOwnProperty.call(pending, p)) { delete pending[p]; sync.persistSoon(); }
  };
  // Plain note sends (new here, or changed here only) wait until everything
  // else has been handled one at a time, then go several at once.
  const sends: { p: string; signature: string }[] = [];
  // Settings first, then types, then the notes that use them.
  const rank = (p: string) => p === CONFIG_PATH ? 0 : sync.kindOf(p) === "resource" ? 1 : 2;
  for (const p of [...paths].sort((a, b) => rank(a) - rank(b))) {
    if (blockedSources.has(p) || (blockedTargets.has(p) && !sync.data.paths[p]) || unreadable.has(p) || (defer && pending[p] > Date.now())) continue;
    await sync.checkOwnership();
    if (!sync.mirroring || sync.unloaded) throw new Error("Mirror stopped");
    const l = await sync.local(p), r = blockedTargets.has(p) ? undefined : remotes.get(p);
    let k = sync.data.paths[p];
    // Over the collection's size limit: neither sent nor fetched, never deleted.
    if ((r?.kind ?? sync.kindOf(p)) === "file" && collectionExcludes(p, "file", sync.inclusion, l?.bytes.length ?? r?.size)) continue;
    if (l?.unsupportedEncoding) {
      const key = `encoding:${p}:${l.hash}`;
      if (!sync.warnedPaths.has(key)) {
        sync.warnedPaths.add(key); sync.log(`unsupported UTF-8 record skipped: ${JSON.stringify(p)}`);
      }
      const signature = JSON.stringify([l.hash, r?.id, r?.kind, r?.revision]);
      if (sync.data.pathFailures?.[p]?.signature !== signature) {
        (sync.data.pathFailures ??= Object.create(null) as NonNullable<SyncState["pathFailures"]>)[p] = { signature, code: "unsupported_encoding" }; await sync.persist();
      }
      continue;
    }
    const kind = r?.kind ?? k?.kind ?? sync.kindOf(p) as ItemKind;
    // The kind is part of the input: a failure recorded while a path was sent
    // as another kind (an older build sent definitions as notes) is stale.
    const signature = JSON.stringify(kind === "resource" ? [kind, l?.hash, r?.id, r?.kind, r?.revision] : [kind, l?.hash, r?.id, r?.kind, r?.revision, definitions]);
    const failure = sync.data.pathFailures?.[p];
    const recovering = Object.values(sync.data.conflictCopies ?? {}).some(c => c.path === p) || Object.values(sync.data.handledRejections ?? {}).some(h => h.path === p);
    // A durable preservation journal makes replay safe even after the copy's
    // confirmation reply was lost; without it, unknown outcomes stay blocked.
    if (failure && ((failure.unknown && !r && !recovering) || (failure.signature === signature && ((!retryFailed && !recovering) || (failure.unknown && !recovering))))) continue;
    if (sync.data.pathFailures?.[p]) { delete sync.data.pathFailures[p]; await sync.persist(); }
    let outcome: ActivityKind | null = null;
    try {
    const sent = sync.data.sending?.[p];
    if (sent !== undefined) {
      // A send cut off by quit or reload. If it landed, that remote version
      // is the baseline: compare the local file against it, not the older one.
      if (r && r.kind !== "file" && r.hash === sent) { sync.remember(p, r, sent); k = sync.data.paths[p]; }
      delete sync.data.sending![p]; await sync.persist();
    }
    const decision = reconcileDecision(k, l?.hash, r);
    const outcomes: Partial<Record<typeof decision, ActivityKind>> = { pull: "downloaded", push: "uploaded", deleteRemote: "deleted_remote", deleteLocal: "deleted_here", conflict: "conflict" };
    outcome = outcomes[decision] ?? null;
    if (kind === "resource") {
      if (await sync.reconcileDefinition(p, decision, l, r)) definitionsChanged = true;
    } else switch (decision) {
      case "none": if (k && l) sync.remember(p, r!, l.hash); break;
      case "remember": sync.remember(p, r!, l!.hash); break;
      case "pull": await sync.pull(p, r!, l?.hash); break;
      case "push":
        if (kind === "record" && !recovering) { sends.push({ p, signature }); continue; }
        try { await sync.push(p, l!, r); }
        catch (e: unknown) { const failure = errorInfo(e);
          if (!isConflict(e)) throw e;
          // Fetch a fresh view after a live revision rejection and use the
          // identical preserve-local/pull-remote rule (no blind retry).
          const fresh = (await sync.remoteAll()).get(p);
          await sync.conflict(p, await sync.local(p), fresh, failure.mutationId ? { mutationId: failure.mutationId, local: l! } : undefined);
          if (sync.data.uploads?.[p]) await sync.clearUpload(p);
          outcome = "conflict";
        }
        break;
      case "deleteRemote":
        try { await sync.call(r!.kind === "record" ? "remove" : "fileDelete", r!.id, r!.revision); delete sync.data.paths[p]; await sync.persist(); }
        catch (e: unknown) { const failure = errorInfo(e);
          if (!isConflict(e)) throw e;
          const fresh = (await sync.remoteAll()).get(p);
          if (fresh) {
            // A delete submitted no local document. Its safe conflict outcome
            // is restoration of the winning remote bytes, not a new copy.
            // Journal that exact proof before IO; a failed pull cannot clear
            // the ledger, and crash recovery still requires confirmed bytes.
            const h = failure.mutationId ? { path: p, hash: fresh.hash!, kind: fresh.kind === "file" ? "file" as const : "record" as const, copy: p, handled: false } : undefined;
            if (h && failure.mutationId) { (sync.data.handledRejections ??= {})[failure.mutationId] = h; await sync.persist(); }
            await sync.pull(p, fresh);
            if (h && fresh.confirmed === true) { h.handled = true; await sync.persist(); }
            outcome = "downloaded";
          } else outcome = "deleted_remote";
        }
        break;
      case "deleteLocal": {
        const latest = await sync.local(p);
        if (latest && latest.hash !== l?.hash) { await sync.conflict(p, latest); outcome = "conflict"; }
        else await sync.removeLocal(p, latest?.hash);
        break;
      }
      case "forget": delete sync.data.paths[p]; await sync.persist(); break;
      case "conflict": await sync.conflict(p, l, r); break;
    }
    } catch (e: unknown) { outcome = await notSynced(p, signature, e); }
    settled(p, outcome);
  }
  await sync.sendNotes(sends, remotes, settled, notSynced);
  sync.scheduleSettle();
  await sync.acknowledgeHandled();
  const failed = Object.keys(sync.data.pathFailures ?? {});
  // One notice for the pass, only when something newly failed. The Sync tab
  // lists every path and why; the status bar keeps the count.
  const fresh = failed.filter(p => !failedBefore.has(p)).length;
  if (fresh) new Notice(`mdbase: ${fresh === 1 ? "1 file" : `${fresh} files`} couldn't sync. Open Sync to see why.`, 8000);
  if (!affected) sync.totals = sync.countTotals(remotes);
  if (!blockedSources.size && !failed.length && !Object.keys(sync.data.pendingPaths ?? {}).length && !Object.keys(sync.data.uploads ?? {}).length) {
    sync.lastSynced = Date.now();
    if (sync.activityTimer === null) sync.activityTimer = window.setTimeout(() => { sync.activityTimer = null; void sync.writeActivity(); }, 2000);
  }
  sync.passStatus(sync.phase.sync ? readyText(sync.phase.sync) : "Synced");
  // Notes refused under the old definitions get another chance now.
  if (retryMoves || (definitionsChanged && failed.length)) window.setTimeout(() => sync.requestReconcile(), 0);
  return failed.length === 0 && blockedSources.size === 0;
}
/**
 * Send plain note changes, several at a time. Each send is independent: its
 * own journal entry, its own failure. A send the collection rejects as a
 * conflict waits until the others have finished, then is resolved alone,
 * exactly as when sends went one by one.
 */
export async function sendNotes(sync: NativeSync, sends: { p: string; signature: string }[], remotes: Map<string, Remote>, settled: (p: string, outcome: ActivityKind | null) => void, notSynced: (p: string, signature: string, e: unknown) => Promise<ActivityKind>) {
  if (!sends.length) return;
  type Local = NonNullable<Awaited<ReturnType<NativeSync["local"]>>>;
  const conflicts: { p: string; signature: string; e: unknown; l: Local }[] = [];
  let next = 0, done = 0, shown = 0, stop: Error | undefined;
  const sendOne = async ({ p, signature }: { p: string; signature: string }) => {
    let l: Awaited<ReturnType<NativeSync["local"]>>;
    try {
      await sync.assertMirror();
      // Read again now rather than hold every note's text in memory. If the
      // file changed meanwhile and is no longer a plain send, a later pass decides.
      l = await sync.local(p);
      const r = remotes.get(p);
      if (!l || l.unsupportedEncoding || reconcileDecision(sync.data.paths[p], l.hash, r) !== "push") return;
      await sync.push(p, l, r);
    } catch (e: unknown) {
      if (l && isConflict(e)) { conflicts.push({ p, signature, e, l }); return; }
      settled(p, await notSynced(p, signature, e));
      return;
    }
    settled(p, "uploaded");
  };
  const worker = async () => {
    while (next < sends.length && !stop) {
      try { await sendOne(sends[next++]); }
      catch (e) { stop ??= e instanceof Error ? e : new Error("Mirror stopped"); }
      done++;
      if (sends.length > 10 && Date.now() - shown > 500) { shown = Date.now(); sync.setStatus(`Uploading ${done.toLocaleString()} of ${sends.length.toLocaleString()} notes`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, sends.length) }, worker));
  if (stop) throw stop;
  for (const { p, signature, e, l } of conflicts) {
    let outcome: ActivityKind = "conflict";
    try {
      // A fresh view after the rejection, then the same preserve-local and
      // pull-remote rule as any conflict (no blind retry).
      const fresh = (await sync.remoteAll()).get(p);
      await sync.conflict(p, await sync.local(p), fresh, errorInfo(e).mutationId! ? { mutationId: errorInfo(e).mutationId!, local: l } : undefined);
    } catch (error: unknown) { outcome = await notSynced(p, signature, error); }
    settled(p, outcome);
  }
}
/**
 * What the Overview counts. `remotes` is the listing taken before the pass,
 * so paths this pass sent (all of them, on a first sync into an empty
 * collection) are counted from the journal; their sizes come with the next full pass.
 */
export function countTotals(sync: NativeSync, remotes: Map<string, Remote & { size?: number }>): SyncTotals {
  const t: SyncTotals = { notes: 0, attachments: 0, definitions: 0, attachmentBytes: 0, notHere: 0, byCollection: 0 };
  for (const [p, r] of remotes) {
    if (collectionExcludes(p, r.kind === "file" ? "file" : r.kind, sync.inclusion, r.size)) { t.notHere++; t.byCollection++; continue; }
    if (sync.skipped(p)) { t.notHere++; continue; }
    if (!sync.data.paths[p]) continue;
    if (r.kind === "record") t.notes++;
    else if (r.kind === "resource") t.definitions++;
    else { t.attachments++; t.attachmentBytes += typeof r.size === "number" ? r.size : 0; }
  }
  for (const [p, known] of Object.entries(sync.data.paths)) {
    if (remotes.has(p)) continue;
    if (known.kind === "record") t.notes++;
    else if (known.kind === "resource") t.definitions++;
    else t.attachments++;
  }
  return t;
}
/** Sync one definition. Returns true when the collection's definitions changed. */
export async function reconcileDefinition(sync: NativeSync, p: string, decision: ReturnType<typeof reconcileDecision>, l: Awaited<ReturnType<NativeSync["local"]>>, r?: Remote): Promise<boolean> {
  // A conflict copy of a type file would itself be a type, so definitions
  // never get one. The user picks a side in the Sync tab.
  const conflict = () => Object.assign(new Error("Definition changed on both sides"), { code: "conflict", reason: "definition_conflict" });
  const k = sync.data.paths[p];
  switch (decision) {
    case "none": if (k && l) sync.remember(p, r!, l.hash); return false;
    case "remember": sync.remember(p, r!, l!.hash); return false;
    case "forget": delete sync.data.paths[p]; await sync.persist(); return false;
    case "pull": {
      const latest = await sync.local(p);
      if (latest && latest.hash !== k?.hash && latest.hash !== r!.hash) throw conflict();
      await sync.put(p, encode(r!.document!), latest?.hash);
      sync.remember(p, r!, r!.hash!); return false;
    }
    case "push":
      try { await sync.push(p, l!, r); return true; }
      catch (e: unknown) { if (isConflict(e)) throw conflict(); throw e; }
    case "deleteRemote":
      try { await sync.call("resourceDelete", p, r!.revision); delete sync.data.paths[p]; await sync.persist(); return true; }
      catch (e: unknown) { if (isConflict(e)) throw conflict(); throw e; }
    case "deleteLocal": {
      const latest = await sync.local(p);
      if (latest && latest.hash !== l?.hash) throw conflict();
      await sync.removeLocal(p, latest?.hash); return false;
    }
    case "conflict": throw conflict();
  }
}
/** The user's choice for a definition that changed on both sides. */
export async function resolveDefinition(sync: NativeSync, p: string, keep: "local" | "remote") {
  await sync.enqueue(async () => {
    if (sync.kindOf(p) !== "resource") return;
    const r = (await sync.remoteAll()).get(p), l = await sync.local(p);
    if (keep === "local") {
      if (l) await sync.push(p, l, r);
      else if (r) { await sync.call("resourceDelete", p, r.revision); delete sync.data.paths[p]; await sync.persist(); }
    } else {
      // Keep the replaced text where sync never looks, in case it's wanted.
      if (l) {
        sync.assertDiskPath(".mdbase/replaced");
        const backup = sync.host.join(sync.root, ".mdbase", "replaced", `${new Date().toISOString().replace(/[:.]/g, "-")}`, p);
        await sync.host.mkdir(sync.host.dirname(backup));
        await sync.host.writeBytes(backup, l.bytes);
        sync.log(`definition replaced; previous text kept in .mdbase/replaced`);
      }
      if (r) { await sync.put(p, encode(r.document!), l?.hash); sync.remember(p, r, r.hash!); }
      else if (l) await sync.removeLocal(p, l.hash);
    }
    delete sync.data.pathFailures?.[p]; await sync.persist();
    await sync.reconcileAll(false, undefined, true);
  });
}