// Native SDK host ported from the verified Obsidian SDK spike. The iframe owns the replica; all
// vault IO and durable three-way sync state live here. No page/ runtime files.
import { Notice, Component, SuggestModal, TAbstractFile, TFile, App, Platform, parseYaml, type MarkdownView, type PluginManifest } from "obsidian";
import { errorInfo, isObject, type NativeMethod, type NativeMethods, type NativeResult, type NativePhase, type PageMessage } from "./protocol";
import { DesktopHost } from "./desktop";
import { MobileHost } from "./mobile";
import type { EngineHost } from "./host";
import { encode, decode, hash, validUtf8 } from "./encoding";
import { AWAITING_APPROVAL, HANDED_OVER, NEEDS_APPROVAL, PRIVATE_COLLECTIONS_HINT, SIGN_IN_STOPPED, STARTING_STALLED, failedText, readyText, stoppedText, syncOffline } from "../words";
import { retryUpload, type UploadIdentity } from "./upload";
import { conflictPath, reconcileDecision, remoteMoveDecision, localMovePairs, Synced } from "./reconcile";
import { classifyPath, layoutFromConfig, CONFIG_PATH, DEFAULT_LAYOUT, type CollectionLayout, type PathKind } from "./classify";
import { NO_FILTER, collectionExcludes, normalizeFolder, recordActivity, skippedHere, validActivity, validFilter, validInclusion, type ActivityEntry, type ActivityKind, type CollectionInclusion, type DeviceFilter } from "./device";
import { describeFailure, type FailureIssue } from "./failures";

type ItemKind = Synced["kind"];
/** One path that didn't sync, for the Sync tab. */
export interface DirectFailure { path: string; title: string; detail: string; choose?: boolean }
/** Status text while a Private collection waits for its key, by how the account unlocks. */
const LOCKED_TEXT: Record<string, string> = {
  password: "Enter your encryption password to sync this Private collection.",
  strict: "This Private collection can't be unlocked in Obsidian.",
  none: "Set an encryption password to sync this Private collection.",
};
/** A collection in a chooser. Private ones say so: they ask for the encryption password. */
function renderCollectionChoice(c: { name: string; private?: boolean }, el: HTMLElement) {
  el.createSpan({ text: c.name });
  if (c.private) el.createSpan({ cls: "mdbase-choice-tag", text: "Private" });
}
/** Collection choosers say, below the list, why a Private collection may be absent. */
function withPrivateHint<T>(modal: SuggestModal<T>): SuggestModal<T> {
  modal.setInstructions([{ command: "", purpose: PRIVATE_COLLECTIONS_HINT }]);
  return modal;
}
/** Before the first sync of a vault that has notes into a collection that has items. */
export interface MergePrompt { collectionId: string; name: string; local: number; remote: number }
export interface SyncTotals { notes: number; attachments: number; definitions: number; attachmentBytes: number; notHere: number; byCollection: number }
export interface NativeView {
  failures: DirectFailure[]; merge: MergePrompt | null;
  conflicts: { path: string; copy: string }[];
  /** Most recent first. */
  activity: ActivityEntry[];
  /** When a full pass last finished with nothing left to send or fix. */
  lastSynced: number | null;
  totals: SyncTotals | null;
  device: DeviceFilter;
  /** The collection's file policy, when it has one. */
  inclusion: CollectionInclusion | null;
  /** Bound to a collection: waiting for approval is this vault's own collection. */
  bound: boolean;
}
// Refusals of this exact input. Retrying unchanged bytes gets the same answer,
// so they become per-path failures instead of stopping every other path.
const REFUSED = new Set(["invalid_request", "invalid_record", "too_large", "quota_exceeded", "forbidden"]);
const isRefusal = (e: unknown) => REFUSED.has(errorInfo(e).code ?? "") && !["cursor_stale", "cursor_expired"].includes(errorInfo(e).reason ?? "");


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
  pathFailures?: Record<string, { signature: string; code?: string; reason?: string; unknown?: boolean; issues?: FailureIssue[] }>;
  // The collection the user agreed to combine this vault's existing notes with.
  mergeConfirmed?: string;
  // Intent is saved before writing the copy; handled only after confirmed upload.
  handledRejections?: Record<string, { path: string; hash: string; kind: "record" | "file"; copy?: string; handled?: boolean }>;
  // Retain copy identity until the original has been resolved, even for
  // snapshot conflicts without a rejected mutation ID.
  conflictCopies?: Record<string, { path: string; hash: string; copy: string; kind: "record" | "file" }>;
  // What this device leaves out. Never sent anywhere; skipped paths keep no
  // synced state here, so turning one back on compares both sides afresh.
  device?: DeviceFilter;
  // Note and definition text sent but not yet confirmed (content hash). If the
  // app quits or reloads mid-send, the server may have kept it; a remote copy
  // with exactly this text is then this device's own edit, not a conflict.
  sending?: Record<string, string>;
}
type WireItem = NativeResult<"fileGet"> | NativeResult<"replace"> | NativeResult<"resourcePut">;
interface Remote { id: string; path: string; kind: ItemKind; revision: string; hash?: string; document?: string; digest?: string; size?: number; confirmed?: boolean }
/** Status while another device's writes keep invalidating a full scan. Matches words.ts' busy test. */
const CATCHING_UP = "Checking your files: catching up with changes from other devices";
/** How many plain note sends run at once. The SDK confirms them in batches. */
const SEND_CONCURRENCY = 16;
const isConflict = (e: unknown) => /conflict|revision/.test(`${errorInfo(e).code} ${errorInfo(e).reason}`);
/** How long starting may take before Sync offers Restart sync. */
export const START_STALL_MS = 30_000;

