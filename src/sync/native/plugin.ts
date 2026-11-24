import { t } from "@lingui/core/macro";
// Native SDK host ported from the verified Obsidian SDK spike. The iframe owns the replica; all
// vault IO and durable three-way sync state live here. No page/ runtime files.
import { Notice, Component, TAbstractFile, TFile, App, Platform, parseYaml, type MarkdownView, type PluginManifest } from "obsidian";
import { errorInfo, isObject, type NativeMethod, type NativeMethods, type NativeResult, type NativePhase, type PageMessage } from "./protocol";
import { DesktopHost } from "./desktop";
import { MobileHost } from "./mobile";
import type { EngineHost } from "./host";
import { encode, hash, validUtf8 } from "./encoding";
import { STARTING_STALLED, failedText, type SignOutResult } from "../words";
import type { Synced, reconcileDecision } from "./reconcile";
import { classifyPath, layoutFromConfig, CONFIG_PATH, DEFAULT_LAYOUT, type CollectionLayout, type PathKind } from "./classify";
import { NO_FILTER, collectionExcludes, normalizeFolder, recordActivity, skippedHere, validActivity, validFilter, validInclusion, type ActivityEntry, type ActivityKind, type CollectionInclusion, type DeviceFilter } from "./device";
import { describeFailure } from "./failures";
import { readSyncState, type SyncState } from "./journal";
import * as marker from "./marker";
import * as session from "./session";
import * as transfers from "./transfers";
import * as conflicts from "./conflicts";
import * as pass from "./pass";

export type ItemKind = Synced["kind"];
/** One path that didn't sync, for the Sync tab. */
export interface DirectFailure { path: string; title: string; detail: string; choose?: boolean }
/** Before the first sync of a vault that has notes into a collection that has items. */
export interface MergePrompt { collectionId: string; name: string; local: number; remote: number }
export interface SyncTotals { notes: number; attachments: number; definitions: number; attachmentBytes: number; notHere: number; byCollection: number }
export interface NativeView {
  statusKind?: "busy" | "problem";
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
export type WireItem = NativeResult<"fileGet"> | NativeResult<"replace"> | NativeResult<"resourcePut">;
export interface Remote { id: string; path: string; kind: ItemKind; revision: string; hash?: string; document?: string; digest?: string; size?: number; confirmed?: boolean }
/** A file as read here: its bytes and their hash. */
export type LocalFile = NonNullable<Awaited<ReturnType<NativeSync["local"]>>>;
/** Status while another device's writes keep invalidating a full scan. Matches words.ts' busy test. */

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
  data!: SyncState;
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
  statusKind: "busy" | "problem" | undefined;
  activity: ActivityEntry[] = [];
  lastSynced: number | null = null;
  totals: SyncTotals | null = null;
  /** After Choose another collection or Sign out, the next list is the person's to pick from. */
  pickManually = false;
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
    this.setStatus(t`Starting sync`);
    this.pluginDir = this.host.pluginDir;
    this.root = this.host.root;
    // Obsidian's loadData returns null after a JSON parse failure. Treating that
    // as first install destroys the only durable sync/rejection journal.
    try {
      this.data = await this.readData();
      const fresh = this.takeOverFrom?.fresh === true;
      if (fresh) this.takeOverFrom = null;
      this.bindVault(fresh);
      this.data.paths = Object.assign(Object.create(null) as SyncState["paths"], this.data.paths);
      this.data.pathFailures = Object.assign(Object.create(null) as NonNullable<SyncState["pathFailures"]>, this.data.pathFailures);
      await this.readActivity();
      if (!this.data.collectionId && this.previousCollection) this.data.collectionId = this.previousCollection;
      if (this.takeOverFrom) { const seen = this.takeOverFrom.marker; this.takeOverFrom = null; await marker.takeOver(this, seen); }
      else if (fresh) {
        // The person chose Set up sync here. A marker copied in with the settings
        // is replaced if it looks like an earlier install's; a live one still blocks.
        const text = await marker.readMarkerText(this);
        if (text !== null && marker.classify(text, this)[1]) await marker.takeOver(this, text);
      }
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
    } catch (e) {
      this.closeServer();
      if (e instanceof marker.FolderOwned) { this.blockForOwner(e); return; }
      if (errorInfo(e).code === "platform_unsupported") { this.phase = { kind: "unsupported" }; this.setStatus(errorInfo(e).message ?? ""); return; }
      this.phase = { kind: "blocked" }; this.fail("startup", e); return;
    }
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
      () => { for (const t of [this.markerTimer, this.blockTimer]) if (t !== null) window.clearInterval(t); },
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
    this.markerTimer = this.blockTimer = this.settleTimer = this.reconcileRetryTimer = this.stallTimer = this.activityTimer = null;
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
  /**
   * sync-state.json names the vault it belongs to, so a copy never shares
   * another vault's replica storage. When it names another place:
   *  - the old folder is gone from this device: the vault was moved or
   *    renamed, and everything carries on;
   *  - nothing was set up to sync: start this vault afresh, silently;
   *  - set up to sync: stop, and start afresh only when the person chooses
   *    Set up sync here (`fresh`). Notes on disk are never touched; the next
   *    collection's first pass compares every file again.
   * A fresh start keeps only this device's file choices, under a new vault id.
   */
  bindVault(fresh = false) {
    const location = this.host.location();
    const was = this.data.vaultLocation;
    if (was !== undefined && was !== location && !this.host.movedFrom?.(was)) {
      if (this.setUp && !fresh) throw new marker.FolderOwned("copied", true, null);
      const { device } = this.data;
      this.data = { version: 1, vaultId: this.host.uuid(), paths: {}, ...(device === undefined ? {} : { device }) };
      this.log("sync settings came from another vault: starting this vault afresh");
    }
    this.data.vaultLocation = location;
  }
  readData(): Promise<SyncState> { return readSyncState(this.host, this.pluginDir, p => this.validPath(p)); }
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

