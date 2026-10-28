/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- Preserve the spike\'s dynamic SDK bridge; lifecycle and on-disk checks guard optional state. */
// The SDK host page. Runs in a loopback iframe inside Obsidian so the SDK sees a
// native app origin (http://127.0.0.1:<vault port>). Owns the WASM replica; the plugin
// drives it over postMessage and does all vault IO.
import { createMdbase } from "@mdbase-dev/sdk";
import template from "./mdbase-app.json";
import { DownloadPull } from "./downloadPull";
import { RetryUploads } from "./upload";
const manifest = { ...template, homepage: `${location.origin}/`, redirect_uris: [`${location.origin}/auth/mdbase/callback`] };
const namespace = new URL(location.href).searchParams.get("vault");
if (!namespace) throw new Error("Missing stable vault storage namespace");

declare const __MDBASE_ENVIRONMENT__: "lab" | "production";
let bridge: MessagePort | null = null;
const queued: any[] = [];
if (parent === window) throw new Error("Native SDK must run inside its owning vault");
const post = (msg: any, transfer: Transferable[] = []) => {
  if (bridge) bridge.postMessage(msg, transfer); else queued.push(msg);
};
const log = (...parts: any[]) => post({ type: "log", text: parts.map(String).join(" ") });

const mdbase = createMdbase(
  { id: manifest.id, name: manifest.name, environment: __MDBASE_ENVIRONMENT__, origin: location.origin, manifest, storage: { applicationNamespace: namespace } },
  { followVisibility: false, signIn: { open: (url: string) => post({ type: "open-url", url }) } },
);
// The iframe is deliberately hidden; Obsidian, not iframe visibility, owns IO.
mdbase.setForeground(true);
const confirmed = async (w: any) => {
  const receipt = await w.confirmed;
  // Confirmation means the log accepted an outcome, not necessarily our edit.
  // In particular two path-only moves can confirm with a recorded path conflict
  // (their document revision is identical). Preserve the losing intent before
  // explicitly dismissing that runtime conflict, just like a rejected CAS.
  if (receipt?.status === "conflicted" || receipt?.conflicts?.length) {
    throw Object.assign(new Error("Confirmed write contains unresolved conflicts"), { code: "conflict", reason: "recorded_conflict", mutationId: receipt.mutation });
  }
  return w;
};

function phaseSummary() {
  const s: any = mdbase.getSnapshot();
  const p: any = s.phase;
  return {
    kind: p.kind,
    collectionId: p.collectionId ?? null,
    sync: s.sync ? { kind: s.sync.kind, text: s.sync.text, pending: s.sync.pending, health: s.sync.health } : null,
    problem: p.problem ? { code: p.problem.code, reason: p.problem.reason, title: p.problem.title, message: p.problem.message } : null,
    collections: (s.collections ?? []).map((c: any) => ({ id: c.collectionId, name: c.displayName ?? c.name ?? c.collectionId, availability: c.availability?.kind ?? c.availability ?? null })),
  };
}
let last = "";
mdbase.subscribe(() => {
  const summary = phaseSummary();
  const key = JSON.stringify(summary);
  if (key !== last) { last = key; post({ type: "phase", phase: summary }); }
});

function records(): any {
  const p: any = mdbase.getSnapshot().phase;
  if (p.kind !== "ready") throw Object.assign(new Error(`not ready (${p.kind})`), { code: "not_ready" });
  return p.connection.records;
}
const files = (): any => { records(); return (mdbase.getSnapshot().phase as any).connection.files; };
const fplain = (f: any) => ({ id: f.id, path: f.path, size: f.size, digest: f.digest, state: f.state, media: f.media, confirmed: f.confirmedSeq > 0 && f.state !== "pending_upload" && !f.hold });
const plain = (r: any) => ({ id: r.id, path: r.path, revision: r.revision, document: r.document, state: r.state?.kind ?? r.state, confirmed: r.state?.state === "confirmed" && !r.state?.hold && !r.state?.unresolved });