export default class NativeSync extends Component {
  constructor(readonly app: App, readonly manifest: PluginManifest, readonly changed: (text: string, phase: NativePhase, view?: NativeView) => void, readonly previousCollection?: string) {
    super();
    this.host = Platform.isMobile || Platform.isMobileApp ? new MobileHost(app, manifest) : new DesktopHost(app, manifest);
    this.frameCapability = this.host.uuid();
  }
  readonly host: EngineHost;
  private frameUrl = "";
  private persistence: Promise<void> = Promise.resolve();
  frame: HTMLIFrameElement | null = null;
  calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }>();
  nextCall = 1;
  phase: NativePhase = { kind: "starting" };
  bridge: MessagePort | null = null;
  data!: Data;
  origin = "";
  // A web page must not be able to frame this authenticated SDK host. The
  // capability is memory-only, checked by the HTTP listener before serving HTML.
  private readonly frameCapability: string;
  signInUrl: string | null = null; // bearer secret, memory only; never log
  mirroring = false;
  admitting = true;
  unloaded = false;
  jobs: Promise<unknown> = Promise.resolve(); // FS/state transactions, not an upload-lane workaround.
  root = "";
  pluginDir = "";
  markerTimer: number | null = null;
  settleTimer: number | null = null;
  warnedPaths = new Set<string>();
  reconcileQueued = false;
  reconcileFull = false;
  reconcilePaths = new Set<string>();
  deferredRemoteMoves = new Map<string, string>();
  sweptIncoming = false;
  reconcileCursor?: string;
  startingMirror = false;
  syncingFiles = false;
  reconcileImmediate = false;
  reconcileRetryTimer: number | null = null;
  reconcileRetryDelay = 250;
  writingPaths = new Set<string>();
  layout: CollectionLayout = DEFAULT_LAYOUT;
  merge: MergePrompt | null = null;
  statusText = "";
  activity: ActivityEntry[] = [];
  lastSynced: number | null = null;
  totals: SyncTotals | null = null;
  activityTimer: number | null = null;
  dirty = false; persistCost = 0;
  persistTimer: number | null = null; commitTimer: number | null = null;
  commitWaiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  /** The collection's file policy; undefined until read, null when it has none. */
  inclusion: CollectionInclusion | null | undefined = undefined;
  /** Starting has taken longer than START_STALL_MS. */
  stalled = false;
  stallTimer: number | null = null;
  stallMs = START_STALL_MS;
  /** After unload: this host writes nothing more, so a new one owns the journal. */
  retired = false;
  /** Resolves once the loopback server has closed (its port is free again). */
  released: Promise<void> = Promise.resolve();

  onload(): void { void this.initialize(); }

  async initialize(): Promise<void> {
    this.setStatus("Starting sync");
    this.pluginDir = this.host.pluginDir;
    this.root = this.host.root;
    // Obsidian's loadData returns null after a JSON parse failure. Treating that
    // as first install destroys the only durable sync/rejection journal.
    try {
      this.data = await this.readData();
      this.data.paths = Object.assign(Object.create(null) as Data["paths"], this.data.paths);
      this.data.pathFailures = Object.assign(Object.create(null) as NonNullable<Data["pathFailures"]>, this.data.pathFailures);
      this.bindVault();
      await this.readActivity();
      if (!this.data.collectionId && this.previousCollection) this.data.collectionId = this.previousCollection;
      // A marker from desktop, an unknown host, or another installation is never
      // overridden, even when stale. Do not overwrite data before this check.
      await this.checkOwnership();
      await this.persist();
      await this.startServer();
      // Unloaded while the port opened: never leave a frame or listener behind.
      if (this.unloaded) { this.closeServer(); return; }
      // Reserve even on first sign-in, before the SDK can auto-open anything.
      // collection_id is null only until the SDK first identifies a collection;
      // the daemon refuses host:"obsidian" regardless of that optional field.
      await this.claim(this.data.collectionId);
      if (this.unloaded) { this.closeServer(); return; }
    } catch (e) { this.closeServer(); this.phase = { kind: "blocked" }; this.fail("startup", e); return; }
    this.registerDomEvent(window, "message", (e: MessageEvent) => this.onMessage(e));
    this.frame = this.app.workspace.containerEl.createEl("iframe", { attr: { src: this.pageUrl(), "data-mdbase-native": "1" } });
    Object.assign(this.frame.style, { position: "fixed", width: "1px", height: "1px", border: "0", left: "-10px", top: "-10px" });
    this.watchStart();
    this.markerTimer = window.setInterval(() => { void (async () => {
      try {
        await this.checkOwnership();
        if (await this.ownsMarker()) await this.writeMarker();
      } catch (e) { this.pauseForOwnership(e); }
    })(); }, 5000);
    this.registerEvent(this.app.vault.on("create", f => this.onVaultChange(f, true)));
    this.registerEvent(this.app.vault.on("modify", f => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", f => this.onVaultChange(f, true)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => {
      if (!this.admitting || !this.mirroring) return;
      if (this.collectionPath(f.path) || this.collectionPath(old)) void this.enqueue(() => this.renameLocal(f, old));
    }));
  }

  pageUrl() { return this.frameUrl; }
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
  //
  // Nothing here waits for the SDK: a broken SDK (its Worker quarantined) can't
  // stop gracefully. Removing the iframe ends its document, which is the SDK's
  // own page-reload path: pagehide abandons the runtime and terminates the
  // Worker, and with the document go its Web Locks, BroadcastChannels and OPFS
  // handles. Every step runs even if an earlier one throws.
  onunload() {
    this.unloaded = true; this.admitting = false; this.mirroring = false;
    const steps: (() => void)[] = [
      () => { for (const t of [this.settleTimer, this.reconcileRetryTimer, this.stallTimer]) if (t !== null) window.clearTimeout(t); },
      () => { if (this.markerTimer !== null) window.clearInterval(this.markerTimer); },
      // Memory is the truth; anything persistSoon() or durable() deferred goes to disk now.
      () => { if (this.data && (this.dirty || this.commitTimer !== null)) void this.persist().catch(error => this.fail("saving state", error)); },
      () => { if (this.activityTimer !== null) { window.clearTimeout(this.activityTimer); void this.writeActivity(); } },
      () => { this.bridge?.close(); },
      () => { this.frame?.remove(); },
      () => this.closeServer(),
    ];
    for (const step of steps) {
      try { step(); } catch (e: unknown) { this.log(`unload step failed: ${errorInfo(e).code ?? "error"}`); }
    }
    this.markerTimer = this.settleTimer = this.reconcileRetryTimer = this.stallTimer = this.activityTimer = null;
    this.bridge = null; this.frame = null;
    // From here on a new host may own sync-state.json; this one must not write it.
    this.retired = true;
    for (const t of [this.persistTimer, this.commitTimer]) if (t !== null) window.clearTimeout(t);
    this.persistTimer = this.commitTimer = null;
    const waiting = this.commitWaiters; this.commitWaiters = [];
    for (const w of waiting) w.reject(Object.assign(new Error("unloaded"), { code: "unloaded" }));
    for (const c of this.calls.values()) { window.clearTimeout(c.timer); c.reject(new Error("unloaded")); }
    this.calls.clear();
  }
  /** Close the loopback server and every connection to it; `released` says when the port is free. */
  closeServer() {
    this.released = Promise.all([this.persistence, this.jobs, this.host.close()]).then(() => {});
    void this.released.catch(() => this.log("sync host release failed; restart blocked"));
  }
  bindVault() {
    const location = this.host.location();
    if (this.data.vaultLocation !== undefined && this.data.vaultLocation !== location)
      throw new Error("sync-state.json belongs to another vault or host; refusing shared replica storage. Restore this vault's own settings (do not copy another vault's sync-state.json).");
    this.data.vaultLocation = location;
  }
  async readData(): Promise<Data> {
    let saved: unknown;
    try { saved = JSON.parse(await this.host.readText(this.host.join(this.pluginDir, "sync-state.json"))); }
    catch (e: unknown) {
      if (errorInfo(e).code === "ENOENT") return { version: 1, vaultId: this.host.uuid(), paths: {} };
      throw new Error("Cannot read sync-state.json; sync stopped and original state retained. Restore a valid backup before reloading.");
    }
    const object = isObject;
    const valid = (saved: unknown): saved is Data => {
      if (!object(saved) || saved.version !== 1 || typeof saved.vaultId !== "string" || !saved.vaultId || !object(saved.paths)
        || Object.values(saved.paths).some((s) => !object(s) || (s.kind !== "record" && s.kind !== "file" && s.kind !== "resource") || ![s.id, s.revision, s.hash].every(v => typeof v === "string" && !!v))
        || (saved.uploads !== undefined && (!object(saved.uploads) || Object.entries(saved.uploads).some(([p, u]) => !this.validPath(p) || !object(u) || ![u.transferId, u.mutationId].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)) || typeof u.hash !== "string")))
        || (saved.pendingPaths !== undefined && (!object(saved.pendingPaths) || Object.values(saved.pendingPaths).some(v => typeof v !== "number" || !Number.isFinite(v))))
        || (saved.pathFailures !== undefined && (!object(saved.pathFailures) || Object.values(saved.pathFailures).some((h) => !object(h) || typeof h.signature !== "string" || (h.unknown !== undefined && typeof h.unknown !== "boolean"))))
        || (saved.conflictCopies !== undefined && (!object(saved.conflictCopies) || Object.values(saved.conflictCopies).some((h) => !object(h) || ![h.path, h.hash, h.copy].every(v => typeof v === "string" && !!v) || (h.kind !== "record" && h.kind !== "file"))))
        || (saved.sending !== undefined && (!object(saved.sending) || Object.values(saved.sending).some(v => typeof v !== "string")))
        || (saved.handledRejections !== undefined && (!object(saved.handledRejections) || Object.values(saved.handledRejections).some((h) => !object(h) || typeof h.path !== "string" || typeof h.hash !== "string" || (h.kind !== "record" && h.kind !== "file")))))
        return false;
      return true;
    };
    if (!valid(saved)) throw new Error("Invalid sync-state.json; sync stopped and original state retained. Restore a valid backup before reloading.");
    return saved;
  }
  // Three ways to save sync-state.json, which is rewritten whole each time:
  //  - persist(): now. For intent that must be on disk before the IO it covers.
  //  - durable(): resolves once saved. Sends that start together share one write.
  //  - persistSoon(): shortly, and at the end of every pass. Only for facts a
  //    restart can work out again (what was synced; see `sending`).
  persist(): Promise<void> {
    if (this.retired) throw Object.assign(new Error("Sync host stopped; state not written"), { code: "unloaded" });
    const started = Date.now();
    const file = this.host.join(this.pluginDir, "sync-state.json");
    const snapshot = JSON.stringify(this.data, null, 2);
    this.dirty = false;
    for (const timer of [this.persistTimer, this.commitTimer]) if (timer !== null) window.clearTimeout(timer);
    this.persistTimer = this.commitTimer = null;
    const waiting = this.commitWaiters; this.commitWaiters = [];
    let operation;
    try { operation = this.host.writeAtomic(file, snapshot); }
    catch (error) { this.dirty = true; for (const waiter of waiting) waiter.reject(error); throw error; }
    const write = Promise.resolve(operation);
    this.persistence = write;
    void write.then(() => { this.persistCost = Date.now() - started; for (const waiter of waiting) waiter.resolve(); }, error => { this.dirty = true; for (const waiter of waiting) waiter.reject(error); });
    return write;
  }
  persistSoon() {
    if (this.retired) return; // a restart works these facts out again
    this.dirty = true;
    // A large state file takes longer to write, so it is written less often.
    if (this.persistTimer === null) this.persistTimer = window.setTimeout(() => { this.persistTimer = null; void this.flush(true); }, Math.min(2000, Math.max(250, this.persistCost * 20)));
  }
  /** Save anything persistSoon() left unsaved. */
  async flush(quiet = false) {
    if (!this.dirty) return;
    try { await this.persist(); }
    catch (e: unknown) { if (!quiet) throw e; this.log(`saving sync state failed: ${errorInfo(e).code ?? "error"}`); }
  }
  durable(): Promise<void> {
    if (this.retired) return Promise.reject(Object.assign(new Error("Sync host stopped; state not written"), { code: "unloaded" }));
    return new Promise((resolve, reject) => {
      this.commitWaiters.push({ resolve, reject });
      if (this.commitTimer === null) this.commitTimer = window.setTimeout(() => { void (async () => {
        this.commitTimer = null;
        try { await this.persist(); }
        catch (e) { const waiting = this.commitWaiters; this.commitWaiters = []; for (const w of waiting) w.reject(e); }
      })(); }, Math.min(100, Math.max(2, this.persistCost * 2)));
    });
  }
  enqueue(work: () => Promise<unknown>) {
    // Stop admitting stream/command work as well as vault events. Already
    // admitted jobs still finish before handover's final scan and drain.
    if (!this.admitting) return Promise.resolve();
    const run = this.jobs.then(async () => { if (!this.unloaded && this.mirroring) return work(); });
    this.jobs = run.catch(e => this.fail("sync", e)); return run.catch(() => {});
  }

  // ---- in-memory loopback assets -------------------------------------------
  async startServer() {
    const page = await this.host.open({ data: this.data, capability: this.frameCapability, stopped: () => this.unloaded, save: () => this.persist(), log: text => this.log(text) });
    this.origin = page.origin; this.frameUrl = page.url;
  }

  // ---- ownership: .mdbase is private, never a mirrored collection path -------
  get markerPath() { return this.host.join(this.root, ".mdbase", "host.json"); }
  async readMarker(): Promise<unknown> {
    this.assertDiskPath(".mdbase/host.json");
    try {
      const marker: unknown = JSON.parse(await this.host.readText(this.markerPath));
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw new Error("Invalid marker");
      return marker;
    } catch (e: unknown) { if (errorInfo(e).code === "ENOENT") return null; throw new Error("Unreadable ownership marker; waiting for desktop/manual recovery"); }
  }
  async ownsMarker(m?: unknown) {
    if (m === undefined) m = await this.readMarker();
    return this.markerMatches(m);
  }
  markerMatches(m: unknown) {
    return isObject(m) && Number.isSafeInteger(this.data.markerSince) && m.host === "obsidian" && m.collection_id === (this.data.collectionId ?? null) && m.since_ms === this.data.markerSince;
  }
  checkOwnership() {
    return this.host.checkOwnership(text => {
      let marker: unknown = null;
      try {
        marker = text === null ? null : JSON.parse(text);
        if (text !== null && (!marker || typeof marker !== "object" || Array.isArray(marker))) throw new Error("Invalid marker");
      } catch { throw new Error("Unreadable ownership marker; waiting for desktop/manual recovery"); }
      if ((marker && !this.markerMatches(marker)) || (!marker && this.mirroring)) throw new Error("Folder owned elsewhere (or ownership marker missing); waiting. Never remove another host's marker.");
    });
  }
  async claim(id?: string) {
    await this.checkOwnership();
    if (this.data.collectionId && this.data.collectionId !== id) throw Object.assign(new Error("Folder is bound to another collection; drain it before reconfiguration"), { code: "collection_bound" });
    this.data.collectionId = id; this.data.markerSince ??= Date.now(); await this.persist();
    await this.writeMarker(); await this.checkOwnership();
    if (!await this.ownsMarker()) throw new Error("Ownership changed while claiming folder");
  }
  async writeMarker() {
    if (this.unloaded) return;
    this.assertDiskPath(".mdbase/host.json");
    await this.host.mkdir(this.host.dirname(this.markerPath));
    if (this.unloaded) return;
    await this.host.writeAtomic(this.markerPath, JSON.stringify({ host: "obsidian", pid: this.host.processId, collection_id: this.data.collectionId ?? null, since_ms: this.data.markerSince, heartbeat_ms: Date.now() }), true);
  }
  pauseForOwnership(e: unknown) {
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
      await this.checkOwnership();
      if (!await this.ownsMarker()) throw new Error("Ownership changed during handover");
      await this.host.remove(this.markerPath);
      this.log("handover: SDK stopped; own marker removed");
      if (this.markerTimer) window.clearInterval(this.markerTimer);
      // Stopped on purpose: a state of its own, so it reads as done, not as a fault.
      this.phase = { kind: "handed_over" };
      this.setStatus(HANDED_OVER);
      new Notice("mdbase: everything is sent. Add this folder in the mdbase app to keep syncing it.", 10000);
    } catch (e) { this.mirroring = false; this.fail("handover (marker retained)", e); }
  }

  // ---- iframe RPC ----------------------------------------------------------
  call<Method extends NativeMethod>(method: Method, ...args: Parameters<NativeMethods[Method]>): Promise<NativeResult<Method>> {
    if (!this.bridge) return Promise.reject(new Error("SDK host is not running"));
    const id = this.nextCall++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.calls.delete(id); reject(Object.assign(new Error(`SDK ${method} timed out; outcome may be unknown`), { code: "outcome_unknown" })); }, 180_000);
      this.calls.set(id, { resolve: value => resolve(value as NativeResult<Method>), reject, timer });
      this.bridge!.postMessage({ type: "call", id, method, args });
    });
  }
  async onMessage(e: Pick<MessageEvent<PageMessage>, "origin" | "source" | "data">) {
    if (this.unloaded) return;
    if (e.origin !== this.origin || e.source !== this.frame?.contentWindow || !e.data) return;
    const m = e.data;
    switch (m.type) {
      case "hello": {
        if (this.bridge) return;
        const channel = new MessageChannel(); this.bridge = channel.port1;
        channel.port1.onmessage = (event: MessageEvent<PageMessage>) => this.onMessage({ origin: this.origin, source: this.frame!.contentWindow, data: event.data });
        this.frame.contentWindow!.postMessage({ type: "connect" }, this.origin, [channel.port2]);
        this.log(`page up: origin=${m.origin} opfs=${m.opfs} secure=${m.isSecureContext}`);
        try { await this.checkOwnership(); } catch (e) { this.pauseForOwnership(e); return; }
        void this.call("start").catch(e => this.fail("start", e)); break;
      }
      case "phase": void this.onPhase(m.phase).catch(e => this.fail("phase", e)); break;
      case "open-url": this.openSignIn(m.url); break;
      case "changes": {
        const paths = new Set<string>();
        const changed = new Set(m.batch.changes.map(c => c.id));
        for (const c of m.batch.changes) if (c.path && this.validPath(c.path)) paths.add(c.path);
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
  async select(id: string) { await this.claim(id); await this.call("select", id); }
  async onPhase(phase: NativePhase) {
    // After a handover the SDK is stopped; its closing notices change nothing here.
    if (this.phase.kind === "handed_over") return;
    const was = this.phase; this.phase = phase;
    if (phase.kind !== "starting") this.endStartWatch();
    else if (was.kind !== "starting") this.watchStart();
    // Apply the transition before awaiting select/watch. A ready notification
    // can arrive while the earlier choosing handler is still awaiting select;
    // that older handler must not turn mirroring off again after ready wins.
    if (phase.kind !== "ready") this.mirroring = false;
    if (["ready", "signed_out", "problem", "closed"].includes(phase.kind)) this.signInUrl = null;
    const phaseText: Record<string, string> = {
      starting: this.stalled ? STARTING_STALLED : "Starting sync", signed_out: "Sign in to sync this vault.",
      authorizing: this.data?.collectionId ? AWAITING_APPROVAL : "Finish signing in in your browser.",
      choosing: "Choose the collection to sync with this vault.", opening: "Getting your collection ready.",
      needs_unlock: phase.unlock?.unlocking ? "Unlocking your collection." : LOCKED_TEXT[phase.unlock?.mode ?? "password"],
      needs_approval: NEEDS_APPROVAL,
      problem: "Sync needs attention. Your files are kept on this computer.", closed: "Sync stopped. Your files stay here.",
    };
    // A later notice of the same stop (its sync counts or collection list
    // changed) keeps the words saying why, not the generic problem text.
    const sameStop = phase.kind !== "ready" && phase.kind !== "needs_unlock" && phase.kind === was.kind && phase.problem && JSON.stringify(phase.problem) === JSON.stringify(was.problem);
    if (this.admitting && sameStop) this.setStatus(this.statusText);
    else if (this.admitting && !(phase.kind === "ready" && (this.syncingFiles || this.startingMirror || this.reconcileRetryTimer !== null)))
      this.setStatus(phase.kind === "ready" ? phase.sync ? readyText(phase.sync) : "Checking your files" : phaseText[phase.kind] ?? "Starting sync");
    // A pass in progress keeps its own progress text, but going offline or
    // coming back must still reach the UI; "Uploading 83 of 500" would
    // otherwise stay up for as long as the connection is down (QA2-1).
    else if (this.admitting && phase.sync?.state !== was.sync?.state) this.setStatus(this.statusText);
    // Names/documents never belong in this log.
    this.log(`phase ${phase.kind}${phase.problem ? ` ${phase.problem.code ?? ""} ${phase.problem.reason ?? ""}` : ""}${phase.sync ? ` sync=${phase.sync.state} pending=${phase.sync.pending}` : ""}`);
    // A wrong password is shown beside the form; it doesn't stop sync.
    if (this.admitting && phase.kind !== "needs_unlock" && phase.problem && JSON.stringify(phase.problem) !== JSON.stringify(was.problem))
      this.fail("sync", phase.problem, this.needsRestart && this.canStartOver ? SIGN_IN_STOPPED : stoppedText(phase.problem), true);
    if (syncOffline(phase.sync) && !syncOffline(was.sync))
      new Notice("mdbase: sync service unreachable. Changes are saved on this device and will sync when the connection returns.", 10000);
    if (this.admitting && (phase.kind === "opening" || phase.kind === "needs_unlock") && phase.collectionId) {
      try { await this.claim(phase.collectionId ?? undefined); } catch (e) { this.pauseForOwnership(e); return; }
    }
    if (this.admitting && phase.kind === "choosing") {
      const bound = phase.collections?.find((c: { id: string }) => c.id === this.data.collectionId);
      if (bound) await this.select(bound.id);
      else if (!this.data.collectionId && phase.collections?.length === 1) await this.select(phase.collections[0].id);
    }
    // select() can publish opening/ready before its promise settles. The older
    // choosing handler must not subsequently turn off the now-ready mirror.
    if (this.unloaded || this.phase !== phase) return;
    if (this.admitting && phase.kind === "ready" && (was.kind !== "ready" || was.collectionId !== phase.collectionId)) {
      try { await this.claim(phase.collectionId ?? undefined); } catch (e) { this.pauseForOwnership(e); return; }
      if (await this.needsMergeConfirmation(phase)) return;
      await this.startMirror();
    }
  }
  /**
   * Before the first sync, a vault with notes and a collection with items would
   * be combined in both directions. That needs the user's say-so: the single
   * collection is picked automatically, so it may not be the one they meant.
   */
  async needsMergeConfirmation(phase: NativePhase): Promise<boolean> {
    if (this.data.cursor !== undefined || Object.keys(this.data.paths).length || this.data.mergeConfirmed === phase.collectionId) return false;
    const remotes = await this.remoteAll(); // also reads the layout
    if (this.unloaded || this.phase !== phase) return true;
    const remote = [...remotes.values()].filter(r => r.kind !== "resource").length;
    const local = (await this.localPaths()).filter(p => this.kindOf(p) !== "resource").length;
    if (!remote || !local) return false;
    const name = phase.collections?.find((c: { id: string }) => c.id === phase.collectionId)?.name ?? "this collection";
    if (!phase.collectionId) throw new Error("Missing collection identity");
    this.merge = { collectionId: phase.collectionId, name, local, remote };
    this.log(`waiting for merge confirmation: local=${local} remote=${remote}`);
    this.setStatus(`Waiting for you: this vault and “${name}” both have notes.`);
    return true;
  }
  /**
   * Unlock the Private collection this vault is waiting on. The secret goes to
   * the sync engine for this one call and is kept nowhere here. A wrong one
   * comes back on the phase (`phase.problem`), not as an error.
   */
  async unlock(secret: { password: string } | { recoveryKey: string }) {
    const phase = this.phase;
    if (phase.kind !== "needs_unlock" || phase.unlock?.unlocking || !phase.collectionId) return;
    await this.call("unlock", phase.collectionId, secret);
  }
  /** Read again how the account unlocks (after setting a password elsewhere). */
  async recheckLock() {
    if (this.phase.kind === "needs_unlock" && this.phase.collectionId) await this.select(this.phase.collectionId);
  }
  async confirmMerge() {
    const m = this.merge, phase = this.phase;
    if (!m || phase.kind !== "ready" || phase.collectionId !== m.collectionId) return;
    this.data.mergeConfirmed = m.collectionId; this.merge = null; await this.persist();
    await this.startMirror();
  }
  /** Only before anything has synced: release the collection and pick again. */
  /** Whether this vault can still be pointed at a different collection. */
  get canChooseAnother(): boolean {
    return (this.merge !== null || this.phase.kind === "needs_unlock") && this.data.cursor === undefined && !Object.keys(this.data.paths).length;
  }
  async chooseAnother() {
    if (!this.canChooseAnother) return;
    const current = this.merge?.collectionId ?? this.phase.collectionId;
    const select = (id: string) => this.select(id);
    const addCollection = () => this.call("addCollection");
    const reset = async () => { this.data.collectionId = undefined; this.merge = null; await this.persist(); await this.writeMarker(); this.setStatus("Getting your collection ready."); };
    const failed = (error: unknown) => this.fail("select", error);
    const items: { id: string | null; name: string; private?: boolean }[] = [
      ...(this.phase.collections ?? []).filter((c: { id: string }) => c.id !== current),
      { id: null, name: "New collection…" },
    ];
    withPrivateHint(new (class extends SuggestModal<{ id: string | null; name: string; private?: boolean }> {
      getSuggestions(q: string) { return items.filter(c => c.name.toLowerCase().includes(q.toLowerCase())); }
      renderSuggestion(c: { id: string | null; name: string; private?: boolean }, el: HTMLElement) { renderCollectionChoice(c, el); }
      onChooseSuggestion(c: { id: string | null; name: string }) {
        void (async () => {
          await reset();
          await (c.id ? select(c.id) : addCollection());
        })().catch(failed);
      }
    })(this.app)).open();
  }
  async startMirror() {
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
    await this.sweepIncoming();
    this.startingMirror = true;
    try { await this.call("watch", this.data.cursor); }
    finally { this.startingMirror = false; }
    this.requestReconcile(undefined, undefined, true);
    await this.jobs;
  }
  /**
   * `.mdbase/incoming` holds only staging copies of downloads, each removed by
   * its own transfer. A transfer killed with the app (Android stops Obsidian
   * without warning) leaves its partial copy behind. Sweep once per load,
   * before the first pass: no transfer of this load has started yet, and a
   * later restart of the mirror must not touch a transfer still running.
   */
  async sweepIncoming() {
    if (this.sweptIncoming) return;
    this.sweptIncoming = true;
    const incoming = this.host.join(this.root, ".mdbase", "incoming");
    try {
      if (!await this.host.exists(incoming)) return;
      for (const entry of await this.host.list(incoming)) {
        if (!entry.file || !entry.name.endsWith(".tmp")) continue;
        await this.host.remove(this.host.join(incoming, entry.name));
        this.log("removed an interrupted download's staging copy");
      }
    } catch (e: unknown) { this.log(`staging cleanup skipped: ${errorInfo(e).message ?? String(e)}`); }
  }
  async signIn() {
    if (this.phase.kind === "authorizing" && this.signInUrl) {
      this.openSignIn(this.signInUrl);
      new Notice("mdbase: sign-in is still pending. Reopened the existing approval link; finish or cancel it in your browser.");
      return;
    }
    await this.call("signIn");
  }
  /**
   * The sync engine's suggested way back when this app's access was removed:
   * approve this collection again in the browser. Only for a stop that asks for it.
   */
  async requestAccess() {
    const phase = this.phase;
    if ((phase.problem?.action !== "approve" && phase.kind !== "needs_approval") || !phase.collectionId) return;
    await this.call("approve", phase.collectionId);
  }
  /**
   * Ask the sync engine to try again after a stop: its start() restarts a
   * blocked sign-in and reopens a blocked collection. Nothing is reset.
   */
  async retry() {
    if (this.phase.kind !== "problem") return;
    const before = JSON.stringify(this.phase.problem);
    await this.call("start");
    // Phase notices arrive before the call's reply. The same stop means nothing changed: say so.
    if (this.phase.kind === "problem" && JSON.stringify(this.phase.problem) === before)
      throw Object.assign(new Error("Tried again, but sync still can't continue."), { code: "still_stopped" });
  }
  /**
   * The SDK's Worker is gone: it quarantined itself (`application_worker_*`)
   * and refuses every call, so only a fresh host (Restart sync) can go on.
   */
  get workerGone(): boolean {
    return this.phase.kind === "problem" && /^application_worker_/.test(String(this.phase.problem?.code ?? ""));
  }
  /** Only a fresh host can go on: the SDK asks for a reload, its Worker is gone, or starting stalled. */
  get needsRestart(): boolean {
    return (this.phase.kind === "problem" && (this.phase.problem?.action === "reload" || this.workerGone)) || (this.phase.kind === "starting" && this.stalled);
  }
  /** Starting gets START_STALL_MS before Sync says so and offers Restart sync. */
  watchStart() {
    this.endStartWatch();
    if (this.unloaded) return;
    this.stallTimer = window.setTimeout(() => {
      this.stallTimer = null;
      if (this.unloaded || this.phase.kind !== "starting") return;
      this.stalled = true;
      this.log(`still starting after ${this.stallMs / 1000} s`);
      this.setStatus(STARTING_STALLED);
    }, this.stallMs);
  }
  endStartWatch() {
    if (this.stallTimer !== null) window.clearTimeout(this.stallTimer);
    this.stallTimer = null; this.stalled = false;
  }
  /**
   * Whether signing this vault out of mdbase loses nothing: no collection is
   * bound, nothing has synced, and nothing is waiting to be sent or preserved.
   * Only then can a stuck sign-in be abandoned (see startOver).
   */
  get canStartOver(): boolean {
    const d = this.data;
    if (!d || this.phase.kind !== "problem" || this.mirroring || this.merge !== null) return false;
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
  async startOver() {
    if (!this.canStartOver) return;
    this.signInUrl = null;
    this.log("start over: signing out of an unfinished sign-in (nothing bound)");
    await this.call("signOut");
    if (this.phase.kind === "problem")
      throw Object.assign(new Error("Start over didn't finish. Choose Restart sync, then Start over again."), { code: "still_stopped" });
  }
  openSignIn(url: string) {
    this.signInUrl = url;
    void this.host.openExternal(url)
      .then(() => this.log("sign-in opened in system browser"), (e: Error) => this.fail("open sign-in", e));
  }
  choose() {
    const items = this.phase.collections ?? [];
    const select = (id: string) => { void this.select(id).catch(error => this.fail("select", error)); };
    withPrivateHint(new (class extends SuggestModal<NonNullable<NativePhase["collections"]>[number]> {
      getSuggestions(q: string) { return items.filter((c: NonNullable<NativePhase["collections"]>[number]) => c.name.toLowerCase().includes(q.toLowerCase())); }
      renderSuggestion(c: NonNullable<NativePhase["collections"]>[number], el: HTMLElement) { renderCollectionChoice(c, el); }
      onChooseSuggestion(c: NonNullable<NativePhase["collections"]>[number]) { select(c.id); }
    })(this.app)).open();
  }

  // ---- durable three-way reconciliation ------------------------------------
  collectionPath(vp: string) {
    const p = vp;
    return this.validPath(p) && this.kindOf(p) !== "excluded" ? p : null;
  }
  /** How the collection treats this path (see classify.ts). */
  kindOf(p: string): PathKind {
    const kind = classifyPath(p, this.layout);
    return this.leftOut(p, kind) ? "excluded" : kind;
  }
  /** Left out by this device's choices or by the collection's file policy. */
  leftOut(p: string, kind: PathKind, size?: number): boolean {
    return skippedHere(p, kind, this.data?.device) || collectionExcludes(p, kind, this.inclusion, size);
  }
  /** A path that isn't synced here although it may exist in the collection. */
  skipped(p: string, size?: number): boolean { return this.leftOut(p, classifyPath(p, this.layout), size); }
  /** Refresh the collection's file policy. Unavailable leaves the last one in place. */
  async readInclusion() {
    try {
      const next = await this.call("inclusion");
      const changed = JSON.stringify(next) !== JSON.stringify(this.inclusion);
      if (next === null || validInclusion(next)) this.inclusion = next;
      if (changed) await this.forgetSkipped();
    } catch (e: unknown) {
      // Without it this device syncs every file type, as before; Connect still
      // refuses what its policy excludes, and those show as not synced.
      this.log(`collection file policy unavailable: ${errorInfo(e).code ?? "error"}`);
      this.inclusion ??= null;
    }
  }

  // ---- this device's choices and activity ----------------------------------
  get device(): DeviceFilter { return this.data?.device ?? NO_FILTER; }
  /** Change what this device syncs. Newly skipped paths are forgotten, never deleted. */
  async setDevice(next: DeviceFilter) {
    const filter: DeviceFilter = { skip: [...new Set(next.skip)], folders: [...new Set(next.folders.map(normalizeFolder).filter(Boolean))] };
    if (!validFilter(filter)) throw new Error("Invalid device sync choices");
    // Saved before anything else: a choice must survive a reload even when it
    // matches no file yet (QA-1).
    const apply = async () => { this.data.device = filter.skip.length || filter.folders.length ? filter : undefined; await this.persist(); await this.forgetSkipped(); };
    // Between passes only: a pass in flight still holds the old choices.
    if (this.mirroring) await this.enqueue(async () => { await apply(); await this.reconcileAll(false, undefined, true); });
    else await apply();
    this.setStatus(this.statusText);
  }
  /** Skipped paths keep no synced state, so turning one back on compares both sides afresh. */
  async forgetSkipped() {
    let changed = false;
    for (const p of Object.keys(this.data.paths)) if (this.skipped(p)) { delete this.data.paths[p]; changed = true; }
    // Paths never synced (a refused new note, say) leave records here too. A
    // stale one would keep "Last synced" from ever updating (QA-5).
    for (const map of [this.data.pendingPaths, this.data.pathFailures, this.data.sending])
      for (const p of Object.keys(map ?? {})) if (this.skipped(p)) { delete map![p]; changed = true; }
    if (changed) await this.persist();
  }
  note(kind: ActivityKind, p: string, extra: Partial<ActivityEntry> = {}) {
    this.activity = recordActivity(this.activity, { at: Date.now(), kind, path: p, ...extra });
    if (this.activityTimer === null) this.activityTimer = window.setTimeout(() => { this.activityTimer = null; void this.writeActivity(); }, 2000);
  }
  activityFile() { return this.host.join(this.pluginDir, "sync-activity.json"); }
  async readActivity() {
    try {
      const saved: unknown = JSON.parse(await this.host.readText(this.activityFile()));
      if (isObject(saved) && validActivity(saved.activity)) this.activity = saved.activity;
      if (isObject(saved) && typeof saved.lastSynced === "number") this.lastSynced = saved.lastSynced;
    } catch { /* no history yet, or unreadable: start a new one */ }
  }
  async writeActivity() {
    try {
      await this.host.writeAtomic(this.activityFile(), JSON.stringify({ activity: this.activity, lastSynced: this.lastSynced }));
    } catch (e: unknown) { this.log(`activity not saved: ${errorInfo(e).code ?? "error"}`); }
  }
  /** Read the layout from this vault's mdbase.yaml, else the collection's. */
  async readLayout(remoteConfig?: string) {
    let text: string | undefined;
    try { this.assertDiskPath(CONFIG_PATH); text = await this.host.readText(this.host.join(this.root, CONFIG_PATH)); }
    catch { text = remoteConfig; }
    try { this.layout = text === undefined ? DEFAULT_LAYOUT : layoutFromConfig(parseYaml(text)); }
    catch { this.layout = DEFAULT_LAYOUT; } // Connect reports a broken config itself
  }
  validPath(p: string) {
    // The SDK canonicalizes to NFC. Sending NFD under a different local key
    // can alias an existing record and make reconciliation move it over itself.
    return !!p && p === p.normalize("NFC") && !p.includes("\\") && !p.startsWith("/") && p.split("/").every(x => !!x && x !== "." && x !== ".." && ![".mdbase", this.app.vault.configDir, ".trash", ".git"].includes(x));
  }
  vaultPath(p: string) { if (!this.validPath(p)) throw new Error("Unsafe/private collection path refused"); return p; }
  editorViews(p: string): MarkdownView[] {
    const vp = this.vaultPath(p);
    return this.app.workspace?.getLeavesOfType("markdown").map(({ view }) => view).filter((view): view is MarkdownView =>
      "file" in view && isObject(view.file) && view.file.path === vp && "editor" in view && !!view.editor && "getViewData" in view && typeof view.getViewData === "function") ?? [];
  }
  // Discovery alone is insufficient: known/remote paths can be replaced by a
  // symlink after discovery, including any ancestor directory. Never follow it.
  assertDiskPath(p: string) { this.host.assertPath(p); }
  accessiblePath(p: string) {
    if (!this.validPath(p)) return false;
    try { this.assertDiskPath(p); return true; }
    catch (e: unknown) {
      if (errorInfo(e).code !== "unsafe_symlink") throw e;
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
      const diskBytes = await this.host.readBytes(this.host.join(this.root, this.vaultPath(p)));
      const unsupportedEncoding = this.kindOf(p) !== "file" && !validUtf8(diskBytes);
      // Never let an editor's replacement-character decode masquerade as the
      // original invalid disk bytes. Snapshot buffers AFTER asynchronous IO.
      const buffers = !unsupportedEncoding && p.endsWith(".md") ? this.editorViews(p).map(v => v.getViewData()) : [];
      if (new Set(buffers).size > 1) throw new Error("Open editor buffers disagree; local state retained");
      const bytes = buffers.length ? encode(buffers[0]) : diskBytes;
      if (!bytes) return undefined;
      return { f: f instanceof TFile ? f : undefined, bytes, hash: await this.host.hash(bytes), unsupportedEncoding };
    } catch (e: unknown) {
      // Disk watchers can expose the old TFile briefly after an external mv.
      if (errorInfo(e).code === "ENOENT" || errorInfo(e).code === "EISDIR") return undefined;
      throw e;
    }
  }
  async localPaths(skippedOnly = false) {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await this.host.list(this.host.join(this.root, dir))) {
        const p = dir ? `${dir}/${entry.name}` : entry.name;
        if (!this.validPath(p)) {
          if (p !== p.normalize("NFC") && !this.warnedPaths.has(p)) {
            this.warnedPaths.add(p);
            this.log(`unsupported non-NFC path skipped: ${JSON.stringify(p)}`);
            new Notice("mdbase: a non-nfc filename cannot sync. Rename it to unicode nfc; existing files were not changed.", 10000);
          }
          continue;
        }
        if (entry.directory) { if (!entry.name.startsWith(".") && entry.name !== "node_modules") await walk(p); }
        else if (entry.file && (skippedOnly ? this.skipped(p) : this.kindOf(p) !== "excluded")) out.push(p); // do not traverse symlinks
      }
    };
    await walk(""); return out;
  }
  remote(r: WireItem, kind: ItemKind): Remote {
    return "digest" in r
      ? { ...r, kind, revision: r.digest, hash: r.digest }
      : { ...r, kind, revision: r.revision, hash: hash(encode("document" in r ? r.document ?? "" : "")) };
  }
  async remoteAll(affected?: Set<string>): Promise<Map<string, Remote>> {
    const out = new Map<string, Remote>(), identities = new Set<string>();
    // Definitions are few and the change stream never reports them, so every
    // pass lists them all. Record/file lookups must not be asked for them.
    const resources = await this.call("resourcesAll");
    await this.readLayout(resources.find(r => r.path === CONFIG_PATH)?.document);
    const lookup = affected && [...affected].filter(p => this.validPath(p) && !["resource", "excluded"].includes(this.kindOf(p)));
    const selected = lookup ? (lookup.length ? await this.call("at", lookup) : []) : undefined;
    const records = selected ? selected.filter(r => r.kind === "record") : await this.call("all");
    const files = selected ? selected.filter(r => r.kind === "file") : await this.call("filesAll");
    for (const [rows, kind] of [[resources, "resource"], [records, "record"], [files, "file"]] as const) for (const row of rows) {
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
      this.assertDiskPath(p);
      return this.host.identity(this.host.join(this.root, this.vaultPath(p)));
    } catch { return undefined; } // mobile/non-filesystem: hash-only matching
  }
  remember(p: string, r: Remote, localHash: string) {
    const next = { id: r.id, kind: r.kind, revision: r.revision, hash: localHash, disk: this.diskIdentity(p) };
    const prev = this.data.paths[p];
    if (prev && prev.id === next.id && prev.kind === next.kind && prev.revision === next.revision && prev.hash === next.hash && prev.disk?.dev === next.disk?.dev && prev.disk?.ino === next.disk?.ino && prev.disk?.birthtimeMs === next.disk?.birthtimeMs) return;
    // If this is lost in a crash, the next start compares both sides again and
    // reaches the same answer (for a sent note, through `sending`).
    this.data.paths[p] = next; this.persistSoon();
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
    await this.assertMirror();
    let next: WireItem;
    try {
      next = r.kind === "record"
        ? await this.call("replace", r.id, { path: from, doc: r.document! }, { path: to, doc: r.document! }, r.revision)
        : await this.call("fileMove", r.id, to, r.revision);
    } catch (e: unknown) { const failure = errorInfo(e);
      // A rejected path-only record CAS is still a ledger write. Preserve its
      // exact submitted document/target before acknowledging it, just as for an
      // edit rejection. Usually the user's moved file itself is the copy, so do
      // not manufacture a second identical conflict file unnecessarily.
      if (isConflict(e) && failure.mutationId && r.kind === "record") {
        const bytes = encode(r.document!), submitted = { f: undefined, bytes, hash: hash(bytes), unsupportedEncoding: false };
        const local = await this.local(to), target = (await this.remoteAll()).get(to);
        if (local?.hash === submitted.hash && (!target || (target.kind === "record" && target.hash === submitted.hash && target.confirmed === true))) {
          const h = { path: from, hash: submitted.hash, kind: "record" as const, copy: to, handled: false };
          (this.data.handledRejections ??= {})[failure.mutationId] = h; await this.persist();
          if (!target) await this.push(to, submitted);
          h.handled = true; await this.persist();
        } else await this.preserveConflict(to, submitted, failure.mutationId);
        await this.acknowledgeHandled();
      }

      throw e; // caller refreshes the winning remote identity before reconciling
    }
    delete this.data.paths[from];
    delete this.data.pendingPaths?.[from]; delete this.data.pendingPaths?.[to];
    // Move first, then CAS any content edit in the ordinary path pass.
    const moved = this.remote(next, r.kind); this.remember(to, moved, k.hash);
    this.note("moved", from, { to, from: "here" });
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
      this.syncingFiles = true; this.passStatus("Checking your files");
      try {
        if (await this.reconcileAll(!now, affected) === false) {
          // Paths that didn't sync are listed in the Sync tab; everything else
          // synced. Keep the cursor so their remote changes are revisited, and
          // make the next trigger a full pass.
          this.reconcileFull = true; this.reconcileCursor ??= nextCursor;
          return;
        }
        if (nextCursor !== undefined && nextCursor !== this.data.cursor) { this.data.cursor = nextCursor; await this.persist(); }
        this.reconcileRetryDelay = 250;
      } catch (e: unknown) {
        // Never skip a failed batch by committing a later cursor after a partial
        // pass. The next trigger must reconcile a full snapshot before advancing.
        this.reconcileFull = true; this.reconcileCursor ??= nextCursor; this.reconcileImmediate ||= now;
        // A paged read can lose its cursor twice while another device mutates
        // the collection (the SDK already retries once). This is not a failed
        // write. Coalesce new events and retry a fresh full scan with bounded
        // backoff, including when no later event arrives. Never commit a partial
        // snapshot or advance the stream cursor, and don't spam failure Notices.
        if (errorInfo(e).code === "invalid_request" && ["cursor_stale", "cursor_expired"].includes(errorInfo(e).reason ?? "")) {
          if (this.reconcileRetryDelay === 250) this.log("snapshot query invalidated; retrying full scan with cursor retained");
          // Not up to date until a full pass completes, whatever the SDK says (QA-2).
          this.passStatus(CATCHING_UP);
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
    let result: boolean | undefined;
    try { result = await this.reconcilePass(defer, affected, retryFailed); }
    catch (e) { await this.flush(true); throw e; }
    await this.flush();
    return result;
  }
  async reconcilePass(defer: boolean, affected: Set<string> | undefined, retryFailed: boolean): Promise<boolean | undefined> {
    if (!this.mirroring) return;
    await this.checkOwnership();
    // Recovery journals require the original and preservation copy together.
    if (this.deferredRemoteMoves.size || Object.keys(this.data.handledRejections ?? {}).length || Object.keys(this.data.conflictCopies ?? {}).length || Object.keys(this.data.pathFailures ?? {}).length) affected = undefined;
    if (!affected || this.inclusion === undefined) await this.readInclusion();
    await this.forgetSkipped();
    await this.resumeUploads();
    let remotes = await this.remoteAll(affected);
    await this.acknowledgeHandled(false, remotes);
    const failedBefore = new Set(Object.keys(this.data.pathFailures ?? {}));
    // One path's failure is recorded for the Sync tab; the pass carries on.
    const notSynced = async (p: string, signature: string, e: unknown): Promise<ActivityKind> => {
      if (!this.mirroring || this.unloaded) throw e;
      await this.checkOwnership();
      (this.data.pathFailures ??= Object.create(null) as NonNullable<Data["pathFailures"]>)[p] = { signature, code: errorInfo(e).code, reason: errorInfo(e).reason, unknown: /unknown/.test(`${errorInfo(e).code} ${errorInfo(e).reason}`), ...(Array.isArray(errorInfo(e).issues) ? { issues: errorInfo(e).issues } : {}) };
      await this.persist();
      this.log(`not synced: ${JSON.stringify(p)} ${[errorInfo(e).code, errorInfo(e).reason].filter(Boolean).join(" ")}`);
      return "not_synced";
    };
    if (affected) {
      // Remote definition changes arrive only through this listing.
      for (const r of remotes.values()) if (r.kind === "resource" && this.data.paths[r.path]?.revision !== r.revision) affected.add(r.path);
      for (const [p, k] of Object.entries(this.data.paths)) if (k.kind === "resource" && !remotes.has(p)) affected.add(p);
    }
    // Records validate against the definitions. Folding their revisions into a
    // record's failure signature retries an invalid_record once types change.
    const definitions = hash(encode(JSON.stringify([...remotes.values()].filter(r => r.kind === "resource").map(r => [r.path, r.revision]).sort())));
    let definitionsChanged = false;
    // Index once, rather than allocating/scanning all remotes for every path.
    const byId = new Map([...remotes.values()].map(r => [`${r.kind}:${r.id}`, r]));
    const previousMoves = this.deferredRemoteMoves;
    this.deferredRemoteMoves = new Map();
    const blockedSources = new Set<string>(), blockedTargets = new Set<string>();
    let retryMoves = false, refreshRemotes = false;
    // Join by stable identity BEFORE treating a new path as a new remote item.
    for (const [from, k] of Object.entries(this.data.paths)) {
      const r = byId.get(`${k.kind}:${k.id}`);
      // A move into a folder this device skips reads as a removal at `from`.
      if (!r || r.path === from || !this.accessiblePath(from) || !this.accessiblePath(r.path) || this.skipped(r.path) || (affected && !affected.has(from) && !affected.has(r.path))) continue;
      affected?.add(from); affected?.add(r.path);
      const signature = `remote-move:${JSON.stringify([k.id, k.kind, r.path, r.revision])}`;
      try {
      const l = await this.local(from);
      const tracked = this.data.paths[r.path];
      let occupied = !!tracked || !!this.app.vault.getAbstractFileByPath(this.vaultPath(r.path)) || await this.host.exists(this.host.join(this.root, r.path));
      if (!tracked && occupied && k.id === r.id && k.kind === r.kind) {
        if (l && !l.f) throw Object.assign(new Error("Waiting for vault index before remote rename"), { code: "vault_index_pending" });
        const occupant = await this.local(r.path);
        if (occupant) {
          refreshRemotes = true;
          const copy = await this.preserveConflict(r.path, occupant);
          affected?.add(copy);
          await this.removeLocal(r.path, occupant.hash);
          occupied = false;
          this.note("conflict", r.path);
        }
      }
      const decision = remoteMoveDecision(k, l?.hash, r, occupied);
      if (decision === "blocked") {
        blockedSources.add(from); blockedTargets.add(r.path);
        this.deferredRemoteMoves.set(from, signature);
        if (previousMoves.get(from) === signature || this.data.pathFailures?.[from]?.signature === signature) {
          await notSynced(from, signature, { code: "remote_move_blocked", reason: k.id !== r.id || k.kind !== r.kind ? "identity_mismatch" : "destination_occupied", issues: [{ message: `Destination: ${r.path}` }] });
        } else retryMoves = true;
        continue;
      }
      if (decision === "rename") {
        await this.ensureFolder(this.vaultPath(r.path)); await this.assertMirror();
        if (!l!.f) throw Object.assign(new Error("Waiting for vault index before remote rename"), { code: "vault_index_pending" });
        await this.app.vault.rename(l!.f, this.vaultPath(r.path));
        this.data.paths[r.path] = k;
        this.note("moved", from, { to: r.path, from: "remote" });
        this.log(`remote ${r.kind} move: renamed locally (no download)`);
      }
      delete this.data.pathFailures?.[from];
      delete this.data.paths[from]; await this.persist();
      } catch (e: unknown) {
        blockedSources.add(from); blockedTargets.add(r.path);
        await notSynced(from, signature, e);
      }
    }
    if (refreshRemotes) remotes = await this.remoteAll(affected);
    for (const [p, failure] of Object.entries(this.data.pathFailures ?? {})) if (failure.signature.startsWith("remote-move:") && !blockedSources.has(p)) {
      delete this.data.pathFailures![p]; await this.persist();
    }
    const paths = new Set([...(affected ?? [...Object.keys(this.data.paths), ...remotes.keys()])].filter(p => this.accessiblePath(p) && this.kindOf(p) !== "excluded"));
    if (!affected) for (const p of await this.localPaths()) paths.add(p);
    // Pairing needs hashes, not payloads. Keeping every byte here retained an
    // entire vault (including large attachments) throughout slow network IO.
    const locals = new Map<string, { hash: string; unsupportedEncoding?: boolean }>();
    const unreadable = new Set<string>();
    for (const p of paths) {
      try { const l = await this.local(p); if (l) locals.set(p, { hash: l.hash, unsupportedEncoding: l.unsupportedEncoding }); }
      catch (e: unknown) {
        await this.assertMirror(); unreadable.add(p);
        (this.data.pathFailures ??= Object.create(null) as NonNullable<Data["pathFailures"]>)[p] = { signature: "unreadable", code: errorInfo(e).code ?? "unreadable" };
        await this.persist(); this.log(`read failed: ${JSON.stringify(p)} ${errorInfo(e).code ?? ""}`);
      }
    }
    if (!affected) for (const p of Object.keys(this.data.pathFailures ?? {})) if (!paths.has(p)) { delete this.data.pathFailures![p]; await this.persist(); }
    const missing = Object.entries(this.data.paths).filter(([p]) => paths.has(p) && !blockedSources.has(p) && !blockedTargets.has(p) && !unreadable.has(p) && !locals.has(p)).map(([p, known]) => ({ path: p, known, remote: remotes.get(p) }));
    const added = [...locals].filter(([p, l]) => !blockedSources.has(p) && !blockedTargets.has(p) && !l.unsupportedEncoding && !this.data.paths[p] && !remotes.has(p)).map(([p, l]) => ({ path: p, kind: this.kindOf(p) as ItemKind, hash: l.hash, disk: this.diskIdentity(p) }));
    // A content event can race disk moves whose create/delete watcher has not
    // arrived yet. Topology needs the whole disk for conservative move pairing.
    if (affected && (missing.length || added.length)) return this.reconcileAll(defer, undefined, retryFailed);
    // Moving a note into a folder this device skips is still a move for every
    // other device. Pair those by inode only: skipped files are never hashed.
    const intoSkipped = missing.length && !affected ? (await this.localPaths(true)).filter(p => !this.data.paths[p] && !remotes.has(p)).map(p => ({ path: p, kind: classifyPath(p, this.layout) as ItemKind, hash: "", disk: this.diskIdentity(p) })) : [];
    // A definition's path is its identity: moving one is a delete plus a create.
    for (const pair of localMovePairs(missing.filter(m => m.known.kind !== "resource"), [...added, ...intoSkipped].filter(a => a.kind !== "resource"))) {
      // Recheck disk state after async IO; never move a now-occupied source.
      const skippedTarget = this.skipped(pair.to);
      const signature = `local-move:${JSON.stringify([pair.from, pair.to, locals.get(pair.to)?.hash, remotes.get(pair.from)?.revision])}`;
      if (this.data.pathFailures?.[pair.to]?.signature === signature && !retryFailed) {
        blockedSources.add(pair.from); blockedTargets.add(pair.to); continue;
      }
      try {
        if (await this.local(pair.from) || !(skippedTarget ? await this.host.exists(this.host.join(this.root, pair.to)) : await this.local(pair.to))) continue;
        const moved = await this.moveLocal(pair.from, pair.to, this.data.paths[pair.from], remotes.get(pair.from)!);
        remotes.delete(pair.from);
        if (skippedTarget) { delete this.data.paths[pair.to]; await this.persist(); }
        else remotes.set(pair.to, moved);
        this.log(`external move paired by ${pair.via}`);
      } catch (e) {
        if (isConflict(e)) remotes = await this.remoteAll();
        else {
          blockedSources.add(pair.from); blockedTargets.add(pair.to);
          await notSynced(pair.to, signature, e);
        }
      }
    }
    const pending = this.data.pendingPaths ??= Object.create(null) as NonNullable<Data["pendingPaths"]>;
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
    if (pendingChanged) await this.persist();
    this.scheduleSettle();
    // What happened to one path: its activity line, and its settle deadline.
    const settled = (p: string, outcome: ActivityKind | null) => {
      if (outcome) this.note(outcome, p, outcome === "deleted_remote" ? { from: "here" } : outcome === "deleted_here" ? { from: "remote" } : {});
      if (Object.prototype.hasOwnProperty.call(pending, p)) { delete pending[p]; this.persistSoon(); }
    };
    // Plain note sends (new here, or changed here only) wait until everything
    // else has been handled one at a time, then go several at once.
    const sends: { p: string; signature: string }[] = [];
    // Settings first, then types, then the notes that use them.
    const rank = (p: string) => p === CONFIG_PATH ? 0 : this.kindOf(p) === "resource" ? 1 : 2;
    for (const p of [...paths].sort((a, b) => rank(a) - rank(b))) {
      if (blockedSources.has(p) || (blockedTargets.has(p) && !this.data.paths[p]) || unreadable.has(p) || (defer && pending[p] > Date.now())) continue;
      await this.checkOwnership();
      if (!this.mirroring || this.unloaded) throw new Error("Mirror stopped");
      const l = await this.local(p), r = blockedTargets.has(p) ? undefined : remotes.get(p);
      let k = this.data.paths[p];
      // Over the collection's size limit: neither sent nor fetched, never deleted.
      if ((r?.kind ?? this.kindOf(p)) === "file" && collectionExcludes(p, "file", this.inclusion, l?.bytes.length ?? r?.size)) continue;
      if (l?.unsupportedEncoding) {
        const key = `encoding:${p}:${l.hash}`;
        if (!this.warnedPaths.has(key)) {
          this.warnedPaths.add(key); this.log(`unsupported UTF-8 record skipped: ${JSON.stringify(p)}`);
        }
        const signature = JSON.stringify([l.hash, r?.id, r?.kind, r?.revision]);
        if (this.data.pathFailures?.[p]?.signature !== signature) {
          (this.data.pathFailures ??= Object.create(null) as NonNullable<Data["pathFailures"]>)[p] = { signature, code: "unsupported_encoding" }; await this.persist();
        }
        continue;
      }
      const kind = r?.kind ?? k?.kind ?? this.kindOf(p) as ItemKind;
      // The kind is part of the input: a failure recorded while a path was sent
      // as another kind (an older build sent definitions as notes) is stale.
      const signature = JSON.stringify(kind === "resource" ? [kind, l?.hash, r?.id, r?.kind, r?.revision] : [kind, l?.hash, r?.id, r?.kind, r?.revision, definitions]);
      const failure = this.data.pathFailures?.[p];
      const recovering = Object.values(this.data.conflictCopies ?? {}).some(c => c.path === p) || Object.values(this.data.handledRejections ?? {}).some(h => h.path === p);
      // A durable preservation journal makes replay safe even after the copy's
      // confirmation reply was lost; without it, unknown outcomes stay blocked.
      if (failure && ((failure.unknown && !r && !recovering) || (failure.signature === signature && ((!retryFailed && !recovering) || (failure.unknown && !recovering))))) continue;
      if (this.data.pathFailures?.[p]) { delete this.data.pathFailures[p]; await this.persist(); }
      let outcome: ActivityKind | null = null;
      try {
      const sent = this.data.sending?.[p];
      if (sent !== undefined) {
        // A send cut off by quit or reload. If it landed, that remote version
        // is the baseline: compare the local file against it, not the older one.
        if (r && r.kind !== "file" && r.hash === sent) { this.remember(p, r, sent); k = this.data.paths[p]; }
        delete this.data.sending![p]; await this.persist();
      }
      const decision = reconcileDecision(k, l?.hash, r);
      const outcomes: Partial<Record<typeof decision, ActivityKind>> = { pull: "downloaded", push: "uploaded", deleteRemote: "deleted_remote", deleteLocal: "deleted_here", conflict: "conflict" };
      outcome = outcomes[decision] ?? null;
      if (kind === "resource") {
        if (await this.reconcileDefinition(p, decision, l, r)) definitionsChanged = true;
      } else switch (decision) {
        case "none": if (k && l) this.remember(p, r!, l.hash); break;
        case "remember": this.remember(p, r!, l!.hash); break;
        case "pull": await this.pull(p, r!, l?.hash); break;
        case "push":
          if (kind === "record" && !recovering) { sends.push({ p, signature }); continue; }
          try { await this.push(p, l!, r); }
          catch (e: unknown) { const failure = errorInfo(e);
            if (!isConflict(e)) throw e;
            // Fetch a fresh view after a live revision rejection and use the
            // identical preserve-local/pull-remote rule (no blind retry).
            const fresh = (await this.remoteAll()).get(p);
            await this.conflict(p, await this.local(p), fresh, failure.mutationId ? { mutationId: failure.mutationId, local: l! } : undefined);
            if (this.data.uploads?.[p]) await this.clearUpload(p);
            outcome = "conflict";
          }
          break;
        case "deleteRemote":
          try { await this.call(r!.kind === "record" ? "remove" : "fileDelete", r!.id, r!.revision); delete this.data.paths[p]; await this.persist(); }
          catch (e: unknown) { const failure = errorInfo(e);
            if (!isConflict(e)) throw e;
            const fresh = (await this.remoteAll()).get(p);
            if (fresh) {
              // A delete submitted no local document. Its safe conflict outcome
              // is restoration of the winning remote bytes, not a new copy.
              // Journal that exact proof before IO; a failed pull cannot clear
              // the ledger, and crash recovery still requires confirmed bytes.
              const h = failure.mutationId ? { path: p, hash: fresh.hash!, kind: fresh.kind === "file" ? "file" as const : "record" as const, copy: p, handled: false } : undefined;
              if (h && failure.mutationId) { (this.data.handledRejections ??= {})[failure.mutationId] = h; await this.persist(); }
              await this.pull(p, fresh);
              if (h && fresh.confirmed === true) { h.handled = true; await this.persist(); }
              outcome = "downloaded";
            } else outcome = "deleted_remote";
          }
          break;
        case "deleteLocal": {
          const latest = await this.local(p);
          if (latest && latest.hash !== l?.hash) { await this.conflict(p, latest); outcome = "conflict"; }
          else await this.removeLocal(p, latest?.hash);
          break;
        }
        case "forget": delete this.data.paths[p]; await this.persist(); break;
        case "conflict": await this.conflict(p, l, r); break;
      }
      } catch (e: unknown) { outcome = await notSynced(p, signature, e); }
      settled(p, outcome);
    }
    await this.sendNotes(sends, remotes, settled, notSynced);
    this.scheduleSettle();
    await this.acknowledgeHandled();
    const failed = Object.keys(this.data.pathFailures ?? {});
    // One notice for the pass, only when something newly failed. The Sync tab
    // lists every path and why; the status bar keeps the count.
    const fresh = failed.filter(p => !failedBefore.has(p)).length;
    if (fresh) new Notice(`mdbase: ${fresh === 1 ? "1 file" : `${fresh} files`} couldn't sync. Open Sync to see why.`, 8000);
    if (!affected) this.totals = this.countTotals(remotes);
    if (!blockedSources.size && !failed.length && !Object.keys(this.data.pendingPaths ?? {}).length && !Object.keys(this.data.uploads ?? {}).length) {
      this.lastSynced = Date.now();
      if (this.activityTimer === null) this.activityTimer = window.setTimeout(() => { this.activityTimer = null; void this.writeActivity(); }, 2000);
    }
    this.passStatus(this.phase.sync ? readyText(this.phase.sync) : "Synced");
    // Notes refused under the old definitions get another chance now.
    if (retryMoves || (definitionsChanged && failed.length)) window.setTimeout(() => this.requestReconcile(), 0);
    return failed.length === 0 && blockedSources.size === 0;
  }
  /**
   * Send plain note changes, several at a time. Each send is independent: its
   * own journal entry, its own failure. A send the collection rejects as a
   * conflict waits until the others have finished, then is resolved alone,
   * exactly as when sends went one by one.
   */
  async sendNotes(sends: { p: string; signature: string }[], remotes: Map<string, Remote>, settled: (p: string, outcome: ActivityKind | null) => void, notSynced: (p: string, signature: string, e: unknown) => Promise<ActivityKind>) {
    if (!sends.length) return;
    type Local = NonNullable<Awaited<ReturnType<NativeSync["local"]>>>;
    const conflicts: { p: string; signature: string; e: unknown; l: Local }[] = [];
    let next = 0, done = 0, shown = 0, stop: Error | undefined;
    const sendOne = async ({ p, signature }: { p: string; signature: string }) => {
      let l: Awaited<ReturnType<NativeSync["local"]>>;
      try {
        await this.assertMirror();
        // Read again now rather than hold every note's text in memory. If the
        // file changed meanwhile and is no longer a plain send, a later pass decides.
        l = await this.local(p);
        const r = remotes.get(p);
        if (!l || l.unsupportedEncoding || reconcileDecision(this.data.paths[p], l.hash, r) !== "push") return;
        await this.push(p, l, r);
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
        if (sends.length > 10 && Date.now() - shown > 500) { shown = Date.now(); this.setStatus(`Uploading ${done.toLocaleString()} of ${sends.length.toLocaleString()} notes`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, sends.length) }, worker));
    if (stop) throw stop;
    for (const { p, signature, e, l } of conflicts) {
      let outcome: ActivityKind = "conflict";
      try {
        // A fresh view after the rejection, then the same preserve-local and
        // pull-remote rule as any conflict (no blind retry).
        const fresh = (await this.remoteAll()).get(p);
        await this.conflict(p, await this.local(p), fresh, errorInfo(e).mutationId! ? { mutationId: errorInfo(e).mutationId!, local: l } : undefined);
      } catch (error: unknown) { outcome = await notSynced(p, signature, error); }
      settled(p, outcome);
    }
  }
  countTotals(remotes: Map<string, Remote & { size?: number }>): SyncTotals {
    const t: SyncTotals = { notes: 0, attachments: 0, definitions: 0, attachmentBytes: 0, notHere: 0, byCollection: 0 };
    for (const [p, r] of remotes) {
      if (collectionExcludes(p, r.kind === "file" ? "file" : r.kind, this.inclusion, r.size)) { t.notHere++; t.byCollection++; continue; }
      if (this.skipped(p)) { t.notHere++; continue; }
      if (!this.data.paths[p]) continue;
      if (r.kind === "record") t.notes++;
      else if (r.kind === "resource") t.definitions++;
      else { t.attachments++; t.attachmentBytes += typeof r.size === "number" ? r.size : 0; }
    }
    return t;
  }
  /** Sync one definition. Returns true when the collection's definitions changed. */
  async reconcileDefinition(p: string, decision: ReturnType<typeof reconcileDecision>, l: Awaited<ReturnType<NativeSync["local"]>>, r?: Remote): Promise<boolean> {
    // A conflict copy of a type file would itself be a type, so definitions
    // never get one. The user picks a side in the Sync tab.
    const conflict = () => Object.assign(new Error("Definition changed on both sides"), { code: "conflict", reason: "definition_conflict" });
    const k = this.data.paths[p];
    switch (decision) {
      case "none": if (k && l) this.remember(p, r!, l.hash); return false;
      case "remember": this.remember(p, r!, l!.hash); return false;
      case "forget": delete this.data.paths[p]; await this.persist(); return false;
      case "pull": {
        const latest = await this.local(p);
        if (latest && latest.hash !== k?.hash && latest.hash !== r!.hash) throw conflict();
        await this.put(p, encode(r!.document!), latest?.hash);
        this.remember(p, r!, r!.hash!); return false;
      }
      case "push":
        try { await this.push(p, l!, r); return true; }
        catch (e: unknown) { if (isConflict(e)) throw conflict(); throw e; }
      case "deleteRemote":
        try { await this.call("resourceDelete", p, r!.revision); delete this.data.paths[p]; await this.persist(); return true; }
        catch (e: unknown) { if (isConflict(e)) throw conflict(); throw e; }
      case "deleteLocal": {
        const latest = await this.local(p);
        if (latest && latest.hash !== l?.hash) throw conflict();
        await this.removeLocal(p, latest?.hash); return false;
      }
      case "conflict": throw conflict();
    }
  }
  /** The user's choice for a definition that changed on both sides. */
  async resolveDefinition(p: string, keep: "local" | "remote") {
    await this.enqueue(async () => {
      if (this.kindOf(p) !== "resource") return;
      const r = (await this.remoteAll()).get(p), l = await this.local(p);
      if (keep === "local") {
        if (l) await this.push(p, l, r);
        else if (r) { await this.call("resourceDelete", p, r.revision); delete this.data.paths[p]; await this.persist(); }
      } else {
        // Keep the replaced text where sync never looks, in case it's wanted.
        if (l) {
          this.assertDiskPath(".mdbase/replaced");
          const backup = this.host.join(this.root, ".mdbase", "replaced", `${new Date().toISOString().replace(/[:.]/g, "-")}`, p);
          await this.host.mkdir(this.host.dirname(backup));
          await this.host.writeBytes(backup, l.bytes);
          this.log(`definition replaced; previous text kept in .mdbase/replaced`);
        }
        if (r) { await this.put(p, encode(r.document!), l?.hash); this.remember(p, r, r.hash!); }
        else if (l) await this.removeLocal(p, l.hash);
      }
      delete this.data.pathFailures?.[p]; await this.persist();
      await this.reconcileAll(false, undefined, true);
    });
  }
  async ensureFolder(vp: string) {
    const dir = vp.split("/").slice(0, -1).join("/");
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      try { await this.app.vault.createFolder(dir); }
      catch (e) { if (!await this.app.vault.adapter.exists(dir)) throw e; }
    }
  }
  assertActive() {
    if (this.unloaded || !this.mirroring) throw new Error("Mirror stopped");
  }
  publicationGuard(p: string, expectedHash?: string) {
    this.assertActive(); this.assertDiskPath(p);
    if (this.editorViews(p).some(view => hash(encode(view.getViewData())) !== expectedHash))
      throw Object.assign(new Error("Local editor changed before publication; retained"), { code: "local_changed" });
  }
  async assertMirror() {
    if (!this.mirroring || this.unloaded) throw new Error("Mirror stopped");
    await this.checkOwnership();
  }
  async put(p: string, bytes: Uint8Array, expectedHash?: string) {
    await this.assertMirror(); this.assertDiskPath(p);
    const vp = this.vaultPath(p), f = this.app.vault.getAbstractFileByPath(vp);
    if (f && !(f instanceof TFile)) throw new Error("Folder collides with remote file");
    const initial = await this.local(p), nextHash = hash(bytes);
    const changed = () => Object.assign(new Error("Local file changed during download; retry preservation"), { code: "local_changed" });
    if (arguments.length > 2 && initial?.hash !== expectedHash && initial?.hash !== nextHash) throw changed();
    if (initial?.hash === nextHash) return;
    if (initial?.unsupportedEncoding) throw Object.assign(new Error("Invalid UTF-8 disk bytes retained"), { code: "unsupported_encoding" });
    const applyEditors = async () => {
      await this.assertMirror();
      const editors = p.endsWith(".md") ? this.editorViews(p) : [];
      if (!editors.length) return undefined;
      const text = decode(bytes);
      if (!validUtf8(bytes)) throw Object.assign(new Error("Invalid UTF-8 cannot enter editor"), { code: "unsupported_encoding" });
      // No await between this buffer recheck and setValue: newer typing must
      // enter preservation, never be clobbered by atomic disk publication.
      if (editors.some(v => hash(encode(v.getViewData())) !== initial?.hash)) throw changed();
      this.assertDiskPath(p);
      for (const view of editors) if (view.getViewData() !== text) view.editor.setValue(text);
      await Promise.all(editors.map(view => view.save()));
      return true;
    };
    this.writingPaths.add(p);
    try {
      if (await applyEditors()) return;
      await this.ensureFolder(vp); await this.assertMirror(); this.assertDiskPath(p);
      const incoming = this.host.join(this.root, ".mdbase", "incoming");
      this.assertDiskPath(".mdbase/incoming"); await this.host.mkdir(incoming);
      const temp = this.host.join(incoming, this.host.uuid() + ".tmp");
      try {
        await this.host.writeBytes(temp, bytes, true);
        await this.assertMirror(); this.assertDiskPath(p);
        const current = await this.local(p);
        if (current?.hash !== initial?.hash) throw changed();
        if (await applyEditors()) return;
        await this.host.publish(temp, this.host.join(this.root, vp), initial?.hash, nextHash, () => this.checkOwnership(), () => this.publicationGuard(p, initial?.hash));
      } finally { if (await this.host.exists(temp)) await this.host.remove(temp); }
    } finally { this.writingPaths.delete(p); }
  }
  async pull(p: string, r: Remote, expectedHash = this.data.paths[p]?.hash): Promise<void> {
    if (r.kind === "file") return this.pullFile(p, r, expectedHash);
    const bytes = encode(r.document!);
    const latest = await this.local(p);
    if (latest && latest.hash !== expectedHash && latest.hash !== hash(bytes)) {
      await this.preserveConflict(p, latest);
      // Upload confirmation may take a while. If the user edited again during
      // it, take another snapshot rather than overwrite that newer local edit.
      return this.pull(p, r, latest.hash);
    }
    try { await this.put(p, bytes, latest?.hash); }
    catch (e: unknown) { if (errorInfo(e).code === "local_changed") return this.pull(p, r, latest?.hash); throw e; }
    this.remember(p, r, hash(bytes));
  }
  async push(p: string, l: NonNullable<Awaited<ReturnType<NativeSync["local"]>>>, r?: Remote) {
    await this.assertMirror();
    const kind = this.kindOf(p);
    if (kind === "excluded") throw new Error("Excluded path is never sent");
    if (r && r.kind !== kind) throw new Error("Remote item kind differs from extension; manual resolution required");
    let next: WireItem;
    if (kind !== "file") {
      const doc = decode(l.bytes);
      if (!validUtf8(l.bytes)) throw Object.assign(new Error("Text is not valid UTF-8; local bytes retained"), { code: "unsupported_encoding" });
      // Base is the replica's current exact document, not a stale cached body.
      (this.data.sending ??= Object.create(null) as NonNullable<Data["sending"]>)[p] = l.hash; await this.durable();
      await this.assertMirror();
      try {
        next = kind === "resource"
          ? await this.call("resourcePut", p, doc, r?.revision)
          : r ? await this.call("replace", r.id, { path: r.path, doc: r.document! }, { path: p, doc }, r.revision) : await this.call("create", p, doc);
      } catch (e: unknown) {
        // A definite refusal or conflict means the text didn't land.
        if (isRefusal(e) || isConflict(e)) { delete this.data.sending[p]; await this.persist(); }
        throw e;
      }
      delete this.data.sending[p]; // remember() below persists
    } else {
      const uploads = this.data.uploads ??= Object.create(null) as NonNullable<Data["uploads"]>;
      if (!uploads[p]) {
        const identity = { transferId: this.host.uuid(), mutationId: this.host.uuid(), hash: l.hash, fileId: r?.id, revision: r?.revision };
        this.assertDiskPath(".mdbase/uploads");
        await this.host.mkdir(this.host.join(this.root, ".mdbase/uploads"));
        await this.host.writeBytes(this.uploadPath(identity.transferId), l.bytes, true);
        uploads[p] = identity; await this.persist(); // bytes and identity precede the first send
      }
      try { next = await this.finishUpload(p); }
      catch (e: unknown) { if (isRefusal(e)) await this.clearUpload(p); throw e; }
    }
    // Only identity and revision are kept; a note's reply may omit its text.
    this.remember(p, this.remote(next, kind), l.hash);
    this.log(`pushed ${kind} (${l.bytes.length} bytes)${"via" in next && next.via ? ` via ${next.via}` : ""}`);
  }
  uploadPath(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid upload identity");
    this.assertDiskPath(`.mdbase/uploads/${id}`);
    return this.host.join(this.root, ".mdbase/uploads", id);
  }
  async finishUpload(p: string) {
    const intent = this.data.uploads![p];
    const bytes = await this.host.readBytes(this.uploadPath(intent.transferId));
    if (hash(bytes) !== intent.hash) throw new Error("Upload recovery bytes differ; stopped");
    const next = await retryUpload(() => this.call("upload", p, bytes, intent.fileId, intent.revision, intent));
    this.remember(p, this.remote(next, "file"), intent.hash);
    await this.clearUpload(p);
    return next;
  }
  async clearUpload(p: string) {
    const intent = this.data.uploads?.[p]; if (!intent) return;
    delete this.data.uploads![p]; await this.persist();
    await this.host.remove(this.uploadPath(intent.transferId));
    await this.call("uploadForget", intent.transferId);
  }
  async resumeUploads() {
    for (const p of Object.keys(this.data.uploads ?? {})) {
      await this.assertMirror();
      // An upload saved before this path was known to be a note, a definition
      // or excluded was never accepted. Drop the saved copy; the vault file is
      // untouched and the path pass sends it the right way (or not at all).
      if (this.kindOf(p) !== "file") { this.log(`dropped upload for non-file path ${JSON.stringify(p)}`); await this.clearUpload(p); continue; }
      try { await this.finishUpload(p); }
      catch (e: unknown) { const failure = errorInfo(e);
        // Refused outright: resending the same bytes can't succeed. The path
        // pass resends only if they change, and records why in the Sync tab.
        if (isRefusal(e)) { this.log(`upload refused for ${JSON.stringify(p)}: ${failure.code}`); await this.clearUpload(p); continue; }
        if (!isConflict(e) || !failure.mutationId) throw e;
        const intent = this.data.uploads![p];
        const bytes = await this.host.readBytes(this.uploadPath(intent.transferId));
        const submitted = { bytes, hash: intent.hash, f: undefined, unsupportedEncoding: false };
        await this.conflict(p, await this.local(p), (await this.remoteAll()).get(p), { mutationId: failure.mutationId, local: submitted });
        await this.clearUpload(p);
      }
    }
  }
  async pullFile(p: string, r: Remote, expectedHash?: string) {
    await this.assertMirror(); this.assertDiskPath(".mdbase/incoming");
    const token = await this.call("downloadOpen", r.id);
    await this.host.stageDownload({
      directory: this.host.join(this.root, ".mdbase/incoming"), digest: r.digest!,
      next: () => this.call("downloadNext", token),
      close: async () => { await this.call("downloadClose", token); },
      publish: async staged => {
        const latest = await this.local(p);
        if (latest && latest.hash !== expectedHash && latest.hash !== r.digest) await this.preserveConflict(p, latest);
        const current = await this.local(p);
        if (current?.hash !== latest?.hash) throw new Error("Local file changed during download; retained");
        await this.ensureFolder(this.vaultPath(p));
        await this.assertMirror(); this.assertDiskPath(p);
        await this.host.publish(staged, this.host.join(this.root, p), current?.hash, r.digest!, () => this.checkOwnership(), () => this.publicationGuard(p, current?.hash));
        this.remember(p, r, r.digest!);
      },
    });
  }
  async removeLocal(p: string, expectedHash?: string) {
    await this.assertMirror(); this.assertDiskPath(p);
    const latest = await this.local(p);
    if (arguments.length > 1 && latest?.hash !== expectedHash) throw Object.assign(new Error("Local file changed before delete; bytes retained"), { code: "local_changed" });
    this.writingPaths.add(p);
    try {
    try {
      const current = await this.host.hash(await this.host.readBytes(this.host.join(this.root, this.vaultPath(p))));
      if (arguments.length > 1 && current !== expectedHash) throw Object.assign(new Error("Local file changed before delete; bytes retained"), { code: "local_changed" });
      await this.assertMirror(); this.assertDiskPath(p);
      await this.host.remove(this.host.join(this.root, p));
    } catch (e: unknown) { if (errorInfo(e).code !== "ENOENT") throw e; }
    delete this.data.paths[p]; await this.persist();
    } finally { this.writingPaths.delete(p); }
  }
  async preserveConflict(p: string, l: NonNullable<Awaited<ReturnType<NativeSync["local"]>>>, mutationId?: string) {
    const kind = this.kindOf(p) === "record" ? "record" : "file";
    const key = JSON.stringify([p, l.hash]);
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
    await this.persist(); // before local IO and remote publication, not only CAS rejections
    await this.put(copy, l.bytes);
    if (remote && remote.confirmed !== true)
      throw Object.assign(new Error("Conflict copy awaiting confirmation; local state retained"), { code: "outcome_unknown" });
    // A crash after confirmation but before replacing the original must not
    // publish another conflict item. Otherwise retry the same saved copy path.
    if (!remote) await this.push(copy, l);
    else this.remember(copy, remote, l.hash);
    if (mutationId) {
      this.data.handledRejections![mutationId].handled = true; await this.persist();
    }
    return copy;
  }
  async keepConflictCopies(copyPath: string) {
    await this.enqueue(async () => {
      await this.assertMirror();
      const remotes = await this.remoteAll();
      for (const [key, copy] of Object.entries(this.data.conflictCopies ?? {})) if (copy.copy === copyPath) {
        const remote = remotes.get(copy.copy), local = await this.local(copy.copy);
        const original = remotes.get(copy.path), current = await this.local(copy.path);
        if (remote?.confirmed !== true || remote.hash !== copy.hash || local?.hash !== copy.hash || !this.data.paths[copy.path] || original?.confirmed !== true || !current || original.hash !== current.hash) {
          new Notice("mdbase: both files must finish syncing before keeping them."); return;
        }
        delete this.data.conflictCopies![key];
      }
      await this.persist(); this.setStatus(this.statusText);
    });
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
    const discard = (entry: typeof entries[number]) => {
      void this.enqueue(async () => {
        const ok = await this.call("acknowledge", entry.mutationId);
        delete this.data.handledRejections?.[entry.mutationId]; await this.persist();
        this.log(`rejected write discarded by user: mutationId=${entry.mutationId} problem=${entry.code} ok=${ok}`);
        new Notice(ok ? "mdbase: rejected write discarded" : "mdbase: discard failed");
      }).catch(error => this.fail("discard rejected", error));
    };
    new (class extends SuggestModal<typeof entries[number]> {
      getSuggestions(q: string) { return entries.filter(e => label(e).toLowerCase().includes(q.toLowerCase())); }
      renderSuggestion(e: typeof entries[number], el: HTMLElement) { el.setText(`Discard: ${label(e)}`); }
      onChooseSuggestion(e: typeof entries[number]) { discard(e); }
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
      if (!h || (!h.handled && !(copy && copy.kind === h.kind && copy.confirmed === true && copy.hash === h.hash && local?.hash === h.hash))) {
        if (explicit) this.log(`rejected write retained: mutationId=${e.mutationId}; preservation unproven`);
        continue;
      }
      h.handled = true; await this.persist(); // survives an acknowledgement failure/crash
      if (await this.call("acknowledge", e.mutationId)) {
        this.log(`handled rejection acknowledged: mutationId=${e.mutationId} path=${JSON.stringify(h.path)} problem=${e.code}`);
        delete this.data.handledRejections![e.mutationId]; await this.persist();
      }
    }
    // If a crash happened after SDK acknowledgement but before sync-state.json commit,
    // repeating acknowledgement is harmless; never touch an unrelated entry.
    for (const [id, h] of Object.entries(this.data.handledRejections ?? {})) {
      if (h.handled && !entries.some(e => e.mutationId === id) && await this.call("acknowledge", id)) {
        delete this.data.handledRejections![id]; await this.persist();
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
    await this.persist();
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
    // The config decides what is a note, a definition or excluded: rescan.
    this.requestReconcile(p === CONFIG_PATH ? undefined : this.writingPaths.has(p) ? [p] : topology || !this.data.paths[p] ? undefined : [p]);
  }
  async renameLocal(f: TAbstractFile, old: string) {
    const from0 = this.collectionPath(old), k0 = from0 ? this.data.paths[from0] : undefined;
    // Moved into a folder this device skips: still a move for every other device.
    if (from0 && k0 && f instanceof TFile && this.validPath(f.path) && this.skipped(f.path) && k0.kind !== "resource") {
      const r = (await this.remoteAll()).get(from0);
      if (r && r.id === k0.id && r.revision === k0.revision && r.kind === classifyPath(f.path, this.layout)) {
        try { await this.moveLocal(from0, f.path, k0, r); delete this.data.paths[f.path]; await this.persist(); }
        catch (e) { if (!isConflict(e)) throw e; }
      }
      return this.reconcileAll(true);
    }
    const p = this.collectionPath(f.path), from = this.collectionPath(old), k = from ? this.data.paths[from] : undefined;
    if (p && from && k && f instanceof TFile && !this.data.paths[p]) {
      const r = (await this.remoteAll()).get(from), l = await this.local(p);
      if (r && l && r.id === k.id && r.revision === k.revision && r.kind !== "resource" && this.kindOf(p) === r.kind) {
        try {
          await this.moveLocal(from, p, k, r);
        } catch (e) { if (!isConflict(e)) throw e; }
      }
    }
    await this.reconcileAll(true);
  }

  setStatus(text: string) { this.statusText = text; this.changed(text, this.stalled && this.phase.kind === "starting" ? { ...this.phase, stalled: true } : this.phase, this.view()); }
  /**
   * Progress from a pass. A pass still running when sync stops (access removed,
   * say) must not put "Synced" back over the words saying why; its counts still go out.
   */
  passStatus(text: string) { this.setStatus(this.phase.kind === "ready" ? text : this.statusText); }
  view(): NativeView {
    const failures = Object.entries(this.data?.pathFailures ?? {}).map(([p, f]) => ({ path: p, ...describeFailure({ ...f, kind: this.data.paths[p]?.kind }) }));
    const conflicts = Object.values(this.data?.conflictCopies ?? {}).map(({ path, copy }) => ({ path, copy }));
    return { failures: failures.sort((a, b) => a.path.localeCompare(b.path)), conflicts, merge: this.merge, activity: this.activity, lastSynced: this.lastSynced, totals: this.totals, device: this.device, inclusion: this.inclusion ?? null, bound: !!this.data?.collectionId };
  }
  safeText(text: string) { return String(text).replace(/https?:\/\/[^\s"<>]+/g, value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return "[url]"; } }); }
  log(text: string) {
    const line = `${new Date().toISOString()} ${text}`;
    console.debug("[mdbase]", line);
  }
  /** `whole`: `userMessage` is already the full status sentence (a stop the sync engine explained). */
  fail(what: string, e: unknown, userMessage?: string, whole = false) {
    // Calls cut off by our own unload are not failures; the next start resumes.
    if (this.unloaded) { this.log(`stopped during ${what} (plugin unloading)`); return; }
    // Do not log arbitrary mutation error bodies: they can contain documents.
    const detail = [errorInfo(e).code, errorInfo(e).reason].filter(Boolean).join(" ") || (what === "startup" || what === "ownership" || what === "start" ? this.safeText(errorInfo(e).message ?? "error") : "operation failed; local state retained");
    if (errorInfo(e).code === "collection_bound") userMessage = "This folder is already bound to a collection. Use a separate vault for another collection; this vault cannot be rebound while syncing.";
    if (what === "ownership" && !userMessage) userMessage = "Another app may be syncing this folder, so Obsidian is waiting. Your files here are untouched.";
    // Plain words for the status; the code stays for support, and the log keeps the detail.
    const code = [errorInfo(e).code, errorInfo(e).reason].filter(Boolean).join(" ");
    const reason = userMessage ?? (what === "startup" || what === "start" ? detail : `Something went wrong${code ? ` (${code})` : ""}. Your files here are untouched`);
    this.setStatus(whole && userMessage ? userMessage : failedText(reason));
    this.log(`FAILED ${what}: ${detail}`); new Notice(`mdbase: ${userMessage ?? `${what}: ${detail}`}`, 10000);
  }
}
