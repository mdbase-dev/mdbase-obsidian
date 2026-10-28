/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-this-alias -- Preserve the spike\'s dynamic SDK bridge; lifecycle and on-disk checks guard optional state. */
// Native SDK host ported from the verified Obsidian SDK spike. The iframe owns the replica; all
// vault IO and durable three-way sync state live here. No page/ runtime files.
import { Notice, Component, SuggestModal, TAbstractFile, TFile, App, FileSystemAdapter, type PluginManifest } from "obsidian";
import { nativeModule } from "./node";
const http = nativeModule<typeof import("node:http")>("http");
const fs = nativeModule<typeof import("node:fs")>("fs");
const path = nativeModule<typeof import("node:path")>("path");
const os = nativeModule<typeof import("node:os")>("os");
const { createHash, randomUUID } = nativeModule<typeof import("node:crypto")>("crypto");
const { spawnSync } = nativeModule<typeof import("node:child_process")>("child_process");
const { brotliDecompressSync } = nativeModule<typeof import("node:zlib")>("zlib");
import packedAssets from "embedded:assets";
import { validVaultPort } from "../ownership";
import { stageDownload } from "./download";
import { retryUpload, type UploadIdentity } from "./upload";
import { conflictPath, reconcileDecision, remoteMoveDecision, localMovePairs, Synced } from "./reconcile";


const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm",
};
interface Data {
  version: 1; vaultId: string; port?: number; collectionId?: string; markerSince?: number;
  // Prevent copied settings from opening another vault's writable replica.
  vaultLocation?: string;
  paths: Record<string, Synced>; cursor?: string;
  uploads?: Record<string, UploadIdentity & { hash: string; fileId?: string; revision?: string }>;
  // Absolute deadlines for unpaired deletes AND unknown creates. Paths retain
  // their synced identity until confirmation; startup reconciles even after crash.
  pendingPaths?: Record<string, number>;
  // Per-input failures do not block unrelated paths or endlessly resubmit a
  // rejected create. Changed inputs or explicit resync retry known outcomes.
  pathFailures?: Record<string, { signature: string; code?: string; reason?: string; unknown?: boolean }>;
  // Intent is saved before writing the copy; handled only after confirmed upload.
  handledRejections?: Record<string, { path: string; hash: string; kind: "record" | "file"; copy?: string; handled?: boolean }>;
  // Retain copy identity until the original has been resolved, even for
  // snapshot conflicts without a rejected mutation ID.
  conflictCopies?: Record<string, { path: string; hash: string; copy: string; kind: "record" | "file" }>;
}
// eslint-disable-next-line obsidianmd/prefer-active-doc -- This is the SDK record document field, not a DOM document.
interface Remote { id: string; path: string; kind: "record" | "file"; revision: string; hash?: string; document?: string; digest?: string; confirmed?: boolean }
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const isConflict = (e: any) => /conflict|revision/.test(`${e?.code} ${e?.reason}`);

