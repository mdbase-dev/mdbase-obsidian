import type { ConflictEntry, ConflictValue, Hold, MdbaseClient, SyncStatus } from "@mdbase-dev/sdk/thin-client";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  collectionIdFrom,
  desktopModules,
  findBinary,
  MdbaseCli,
  MdbaseError,
  readLinkFiles,
  vaultCollection,
  type CollectionStatus,
  type DaemonStatus,
  type HoldSummary,
} from "./daemon";
import { folderHost } from "./ownership";
import type NativeSync from "./native/plugin";
import { EditorFence, type WorkspaceLike } from "./editorFence";

export type SyncKind = "cloud" | "private";
export type HoldChoice = "keep_mine" | "take_theirs" | "keep_both" | "delete";

/** A file mdbase kept instead of overwriting, waiting for a decision. */
export interface HeldFile {
  id: string;
  path: string;
  reason: string;
  hasTheirs: boolean;
  mine: string | null;
  theirs: string | null;
}

/**
 * An edit made on two devices at once that mdbase settled on its own (it kept
 * one side). Shown so a person can check it, and for a property, switch.
 */
export interface MergedChange {
  entry: ConflictEntry;
  /** The note's path in the collection, or "" while unknown. */
  path: string;
  kind: ConflictEntry["conflict"]["kind"];
  field: string | null;
  kept: string;
  lost: string;
  /** The other side's property value, when it can be chosen instead. */
  lostValue: unknown;
}

export type DaemonState = "checking" | "mobile" | "not_installed" | "not_running" | "running" | "error";
export type LinkState = "off" | "connecting" | "open" | "declined" | "failed";

export interface PendingApproval {
  device: string;
  name: string;
}

export interface SyncSnapshot {
  direct?: { text: string; phase: { kind: string; sync?: { kind: string; pending: number }; problem?: unknown } };
  daemon: DaemonState;
  /** The last failure reaching mdbase, for `daemon: "error"`. */
  error: MdbaseError | null;
  status: DaemonStatus | null;
  /** This vault's collection, if it has one. */
  collection: CollectionStatus | null;
  /** The collection's folder inside the vault ("" for the whole vault). */
  prefix: string;
  /** Live sync state over the link, newer than `collection.sync` while open. */
  live: SyncStatus | null;
  link: LinkState;
  holds: HeldFile[];
  approvals: PendingApproval[];
  /** Edits settled automatically that a person may want to check (needs the link). */
  merged: MergedChange[];
  /** The sign-in page while a sign-in waits for approval in the browser. */
  signingIn: string | null;
  /** What is being done right now, e.g. "Turning on sync". */
  busy: string | null;
}

export interface SyncHost {
  /** Absolute vault folder, or null on mobile. */
  vaultPath(): string | null;
  /** Names of visible entries at the vault's top level. */
  vaultTopLevel(): string[];
  workspace(): WorkspaceLike;
  binaryOverride(): string;
  createNative?(changed: (text: string, phase: unknown) => void, collection?: string): Promise<NativeSync>;
  appVersion: string;
  openUrl(url: string): void;
}

const isMdbaseError = (error: unknown): error is { code: string; reason?: string; message: string } =>
  typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string";

function holdText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Sync through the mdbase desktop app. Setup runs through its `mdbase` tool;
 * status, held files and the editor fence run over the SDK's localhost link.
 * One instance per vault; views subscribe to its snapshot.
 */
export class SyncController {
  native: NativeSync | null = null;
  private lastDesktopCollection?: string;
  readonly cli: MdbaseCli;
  private snapshotValue: SyncSnapshot = {
    daemon: "checking", error: null, status: null, collection: null, prefix: "", live: null,
    link: "off", holds: [], approvals: [], merged: [], signingIn: null, busy: null,
  };
  private readonly listeners = new Set<() => void>();
  private timer: number | null = null;
  private stopped = true;
  private refreshing: Promise<void> | null = null;
  private client: MdbaseClient | null = null;
  private clientFor: string | null = null;
  private linkAttempt = 0;
  private clientStops: (() => void)[] = [];
  private fence: EditorFence | null = null;
  private fenceTimer: number | null = null;
  private signInDeadline = 0;

  constructor(private readonly host: SyncHost, readonly mobile: boolean) {
    this.cli = new MdbaseCli(() => (this.mobile ? null : findBinary(host.binaryOverride())));
    if (mobile) this.snapshotValue = { ...this.snapshotValue, daemon: "mobile" };
  }

