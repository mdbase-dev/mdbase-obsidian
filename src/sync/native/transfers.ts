// Moving bytes between the vault and the collection: write a file here, fetch
// one, send one (resumable for attachments), delete one, move one.
import { TFile } from "obsidian";
import { errorInfo } from "./protocol";
import { encode, decode, hash, validUtf8 } from "./encoding";
import { retryUpload } from "./upload";
import type { Synced } from "./reconcile";
import type NativeSync from "./plugin";
import type { LocalFile, Remote, WireItem } from "./plugin";
import type { SyncState } from "./journal";

// Refusals of this exact input. Retrying unchanged bytes gets the same answer,
// so they become per-path failures instead of stopping every other path.
const REFUSED = new Set(["invalid_request", "invalid_record", "too_large", "quota_exceeded", "forbidden"]);
export const isRefusal = (e: unknown) => REFUSED.has(errorInfo(e).code ?? "") && !["cursor_stale", "cursor_expired"].includes(errorInfo(e).reason ?? "");
export const isConflict = (e: unknown) => /conflict|revision/.test(`${errorInfo(e).code} ${errorInfo(e).reason}`);
// Transient transport/service failures while resuming an attachment upload:
// keep the durable upload identity and saved bytes for a later retry without
// halting unrelated paths in this pass.
const TRANSIENT_UPLOAD = new Set(["unavailable", "rate_limited", "timeout", "outcome_unknown"]);
export const isTransientUpload = (e: unknown) => TRANSIENT_UPLOAD.has(errorInfo(e).code ?? "");