export default class NativeSync extends Component {
  constructor(readonly app: App, readonly manifest: PluginManifest, readonly changed: (text: string, phase: any) => void, readonly previousCollection?: string) { super(); }
  server: import("node:http").Server | null = null;
  frame: HTMLIFrameElement | null = null;
  calls = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: number }>();
  nextCall = 1;
  phase: any = { kind: "starting" };
  bridge: MessagePort | null = null;
  data!: Data;
  origin = "";
  // A web page must not be able to frame this authenticated SDK host. The
  // capability is memory-only, checked by the HTTP listener before serving HTML.
  private readonly frameCapability = randomUUID();
  signInUrl: string | null = null; // bearer secret, memory only; never log
  mirroring = false;
  admitting = true;
  unloaded = false;
  jobs: Promise<any> = Promise.resolve(); // FS/state transactions, not an upload-lane workaround.
  root = "";
  pluginDir = "";
  markerTimer: number | null = null;
  settleTimer: number | null = null;
  served = new Set<string>();
  warnedPaths = new Set<string>();
  assets = new Map<string, Buffer>();
  reconcileQueued = false;
  reconcileFull = false;
  reconcilePaths = new Set<string>();
  reconcileCursor?: string;
  startingMirror = false;
  syncingFiles = false;
  reconcileImmediate = false;
  reconcileRetryTimer: number | null = null;
  reconcileRetryDelay = 250;
  writingPaths = new Set<string>();

  onload(): void { void this.initialize(); }

  async initialize(): Promise<void> {
    this.setStatus("Starting sync");
    this.pluginDir = path.join((this.app.vault.adapter as any).getBasePath(), this.manifest.dir!);
    this.root = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
    // Obsidian's loadData returns null after a JSON parse failure. Treating that
    // as first install destroys the only durable sync/rejection journal.
    try {
      this.data = this.readData();
      this.data.paths = Object.assign(Object.create(null), this.data.paths);
      this.data.pathFailures = Object.assign(Object.create(null), this.data.pathFailures);
      this.bindVault();
      if (!this.data.collectionId && this.previousCollection) this.data.collectionId = this.previousCollection;
      // A marker from desktop, an unknown host, or another installation is never
      // overridden, even when stale. Do not overwrite data before this check.
      this.checkOwnership();
      this.persist();
      await this.startServer();
      // Reserve even on first sign-in, before the SDK can auto-open anything.
      // collection_id is null only until the SDK first identifies a collection;
      // the daemon refuses host:"obsidian" regardless of that optional field.
      this.claim(this.data.collectionId);
    } catch (e) { this.server?.close(); this.phase = { kind: "blocked" }; this.fail("startup", e); return; }
    this.registerDomEvent(window, "message", (e: MessageEvent) => this.onMessage(e));
    this.frame = this.app.workspace.containerEl.createEl("iframe", { attr: { src: this.pageUrl(), "data-mdbase-native": "1" } });
    Object.assign(this.frame.style, { position: "fixed", width: "1px", height: "1px", border: "0", left: "-10px", top: "-10px" });
    this.markerTimer = window.setInterval(() => {
      try {
        this.checkOwnership();
        if (this.ownsMarker()) this.writeMarker();
      } catch (e) { this.pauseForOwnership(e); }
    }, 5000);
    this.registerEvent(this.app.vault.on("create", f => this.onVaultChange(f, true)));
    this.registerEvent(this.app.vault.on("modify", f => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", f => this.onVaultChange(f, true)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => {
      if (!this.admitting || !this.mirroring) return;
      if (this.collectionPath(f.path) || this.collectionPath(old)) void this.enqueue(() => this.renameLocal(f, old));
    }));
  }

  pageUrl() {
    return `${this.origin}/?bridge=${this.frameCapability}&vault=${encodeURIComponent(`obsidian-vault-${this.data.vaultId}`)}${this.data.collectionId ? `&collection=${encodeURIComponent(this.data.collectionId)}` : ""}`;
  }
  async addCollection() {
    // SDK approval selects the newly added collection. A bound mirror cannot
    // follow that switch without putting its existing files in another collection.
    if (this.data.collectionId) {
      this.fail("add collection", { code: "collection_bound" }); return;
    }
    await this.call("addCollection");
  }

  // Obsidian does not await onunload. Abrupt exit/reload MUST retain ownership:
  // only the explicit drain/stop command is allowed to remove the descriptor.
  onunload() {
    this.unloaded = true; this.admitting = false; this.mirroring = false;
    if (this.markerTimer) window.clearInterval(this.markerTimer);
    if (this.settleTimer) window.clearTimeout(this.settleTimer);
    if (this.reconcileRetryTimer) window.clearTimeout(this.reconcileRetryTimer);
    this.reconcileRetryTimer = null;
    this.bridge?.close(); this.bridge = null;
    this.frame?.remove(); this.server?.close();
    for (const c of this.calls.values()) { window.clearTimeout(c.timer); c.reject(new Error("unloaded")); }
    this.calls.clear();
  }
  bindVault() {
    const location = `${os.hostname()}:${fs.realpathSync(this.root)}`;
    if (this.data.vaultLocation !== undefined && this.data.vaultLocation !== location)
      throw new Error("sync-state.json belongs to another vault or host; refusing shared replica storage. Restore this vault's own settings (do not copy another vault's sync-state.json).");
    this.data.vaultLocation = location;
  }
  readData(): Data {
    let saved: any;
    try { saved = JSON.parse(fs.readFileSync(path.join(this.pluginDir, "sync-state.json"), "utf8")); }
    catch (e: any) {
      if (e.code === "ENOENT") return { version: 1, vaultId: randomUUID(), paths: {} };
      throw new Error("Cannot read sync-state.json; sync stopped and original state retained. Restore a valid backup before reloading.");
    }
    const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
    if (!object(saved) || saved.version !== 1 || typeof saved.vaultId !== "string" || !saved.vaultId || !object(saved.paths)
      || Object.values(saved.paths).some((s: any) => !object(s) || !["record", "file"].includes(s.kind) || ![s.id, s.revision, s.hash].every(v => typeof v === "string" && !!v))
      || (saved.uploads !== undefined && (!object(saved.uploads) || Object.entries(saved.uploads).some(([p, u]: [string, any]) => !this.validPath(p) || !object(u) || ![u.transferId, u.mutationId].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)) || typeof u.hash !== "string")))
      || (saved.pendingPaths !== undefined && (!object(saved.pendingPaths) || Object.values(saved.pendingPaths).some(v => typeof v !== "number" || !Number.isFinite(v))))
      || (saved.pathFailures !== undefined && (!object(saved.pathFailures) || Object.values(saved.pathFailures).some((h: any) => !object(h) || typeof h.signature !== "string" || (h.unknown !== undefined && typeof h.unknown !== "boolean"))))
      || (saved.conflictCopies !== undefined && (!object(saved.conflictCopies) || Object.values(saved.conflictCopies).some((h: any) => !object(h) || ![h.path, h.hash, h.copy].every(v => typeof v === "string" && !!v) || !["record", "file"].includes(h.kind))))
      || (saved.handledRejections !== undefined && (!object(saved.handledRejections) || Object.values(saved.handledRejections).some((h: any) => !object(h) || typeof h.path !== "string" || typeof h.hash !== "string" || !["record", "file"].includes(h.kind)))))
      throw new Error("Invalid sync-state.json; sync stopped and original state retained. Restore a valid backup before reloading.");
    return saved;
  }
  persist() {
    const file = path.join(this.pluginDir, "sync-state.json"), temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
  }
  enqueue(work: () => Promise<any>) {
    // Stop admitting stream/command work as well as vault events. Already
    // admitted jobs still finish before handover's final scan and drain.
    if (!this.admitting) return Promise.resolve();
    const run = this.jobs.then(async () => { if (!this.unloaded && this.mirroring) return work(); });
    this.jobs = run.catch(e => this.fail("sync", e)); return run.catch(() => {});
  }

  // ---- in-memory loopback assets -------------------------------------------
  async startServer() {
    this.server = http.createServer((req, res) => {
      let request: URL;
      try { request = new URL(req.url ?? "/", this.origin); } catch { res.writeHead(400).end(); return; }
      let rel = request.pathname;
      if (rel.startsWith("/auth/")) { res.writeHead(200, { "content-type": "text/plain" }).end("Return to Obsidian to finish signing in."); return; }
      if (rel === "/" || rel === "/index.html") {
        if (request.searchParams.get("bridge") !== this.frameCapability) { res.writeHead(403).end(); return; }
        rel = "/index.html";
      }
      const packed = (packedAssets)[rel];
      if (!packed) { res.writeHead(404).end(); return; }
      let bytes = this.assets.get(rel);
      if (!bytes) { bytes = brotliDecompressSync(Buffer.from(packed, "base64")); this.assets.set(rel, bytes); }
      if (!this.served.has(rel)) { this.served.add(rel); this.log(`memory asset ${rel} (${bytes.length} bytes)`); }
      res.writeHead(200, { "content-type": TYPES[path.extname(rel)] ?? "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
      res.end(bytes);
    });
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      const failed = (e: Error) => { this.server!.off("listening", ready); reject(e); };
      const ready = () => { this.server!.off("error", failed); resolve(); };
      this.server!.once("error", failed); this.server!.once("listening", ready);
      this.origin = `http://127.0.0.1:${port}`; this.server!.listen(port, "127.0.0.1");
    });
    if (this.data.port !== undefined) {
      if (!validVaultPort(this.data.port)) throw new Error("Invalid saved native port");
      try { await listen(this.data.port); }
      catch (e: any) { throw new Error(`Saved port ${this.data.port} unavailable (${e.code}); not switching origins. Close the other listener and reload.`); }
    } else {
      const first = Math.floor(Math.random() * 100);
      for (let n = 0; n < 100; n++) {
        const port = 48300 + ((first + n) % 100);
        try { await listen(port); this.data.port = port; this.persist(); break; }
        catch (e: any) { if (e.code !== "EADDRINUSE") throw e; }
      }
      if (!this.data.port) throw new Error("No free native port in 48300–48399");
    }
    this.log(`native host ${this.origin}; assets embedded in main.js`);
  }

  // ---- ownership: .mdbase is private, never a mirrored collection path -------
  get markerPath() { return path.join(this.root, ".mdbase", "host.json"); }
  readMarker(): any {
    this.assertDiskPath(".mdbase/host.json");
    try {
      const marker = JSON.parse(fs.readFileSync(this.markerPath, "utf8"));
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("Invalid marker");
      return marker;
    } catch (e: any) { if (e.code === "ENOENT") return null; throw new Error("Unreadable ownership marker; waiting for desktop/manual recovery"); }
  }
  ownsMarker(m = this.readMarker()) {
    return !!m && Number.isSafeInteger(this.data.markerSince) && m.host === "obsidian" && m.collection_id === (this.data.collectionId ?? null) && m.since_ms === this.data.markerSince;
  }
  checkOwnership() {
    this.assertDiskPath(".mdbase/host.lock");
    const m = this.readMarker();
    if ((m && !this.ownsMarker(m)) || (!m && this.mirroring)) throw new Error("Folder owned elsewhere (or ownership marker missing); waiting. Never remove another host's marker.");
    const lock = path.join(this.root, ".mdbase", "host.lock");
    if (fs.existsSync(lock)) {
      // Node has no flock primitive. Probe the same OS advisory lock used by the
      // daemon; absence of a supported probe fails closed instead of guessing by age.
      if (process.platform !== "linux" || spawnSync("flock", ["-n", lock, "true"], { timeout: 1000 }).status !== 0)
        throw new Error("Desktop folder lock held or lock probe unavailable; waiting");
    }
  }
  claim(id?: string) {
    this.checkOwnership();
    if (this.data.collectionId && this.data.collectionId !== id) throw Object.assign(new Error("Folder is bound to another collection; drain it before reconfiguration"), { code: "collection_bound" });
    this.data.collectionId = id; this.data.markerSince ??= Date.now(); this.persist();
    this.writeMarker(); this.checkOwnership();
    if (!this.ownsMarker()) throw new Error("Ownership changed while claiming folder");
  }
  writeMarker() {
    this.assertDiskPath(".mdbase/host.json");
    fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
    const temp = this.markerPath + `.obsidian-${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ host: "obsidian", pid: process.pid, collection_id: this.data.collectionId ?? null, since_ms: this.data.markerSince, heartbeat_ms: Date.now() }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, this.markerPath);
  }
  pauseForOwnership(e: any) {
    if (!this.admitting) return;
    this.admitting = false; this.mirroring = false;
    this.setStatus("Another app is syncing this folder. Waiting for it."); this.fail("ownership", e);
    void this.call("stop").catch(() => {}); // never removes the competing marker
  }
  async handover() {
    if (!this.admitting) return;
    this.admitting = false;
    try {
      if (this.data.collectionId && !this.mirroring) throw new Error("Collection not ready; cannot verify drain");
      await this.jobs;
      await this.reconcileAll(); // captures any local edits not yet admitted to the queue
      if (Object.keys(this.data.pathFailures ?? {}).length) throw new Error("File sync failures remain; local bytes retained and handover blocked");
      await this.call("unwatch");
      if (this.data.collectionId) {
        await this.call("drain");
        this.log("handover: drain confirmed pending 0, holds 0, unresolved 0");
      }
      this.mirroring = false;
      await this.call("stop");
      this.checkOwnership();
      if (!this.ownsMarker()) throw new Error("Ownership changed during handover");
      fs.unlinkSync(this.markerPath);
      this.log("handover: SDK stopped; own marker removed");
      if (this.markerTimer) window.clearInterval(this.markerTimer);
      this.setStatus("Sync stopped here. Add this folder to mdbase using the same collection.");
      new Notice("mdbase: drained and stopped. Desktop may now join this folder's existing collection.");
    } catch (e) { this.mirroring = false; this.fail("handover (marker retained)", e); }
  }

  // ---- iframe RPC ----------------------------------------------------------
  call(method: string, ...args: any[]): Promise<any> {
    if (!this.bridge) return Promise.reject(new Error("SDK host is not running"));
    const id = this.nextCall++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.calls.delete(id); reject(Object.assign(new Error(`SDK ${method} timed out; outcome may be unknown`), { code: "outcome_unknown" })); }, 180_000);
      this.calls.set(id, { resolve, reject, timer });
      this.bridge!.postMessage({ type: "call", id, method, args });
    });
  }
  onMessage(e: MessageEvent) {
    if (e.origin !== this.origin || e.source !== this.frame?.contentWindow || !e.data) return;
    const m = e.data;
    switch (m.type) {
      case "hello": {
        if (this.bridge) return;
        const channel = new MessageChannel(); this.bridge = channel.port1;
        channel.port1.onmessage = event => this.onMessage({ origin: this.origin, source: this.frame!.contentWindow, data: event.data } as MessageEvent);
        this.frame.contentWindow!.postMessage({ type: "connect" }, this.origin, [channel.port2]);
        this.log(`page up: origin=${m.origin} opfs=${m.opfs} secure=${m.isSecureContext}`);
        try { this.checkOwnership(); } catch (e) { this.pauseForOwnership(e); return; }
        void this.call("start").catch(e => this.fail("start", e)); break;
      }
      case "phase": void this.onPhase(m.phase).catch(e => this.fail("phase", e)); break;
      case "open-url": this.openSignIn(m.url); break;
      case "changes": {
        const paths = new Set<string>();
        const changed = new Set(m.batch.changes.map((c: any) => c.id));
        for (const c of m.batch.changes) if (this.validPath(c.path)) paths.add(c.path);
        // Include the old path for moves and tombstones whose path is absent.
        for (const [p, k] of Object.entries(this.data.paths)) if (changed.has(k.id)) paths.add(p);
        this.requestReconcile(m.batch.reset ? undefined : paths, m.batch.cursor); break;
      }
      case "transfer":
        if (this.mirroring && Number.isFinite(m.done) && Number.isFinite(m.total) && m.total > 0)
          this.setStatus(`${m.direction === "upload" ? "uploading" : "downloading"} ${Math.min(100, Math.round(100 * m.done / m.total))}% (${Math.round(m.total / 1024 / 1024)} MiB)`);
        break;
      case "log": this.log(this.safeText(m.text)); break;
      case "result": {
        const c = this.calls.get(m.id); if (!c) return;
        this.calls.delete(m.id); window.clearTimeout(c.timer);
        if (m.ok) c.resolve(m.value); else c.reject(Object.assign(new Error(m.error.message), m.error)); break;
      }
    }
  }
  async select(id: string) { this.claim(id); await this.call("select", id); }
  async onPhase(phase: any) {
    const was = this.phase; this.phase = phase;
    // Apply the transition before awaiting select/watch. A ready notification
    // can arrive while the earlier choosing handler is still awaiting select;
    // that older handler must not turn mirroring off again after ready wins.
    if (phase.kind !== "ready") this.mirroring = false;
    if (["ready", "signed_out", "problem", "closed"].includes(phase.kind)) this.signInUrl = null;
    const phaseText: Record<string, string> = {
      starting: "Starting sync", signed_out: "Sign in to sync this vault.", authorizing: "Finish signing in in your browser.",
      choosing: "Choose the collection to sync with this vault.", opening: "Getting your collection ready.",
      problem: "Sync needs attention. Your files are kept on this computer.", closed: "Sync stopped. Your files stay here.",
    };
    if (this.admitting && !(phase.kind === "ready" && (this.syncingFiles || this.startingMirror)))
      this.setStatus(phase.kind === "ready" ? phase.sync?.text ?? "Checking your files" : phaseText[phase.kind] ?? "Starting sync");
    // Names/documents never belong in this log.
    this.log(`phase ${phase.kind}${phase.problem ? ` ${phase.problem.code ?? ""} ${phase.problem.reason ?? ""}` : ""}${phase.sync ? ` sync=${phase.sync.kind} pending=${phase.sync.pending}` : ""}`);
    if (this.admitting && phase.problem && JSON.stringify(phase.problem) !== JSON.stringify(was.problem))
      this.fail("sync", phase.problem, [phase.problem.title, phase.problem.message].filter(Boolean).join(": ") || undefined);
    if (phase.sync?.kind === "offline" && was.sync?.kind !== "offline")
      new Notice("mdbase: sync service unreachable. Changes are saved on this device and will sync when the connection returns.", 10000);
    if (this.admitting && phase.kind === "opening" && phase.collectionId) {
      try { this.claim(phase.collectionId); } catch (e) { this.pauseForOwnership(e); return; }
    }
    if (this.admitting && phase.kind === "choosing") {
      const bound = phase.collections.find((c: { id: string }) => c.id === this.data.collectionId);
      if (bound) await this.select(bound.id);
      else if (!this.data.collectionId && phase.collections.length === 1) await this.select(phase.collections[0].id);
    }
    // select() can publish opening/ready before its promise settles. The older
    // choosing handler must not subsequently turn off the now-ready mirror.
    if (this.unloaded || this.phase !== phase) return;
    if (this.admitting && phase.kind === "ready" && (was.kind !== "ready" || was.collectionId !== phase.collectionId)) {
      try { this.claim(phase.collectionId); } catch (e) { this.pauseForOwnership(e); return; }
      this.mirroring = true;
      // enqueue may have skipped an old scheduled pass while non-ready. A new
      // ready snapshot supersedes it; do not leave future events wedged behind
      // its stale queued flag.
      this.reconcileQueued = false;
      // Start the stream before taking the snapshot; replayed/duplicate events
      // are harmless because reconciliation compares hashes and revisions.
      // watch may synchronously replay/reset before its RPC reply. Fold that
      // into the mandatory startup snapshot instead of running two full scans.
      this.setStatus("Checking your files");
      this.startingMirror = true;
      try { await this.call("watch", this.data.cursor); }
      finally { this.startingMirror = false; }
      this.requestReconcile(undefined, undefined, true);
      await this.jobs;
    }
  }
  async signIn() {
    if (this.phase.kind === "authorizing" && this.signInUrl) {
      this.openSignIn(this.signInUrl);
      new Notice("mdbase: sign-in is still pending. Reopened the existing approval link; finish or cancel it in your browser.");
      return;
    }
    await this.call("signIn");
  }
  openSignIn(url: string) {
    this.signInUrl = url;
    // Obsidian desktop: hand the link to the system browser.
    void (window as any).require("electron").shell.openExternal(url)
      .then(() => this.log("sign-in opened in system browser"), (e: Error) => this.fail("open sign-in", e));
  }
  choose() {
    const items = this.phase.collections ?? [], plugin = this;
    new (class extends SuggestModal<any> {
      getSuggestions(q: string) { return items.filter((c: any) => c.name.toLowerCase().includes(q.toLowerCase())); }
      renderSuggestion(c: any, el: HTMLElement) { el.setText(c.name); }
      onChooseSuggestion(c: any) { void plugin.select(c.id).catch(e => plugin.fail("select", e)); }
    })(this.app).open();
  }

  // ---- durable three-way reconciliation ------------------------------------
  collectionPath(vp: string) {
    const p = vp;
    return this.validPath(p) ? p : null;
  }
  validPath(p: string) {
    // The SDK canonicalizes to NFC. Sending NFD under a different local key
    // can alias an existing record and make reconciliation move it over itself.
    return !!p && p === p.normalize("NFC") && !p.includes("\\") && !p.startsWith("/") && p.split("/").every(x => !!x && x !== "." && x !== ".." && ![".mdbase", this.app.vault.configDir, ".trash", ".git"].includes(x));
  }
  vaultPath(p: string) { if (!this.validPath(p)) throw new Error("Unsafe/private collection path refused"); return p; }
  editorViews(p: string): any[] {
    const vp = this.vaultPath(p);
    return this.app.workspace?.getLeavesOfType("markdown").flatMap(({ view }: any) =>
      view.file?.path === vp && view.editor && typeof view.getViewData === "function" ? [view] : []) ?? [];
  }
  // Discovery alone is insufficient: known/remote paths can be replaced by a
  // symlink after discovery, including any ancestor directory. Never follow it.
  assertDiskPath(p: string) {
    let current = this.root;
    for (const part of ["", ...p.split("/")]) {
      if (part) current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error("Symlink mirror path refused"), { code: "unsafe_symlink" });
      } catch (e: any) { if (e.code === "ENOENT") return; throw e; }
    }
  }
  accessiblePath(p: string) {
    if (!this.validPath(p)) return false;
    try { this.assertDiskPath(p); return true; }
    catch (e: any) {
      if (e.code !== "unsafe_symlink") throw e;
      if (!this.warnedPaths.has(p)) {
        this.warnedPaths.add(p); this.log(`symlink path skipped: ${JSON.stringify(p)}`);
        new Notice("mdbase: a symlink in the mirror was skipped. Its target will not be read or changed.", 10000);
      }
      return false;
    }
  }
  async local(p: string) {
    if (!this.accessiblePath(p)) return undefined;
    const f = this.app.vault.getAbstractFileByPath(this.vaultPath(p));
    try {
      const adapter = this.app.vault.adapter;
      // Desktop watchers may publish delete/create in different batches, or
      // throttle the create while backgrounded. Use disk truth, not that index.
      // Markdown autosave is debounced. Disk alone can be unchanged while a
      // user has an entire losing edit in memory. Include that buffer in every
      // three-way/recheck decision, and fail closed on inconsistent open views.
      const diskBytes = adapter instanceof FileSystemAdapter
        ? new Uint8Array(await fs.promises.readFile(path.join(adapter.getBasePath(), this.vaultPath(p))))
        : f instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(f)) : undefined;
      const unsupportedEncoding = !!diskBytes && p.endsWith(".md") && !Buffer.from(Buffer.from(diskBytes).toString("utf8"), "utf8").equals(Buffer.from(diskBytes));
      // Never let an editor's replacement-character decode masquerade as the
      // original invalid disk bytes. Snapshot buffers AFTER asynchronous IO.
      const buffers = !unsupportedEncoding && p.endsWith(".md") ? this.editorViews(p).map(v => v.getViewData() as string) : [];
      if (new Set(buffers).size > 1) throw new Error("Open editor buffers disagree; local state retained");
      const bytes = buffers.length ? new Uint8Array(Buffer.from(buffers[0], "utf8")) : diskBytes;
      if (!bytes) return undefined;
      return { f: f instanceof TFile ? f : undefined, bytes, hash: hash(bytes), unsupportedEncoding };
    } catch (e: any) {
      // Disk watchers can expose the old TFile briefly after an external mv.
      if (e.code === "ENOENT" || e.code === "EISDIR") return undefined;
      throw e;
    }
  }
  localPaths() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return this.app.vault.getFiles().flatMap(f => { const p = this.collectionPath(f.path); return p ? [p] : []; });
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(this.root, dir), { withFileTypes: true })) {
        const p = dir ? `${dir}/${entry.name}` : entry.name;
        if (!this.validPath(p)) {
          if (p !== p.normalize("NFC") && !this.warnedPaths.has(p)) {
            this.warnedPaths.add(p);
            this.log(`unsupported non-NFC path skipped: ${JSON.stringify(p)}`);
            new Notice("mdbase: a non-nfc filename cannot sync. Rename it to unicode nfc; existing files were not changed.", 10000);
          }
          continue;
        }
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile()) out.push(p); // do not traverse symlinks
      }
    };
    walk(""); return out;
  }
  remote(r: any, kind: "record" | "file"): Remote {
    return { ...r, kind, revision: kind === "record" ? r.revision : r.digest, hash: kind === "record" ? hash(Buffer.from(r.document, "utf8")) : r.digest };
  }
  async remoteAll(affected?: Set<string>): Promise<Map<string, Remote>> {
    const out = new Map<string, Remote>(), identities = new Set<string>();
    const selected: any[] | undefined = affected ? await this.call("at", [...affected]) : undefined;
    const records: any[] = selected ? selected.filter(r => r.kind === "record") : await this.call("all");
    const files: any[] = selected ? selected.filter(r => r.kind === "file") : await this.call("filesAll");
    for (const [rows, kind] of [[records, "record"], [files, "file"]] as const) for (const row of rows) {
      if (!this.validPath(row.path)) continue;
      const identity = `${kind}:${row.id}`;
      if (out.has(row.path) || identities.has(identity)) {
        // Concurrent path lookups are not a snapshot: an item can move between
        // resolving old/new paths, yielding the same identity twice (possibly
        // at different revisions/paths). Never pick a winner from mixed reads.
        // Retry ONCE through the full snapshot; genuine ambiguity still fails
        // closed there, and the queued cursor cannot advance on that failure.
        if (affected && identities.has(identity)) return this.remoteAll();

        throw new Error("Duplicate remote path/identity; refusing ambiguous mirror");
      }
      identities.add(identity); out.set(row.path, this.remote(row, kind));
    }
    return out;
  }
  diskIdentity(p: string) {
    try {
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) return undefined;
      this.assertDiskPath(p);
      const s = fs.statSync(path.join(adapter.getBasePath(), this.vaultPath(p)));
      return { dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs };
    } catch { return undefined; } // mobile/non-filesystem: hash-only matching
  }
  remember(p: string, r: Remote, localHash: string) {
    const next = { id: r.id, kind: r.kind, revision: r.revision, hash: localHash, disk: this.diskIdentity(p) };
    const prev = this.data.paths[p];
    if (prev && prev.id === next.id && prev.kind === next.kind && prev.revision === next.revision && prev.hash === next.hash && prev.disk?.dev === next.disk?.dev && prev.disk?.ino === next.disk?.ino && prev.disk?.birthtimeMs === next.disk?.birthtimeMs) return;
    this.data.paths[p] = next; this.persist();
  }
  scheduleSettle() {
    if (this.settleTimer) window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
    const deadlines = Object.values(this.data.pendingPaths ?? {}).filter(t => t > Date.now());
    if (deadlines.length && this.admitting && this.mirroring && !this.unloaded) {
      this.settleTimer = window.setTimeout(() => { this.settleTimer = null; void this.enqueue(() => this.reconcileAll(true)); }, Math.max(1, Math.min(...deadlines) - Date.now()));
    }
  }
  async moveLocal(from: string, to: string, k: Synced, r: Remote) {
    this.assertMirror();
    let next: any;
    try {
      next = r.kind === "record"
        ? await this.call("replace", r.id, { path: from, doc: r.document }, { path: to, doc: r.document }, r.revision)
        : await this.call("fileMove", r.id, to, r.revision);
    } catch (e: any) {
      // A rejected path-only record CAS is still a ledger write. Preserve its
      // exact submitted document/target before acknowledging it, just as for an
      // edit rejection. Usually the user's moved file itself is the copy, so do
      // not manufacture a second identical conflict file unnecessarily.
      if (isConflict(e) && e.mutationId && r.kind === "record") {
        const bytes = Buffer.from(r.document!, "utf8"), submitted = { f: undefined, bytes, hash: hash(bytes), unsupportedEncoding: false };
        const local = await this.local(to), target = (await this.remoteAll()).get(to);
        if (local?.hash === submitted.hash && (!target || (target.kind === "record" && target.hash === submitted.hash && target.confirmed === true))) {
          const h = { path: from, hash: submitted.hash, kind: "record" as const, copy: to, handled: false };
          (this.data.handledRejections ??= {})[e.mutationId] = h; this.persist();
          if (!target) await this.push(to, submitted);
          h.handled = true; this.persist();
        } else await this.preserveConflict(to, submitted, e.mutationId);
        await this.acknowledgeHandled();
      }

      throw e; // caller refreshes the winning remote identity before reconciling
    }
    delete this.data.paths[from];
    delete this.data.pendingPaths?.[from]; delete this.data.pendingPaths?.[to];
    // Move first, then CAS any content edit in the ordinary path pass.
    const moved = this.remote(next, r.kind); this.remember(to, moved, k.hash);
    this.log(`local ${r.kind} move: ${JSON.stringify(from)} -> ${JSON.stringify(to)} id=${r.id} (no upload/download)`);
    return moved;
  }
  // At most one pending pass, regardless of watcher/stream burst size. Events
  // arriving during a pass join the next pass, never the snapshot in flight.
  requestReconcile(paths?: Iterable<string>, cursor?: string, immediate = false) {
    if (!this.admitting || !this.mirroring || this.unloaded) return;
    if (paths === undefined) this.reconcileFull = true;
    else for (const p of paths) this.reconcilePaths.add(p);
    if (cursor !== undefined) this.reconcileCursor = cursor;
    this.reconcileImmediate ||= immediate;
    if (this.startingMirror || this.reconcileQueued || this.reconcileRetryTimer) return;
    this.reconcileQueued = true;
    void this.enqueue(async () => {
      this.reconcileQueued = false;
      // A follow-up may already have queued before the preceding pass saw its
      // stale query cursor. Leave its accumulated paths/cursor for the retry.
      if (this.reconcileRetryTimer) return;
      const affected = this.reconcileFull ? undefined : this.reconcilePaths;
      const nextCursor = this.reconcileCursor, now = this.reconcileImmediate;
      this.reconcileFull = false; this.reconcilePaths = new Set(); this.reconcileCursor = undefined; this.reconcileImmediate = false;
      this.syncingFiles = true; this.setStatus("Checking your files");
      try {
        if (await this.reconcileAll(!now, affected) === false)
          throw Object.assign(new Error("Some paths remain unprocessed; cursor retained"), { code: "path_failures" });
        if (nextCursor !== undefined && nextCursor !== this.data.cursor) { this.data.cursor = nextCursor; this.persist(); }
        this.reconcileRetryDelay = 250;
      } catch (e: any) {
        // Never skip a failed batch by committing a later cursor after a partial
        // pass. The next trigger must reconcile a full snapshot before advancing.
        this.reconcileFull = true; this.reconcileCursor ??= nextCursor; this.reconcileImmediate ||= now;
        // A paged read can lose its cursor twice while another device mutates
        // the collection (the SDK already retries once). This is not a failed
        // write. Coalesce new events and retry a fresh full scan with bounded
        // backoff, including when no later event arrives. Never commit a partial
        // snapshot or advance the stream cursor, and don't spam failure Notices.
        if (e?.code === "invalid_request" && ["cursor_stale", "cursor_expired"].includes(e?.reason)) {
          if (this.reconcileRetryDelay === 250) this.log("snapshot query invalidated; retrying full scan with cursor retained");
          this.reconcileRetryTimer = window.setTimeout(() => {
            this.reconcileRetryTimer = null; this.requestReconcile();
          }, this.reconcileRetryDelay);
          this.reconcileRetryDelay = Math.min(2000, this.reconcileRetryDelay * 2);
          return;
        }
        throw e;
      } finally { this.syncingFiles = false; }
    });
  }
  async reconcileAll(defer = false, affected?: Set<string>, retryFailed = false): Promise<boolean | undefined> {
    if (!this.mirroring) return;
    this.checkOwnership();
    // Recovery journals require the original and preservation copy together.
    if (Object.keys(this.data.handledRejections ?? {}).length || Object.keys(this.data.conflictCopies ?? {}).length || Object.keys(this.data.pathFailures ?? {}).length) affected = undefined;
    await this.resumeUploads();
    let remotes = await this.remoteAll(affected);
    await this.acknowledgeHandled(false, remotes);
    // Index once, rather than allocating/scanning all remotes for every path.
    const byId = new Map([...remotes.values()].map(r => [`${r.kind}:${r.id}`, r]));
    // Join by stable identity BEFORE treating a new path as a new remote item.
    for (const [from, k] of Object.entries(this.data.paths)) {
      const r = byId.get(`${k.kind}:${k.id}`);
      if (!r || r.path === from || !this.accessiblePath(from) || !this.accessiblePath(r.path) || (affected && !affected.has(from) && !affected.has(r.path))) continue;
      affected?.add(from); affected?.add(r.path);
      const l = await this.local(from);
      const decision = remoteMoveDecision(k, l?.hash, r, !!this.app.vault.getAbstractFileByPath(this.vaultPath(r.path)) || !!this.data.paths[r.path]);
      if (decision === "blocked") throw new Error("Remote move destination occupied; local state retained");
      if (decision === "rename") {
        await this.ensureFolder(this.vaultPath(r.path)); this.assertMirror();
        if (!l!.f) throw new Error("Waiting for vault index before remote rename");
        await this.app.vault.rename(l!.f, this.vaultPath(r.path));
        this.data.paths[r.path] = k;
        this.log(`remote ${r.kind} move: renamed locally (no download)`);
      }
      delete this.data.paths[from]; this.persist();
    }
    const paths = new Set([...(affected ?? [...Object.keys(this.data.paths), ...remotes.keys()])].filter(p => this.accessiblePath(p)));
    if (!affected) for (const p of this.localPaths()) paths.add(p);
    // Pairing needs hashes, not payloads. Keeping every byte here retained an
    // entire vault (including large attachments) throughout slow network IO.
    const locals = new Map<string, { hash: string; unsupportedEncoding?: boolean }>();
    const unreadable = new Set<string>();
    for (const p of paths) {
      try { const l = await this.local(p); if (l) locals.set(p, { hash: l.hash, unsupportedEncoding: l.unsupportedEncoding }); }
      catch (e: any) {
        this.assertMirror(); unreadable.add(p);
        (this.data.pathFailures ??= Object.create(null))[p] = { signature: "unreadable", code: e?.code };
        this.persist(); this.fail(`read path ${JSON.stringify(p)}`, e);
      }
    }
    if (!affected) for (const p of Object.keys(this.data.pathFailures ?? {})) if (!paths.has(p)) { delete this.data.pathFailures![p]; this.persist(); }
    const missing = Object.entries(this.data.paths).filter(([p]) => paths.has(p) && !unreadable.has(p) && !locals.has(p)).map(([p, known]) => ({ path: p, known, remote: remotes.get(p) }));
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Preserve the literal union through Array.map inference.
    const added = [...locals].filter(([p, l]) => !l.unsupportedEncoding && !this.data.paths[p] && !remotes.has(p)).map(([p, l]) => ({ path: p, kind: (p.endsWith(".md") ? "record" : "file") as Synced["kind"], hash: l.hash, disk: this.diskIdentity(p) }));
    // A content event can race disk moves whose create/delete watcher has not
    // arrived yet. Topology needs the whole disk for conservative move pairing.
    if (affected && (missing.length || added.length)) return this.reconcileAll(defer, undefined, retryFailed);
    for (const pair of localMovePairs(missing, added)) {
      // Recheck disk state after async IO; never move a now-occupied source.
      if (await this.local(pair.from) || !await this.local(pair.to)) continue;
      try {
        const moved = await this.moveLocal(pair.from, pair.to, this.data.paths[pair.from], remotes.get(pair.from)!);
        remotes.delete(pair.from); remotes.set(pair.to, moved);
        this.log(`external move paired by ${pair.via}`);
      } catch (e) { if (!isConflict(e)) throw e; remotes = await this.remoteAll(); }
    }
    const pending = this.data.pendingPaths ??= Object.create(null);
    const unsettled = new Set([...missing.map(m => m.path), ...added.map(a => a.path)].filter(p =>
      (!this.data.paths[p] && locals.has(p) && !remotes.has(p)) || (!!this.data.paths[p] && !locals.has(p))));
    let pendingChanged = false;
    for (const p of Object.keys(pending)) if (paths.has(p) && (!unsettled.has(p) || !defer)) { delete pending[p]; pendingChanged = true; }
    if (defer) for (const p of unsettled) {
      // A wall-clock correction must not turn a two-second move window into
      // hours of stalled work. Startup still consumes persisted intent at once.
      const due = Math.min(pending[p] ?? Date.now() + 2000, Date.now() + 2000);
      if (due !== pending[p]) { pending[p] = due; pendingChanged = true; }
    }
    if (pendingChanged) this.persist();
    this.scheduleSettle();
    for (const p of paths) {
      if (unreadable.has(p) || (defer && pending[p] > Date.now())) continue;
      this.checkOwnership();
      if (!this.mirroring || this.unloaded) throw new Error("Mirror stopped");
      const l = await this.local(p), r = remotes.get(p), k = this.data.paths[p];
      if (l?.unsupportedEncoding) {
        const key = `encoding:${p}:${l.hash}`;
        if (!this.warnedPaths.has(key)) {
          this.warnedPaths.add(key); this.log(`unsupported UTF-8 record skipped: ${JSON.stringify(p)}`);
          new Notice("mdbase: a .md file is not valid UTF-8 and cannot sync as a record. Local bytes were retained; use a binary extension to sync it.", 10000);
        }
        const signature = JSON.stringify([l.hash, r?.id, r?.kind, r?.revision]);
        if (this.data.pathFailures?.[p]?.signature !== signature) {
          (this.data.pathFailures ??= Object.create(null))[p] = { signature, code: "unsupported_encoding" }; this.persist();
        }
        continue;
      }
      const signature = JSON.stringify([l?.hash, r?.id, r?.kind, r?.revision]);
      const failure = this.data.pathFailures?.[p];
      const recovering = Object.values(this.data.conflictCopies ?? {}).some(c => c.path === p) || Object.values(this.data.handledRejections ?? {}).some(h => h.path === p);
      // A durable preservation journal makes replay safe even after the copy's
      // confirmation reply was lost; without it, unknown outcomes stay blocked.
      if (failure && ((failure.unknown && !r && !recovering) || (failure.signature === signature && ((!retryFailed && !recovering) || (failure.unknown && !recovering))))) continue;
      if (this.data.pathFailures?.[p]) { delete this.data.pathFailures[p]; this.persist(); }
      try {
      const decision = reconcileDecision(k, l?.hash, r);
      switch (decision) {
        case "none": if (k && l) this.remember(p, r!, l.hash); break;
        case "remember": this.remember(p, r!, l!.hash); break;
        case "pull": await this.pull(p, r!, l?.hash); break;
        case "push":
          try { await this.push(p, l!, r); }
          catch (e: any) {
            if (!isConflict(e)) throw e;
            // Fetch a fresh view after a live revision rejection and use the
            // identical preserve-local/pull-remote rule (no blind retry).
            const fresh = (await this.remoteAll()).get(p);
            await this.conflict(p, await this.local(p), fresh, e.mutationId ? { mutationId: e.mutationId, local: l! } : undefined);
            if (this.data.uploads?.[p]) await this.clearUpload(p);
          }
          break;
        case "deleteRemote":
          try { await this.call(r!.kind === "record" ? "remove" : "fileDelete", r!.id, r!.revision); delete this.data.paths[p]; this.persist(); }
          catch (e: any) {
            if (!isConflict(e)) throw e;
            const fresh = (await this.remoteAll()).get(p);
            if (fresh) {
              // A delete submitted no local document. Its safe conflict outcome
              // is restoration of the winning remote bytes, not a new copy.
              // Journal that exact proof before IO; a failed pull cannot clear
              // the ledger, and crash recovery still requires confirmed bytes.
              const h = e.mutationId ? { path: p, hash: fresh.hash!, kind: fresh.kind, copy: p, handled: false } : undefined;
              if (h) { (this.data.handledRejections ??= {})[e.mutationId] = h; this.persist(); }
              await this.pull(p, fresh);
              if (h && fresh.confirmed === true) { h.handled = true; this.persist(); }
            }
          }
          break;
        case "deleteLocal": {
          const latest = await this.local(p);
          if (latest && latest.hash !== l?.hash) await this.conflict(p, latest);
          else await this.removeLocal(p, latest?.hash);
          break;
        }
        case "forget": delete this.data.paths[p]; this.persist(); break;
        case "conflict": await this.conflict(p, l, r); break;
      }
      } catch (e: any) {
        if (!this.mirroring || this.unloaded) throw e;
        this.checkOwnership(); // ownership/stop failures remain pass-wide barriers
        (this.data.pathFailures ??= Object.create(null))[p] = { signature, code: e?.code, reason: e?.reason, unknown: /unknown/.test(`${e?.code} ${e?.reason}`) };
        this.persist();
        this.fail(`sync path ${JSON.stringify(p)}`, e);
      }
      if (Object.prototype.hasOwnProperty.call(pending, p)) { delete pending[p]; this.persist(); }
    }
    this.scheduleSettle();
    await this.acknowledgeHandled();
    const blocked = Object.keys(this.data.pathFailures ?? {}).length;
    this.setStatus(blocked ? `ready: ${Object.keys(this.data.paths).length} paths; ${blocked} blocked (see notices)` : this.phase.sync?.text ?? `ready: ${Object.keys(this.data.paths).length} paths`);
    return blocked === 0;
  }
  async ensureFolder(vp: string) {
    const dir = vp.split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      try { await this.app.vault.createFolder(dir); }
      catch (e) { if (!await this.app.vault.adapter.exists(dir)) throw e; }
    }
  }
  assertMirror() {
    if (!this.mirroring || this.unloaded) throw new Error("Mirror stopped");
    this.checkOwnership();
  }
  async put(p: string, bytes: Uint8Array, expectedHash?: string) {
    this.assertMirror(); this.assertDiskPath(p);
    const vp = this.vaultPath(p), f = this.app.vault.getAbstractFileByPath(vp);
    if (f && !(f instanceof TFile)) throw new Error("Folder collides with remote file");
    const initial = await this.local(p), nextHash = hash(bytes);
    const changed = () => Object.assign(new Error("Local file changed during download; retry preservation"), { code: "local_changed" });
    if (arguments.length > 2 && initial?.hash !== expectedHash && initial?.hash !== nextHash) throw changed();
    if (initial?.hash === nextHash) return;
    if (initial?.unsupportedEncoding) throw Object.assign(new Error("Invalid UTF-8 disk bytes retained"), { code: "unsupported_encoding" });
    const applyEditors = () => {
      const editors = p.endsWith(".md") ? this.editorViews(p) : [];
      if (!editors.length) return undefined;
      const text = Buffer.from(bytes).toString("utf8");
      if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw Object.assign(new Error("Invalid UTF-8 cannot enter editor"), { code: "unsupported_encoding" });
      // No await between this buffer recheck and setValue: newer typing must
      // enter preservation, never be clobbered by atomic disk publication.
      if (editors.some(v => hash(Buffer.from(v.getViewData(), "utf8")) !== initial?.hash)) throw changed();
      this.assertMirror(); this.assertDiskPath(p);
      for (const view of editors) if (view.getViewData() !== text) view.editor.setValue(text);
      return Promise.all(editors.map(view => view.save()));
    };
    this.writingPaths.add(p);
    try {
      const saved = applyEditors();
      if (saved) { await saved; return; }
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        await this.ensureFolder(vp); this.assertMirror(); this.assertDiskPath(p);
        const incoming = path.join(this.root, ".mdbase", "incoming");
        this.assertDiskPath(".mdbase/incoming"); fs.mkdirSync(incoming, { recursive: true });
        const temp = path.join(incoming, randomUUID() + ".tmp");
        try {
          await fs.promises.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
          this.assertMirror(); this.assertDiskPath(p);
          const current = await this.local(p);
          if (current?.hash !== initial?.hash) throw changed();
          // An editor can have opened while staging. It owns publication now.
          const saved = applyEditors();
          if (saved) { await saved; return; }
          this.assertMirror(); this.assertDiskPath(p);
          fs.renameSync(temp, path.join(adapter.getBasePath(), vp));
        } finally { await fs.promises.unlink(temp).catch(() => {}); }
      } else {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        if (f instanceof TFile) { this.assertMirror(); this.assertDiskPath(p); await this.app.vault.modifyBinary(f, buffer); }
        else { await this.ensureFolder(vp); this.assertMirror(); this.assertDiskPath(p); await this.app.vault.createBinary(vp, buffer); }
      }
    } finally { this.writingPaths.delete(p); }
  }
  async pull(p: string, r: Remote, expectedHash = this.data.paths[p]?.hash): Promise<void> {
    if (r.kind === "file") return this.pullFile(p, r, expectedHash);
    const bytes = Buffer.from(r.document!, "utf8");
    const latest = await this.local(p);
    if (latest && latest.hash !== expectedHash && latest.hash !== hash(bytes)) {
      await this.preserveConflict(p, latest);
      // Upload confirmation may take a while. If the user edited again during
      // it, take another snapshot rather than overwrite that newer local edit.
      return this.pull(p, r, latest.hash);
    }
    try { await this.put(p, bytes, latest?.hash); }
    catch (e: any) { if (e.code === "local_changed") return this.pull(p, r, latest?.hash); throw e; }
    this.remember(p, r, hash(bytes));
  }
  async push(p: string, l: NonNullable<Awaited<ReturnType<NativeSync["local"]>>>, r?: Remote) {
    this.assertMirror();
    const kind = p.endsWith(".md") ? "record" : "file";
    if (r && r.kind !== kind) throw new Error("Remote item kind differs from extension; manual resolution required");
    let next: any;
    if (kind === "record") {
      const doc = Buffer.from(l.bytes).toString("utf8");
      if (!Buffer.from(doc, "utf8").equals(Buffer.from(l.bytes))) throw Object.assign(new Error("Markdown record is not valid UTF-8; local bytes retained"), { code: "unsupported_encoding" });
      // Base is the replica's current exact document, not a stale cached body.
      next = r ? await this.call("replace", r.id, { path: r.path, doc: r.document }, { path: p, doc }, r.revision) : await this.call("create", p, doc);
    } else {
      const uploads = this.data.uploads ??= Object.create(null);
      if (!uploads[p]) {
        const identity = { transferId: randomUUID(), mutationId: randomUUID(), hash: l.hash, fileId: r?.id, revision: r?.revision };
        this.assertDiskPath(".mdbase/uploads");
        fs.mkdirSync(path.join(this.root, ".mdbase/uploads"), { recursive: true });
        fs.writeFileSync(this.uploadPath(identity.transferId), l.bytes, { flag: "wx", mode: 0o600 });
        uploads[p] = identity; this.persist(); // bytes and identity precede the first send
      }
      next = await this.finishUpload(p);
    }
    this.remember(p, this.remote(next, kind), l.hash);
    this.log(`pushed ${kind} (${l.bytes.length} bytes)`);
  }
  uploadPath(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid upload identity");
    this.assertDiskPath(`.mdbase/uploads/${id}`);
    return path.join(this.root, ".mdbase/uploads", id);
  }
  async finishUpload(p: string) {
    const intent = this.data.uploads![p];
    const bytes = new Uint8Array(fs.readFileSync(this.uploadPath(intent.transferId)));
    if (hash(bytes) !== intent.hash) throw new Error("Upload recovery bytes differ; stopped");
    const next = await retryUpload(() => this.call("upload", p, bytes, intent.fileId, intent.revision, intent));
    this.remember(p, this.remote(next, "file"), intent.hash);
    await this.clearUpload(p);
    return next;
  }
  async clearUpload(p: string) {
    const intent = this.data.uploads?.[p]; if (!intent) return;
    delete this.data.uploads![p]; this.persist();
    fs.unlinkSync(this.uploadPath(intent.transferId));
    await this.call("uploadForget", intent.transferId);
  }
  async resumeUploads() {
    for (const p of Object.keys(this.data.uploads ?? {})) {
      this.assertMirror();
      try { await this.finishUpload(p); }
      catch (e: any) {
        if (!isConflict(e) || !e.mutationId) throw e;
        const intent = this.data.uploads![p];
        const bytes = new Uint8Array(fs.readFileSync(this.uploadPath(intent.transferId)));
        const submitted = { bytes, hash: intent.hash, f: undefined, unsupportedEncoding: false };
        await this.conflict(p, await this.local(p), (await this.remoteAll()).get(p), { mutationId: e.mutationId, local: submitted });
        await this.clearUpload(p);
      }
    }
  }
  async pullFile(p: string, r: Remote, expectedHash?: string) {
    this.assertMirror(); this.assertDiskPath(".mdbase/incoming");
    const token = await this.call("downloadOpen", r.id);
    await stageDownload({
      directory: path.join(this.root, ".mdbase/incoming"), digest: r.digest!,
      next: () => this.call("downloadNext", token),
      close: () => this.call("downloadClose", token),
      publish: async staged => {
        const latest = await this.local(p);
        if (latest && latest.hash !== expectedHash && latest.hash !== r.digest) await this.preserveConflict(p, latest);
        const current = await this.local(p);
        if (current?.hash !== latest?.hash) throw new Error("Local file changed during download; retained");
        await this.ensureFolder(this.vaultPath(p));
        this.assertMirror(); this.assertDiskPath(p);
        // No async gap between the final disk check and atomic publication.
        let diskHash: string | undefined;
        try { diskHash = hash(fs.readFileSync(path.join(this.root, p))); }
        catch (e: any) { if (e.code !== "ENOENT") throw e; }
        if (diskHash !== current?.hash) throw new Error("Local file changed before publication; retained");
        fs.renameSync(staged, path.join(this.root, p));
        this.remember(p, r, r.digest!);
      },
    });
  }
  async removeLocal(p: string, expectedHash?: string) {
    this.assertMirror(); this.assertDiskPath(p);
    const latest = await this.local(p);
    if (arguments.length > 1 && latest?.hash !== expectedHash) throw Object.assign(new Error("Local file changed before delete; bytes retained"), { code: "local_changed" });
    this.writingPaths.add(p);
    try {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      const target = path.join(adapter.getBasePath(), this.vaultPath(p));
      // A disk file can predate its TFile (or survive a stale index entry).
      // Forgetting state without unlinking it would re-upload a remote deletion.
      try {
        const current = hash(fs.readFileSync(target));
        if (arguments.length > 1 && current !== expectedHash) throw Object.assign(new Error("Local file changed before delete; bytes retained"), { code: "local_changed" });
        this.assertMirror(); this.assertDiskPath(p); fs.unlinkSync(target);
      } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    } else {
      const latest = await this.local(p);
      if (arguments.length > 1 && latest?.hash !== expectedHash) throw Object.assign(new Error("Local file changed before delete; bytes retained"), { code: "local_changed" });
      const f = this.app.vault.getAbstractFileByPath(this.vaultPath(p));
      if (f instanceof TFile) await this.app.fileManager.trashFile(f);
    }
    delete this.data.paths[p]; this.persist();
    } finally { this.writingPaths.delete(p); }
  }
  async preserveConflict(p: string, l: NonNullable<Awaited<ReturnType<NativeSync["local"]>>>, mutationId?: string) {
    const key = JSON.stringify([p, l.hash]), kind = p.endsWith(".md") ? "record" : "file";
    const remotes = await this.remoteAll();
    const prior = this.data.conflictCopies?.[key];
    let copy = prior?.copy;
    let remote = copy ? remotes.get(copy) : undefined;
    const local = copy ? await this.local(copy) : undefined;
    // Reuse only an exact copy. Never overwrite a subsequent user edit or an
    // unrelated occupied remote path. Optimistic bytes are not confirmation.
    if (!copy || (local && local.hash !== l.hash) || (remote && (remote.kind !== kind || remote.hash !== l.hash))) {
      // Local/remote existence checks cannot reserve a name on another device,
      // so tag new names with this vault's id: two devices never pick the same one.
      const device = this.data.vaultId.slice(0, 6), stamp = new Date();
      let n = 0; // "<device>", then "<device> 2", "<device> 3", ...
      do copy = conflictPath(p, stamp, ` ${device}${n++ ? ` ${n}` : ""}`);
      while (await this.local(copy) || remotes.has(copy));
      remote = undefined;
    }
    (this.data.conflictCopies ??= {})[key] = { path: p, hash: l.hash, copy, kind };
    if (mutationId)
      (this.data.handledRejections ??= {})[mutationId] = { path: p, hash: l.hash, kind, copy };
    this.persist(); // before local IO and remote publication, not only CAS rejections
    await this.put(copy, l.bytes);
    if (remote && remote.confirmed !== true)
      throw Object.assign(new Error("Conflict copy awaiting confirmation; local state retained"), { code: "outcome_unknown" });
    // A crash after confirmation but before replacing the original must not
    // publish another conflict item. Otherwise retry the same saved copy path.
    if (!remote) await this.push(copy, l);
    else this.remember(copy, remote, l.hash);
    if (mutationId) {
      this.data.handledRejections![mutationId].handled = true; this.persist();
    }
    return copy;
  }
  // User-reviewed escape hatch for rejections the plugin cannot prove it preserved.
  // The user picks one entry; nothing is discarded automatically.
  async discardRejected() {
    const entries: { mutationId: string; records: string[]; code: string }[] = await this.call("rejectedWrites");
    if (!entries.length) { new Notice("mdbase: no rejected writes"); return; }
    const label = (e: typeof entries[number]) => {
      const p = Object.entries(this.data.paths).find(([, k]) => e.records.includes(k.id))?.[0] ?? "unknown path";
      return `${p} — ${e.code} — ${e.mutationId}`;
    };
    const plugin = this;
    new (class extends SuggestModal<typeof entries[number]> {
      getSuggestions(q: string) { return entries.filter(e => label(e).toLowerCase().includes(q.toLowerCase())); }
      renderSuggestion(e: typeof entries[number], el: HTMLElement) { el.setText(`Discard: ${label(e)}`); }
      onChooseSuggestion(e: typeof entries[number]) {
        void plugin.enqueue(async () => {
          const ok = await plugin.call("acknowledge", e.mutationId);
          delete plugin.data.handledRejections?.[e.mutationId]; plugin.persist();
          plugin.log(`rejected write discarded by user: mutationId=${e.mutationId} problem=${e.code} ok=${ok}`);
          new Notice(ok ? "mdbase: rejected write discarded" : "mdbase: discard failed");
        }).catch(err => plugin.fail("discard rejected", err));
      }
    })(this.app).open();
  }
  async acknowledgeHandled(explicit = false, remotes?: Map<string, Remote>) {
    if (!explicit && !Object.keys(this.data.handledRejections ?? {}).length) return;
    const entries: { mutationId: string; records: string[]; code: string }[] = await this.call("rejectedWrites");
    remotes ??= await this.remoteAll();
    for (const e of entries) {
      const h = this.data.handledRejections?.[e.mutationId];
      const source = [...remotes.values()].find(r => e.records.includes(r.id));
      const p = h?.path ?? source?.path ?? Object.entries(this.data.paths).find(([, k]) => e.records.includes(k.id))?.[0] ?? "unknown";
      if (explicit) this.log(`rejected write: mutationId=${e.mutationId} path=${JSON.stringify(p)} problem=${e.code}`);
      const copy = h?.copy ? remotes.get(h.copy) : undefined;
      const local = h?.copy ? await this.local(h.copy) : undefined;
      // No path/name heuristic can prove which bytes a legacy CAS refused.
      // Only our journal binds this mutation to the exact preserved bytes.
      if (!h || (!h.handled && !(copy?.kind === h.kind && copy.confirmed === true && copy.hash === h.hash && local?.hash === h.hash))) {
        if (explicit) this.log(`rejected write retained: mutationId=${e.mutationId}; preservation unproven`);
        continue;
      }
      h.handled = true; this.persist(); // survives an acknowledgement failure/crash
      if (await this.call("acknowledge", e.mutationId)) {
        this.log(`handled rejection acknowledged: mutationId=${e.mutationId} path=${JSON.stringify(h.path)} problem=${e.code}`);
        delete this.data.handledRejections![e.mutationId]; this.persist();
      }
    }
    // If a crash happened after SDK acknowledgement but before sync-state.json commit,
    // repeating acknowledgement is harmless; never touch an unrelated entry.
    for (const [id, h] of Object.entries(this.data.handledRejections ?? {})) {
      if (h.handled && !entries.some(e => e.mutationId === id) && await this.call("acknowledge", id)) {
        delete this.data.handledRejections![id]; this.persist();
      }
    }
  }
  async conflict(p: string, l: Awaited<ReturnType<NativeSync["local"]>>, r?: Remote, rejected?: { mutationId: string; local: NonNullable<Awaited<ReturnType<NativeSync["local"]>>> }) {
    // Preserve local first (including a unique suffix if the minute is reused).
    // If publication fails the local conflict copy survives and retries at startup.
    if (rejected) await this.preserveConflict(p, rejected.local, rejected.mutationId);
    if (l && l.hash !== rejected?.local.hash) await this.preserveConflict(p, l);
    if (r) await this.pull(p, r, l?.hash); else await this.removeLocal(p, l?.hash);
    for (const [key, copy] of Object.entries(this.data.conflictCopies ?? {})) if (copy.path === p) delete this.data.conflictCopies![key];
    this.persist();
    this.log("conflict: local preserved as a new conflict item; remote wins original path");
    new Notice("mdbase: conflict preserved in a separate file; remote version kept at original path.");
  }
  onVaultChange(f: TAbstractFile, topology = false) {
    const p = this.collectionPath(f.path);
    if (!this.admitting || !this.mirroring || !p) return;
    // Creates/deletes retain a whole-disk pass and the persisted move window.
    // Ordinary content bursts need only the union of touched paths.
    // Vault API events caused by our own pull/delete still get rechecked (a
    // concurrent user edit must not be swallowed), but cannot imply an external
    // move and need not rescan every attachment in the vault.
    this.requestReconcile(this.writingPaths.has(p) ? [p] : topology || !this.data.paths[p] ? undefined : [p]);
  }
  async renameLocal(f: TAbstractFile, old: string) {
    const p = this.collectionPath(f.path), from = this.collectionPath(old), k = from ? this.data.paths[from] : undefined;
    if (p && from && k && f instanceof TFile && !this.data.paths[p]) {
      const r = (await this.remoteAll()).get(from), l = await this.local(p);
      if (r && l && r.id === k.id && r.revision === k.revision && (p.endsWith(".md") === (r.kind === "record"))) {
        try {
          await this.moveLocal(from, p, k, r);
        } catch (e) { if (!isConflict(e)) throw e; }
      }
    }
    await this.reconcileAll(true);
  }

  setStatus(text: string) { this.changed(text, this.phase); }
  safeText(text: string) { return String(text).replace(/https?:\/\/[^\s"<>]+/g, value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return "[url]"; } }); }
  log(text: string) {
    const line = `${new Date().toISOString()} ${text}`;
    console.debug("[mdbase]", line);
  }
  fail(what: string, e: any, userMessage?: string) {
    // Do not log arbitrary mutation error bodies: they can contain documents.
    const detail = [e?.code, e?.reason].filter(Boolean).join(" ") || (what === "startup" || what === "ownership" || what === "start" ? this.safeText(e?.message ?? "error") : "operation failed; local state retained");
    if (e?.code === "collection_bound") userMessage = "This folder is already bound to a collection. Use a separate vault for another collection; this vault cannot be rebound while syncing.";
    this.setStatus(`Sync stopped: ${userMessage ?? detail}. Check Sync and reload after resolving the problem.`);
    this.log(`FAILED ${what}: ${detail}`); new Notice(`mdbase: ${userMessage ?? `${what}: ${detail}`}`, 10000);
  }
}