  // ---- ownership: .mdbase is private, never a mirrored collection path (marker.ts) ----
  get markerPath() { return this.host.join(this.root, ".mdbase", "host.json"); }
  readMarker(): Promise<unknown> { return marker.readMarker(this); }
  ownsMarker(m?: unknown) { return marker.ownsMarker(this, m); }
  markerMatches(m: unknown) { return marker.markerMatches(this, m); }
  checkOwnership() { return marker.checkOwnership(this); }
  claim(id?: string) { return marker.claim(this, id); }
  writeMarker() { return marker.writeMarker(this); }
  pauseForOwnership(e: unknown) { marker.pauseForOwnership(this, e); }
  /** The marker text startup found, for Set up sync here to check it is still the same. */
  blockedMarker: string | null = null;
  blockTimer: number | null = null;
  /** Set up to sync: bound to a collection, or anything already synced. */
  get setUp(): boolean { return !!this.data?.collectionId || this.data?.cursor !== undefined || Object.keys(this.data?.paths ?? {}).length > 0; }
  /**
   * Startup found the folder held by someone else. A vault that isn't set up
   * to sync says so only in the Sync tab: a fresh install gets no notice. While
   * blocked, the marker is read again now and then, so Set up sync here
   * appears once a quiet plugin marker grows stale.
   */
  blockForOwner(e: marker.FolderOwned) {
    this.blockedMarker = e.marker;
    this.phase = { kind: "blocked", owner: e.owner, takeover: e.takeover };
    this.log(`folder held elsewhere: owner=${e.owner} takeover=${e.takeover}`);
    if (this.setUp) this.fail("ownership", e, e.message, true);
    else this.setStatus(e.message);
    if (this.blockTimer === null && !this.unloaded) this.blockTimer = window.setInterval(() => { void this.recheckBlock(); }, 15_000);
  }
  async recheckBlock() {
    // Copied settings don't change by waiting; only Set up sync here helps.
    if (this.unloaded || this.phase.kind !== "blocked" || !this.phase.owner || this.phase.owner === "copied") return;
    let next: marker.FolderOwned;
    try {
      const text = await marker.readMarkerText(this);
      // Gone: no one holds it now, and setting up here takes nothing from anyone.
      next = text === null ? new marker.FolderOwned("unknown", true, null) : new marker.FolderOwned(...marker.classify(text, this));
    } catch (e: unknown) { next = e instanceof marker.FolderOwned ? e : new marker.FolderOwned("unreadable", false, null); }
    if (next.owner === this.phase.owner && next.takeover === this.phase.takeover && next.marker === this.blockedMarker) return;
    this.blockedMarker = next.marker;
    this.phase = { kind: "blocked", owner: next.owner, takeover: next.takeover };
    this.setStatus(next.takeover && next.marker === null ? t`Sync isn't set up in this vault.` : next.message);
  }
  /**
   * Set up sync here: the person chose it on the blocked host, and the
   * controller handed this new host the marker text that was offered. Startup
   * replaces that marker (if it's still the same) before its usual check.
   */
  takeOverFrom: { marker: string | null; fresh?: boolean } | null = null;

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
    if (e.source !== this.frame?.contentWindow || !e.data) return;
    const opaqueCapacitorHello = this.origin.startsWith("capacitor:") && e.origin === "null"
      && e.data.type === "hello" && e.data.capability === this.frameCapability;
    if (e.origin !== this.origin && !opaqueCapacitorHello) return;
    const m = e.data;
    switch (m.type) {
      case "hello": {
        if (this.bridge) return;
        const channel = new MessageChannel(); this.bridge = channel.port1;
        channel.port1.onmessage = (event: MessageEvent<PageMessage>) => this.onMessage({ origin: this.origin, source: this.frame!.contentWindow, data: event.data });
        this.frame.contentWindow!.postMessage({ type: "connect" }, opaqueCapacitorHello ? "*" : this.origin, [channel.port2]);
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
        if (this.mirroring && Number.isFinite(m.done) && Number.isFinite(m.total) && m.total > 0) {
          const percent = Math.min(100, Math.round(100 * m.done / m.total));
          const size = Math.round(m.total / 1024 / 1024);
          this.setStatus(m.direction === "upload" ? t`uploading ${percent}% (${size} MiB)` : t`downloading ${percent}% (${size} MiB)`, "busy");
        }
        break;
      case "log": this.log(this.safeText(m.text)); break;
      case "result": {
        const c = this.calls.get(m.id); if (!c) return;
        this.calls.delete(m.id); window.clearTimeout(c.timer);
        if (m.ok) c.resolve(m.value); else c.reject(Object.assign(new Error(m.error.message), m.error)); break;
      }
    }
  }