const downloads = new Map<string, DownloadPull>();
const uploads = new RetryUploads();
let watch: { close?: () => void; stop?: () => void; ready?: Promise<void> } | null = null;
const methods: Record<string, (...args: any[]) => Promise<any>> = {
  start: async () => { await mdbase.start(); return phaseSummary(); },
  signIn: async () => { await mdbase.signIn(); return phaseSummary(); },
  // No discard flag: the SDK must refuse sign-out with unconfirmed writes.
  signOut: async () => { await mdbase.signOut(); return phaseSummary(); },
  addCollection: async () => { await mdbase.addCollection(); return phaseSummary(); },
  configure: async () => { await mdbase.configure(); return phaseSummary(); },
  approve: async (id?: string | null) => { await mdbase.approve(id ?? null); return phaseSummary(); },
  select: async (id: string) => { await mdbase.select(id); return phaseSummary(); },
  // Every record with its exact source.
  all: async () => {
    // Native QUERY budgets hydrated source bytes as well as row count. Even a
    // bounded page of 64 mixed-size notes can exceed 1 MiB. Restart with smaller
    // pages on that precise refusal; never return a truncated/duplicate snapshot.
    for (let limit = 64; ; limit = Math.max(1, Math.floor(limit / 2))) {
      const out: any[] = [];
      try {
        for await (const page of records().queryPages({ limit }, { document: true }, undefined, { onReset: () => { out.length = 0; } }))
          for (const r of page.records) out.push(plain(r));
        return out;
      } catch (e: any) {
        if (limit === 1 || e?.code !== "too_large" || e?.reason !== "query_budget_exceeded") throw e;
      }
    }
  },
  get: async (id: string) => plain(await records().get(id, { document: true })),
  // Bounded ordinary reads for an event's affected paths. Only not_found means
  // absent: permission, budget and transient errors must never look like deletes.
  at: async (paths: string[]) => {
    const out: any[] = []; let next = 0;
    const read = async (path: string) => {
      try { return { ...plain(await records().get({ path }, { document: true })), kind: "record" }; }
      catch (e: any) { if (e?.code !== "not_found") throw e; }
      try { return { ...fplain(await files().get({ path })), kind: "file" }; }
      catch (e: any) { if (e?.code !== "not_found") throw e; }
      return null;
    };
    await Promise.all(Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (next < paths.length) { const row = await read(paths[next++]); if (row) out.push(row); }
    }));
    return out;
  },
  watch: async (cursor?: string) => {
    watch?.close?.(); watch?.stop?.();
    watch = records().watchChanges(cursor, (batch: any) =>
      post({ type: "changes", batch: { cursor: batch.cursor, reset: batch.reset, changes: batch.changes.map((c: any) => ({ id: c.id, path: c.path, kind: c.kind, entity: c.entity ?? null })) } }));
    // The ACK is delivered only after the initial reset/replay callback. Keep
    // startup's barrier closed until that callback has reached the parent.
    await watch!.ready;
    return true;
  },
  create: async (path: string, document: string) => {
    const w: any = await confirmed(await records().create({ path, document }));
    return plain(await records().get(w.recordId, { document: true }));
  },
  replace: async (id: string, base: { path: string; doc: string }, next: { path: string; doc: string }, revision: string) => {
    const ws: any[] = await records().submit([{ kind: "document", id, base, new: next, ifRevision: revision }]);
    await Promise.all(ws.map(confirmed));
    return plain(await records().get(id, { document: true }));
  },
  // ---- files (attachments and anything not a record) ----
  filesAll: async () => { const out: any[] = []; for await (const f of files().list({})) out.push(fplain(f)); return out; },
  fileGet: async (id: string) => fplain(await files().get(id)),
  downloadOpen: async (id: string) => {
    const token = crypto.randomUUID();
    downloads.set(token, new DownloadPull(await files().downloadStream(id)));
    return token;
  },
  downloadNext: async (token: string) => {
    const stream = downloads.get(token);
    if (!stream) throw new Error("Unknown download");
    return stream.next();
  },
  downloadClose: async (token: string) => {
    const stream = downloads.get(token); downloads.delete(token);
    await stream?.close(); return true;
  },
  upload: async (path: string, bytes: Uint8Array, fileId?: string, ifRevision?: string, identity?: { transferId: string; mutationId: string }) => uploads.run(identity, async () => {
    const w: any = await confirmed(await files().upload(path, bytes, { ...identity, ...(fileId ? { fileId } : {}), ...(ifRevision ? { ifRevision } : {}), onProgress: (p: any) => post({ type: "transfer", direction: "upload", done: p.done, total: p.total }) }));
    return fplain(await files().get(w.fileId));
  }),
  uploadForget: async (id: string) => { uploads.forget(id); return true; },
  // Obsidian rewrites links itself and those edits sync as record edits, so the replica must not too.
  fileMove: async (id: string, to: string, revision: string) => {
    await confirmed(await files().move(await files().get(id), to, { updateRefs: false, ifRevision: revision }));
    return fplain(await files().get(id));
  },
  fileDelete: async (id: string, revision: string) => { await confirmed(await files().delete(await files().get(id), { ifRevision: revision })); return true; },
  remove: async (id: string, revision: string) => { await confirmed(await records().delete(await records().get(id), { ifRevision: revision })); return true; },
  // Deliberately return identifiers only: ledger problems/receipts may contain
  // submitted documents. A legacy rejection without a recovery journal is NOT
  // evidence of which bytes were preserved.
  rejectedWrites: async () => {
    const client = records();
    const entries = new Map<string, { mutationId: string; records: string[]; code: string }>();
    for (const e of client.ledger.getSnapshot().rejected) entries.set(e.mutationId, { mutationId: e.mutationId, records: [...e.records], code: e.problem?.code ?? "unknown" });
    for (const e of await client.listConflicts()) {
      const entry = entries.get(e.mutation) ?? { mutationId: e.mutation, records: [] as string[], code: `recorded_${e.conflict.kind}` };
      if (!entry.records.includes(e.conflict.id)) entry.records.push(e.conflict.id);
      entries.set(e.mutation, entry);
    }
    return [...entries.values()];
  },
  acknowledge: async (mutationId: string) => {
    const client = records(), ledger = client.ledger;
    if (!ledger.getSnapshot().restored) throw new Error("Write ledger not restored");
    // The plugin calls this only with exact preservation proof (or an explicit
    // user-reviewed discard). Never clear other mutations or unproven conflicts.
    for (const entry of await client.listConflicts()) if (entry.mutation === mutationId) await confirmed(await client.dismissConflict(entry));
    await ledger.acknowledge(mutationId);
    return !ledger.getSnapshot().rejected.some((e: any) => e.mutationId === mutationId) && !(await client.listConflicts()).some((e: any) => e.mutation === mutationId);
  },
  unwatch: async () => { watch?.close?.(); watch?.stop?.(); watch = null; return true; },
  drain: async () => {
    const until = Date.now() + 120_000;
    while (true) {
      const status = await records().getStatus();
      const writes: any = mdbase.getSnapshot().writes;
      if (writes?.rejected?.length || status.holds > 0 || status.unresolved > 0) {
        log(`drain blocked: rejected=${writes?.rejected?.length ?? 0} holds=${status.holds} unresolved=${status.unresolved} pending=${status.pending}`);
        throw new Error("Unresolved writes/holds; ownership retained");
      }
      if (writes?.restored !== false && status.pending === 0 && (writes?.pending?.length ?? 0) === 0) return true;
      if (Date.now() >= until) throw new Error("Drain timed out; ownership retained");
      await new Promise(resolve => window.setTimeout(resolve, 200));
    }
  },
  stop: async () => { watch?.close?.(); watch?.stop?.(); watch = null; await mdbase.close(); return true; },
  debug: async () => {
    const s: any = mdbase.getSnapshot();
    const safe = (v: any) => JSON.parse(JSON.stringify(v ?? null, (_k, x) => typeof x === "bigint" ? Number(x) : typeof x === "function" ? undefined : x));
    // Conflict values can contain documents/blob references. Diagnostics expose
    // identifiers only, even when the visible file namespace has been cleaned.
    const conflicts = s.phase.kind === "ready" ? (await records().listConflicts()).map((e: any) => ({ seq: e.seq, mutationId: e.mutation, id: e.conflict.id, kind: e.conflict.kind })) : [];
    return safe({ phase: { kind: s.phase.kind, slow: s.phase.slow, progress: s.phase.progress, problem: s.phase.problem }, status: s.status, problem: s.problem, problemDetail: s.problemDetail, readiness: s.readiness, openingProgress: s.openingProgress, sync: s.sync, conflicts });
  },
  status: async () => { const s: any = await records().getStatus(); const w = records().ledger.getSnapshot(); return JSON.parse(JSON.stringify({ ...s, rejected: w.rejected.length, ledgerPending: w.pending.length, restored: w.restored }, (_k, v) => typeof v === "bigint" ? Number(v) : v)); },
};


async function receive(e: MessageEvent) {
  if (!e.data || e.data.type !== "call") return;
  const { id, method, args } = e.data;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`unknown method ${method}`);
    const value: any = await fn(...(args ?? []));
    post({ type: "result", id, ok: true, value }, method === "downloadNext" && value.bytes ? [value.bytes.buffer] : []);
  } catch (err: any) {
    post({ type: "result", id, ok: false, error: { code: err?.code ?? null, reason: err?.reason ?? null, mutationId: err?.mutationId ?? null, message: String(err?.message ?? err) } });
  }
}
window.addEventListener("message", e => {
  if (e.source !== parent || e.data?.type !== "connect" || bridge || !e.ports[0]) return;
  bridge = e.ports[0]; bridge.onmessage = receive;
  for (const msg of queued.splice(0)) bridge.postMessage(msg);
});
// Error messages can include submitted documents or URLs; log only identifiers.
window.addEventListener("error", () => log("page error (details intentionally omitted)"));
window.addEventListener("unhandledrejection", (e: any) => log("page rejection:", e.reason?.code ?? "unknown", e.reason?.reason ?? ""));
parent.postMessage({ type: "hello", origin: location.origin, opfs: !!navigator.storage?.getDirectory, isSecureContext }, "*");