export async function ensureFolder(sync: NativeSync, vp: string) {
  const dir = vp.split("/").slice(0, -1).join("/");
  if (dir && !sync.app.vault.getAbstractFileByPath(dir)) {
    try { await sync.app.vault.createFolder(dir); }
    catch (e) { if (!await sync.app.vault.adapter.exists(dir)) throw e; }
  }
}
export function publicationGuard(sync: NativeSync, p: string, expectedHash?: string) {
  sync.assertActive(); sync.assertDiskPath(p);
  if (sync.editorViews(p).some(view => hash(encode(view.getViewData())) !== expectedHash))
    throw Object.assign(new Error("Local editor changed before publication; retained"), { code: "local_changed" });
}
/** Write `bytes` at `p`. With an expected hash, refuses if the file changed meanwhile. */
export async function put(sync: NativeSync, p: string, bytes: Uint8Array, ...expected: [expectedHash?: string]) {
  const [expectedHash] = expected;
  await sync.assertMirror(); sync.assertDiskPath(p);
  const vp = sync.vaultPath(p), f = sync.app.vault.getAbstractFileByPath(vp);
  if (f && !(f instanceof TFile)) throw new Error("Folder collides with remote file");
  const initial = await sync.local(p), nextHash = hash(bytes);
  const changed = () => Object.assign(new Error("Local file changed during download; retry preservation"), { code: "local_changed" });
  if (expected.length > 0 && initial?.hash !== expectedHash && initial?.hash !== nextHash) throw changed();
  if (initial?.hash === nextHash) return;
  if (initial?.unsupportedEncoding) throw Object.assign(new Error("Invalid UTF-8 disk bytes retained"), { code: "unsupported_encoding" });
  const applyEditors = async () => {
    await sync.assertMirror();
    const editors = p.endsWith(".md") ? sync.editorViews(p) : [];
    if (!editors.length) return undefined;
    const text = decode(bytes);
    if (!validUtf8(bytes)) throw Object.assign(new Error("Invalid UTF-8 cannot enter editor"), { code: "unsupported_encoding" });
    // No await between this buffer recheck and setValue: newer typing must
    // enter preservation, never be clobbered by atomic disk publication.
    if (editors.some(v => hash(encode(v.getViewData())) !== initial?.hash)) throw changed();
    sync.assertDiskPath(p);
    for (const view of editors) if (view.getViewData() !== text) view.editor.setValue(text);
    await Promise.all(editors.map(view => view.save()));
    return true;
  };
  sync.writingPaths.add(p);
  try {
    if (await applyEditors()) return;
    await sync.ensureFolder(vp); await sync.assertMirror(); sync.assertDiskPath(p);
    const incoming = sync.host.join(sync.root, ".mdbase", "incoming");
    sync.assertDiskPath(".mdbase/incoming"); await sync.host.mkdir(incoming);
    const temp = sync.host.join(incoming, sync.host.uuid() + ".tmp");
    try {
      await sync.host.writeBytes(temp, bytes, true);
      await sync.assertMirror(); sync.assertDiskPath(p);
      const current = await sync.local(p);
      if (current?.hash !== initial?.hash) throw changed();
      if (await applyEditors()) return;
      await sync.host.publish(temp, sync.host.join(sync.root, vp), initial?.hash, nextHash, () => sync.checkOwnership(), () => sync.publicationGuard(p, initial?.hash));
    } finally { if (await sync.host.exists(temp)) await sync.host.remove(temp); }
  } finally { sync.writingPaths.delete(p); }
}
export async function pull(sync: NativeSync, p: string, r: Remote, expectedHash = sync.data.paths[p]?.hash): Promise<void> {
  if (r.kind === "file") return sync.pullFile(p, r, expectedHash);
  const bytes = encode(r.document!);
  const latest = await sync.local(p);
  if (latest && latest.hash !== expectedHash && latest.hash !== hash(bytes)) {
    await sync.preserveConflict(p, latest);
    // Upload confirmation may take a while. If the user edited again during
    // it, take another snapshot rather than overwrite that newer local edit.
    return sync.pull(p, r, latest.hash);
  }
  try { await sync.put(p, bytes, latest?.hash); }
  catch (e: unknown) { if (errorInfo(e).code === "local_changed") return sync.pull(p, r, latest?.hash); throw e; }
  sync.remember(p, r, hash(bytes));
}
export async function push(sync: NativeSync, p: string, l: LocalFile, r?: Remote) {
  await sync.assertMirror();
  const kind = sync.kindOf(p);
  if (kind === "excluded") throw new Error("Excluded path is never sent");
  if (r && r.kind !== kind) throw new Error("Remote item kind differs from extension; manual resolution required");
  let next: WireItem;
  if (kind !== "file") {
    const doc = decode(l.bytes);
    if (!validUtf8(l.bytes)) throw Object.assign(new Error("Text is not valid UTF-8; local bytes retained"), { code: "unsupported_encoding" });
    // Base is the replica's current exact document, not a stale cached body.
    (sync.data.sending ??= Object.create(null) as NonNullable<SyncState["sending"]>)[p] = l.hash; await sync.durable();
    await sync.assertMirror();
    try {
      next = kind === "resource"
        ? await sync.call("resourcePut", p, doc, r?.revision)
        : r ? await sync.call("replace", r.id, { path: r.path, doc: r.document! }, { path: p, doc }, r.revision) : await sync.call("create", p, doc);
    } catch (e: unknown) {
      // A definite refusal or conflict means the text didn't land.
      if (isRefusal(e) || isConflict(e)) { delete sync.data.sending[p]; await sync.persist(); }
      throw e;
    }
    delete sync.data.sending[p]; // remember() below persists
  } else {
    const uploads = sync.data.uploads ??= Object.create(null) as NonNullable<SyncState["uploads"]>;
    if (!uploads[p]) {
      const identity = { transferId: sync.host.uuid(), mutationId: sync.host.uuid(), hash: l.hash, fileId: r?.id, revision: r?.revision };
      sync.assertDiskPath(".mdbase/uploads");
      await sync.host.mkdir(sync.host.join(sync.root, ".mdbase/uploads"));
      await sync.host.writeBytes(sync.uploadPath(identity.transferId), l.bytes, true);
      uploads[p] = identity; await sync.persist(); // bytes and identity precede the first send
    }
    try { next = await sync.finishUpload(p); }
    catch (e: unknown) { if (isRefusal(e)) await sync.clearUpload(p); throw e; }
  }
  let remote = sync.remote(next, kind);
  if (kind === "record" && typeof remote.document !== "string" && remote.revision.startsWith("sha256:") && remote.revision !== l.hash) {
    remote = sync.remote(await sync.call("get", remote.id), kind);
  }
  if (kind === "record" && typeof remote.document === "string" && remote.hash !== l.hash && remote.path === p) {
    // The collection rewrote the record during write (for example, lifecycle
    // on_create or on_update). Reflect the authoritative document back into
    // the vault before remembering the new revision so local and remote agree.
    await sync.pull(p, remote, l.hash);
    sync.log(`pushed ${kind} (${l.bytes.length} bytes); reflected collection update`);
    return;
  }
  // Only identity and revision are kept; a note's reply may omit its text.
  sync.remember(p, remote, l.hash);
  sync.log(`pushed ${kind} (${l.bytes.length} bytes)${"via" in next && next.via ? ` via ${next.via}` : ""}`);
}
export function uploadPath(sync: NativeSync, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid upload identity");
  sync.assertDiskPath(`.mdbase/uploads/${id}`);
  return sync.host.join(sync.root, ".mdbase/uploads", id);
}
export async function finishUpload(sync: NativeSync, p: string) {
  const intent = sync.data.uploads![p];
  const bytes = await sync.host.readBytes(sync.uploadPath(intent.transferId));
  if (hash(bytes) !== intent.hash) throw new Error("Upload recovery bytes differ; stopped");
  const next = await retryUpload(() => sync.call("upload", p, bytes, intent.fileId, intent.revision, intent));
  sync.remember(p, sync.remote(next, "file"), intent.hash);
  await sync.clearUpload(p);
  return next;
}
export async function clearUpload(sync: NativeSync, p: string) {
  const intent = sync.data.uploads?.[p]; if (!intent) return;
  delete sync.data.uploads![p]; await sync.persist();
  await sync.host.remove(sync.uploadPath(intent.transferId));
  await sync.call("uploadForget", intent.transferId);
}
export async function resumeUploads(sync: NativeSync) {
  for (const p of Object.keys(sync.data.uploads ?? {})) {
    await sync.assertMirror();
    // An upload saved before this path was known to be a note, a definition
    // or excluded was never accepted. Drop the saved copy; the vault file is
    // untouched and the path pass sends it the right way (or not at all).
    if (sync.kindOf(p) !== "file") { sync.log(`dropped upload for non-file path ${JSON.stringify(p)}`); await sync.clearUpload(p); continue; }
    try {
      await sync.finishUpload(p);
      if (sync.data.pathFailures?.[p]) { delete sync.data.pathFailures[p]; await sync.persist(); }
      sync.note("uploaded", p);
    }
    catch (e: unknown) { const failure = errorInfo(e);
      // Refused outright: resending the same bytes can't succeed. The path
      // pass resends only if they change, and records why in the Sync tab.
      if (isRefusal(e)) { sync.log(`upload refused for ${JSON.stringify(p)}: ${failure.code}`); await sync.clearUpload(p); continue; }
      if (isTransientUpload(e)) {
        if (!sync.mirroring || sync.unloaded) throw e;
        await sync.checkOwnership();
        const intent = sync.data.uploads![p];
        const next = {
          signature: `upload:${intent.transferId}`,
          code: failure.code,
          reason: failure.reason,
          unknown: /unknown/.test(`${failure.code} ${failure.reason}`),
          ...(Array.isArray(failure.issues) ? { issues: failure.issues } : {}),
        };
        const prev = sync.data.pathFailures?.[p];
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
          (sync.data.pathFailures ??= Object.create(null) as NonNullable<SyncState["pathFailures"]>)[p] = next;
          await sync.persist();
        }
        if (prev?.code !== next.code || prev?.reason !== next.reason) sync.note("not_synced", p);
        sync.log(`upload resume deferred for ${JSON.stringify(p)}: ${[failure.code, failure.reason].filter(Boolean).join(" ")}`);
        continue;
      }
      if (!isConflict(e) || !failure.mutationId) throw e;
      const intent = sync.data.uploads![p];
      const bytes = await sync.host.readBytes(sync.uploadPath(intent.transferId));
      const submitted = { bytes, hash: intent.hash, f: undefined, unsupportedEncoding: false };
      await sync.conflict(p, await sync.local(p), (await sync.remoteAll()).get(p), { mutationId: failure.mutationId, local: submitted });
      await sync.clearUpload(p);
      if (sync.data.pathFailures?.[p]) { delete sync.data.pathFailures[p]; await sync.persist(); }
      sync.note("conflict", p);
    }
  }
}
export async function pullFile(sync: NativeSync, p: string, r: Remote, expectedHash?: string) {
  await sync.assertMirror(); sync.assertDiskPath(".mdbase/incoming");
  const token = await sync.call("downloadOpen", r.id);
  await sync.host.stageDownload({
    directory: sync.host.join(sync.root, ".mdbase/incoming"), digest: r.digest!,
    next: () => sync.call("downloadNext", token),
    close: async () => { await sync.call("downloadClose", token); },
    publish: async staged => {
      const latest = await sync.local(p);
      if (latest && latest.hash !== expectedHash && latest.hash !== r.digest) await sync.preserveConflict(p, latest);
      const current = await sync.local(p);
      if (current?.hash !== latest?.hash) throw new Error("Local file changed during download; retained");
      await sync.ensureFolder(sync.vaultPath(p));
      await sync.assertMirror(); sync.assertDiskPath(p);
      await sync.host.publish(staged, sync.host.join(sync.root, p), current?.hash, r.digest!, () => sync.checkOwnership(), () => sync.publicationGuard(p, current?.hash));
      sync.remember(p, r, r.digest!);
    },
  });
}
/** Delete `p` here. With an expected hash, refuses if the file changed meanwhile. */
export async function removeLocal(sync: NativeSync, p: string, ...expected: [expectedHash?: string]) {
  const [expectedHash] = expected;
  await sync.assertMirror(); sync.assertDiskPath(p);
  const latest = await sync.local(p);
  if (expected.length > 0 && latest?.hash !== expectedHash) throw Object.assign(new Error("Local file changed before delete; bytes retained"), { code: "local_changed" });
  sync.writingPaths.add(p);
  try {
  try {
    const current = await sync.host.hash(await sync.host.readBytes(sync.host.join(sync.root, sync.vaultPath(p))));
    if (expected.length > 0 && current !== expectedHash) throw Object.assign(new Error("Local file changed before delete; bytes retained"), { code: "local_changed" });
    await sync.assertMirror(); sync.assertDiskPath(p);
    await sync.host.remove(sync.host.join(sync.root, p));
  } catch (e: unknown) { if (errorInfo(e).code !== "ENOENT") throw e; }
  delete sync.data.paths[p]; await sync.persist();
  } finally { sync.writingPaths.delete(p); }
}
/** Tell the collection a file moved here, so it moves the item rather than sending it again. */
export async function moveLocal(sync: NativeSync, from: string, to: string, k: Synced, r: Remote) {
  await sync.assertMirror();
  let next: WireItem;
  try {
    next = r.kind === "record"
      ? await sync.call("replace", r.id, { path: from, doc: r.document! }, { path: to, doc: r.document! }, r.revision)
      : await sync.call("fileMove", r.id, to, r.revision);
  } catch (e: unknown) { const failure = errorInfo(e);
    // A rejected path-only record CAS is still a ledger write. Preserve its
    // exact submitted document/target before acknowledging it, just as for an
    // edit rejection. Usually the user's moved file itself is the copy, so do
    // not manufacture a second identical conflict file unnecessarily.
    if (isConflict(e) && failure.mutationId && r.kind === "record") {
      const bytes = encode(r.document!), submitted = { f: undefined, bytes, hash: hash(bytes), unsupportedEncoding: false };
      const local = await sync.local(to), target = (await sync.remoteAll()).get(to);
      if (local?.hash === submitted.hash && (!target || (target.kind === "record" && target.hash === submitted.hash && target.confirmed === true))) {
        const h = { path: from, hash: submitted.hash, kind: "record" as const, copy: to, handled: false };
        (sync.data.handledRejections ??= {})[failure.mutationId] = h; await sync.persist();
        if (!target) await sync.push(to, submitted);
        h.handled = true; await sync.persist();
      } else await sync.preserveConflict(to, submitted, failure.mutationId);
      await sync.acknowledgeHandled();
    }

    throw e; // caller refreshes the winning remote identity before reconciling
  }
  delete sync.data.paths[from];
  delete sync.data.pendingPaths?.[from]; delete sync.data.pendingPaths?.[to];
  // Move first, then CAS any content edit in the ordinary path pass.
  let moved = sync.remote(next, r.kind);
  if (r.kind === "record" && typeof moved.document !== "string" && moved.revision.startsWith("sha256:") && moved.revision !== k.hash) {
    moved = sync.remote(await sync.call("get", moved.id), r.kind);
  }
  if (r.kind === "record" && typeof moved.document === "string" && moved.hash !== k.hash && moved.path === to) {
    await sync.pull(to, moved, k.hash);
  } else {
    sync.remember(to, moved, k.hash);
  }
  sync.note("moved", from, { to, from: "here" });
  sync.log(`local ${r.kind} move: ${JSON.stringify(from)} -> ${JSON.stringify(to)} id=${r.id} (no upload/download)`);
  return moved;
}