  // ---- phases, sign-in and collection choice (session.ts) ------------------
  onPhase(phase: NativePhase) { return session.onPhase(this, phase); }
  select(id: string) { return session.select(this, id); }
  addCollection() { return session.addCollection(this); }
  needsMergeConfirmation(phase: NativePhase): Promise<boolean> { return session.needsMergeConfirmation(this, phase); }
  unlock(secret: { password: string } | { recoveryKey: string }) { return session.unlock(this, secret); }
  recheckLock() { return session.recheckLock(this); }
  confirmMerge() { return session.confirmMerge(this); }
  get canChooseAnother(): boolean { return session.canChooseAnother(this); }
  chooseAnother() { return session.chooseAnother(this); }
  choose() { session.choose(this); }
  signIn() { return session.signIn(this); }
  openSignIn(url: string) { session.openSignIn(this, url); }
  requestAccess() { return session.requestAccess(this); }
  retry() { return session.retry(this); }
  get canStartOver(): boolean { return session.canStartOver(this); }
  startOver() { return session.startOver(this); }
  signOut() { return session.signOut(this); }
  reportSignOut(result: SignOutResult | null | undefined) { session.reportSignOut(this, result); }
  get canChooseAgain(): boolean { return session.canChooseAgain(this); }
  chooseAgain() { return session.chooseAgain(this); }
  releaseCollection() { return session.releaseCollection(this); }
  handover() { return session.handover(this); }
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
    this.setStatus(t`Checking your files`, "busy");
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
      this.setStatus(STARTING_STALLED());
    }, this.stallMs);
  }
  endStartWatch() {
    if (this.stallTimer !== null) window.clearTimeout(this.stallTimer);
    this.stallTimer = null; this.stalled = false;
  }

  // ---- durable three-way reconciliation ------------------------------------
  /** True while this vault syncs to a collection whose create path runs lifecycle.on_create. */
  ownsCreateLifecycle(): boolean {
    return !this.unloaded && (this.mirroring || Boolean(this.data?.collectionId));
  }
  /** True when a new note at `vaultPath` can be created directly through the synced collection. */
  canCreateRecord(vaultPath: string): boolean {
    if (!this.mirroring || this.unloaded || !this.admitting || this.phase.sync?.connection === "offline") return false;
    const p = this.collectionPath(vaultPath);
    return p !== null && this.kindOf(p) === "record";
  }
  /**
   * Create a record through the collection first so lifecycle.on_create runs
   * once (including guarded actions), then write the authoritative document
   * into the vault and remember it in the sync journal.
   */
  async createRecord(
    vaultPath: string,
    doc: string,
    writeFile: (path: string, content: string) => Promise<TFile>,
  ): Promise<TFile | null> {
    if (!this.canCreateRecord(vaultPath)) return null;
    const run = this.jobs.then(async (): Promise<TFile | null> => {
      if (!this.canCreateRecord(vaultPath)) return null;
      const p = this.collectionPath(vaultPath);
      if (!p) return null;
      await this.assertMirror();
      if (this.app.vault.getAbstractFileByPath(vaultPath) || await this.host.exists(this.host.join(this.root, vaultPath))) {
        return null;
      }
      const submittedHash = hash(encode(doc));
      let next = await this.call("create", p, doc);
      let remote = this.remote(next, "record");
      if (typeof remote.document !== "string" && remote.revision.startsWith("sha256:") && remote.revision !== submittedHash) {
        next = await this.call("get", remote.id);
        remote = this.remote(next, "record");
      }
      const finalPath = remote.path && this.validPath(remote.path) ? this.vaultPath(remote.path) : vaultPath;
      const finalCollectionPath = this.collectionPath(finalPath) ?? p;
      const authoritative = typeof remote.document === "string" ? remote.document : doc;
      this.writingPaths.add(finalCollectionPath);
      try {
        const file = await writeFile(finalPath, authoritative);
        this.remember(finalCollectionPath, remote, hash(encode(authoritative)));
        await this.flush();
        this.note("uploaded", finalCollectionPath);
        this.log(`created record (${encode(authoritative).length} bytes)${"via" in next && next.via ? ` via ${next.via}` : ""}`);
        return file;
      } finally {
        this.writingPaths.delete(finalCollectionPath);
      }
    });
    this.jobs = run.catch(() => {});
    return run;
  }
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
    this.setStatus(this.statusText, this.statusKind);
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
        new Notice(t`mdbase: a symlink in the mirror was skipped. Its target will not be read or changed.`, 10000);
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
            new Notice(t`mdbase: a non-nfc filename cannot sync. Rename it to unicode nfc; existing files were not changed.`, 10000);
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
  moveLocal(from: string, to: string, k: Synced, r: Remote) { return transfers.moveLocal(this, from, to, k, r); }
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
      this.syncingFiles = true; this.passStatus(t`Checking your files`, "busy");
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
          this.passStatus(t`Checking your files: catching up with changes from other devices`, "busy");
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
  reconcilePass(defer: boolean, affected: Set<string> | undefined, retryFailed: boolean): Promise<boolean | undefined> { return pass.reconcilePass(this, defer, affected, retryFailed); }
  sendNotes(sends: { p: string; signature: string }[], remotes: Map<string, Remote>, settled: (p: string, outcome: ActivityKind | null) => void, notSynced: (p: string, signature: string, e: unknown) => Promise<ActivityKind>) { return pass.sendNotes(this, sends, remotes, settled, notSynced); }
  countTotals(remotes: Map<string, Remote & { size?: number }>): SyncTotals { return pass.countTotals(this, remotes); }
  reconcileDefinition(p: string, decision: ReturnType<typeof reconcileDecision>, l: LocalFile | undefined, r?: Remote): Promise<boolean> { return pass.reconcileDefinition(this, p, decision, l, r); }
  resolveDefinition(p: string, keep: "local" | "remote") { return pass.resolveDefinition(this, p, keep); }

  // ---- moving bytes (transfers.ts) and keeping both sides (conflicts.ts) ----
  ensureFolder(vp: string) { return transfers.ensureFolder(this, vp); }
  assertActive() {
    if (this.unloaded || !this.mirroring) throw new Error("Mirror stopped");
  }
  publicationGuard(p: string, expectedHash?: string) { transfers.publicationGuard(this, p, expectedHash); }
  async assertMirror() {
    if (!this.mirroring || this.unloaded) throw new Error("Mirror stopped");
    await this.checkOwnership();
  }
  put(p: string, bytes: Uint8Array, ...expected: [expectedHash?: string]) { return transfers.put(this, p, bytes, ...expected); }
  pull(p: string, r: Remote, expectedHash?: string): Promise<void> { return transfers.pull(this, p, r, expectedHash); }
  push(p: string, l: LocalFile, r?: Remote) { return transfers.push(this, p, l, r); }
  uploadPath(id: string) { return transfers.uploadPath(this, id); }
  finishUpload(p: string) { return transfers.finishUpload(this, p); }
  clearUpload(p: string) { return transfers.clearUpload(this, p); }
  resumeUploads() { return transfers.resumeUploads(this); }
  pullFile(p: string, r: Remote, expectedHash?: string) { return transfers.pullFile(this, p, r, expectedHash); }
  removeLocal(p: string, ...expected: [expectedHash?: string]) { return transfers.removeLocal(this, p, ...expected); }
  preserveConflict(p: string, l: LocalFile, mutationId?: string) { return conflicts.preserveConflict(this, p, l, mutationId); }
  keepConflictCopies(copyPath: string) { return conflicts.keepConflictCopies(this, copyPath); }
  discardRejected() { return conflicts.discardRejected(this); }
  acknowledgeHandled(explicit = false, remotes?: Map<string, Remote>) { return conflicts.acknowledgeHandled(this, explicit, remotes); }
  conflict(p: string, l: LocalFile | undefined, r?: Remote, rejected?: { mutationId: string; local: LocalFile }) { return conflicts.conflict(this, p, l, r, rejected); }
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
        catch (e) { if (!transfers.isConflict(e)) throw e; }
      }
      return this.reconcileAll(true);
    }
    const p = this.collectionPath(f.path), from = this.collectionPath(old), k = from ? this.data.paths[from] : undefined;
    if (p && from && k && f instanceof TFile && !this.data.paths[p]) {
      const r = (await this.remoteAll()).get(from), l = await this.local(p);
      if (r && l && r.id === k.id && r.revision === k.revision && r.kind !== "resource" && this.kindOf(p) === r.kind) {
        try {
          await this.moveLocal(from, p, k, r);
        } catch (e) { if (!transfers.isConflict(e)) throw e; }
      }
    }
    await this.reconcileAll(true);
  }

  setStatus(text: string, statusKind?: "busy" | "problem") { this.statusKind = statusKind; this.statusText = text; this.changed(text, this.stalled && this.phase.kind === "starting" ? { ...this.phase, stalled: true } : this.phase, this.view()); }
  /**
   * Progress from a pass. A pass still running when sync stops (access removed,
   * say) must not put "Synced" back over the words saying why; its counts still go out.
   */
  passStatus(text: string, statusKind?: "busy" | "problem") { this.setStatus(this.phase.kind === "ready" ? text : this.statusText, this.phase.kind === "ready" ? statusKind : this.statusKind); }
  view(): NativeView {
    const failures = Object.entries(this.data?.pathFailures ?? {}).map(([p, f]) => ({ path: p, ...describeFailure({ ...f, kind: this.data.paths[p]?.kind }) }));
    const conflicts = Object.values(this.data?.conflictCopies ?? {}).map(({ path, copy }) => ({ path, copy }));
    return { statusKind: this.statusKind, failures: failures.sort((a, b) => a.path.localeCompare(b.path)), conflicts, merge: this.merge, activity: this.activity, lastSynced: this.lastSynced, totals: this.totals, device: this.device, inclusion: this.inclusion ?? null, bound: !!this.data?.collectionId };
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
    const info = errorInfo(e);
    const code = [info.code, info.reason].filter(Boolean).join(" ");
    const detail = code || (what === "startup" || what === "ownership" || what === "start" ? this.safeText(info.message ?? "error") : "operation failed; local state retained");
    if (info.code === "collection_bound") userMessage = t`This folder is already bound to a collection. Use a separate vault for another collection; this vault cannot be rebound while syncing.`;
    if (what === "ownership" && !userMessage) userMessage = t`Another app may be syncing this folder, so Obsidian is waiting. Your files here are untouched.`;
    if (!userMessage && what !== "startup" && what !== "start") {
      if (info.code === "unavailable") userMessage = t`Couldn't reach mdbase right now. Your files here are untouched. Check your connection and try again.`;
      else if (info.code === "rate_limited") userMessage = t`mdbase is busy right now. Your files here are untouched. Wait a moment and try again.`;
      else if (info.code === "timeout") userMessage = t`mdbase took too long to answer. Your files here are untouched. Try again in a moment.`;
    }
    // Plain words for the status; the code stays for support, and the log keeps the detail.
    const reason = userMessage ?? (what === "startup" || what === "start" ? detail : (code ? t`Something went wrong (${code}). Your files here are untouched.` : t`Something went wrong. Your files here are untouched.`));
    this.setStatus(whole && userMessage ? userMessage : failedText(reason, !!userMessage || !(what === "startup" || what === "start")), "problem");
    this.log(`FAILED ${what}: ${detail}`);
    const notice = userMessage ? t`mdbase: ${userMessage}` : what === "startup" ? t`mdbase: startup: ${detail}`
      : what === "ownership" ? t`mdbase: ownership: ${detail}` : what === "start" ? t`mdbase: start: ${detail}`
      : what === "sync" ? t`mdbase: sync: ${detail}` : what === "saving state" ? t`mdbase: saving state: ${detail}`
      : what === "phase" ? t`mdbase: phase: ${detail}` : what === "add collection" ? t`mdbase: add collection: ${detail}`
      : what === "select" ? t`mdbase: select: ${detail}` : what === "open sign-in" ? t`mdbase: open sign-in: ${detail}`
      : what === "discard rejected" ? t`mdbase: discard rejected: ${detail}` : t`mdbase: handover (marker retained): ${detail}`;
    new Notice(notice, 10000);
  }
}