  get snapshot(): SyncSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<SyncSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const listener of this.listeners) listener();
  }

  start(): void {
    if (this.mobile || !this.stopped) return;
    this.stopped = false;
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.fenceTimer !== null) window.clearTimeout(this.fenceTimer);
    this.timer = null;
    this.closeLink();
    this.native?.unload(); this.native = null;
  }

  /** Check mdbase now; coalesces with a check already running. */
  refresh(): Promise<void> {
    if (this.mobile) return Promise.resolve();
    this.refreshing ??= this.check().finally(() => {
      this.refreshing = null;
      this.schedule();
    });
    return this.refreshing;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    const s = this.snapshotValue;
    const fast = s.signingIn || s.busy || (s.collection && s.collection.state !== "ready" && s.collection.state !== "paused");
    const delay = s.direct ? 2_000 : fast ? 2_000 : s.link === "open" ? 30_000 : 10_000;
    this.timer = window.setTimeout(() => void this.refresh(), delay);
  }

  private async check(): Promise<void> {
    const vaultPath = this.host.vaultPath();
    if (vaultPath && this.host.createNative) {
      try {
        const { fs, path } = desktopModules();
        let marker: unknown = null;
        try { marker = JSON.parse(fs.readFileSync(path.join(vaultPath, ".mdbase/host.json"), "utf8")); }
        catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw new Error("Cannot read folder ownership. Sync is waiting; files are untouched."); }
        const owner = folderHost(marker);
        if (owner === "wait") throw new Error("This folder is owned by another app. Sync is waiting; files are untouched.");
        if (owner === "plugin") {
          this.closeLink();
          if (!this.native) {
            this.set({ direct: { text: "Starting sync", phase: { kind: "starting" } }, daemon: "running", error: null });
            this.native = await this.host.createNative((text, phase) => {
              this.set({ direct: { text, phase: phase as NonNullable<SyncSnapshot["direct"]>["phase"] } });
            }, this.lastDesktopCollection);
            if (this.stopped) { this.native.unload(); this.native = null; return; }
            this.native.load();
          }
          return;
        }
        const id = (marker as { collection_id?: string }).collection_id;
        if (id) this.lastDesktopCollection = id;
        if (this.native) { this.native.unload(); this.native = null; }
        this.set({ direct: undefined });
      } catch (error) {
        this.native?.unload(); this.native = null;
        this.closeLink();
        this.set({ direct: undefined, daemon: "error", error: new MdbaseError("unavailable", (error as Error).message) });
        return;
      }
    }
    let status: DaemonStatus;
    try {
      status = await this.cli.status();
    } catch (error) {
      const e = error instanceof MdbaseError ? error : new MdbaseError("internal", String(error));
      // A busy daemon (say, taking in thousands of changes) can answer slowly; the open link still reports live.
      if (e.code === "timeout" && this.snapshotValue.link === "open") return;
      const daemon: DaemonState = e.reason === "not_installed" ? "not_installed"
        : e.reason === "daemon_not_running" || e.code === "unavailable" && /not running/i.test(e.message) ? "not_running" : "error";
      this.closeLink();
      // Keep the last known collection: the vault still syncs once mdbase is back.
      this.set({ daemon, error: e, status: null, live: null, holds: [], approvals: [] });
      return;
    }
    const found = vaultPath ? vaultCollection(status, vaultPath) : null;
    const signingIn = this.snapshotValue.signingIn;
    let signInPatch: Partial<SyncSnapshot> = {};
    if (signingIn) {
      if (status.account.signed_in && !status.account.pairing) signInPatch = { signingIn: null };
      else if (status.account.last_error && !status.account.pairing) signInPatch = { signingIn: null, error: new MdbaseError("unauthenticated", status.account.last_error, "sign_in_failed") };
      else if (Date.now() > this.signInDeadline) signInPatch = { signingIn: null };
    }
    const collection = found?.collection ?? null;
    let holds = this.snapshotValue.holds;
    if (!collection) holds = [];
    else if (this.snapshotValue.link !== "open") holds = await this.cliHolds(collection);
    const approvals = collection?.notices.some((n) => n.code === "devices_waiting_for_approval")
      ? await this.pendingApprovals(collection.id) : [];
    this.set({ daemon: "running", error: signInPatch.error ?? null, status, collection, prefix: found?.prefix ?? "", holds, approvals, ...signInPatch });
    // Keep the link through transitional states; only a stopped collection drops it.
    if (collection && collection.mode !== "local" && collection.state !== "failed" && collection.state !== "unavailable") void this.ensureLink(collection, found?.prefix ?? "");
    else this.closeLink();
  }

  private async cliHolds(collection: CollectionStatus): Promise<HeldFile[]> {
    if (!(collection.sync?.holds)) return [];
    try {
      const result = await this.cli.run<HoldSummary[] | { holds: HoldSummary[] }>(["holds", collection.id]);
      const list = Array.isArray(result) ? result : result.holds ?? [];
      return list.map((h) => ({ id: h.id, path: h.path, reason: h.reason, hasTheirs: h.has_theirs, mine: null, theirs: null }));
    } catch {
      return this.snapshotValue.holds;
    }
  }

  private async pendingApprovals(collection: string): Promise<PendingApproval[]> {
    try {
      const result = await this.cli.run<unknown>(["device", "pending", collection]);
      const list = Array.isArray(result) ? result : (result as { devices?: unknown[] }).devices ?? [];
      return list.flatMap((entry) => {
        const d = entry as { device?: string; device_id?: string; id?: string; name?: string };
        const device = d.device ?? d.device_id ?? d.id;
        return device ? [{ device, name: d.name ?? "A new device" }] : [];
      });
    } catch {
      return [];
    }
  }

  // ----- The localhost link -----

  private async ensureLink(collection: CollectionStatus, prefix: string): Promise<void> {
    if (this.clientFor === collection.id) return;
    if (this.snapshotValue.link === "declined" && this.clientFor === null) return;
    this.closeLink();
    const attempt = this.linkAttempt;
    this.clientFor = collection.id;
    this.set({ link: "connecting" });
    try {
      const sdk = await import("@mdbase-dev/sdk/thin-client");
      const staticKey = await sdk.loadOrCreateClientKey("mdbase-obsidian");
      const connector = sdk.localLinkConnector({
        collection: collection.id,
        localOnly: collection.mode === "local",
        staticKey,
        webSocket: (url: string) => new WebSocket(url),
        link: async () => {
          const files = await readLinkFiles();
          return { port: files.port, token: hexToBytes(files.token), device: files.device, noisePublicKey: hexToBytes(files.noisePk) };
        },
      });
      const client = await sdk.connect({
        connector,
        app: { name: "mdbase for Obsidian", version: this.host.appVersion },
        features: ["fence"],
        reconnect: { minDelayMs: 1_000, maxDelayMs: 30_000 },
      });
      if (attempt !== this.linkAttempt || this.stopped) {
        client.close();
        return;
      }
      this.client = client;
      this.fence = new EditorFence(this.host.workspace(), prefix);
      client.offerFence(async (request) => this.fence?.apply(request) ?? { outcome: "not_open" });
      this.clientStops.push(
        client.onStatus((live) => this.set({ live })),
        client.onHolds((holds) => this.set({ holds: holds.map(heldFile) })),
        client.onConflicts((entries) => void this.showMerged(client, entries)),
        client.onLink((state) => this.set({ link: state === "open" ? "open" : state === "reconnecting" ? "connecting" : "failed" })),
      );
      this.set({ link: "open" });
      this.reportFenceSoon();
      void client.listConflicts().then((entries) => this.showMerged(client, entries), () => undefined);
    } catch (error) {
      if (attempt !== this.linkAttempt) return;
      this.clientFor = null;
      // The daemon asks one app at a time; another request's prompt is still open.
      const waiting = isMdbaseError(error) && /waiting for confirmation/i.test(error.message);
      const declined = !waiting && isMdbaseError(error) && error.reason === "link_not_approved";
      if (!waiting) console.warn("mdbase: could not link to the mdbase app", error);
      // Anything but a refusal retries at the next check.
      this.set({ link: declined ? "declined" : waiting ? "connecting" : "failed" });
    }
  }

  /** Ask again after the person declined or closed the confirmation. */
  async linkAgain(): Promise<void> {
    this.set({ link: "off" });
    const { collection, prefix } = this.snapshotValue;
    if (collection) await this.ensureLink(collection, prefix);
  }

  private closeLink(): void {
    this.linkAttempt++;
    for (const stop of this.clientStops.splice(0)) stop();
    this.client?.close();
    this.client = null;
    this.clientFor = null;
    this.fence = null;
    if (this.snapshotValue.link !== "off" && this.snapshotValue.link !== "declined") this.set({ link: "off", live: null, merged: [] });
  }

  /** Call when open notes, or their unsaved state, may have changed. */
  reportFenceSoon(): void {
    if (!this.client || !this.fence) return;
    if (this.fenceTimer !== null) window.clearTimeout(this.fenceTimer);
    this.fenceTimer = window.setTimeout(() => {
      this.fenceTimer = null;
      const entries = this.fence?.report() ?? [];
      void this.client?.reportFence(entries).catch((error: unknown) => console.warn("mdbase: could not report open notes", error));
    }, 300);
  }

  private readonly paths = new Map<string, string>();
  /** Notes whose held versions the person just chose between. */
  private readonly decided = new Set<string>();

  private async showMerged(client: MdbaseClient, entries: ConflictEntry[]): Promise<void> {
    const sdk = await import("@mdbase-dev/sdk/thin-client");
    // Choosing a held version also records the conflict it settled; the person
    // already decided, so don't ask again.
    const already = entries.filter((entry) => this.decided.has(entry.conflict.id));
    for (const entry of already) void client.dismissConflict(entry).catch((error: unknown) => console.warn("mdbase: could not dismiss a decided conflict", error));
    entries = entries.filter((entry) => !this.decided.has(entry.conflict.id));
    const merged = await Promise.all(entries.map(async (entry): Promise<MergedChange> => {
      const id = entry.conflict.id;
      if (!this.paths.has(id)) {
        try { this.paths.set(id, (await client.get(id)).path); } catch { /* deleted or unknown: no path */ }
      }
      const text = (value: ConflictValue | undefined): string => {
        if (!value) return "";
        if (value.form === "text") return value.text;
        if (value.form === "value") return JSON.stringify(sdk.toPlain(value.value));
        return value.form === "deleted" ? "(deleted)" : "(a file)";
      };
      const lost = entry.conflict.lost;
      return {
        entry, path: this.paths.get(id) ?? "", kind: entry.conflict.kind, field: entry.conflict.field ?? null,
        kept: text(entry.conflict.kept), lost: text(lost),
        lostValue: lost.form === "value" ? sdk.toPlain(lost.value) : undefined,
      };
    }));
    if (this.client === client) this.set({ merged });
  }

  /** Accept what mdbase kept. */
  dismissMerged(change: MergedChange): Promise<void> {
    return this.act("Saving your choice", async () => {
      if (!this.client) throw new MdbaseError("unavailable", "Obsidian isn't linked to mdbase right now.");
      await this.client.dismissConflict(change.entry);
      this.set({ merged: this.snapshotValue.merged.filter((m) => m !== change) });
    });
  }

  /** Use the other device's value for a property instead. */
  useOtherValue(change: MergedChange): Promise<void> {
    return this.act("Saving your choice", async () => {
      if (!this.client || change.field === null) throw new MdbaseError("unavailable", "Obsidian isn't linked to mdbase right now.");
      await this.client.resolveConflict(change.entry, change.field, change.lostValue as never);
      this.set({ merged: this.snapshotValue.merged.filter((m) => m !== change) });
    });
  }

  // ----- Actions -----

  private async act<T>(label: string, action: () => Promise<T>): Promise<T> {
    this.set({ busy: label, error: null });
    try {
      return await action();
    } finally {
      this.set({ busy: null });
      await this.refresh();
    }
  }

  startApp(): Promise<void> {
    return this.act("Starting mdbase", async () => {
      await this.cli.run(["daemon", "start"], { timeoutMs: 60_000 });
    });
  }

  async signIn(): Promise<void> {
    const result = await this.act("Opening sign-in", () => this.cli.run<{ verification_uri?: string }>(["account", "sign-in"]));
    if (!result.verification_uri) throw new MdbaseError("internal", "mdbase didn't return a sign-in page.");
    this.signInDeadline = Date.now() + 10 * 60_000;
    this.set({ signingIn: result.verification_uri });
    this.host.openUrl(result.verification_uri);
    this.schedule();
  }

  cancelSignIn(): void {
    this.set({ signingIn: null });
  }

  signOut(): Promise<void> {
    return this.act("Signing out", async () => {
      await this.cli.run(["account", "sign-out"], { yes: true });
    });
  }

  /** Make this vault a collection and sync it. */
  setUp(kind: SyncKind, name: string): Promise<void> {
    const vault = this.host.vaultPath();
    if (!vault) return Promise.reject(new MdbaseError("unavailable", "Sync needs Obsidian for desktop."));
    return this.act("Turning on sync", async () => {
      let collection = this.snapshotValue.collection;
      if (!collection) {
        collection = await this.cli.run<CollectionStatus>(["collection", "add", vault, "--name", name.trim() || "Notes"], { yes: true });
      }
      if (collection.mode === "local") await this.enable(await this.serving(collection.id), kind);
    });
  }

  /** A newly added collection opens first; sync can be turned on once it serves. */
  private async serving(id: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      const status = await this.cli.status();
      const state = status.collections.find((c) => c.id === id)?.state;
      if (state === "ready") return id;
      if (state === "failed" || state === "unavailable") break;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    return id; // let `sync enable` report why
  }

  private async enable(id: string, kind: SyncKind): Promise<void> {
    await this.cli.run(["sync", "enable", id, "--mode", kind === "private" ? "private" : "cloud-copy"], { yes: true, timeoutMs: 180_000 });
  }

  /**
   * Bring a collection from the account into this vault. An empty vault becomes
   * the collection; otherwise it goes into a new folder named `folder`.
   * Returns the folder used ("" for the vault itself).
   */
  join(pasted: string, folder: string): Promise<string> {
    const vault = this.host.vaultPath();
    const id = collectionIdFrom(pasted);
    if (!vault) return Promise.reject(new MdbaseError("unavailable", "Sync needs Obsidian for desktop."));
    if (!id) return Promise.reject(new MdbaseError("invalid_request", "That doesn't look like a collection link or ID.", "bad_id"));
    return this.act("Adding the collection", async () => {
      const { fs, path } = desktopModules();
      const intoVault = this.host.vaultTopLevel().length === 0;
      const tryJoin = async (target: string) => {
        try {
          await this.joinInto(id, target);
          return true;
        } catch (error) {
          if (isMdbaseError(error) && error.reason === "folder_not_empty") return false;
          throw error;
        }
      };
      if (intoVault && await tryJoin(vault)) return "";
      const name = safeFolderName(folder);
      const target = path.join(vault, name);
      if (fs.existsSync(target) && fs.readdirSync(target).length) {
        throw new MdbaseError("invalid_request", `The folder "${name}" already has files. Choose another name.`, "folder_not_empty");
      }
      fs.mkdirSync(target, { recursive: true });
      try {
        await this.joinInto(id, target);
      } catch (error) {
        try { fs.rmdirSync(target); } catch { /* keep a folder that gained files */ }
        throw error;
      }
      return name;
    });
  }

  /** Join as a cloud copy; a private collection asks for the private join instead. */
  private async joinInto(id: string, target: string): Promise<void> {
    try {
      await this.cli.run(["collection", "join", id, target], { yes: true, timeoutMs: 180_000 });
    } catch (error) {
      // A private collection has no cloud copy to join from ("not_current_cloud_copy").
      if (!isMdbaseError(error) || !/private|e2e|end.to.end|not_current_cloud_copy/i.test(`${error.reason ?? ""} ${error.message}`)) throw error;
      await this.cli.run(["collection", "join", id, target, "--private"], { yes: true, timeoutMs: 180_000 });
    }
  }

  /** Stop syncing this vault on this computer. Files stay; other devices are unaffected. */
  disconnect(): Promise<void> {
    const collection = this.snapshotValue.collection;
    if (!collection) return Promise.resolve();
    return this.act("Disconnecting", async () => {
      this.closeLink();
      await this.cli.run(["collection", "remove", collection.id], { yes: true });
    });
  }

  resolve(hold: HeldFile, choice: HoldChoice): Promise<void> {
    const collection = this.snapshotValue.collection;
    if (!collection) return Promise.resolve();
    return this.act("Saving your choice", async () => {
      this.decided.add(hold.id);
      if (this.client && this.snapshotValue.link === "open") await this.client.resolveHold(hold.id, choice);
      else await this.cli.run(["resolve", collection.id, hold.id, choice], { yes: true });
      this.set({ holds: this.snapshotValue.holds.filter((h) => h.id !== hold.id) });
    });
  }

  approve(device: string, code: string): Promise<void> {
    const collection = this.snapshotValue.collection;
    if (!collection) return Promise.resolve();
    return this.act("Approving the device", async () => {
      await this.cli.run(["device", "approve", collection.id, device, "--code", code.replace(/\s+/g, "")], { yes: true, timeoutMs: 60_000 });
    });
  }

  reject(device: string): Promise<void> {
    const collection = this.snapshotValue.collection;
    if (!collection) return Promise.resolve();
    return this.act("Declining the device", async () => {
      await this.cli.run(["device", "reject", collection.id, device], { yes: true });
    });
  }
}

function heldFile(hold: Hold): HeldFile {
  return { id: hold.id, path: hold.path, reason: hold.reason, hasTheirs: hold.theirs !== undefined, mine: holdText(hold.mine), theirs: holdText(hold.theirs) };
}

/** A folder name safe on every desktop OS. */
export function safeFolderName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return cleaned || "mdbase";
}
