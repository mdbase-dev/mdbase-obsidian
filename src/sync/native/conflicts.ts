import { t } from "@lingui/core/macro";
// Conflicts and rejected writes: the local side is always kept as a separate
// copy before the remote side wins the original path, and a rejected write is
// acknowledged only once its exact bytes are proven preserved.
import { Notice } from "obsidian";
import { conflictPath } from "./reconcile";
import { chooseRejectedWrite } from "./choosers";
import type NativeSync from "./plugin";
import type { LocalFile, Remote } from "./plugin";

export async function preserveConflict(sync: NativeSync, p: string, l: LocalFile, mutationId?: string) {
  const kind = sync.kindOf(p) === "record" ? "record" : "file";
  const key = JSON.stringify([p, l.hash]);
  const remotes = await sync.remoteAll();
  const prior = sync.data.conflictCopies?.[key];
  let copy = prior?.copy;
  let remote = copy ? remotes.get(copy) : undefined;
  const local = copy ? await sync.local(copy) : undefined;
  // Reuse only an exact copy. Never overwrite a subsequent user edit or an
  // unrelated occupied remote path. Optimistic bytes are not confirmation.
  if (!copy || (local && local.hash !== l.hash) || (remote && (remote.kind !== kind || remote.hash !== l.hash))) {
    // Local/remote existence checks cannot reserve a name on another device,
    // so tag new names with this vault's id: two devices never pick the same one.
    const device = sync.data.vaultId.slice(0, 6), stamp = new Date();
    let n = 0; // "<device>", then "<device> 2", "<device> 3", ...
    do copy = conflictPath(p, stamp, ` ${device}${n++ ? ` ${n}` : ""}`);
    while (await sync.local(copy) || remotes.has(copy));
    remote = undefined;
  }
  (sync.data.conflictCopies ??= {})[key] = { path: p, hash: l.hash, copy, kind };
  if (mutationId)
    (sync.data.handledRejections ??= {})[mutationId] = { path: p, hash: l.hash, kind, copy };
  await sync.persist(); // before local IO and remote publication, not only CAS rejections
  await sync.put(copy, l.bytes);
  if (remote && remote.confirmed !== true)
    throw Object.assign(new Error("Conflict copy awaiting confirmation; local state retained"), { code: "outcome_unknown" });
  // A crash after confirmation but before replacing the original must not
  // publish another conflict item. Otherwise retry the same saved copy path.
  if (!remote) await sync.push(copy, l);
  else sync.remember(copy, remote, l.hash);
  if (mutationId) {
    sync.data.handledRejections![mutationId].handled = true; await sync.persist();
  }
  return copy;
}
export async function keepConflictCopies(sync: NativeSync, copyPath: string) {
  await sync.enqueue(async () => {
    await sync.assertMirror();
    const remotes = await sync.remoteAll();
    for (const [key, copy] of Object.entries(sync.data.conflictCopies ?? {})) if (copy.copy === copyPath) {
      const remote = remotes.get(copy.copy), local = await sync.local(copy.copy);
      const original = remotes.get(copy.path), current = await sync.local(copy.path);
      if (remote?.confirmed !== true || remote.hash !== copy.hash || local?.hash !== copy.hash || !sync.data.paths[copy.path] || original?.confirmed !== true || !current || original.hash !== current.hash) {
        new Notice(t`mdbase: both files must finish syncing before keeping them.`); return;
      }
      delete sync.data.conflictCopies![key];
    }
    await sync.persist(); sync.setStatus(sync.statusText, sync.statusKind);
  });
}
// User-reviewed escape hatch for rejections the plugin cannot prove it preserved.
// The user picks one entry; nothing is discarded automatically.
export async function discardRejected(sync: NativeSync) {
  const entries: { mutationId: string; records: string[]; code: string }[] = await sync.call("rejectedWrites");
  if (!entries.length) { new Notice(t`mdbase: no rejected writes`); return; }
  const label = (e: typeof entries[number]) => {
    const p = Object.entries(sync.data.paths).find(([, k]) => e.records.includes(k.id))?.[0] ?? "unknown path";
    return `${p} — ${e.code} — ${e.mutationId}`;
  };
  const discard = (entry: typeof entries[number]) => {
    void sync.enqueue(async () => {
      const ok = await sync.call("acknowledge", entry.mutationId);
      delete sync.data.handledRejections?.[entry.mutationId]; await sync.persist();
      sync.log(`rejected write discarded by user: mutationId=${entry.mutationId} problem=${entry.code} ok=${ok}`);
      new Notice(ok ? t`mdbase: rejected write discarded` : t`mdbase: discard failed`);
    }).catch(error => sync.fail("discard rejected", error));
  };
  chooseRejectedWrite(sync.app, entries, label, discard);
}
export async function acknowledgeHandled(sync: NativeSync, explicit = false, remotes?: Map<string, Remote>) {
  if (!explicit && !Object.keys(sync.data.handledRejections ?? {}).length) return;
  const entries: { mutationId: string; records: string[]; code: string }[] = await sync.call("rejectedWrites");
  remotes ??= await sync.remoteAll();
  for (const e of entries) {
    const h = sync.data.handledRejections?.[e.mutationId];
    const source = [...remotes.values()].find(r => e.records.includes(r.id));
    const p = h?.path ?? source?.path ?? Object.entries(sync.data.paths).find(([, k]) => e.records.includes(k.id))?.[0] ?? "unknown";
    if (explicit) sync.log(`rejected write: mutationId=${e.mutationId} path=${JSON.stringify(p)} problem=${e.code}`);
    const copy = h?.copy ? remotes.get(h.copy) : undefined;
    const local = h?.copy ? await sync.local(h.copy) : undefined;
    // No path/name heuristic can prove which bytes a legacy CAS refused.
    // Only our journal binds this mutation to the exact preserved bytes.
    if (!h || (!h.handled && !(copy && copy.kind === h.kind && copy.confirmed === true && copy.hash === h.hash && local?.hash === h.hash))) {
      if (explicit) sync.log(`rejected write retained: mutationId=${e.mutationId}; preservation unproven`);
      continue;
    }
    h.handled = true; await sync.persist(); // survives an acknowledgement failure/crash
    if (await sync.call("acknowledge", e.mutationId)) {
      sync.log(`handled rejection acknowledged: mutationId=${e.mutationId} path=${JSON.stringify(h.path)} problem=${e.code}`);
      delete sync.data.handledRejections![e.mutationId]; await sync.persist();
    }
  }
  // If a crash happened after SDK acknowledgement but before sync-state.json commit,
  // repeating acknowledgement is harmless; never touch an unrelated entry.
  for (const [id, h] of Object.entries(sync.data.handledRejections ?? {})) {
    if (h.handled && !entries.some(e => e.mutationId === id) && await sync.call("acknowledge", id)) {
      delete sync.data.handledRejections![id]; await sync.persist();
    }
  }
}
export async function conflict(sync: NativeSync, p: string, l: LocalFile | undefined, r?: Remote, rejected?: { mutationId: string; local: LocalFile }) {
  // Preserve local first (including a unique suffix if the minute is reused).
  // If publication fails the local conflict copy survives and retries at startup.
  if (rejected) await sync.preserveConflict(p, rejected.local, rejected.mutationId);
  if (l && l.hash !== rejected?.local.hash) await sync.preserveConflict(p, l);
  if (r) await sync.pull(p, r, l?.hash); else await sync.removeLocal(p, l?.hash);
  for (const [key, copy] of Object.entries(sync.data.conflictCopies ?? {})) if (copy.path === p) delete sync.data.conflictCopies![key];
  await sync.persist();
  sync.log("conflict: local preserved as a new conflict item; remote wins original path");
  new Notice(t`mdbase: conflict preserved in a separate file; remote version kept at original path.`);
}
