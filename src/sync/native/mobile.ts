import type { App, DataAdapter, PluginManifest } from "obsidian";
import { requireApiVersion } from "obsidian";
import packedAssets from "embedded:assets";
import type { DownloadOptions, EngineHost, EngineOptions, HostResult } from "./host";
import { vaultNamespace } from "./host";
import { BRIDGE_CHUNK_BYTES } from "./downloadPull";

/** Canonical origin from a Window/Location object, recovering custom schemes whose WHATWG origin is opaque ("null"). */
export function resolveWindowOrigin(loc: { origin?: string; href?: string }): string {
  if (typeof loc.origin === "string" && loc.origin && loc.origin !== "null") return loc.origin;
  if (typeof loc.href === "string" && loc.href) {
    const url = new URL(loc.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : `${url.protocol}//${url.host}`;
  }
  return "";
}
/** Accepted mobile WebView origins: Android (http://localhost) and iOS (capacitor://localhost). */
export function mobileOrigin(origin: string): string {
  const url = new URL(origin);
  const android = url.protocol === "http:" && url.origin === origin && url.hostname === "localhost" && !url.port;
  const ios = url.protocol === "capacitor:" && `${url.protocol}//${url.host}` === origin && url.hostname === "localhost" && !url.port && !url.username && !url.password && !url.search && !url.hash && (url.pathname === "" || url.pathname === "/");
  if (!android && !ios)
    throw new Error("Mobile sync needs a supported secure WebView origin. This origin has not been qualified.");
  return origin;
}
/** Normalize volatile iOS app container UUIDs so App Store updates keep the same vaultLocation binding. */
export function normalizeMobileResourcePath(resource: string): string {
  return resource.split(/[?#]/)[0].replace(/(\/Containers\/Data\/Application\/)[0-9a-fA-F-]+(\/)/, "$1<container>$2");
}
export async function decodeAsset(packed: string): Promise<Uint8Array> {
  const compressed = Uint8Array.from(atob(packed), character => character.charCodeAt(0));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;
const missing = (file: string) => Object.assign(new Error(`Missing sync file: ${file}`), { code: "ENOENT" });

export class MobileHost implements EngineHost {
  readonly root = "";
  readonly pluginDir: string;
  private readonly adapter: DataAdapter;
  private page: string | null = null;
  private workerPage: string | null = null;
  private opening: Promise<{ origin: string; url: string }> | null = null;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly vaultLocation: string;

  constructor(app: App, manifest: PluginManifest) {
    this.adapter = app.vault.adapter;
    if (!manifest.dir) throw new Error("Missing plugin directory");
    this.pluginDir = manifest.dir;
    const resource = this.adapter.getResourcePath(this.join(manifest.dir, "sync-state.json"));
    this.vaultLocation = `mobile:${normalizeMobileResourcePath(resource)}`;
  }
  location() { return this.vaultLocation; }
  join(...parts: string[]) { return parts.filter(Boolean).join("/"); }
  dirname(file: string) { return file.split("/").slice(0, -1).join("/"); }
  uuid() { return crypto.randomUUID(); }
  async openExternal(url: string): Promise<void> { window.open(url); }
  assertPath(file: string) {
    if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some(part => !part || part === "." || part === ".."))
      throw new Error("Unsafe adapter path refused");
  }
  private serializeIO<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.then(() => {}, () => {});
    return result;
  }
  readText(file: string): Promise<string> {
    this.assertPath(file);
    return this.serializeIO(async () => {
      if (!await this.adapter.exists(file)) {
        const temporary = `${file}.tmp`;
        if (!await this.adapter.exists(temporary)) throw missing(file);
        const text = await this.adapter.read(temporary);
        // All writeAtomic callers write JSON (state, ownership marker, activity).
        // A first write can crash before completion, so only adopt valid JSON.
        try { JSON.parse(text); }
        catch { await this.adapter.remove(temporary); throw missing(file); }
        await this.adapter.rename(temporary, file);
      }
      return this.adapter.read(file);
    });
  }
  async readBytes(file: string) { this.assertPath(file); if (!await this.adapter.exists(file)) throw missing(file); return new Uint8Array(await this.adapter.readBinary(file)); }
  writeAtomic(file: string, text: string, _exclusiveTemporary = false): Promise<void> {
    this.assertPath(file);
    if (this.closed) return Promise.reject(new Error("Sync host stopped"));
    return this.serializeIO(async () => {
      // Mobile has one serialized writer; even markers use a recoverable name.
      const temporary = `${file}.tmp`;
      await this.adapter.write(temporary, text);
      if (await this.adapter.exists(file)) await this.adapter.remove(file);
      await this.adapter.rename(temporary, file);
    });
  }
  async writeBytes(file: string, bytes: Uint8Array, exclusive = false) {
    this.assertPath(file);
    if (this.closed) throw new Error("Sync host stopped");
    if (exclusive && await this.adapter.exists(file)) throw new Error("Recovery file already exists");
    await this.adapter.writeBinary(file, buffer(bytes));
  }
  async mkdir(directory: string) {
    if (!directory) return;
    this.assertPath(directory);
    const parts = directory.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const parent = parts.slice(0, count).join("/");
      if (!await this.adapter.exists(parent)) await this.adapter.mkdir(parent);
    }
  }
  exists(file: string) { this.assertPath(file); return this.adapter.exists(file); }
  async remove(file: string) { this.assertPath(file); if (!await this.adapter.exists(file)) throw missing(file); await this.adapter.remove(file); }
  async rename(from: string, to: string) {
    this.assertPath(from); this.assertPath(to);
    if (await this.adapter.exists(to)) throw new Error(`Mobile rename refuses an existing destination: ${to}`);
    await this.adapter.rename(from, to);
  }
  async list(directory: string) {
    if (directory) this.assertPath(directory);
    const listed = await this.adapter.list(directory);
    return [...listed.folders.map(file => ({ name: file.slice(file.lastIndexOf("/") + 1), directory: true, file: false })),
      ...listed.files.map(file => ({ name: file.slice(file.lastIndexOf("/") + 1), directory: false, file: true }))];
  }
  identity() { return undefined; }
  async checkLock() {
    if (await this.exists(".mdbase/host.lock")) throw Object.assign(new Error("Desktop folder lock exists; mobile cannot verify it. Waiting for manual recovery."), { code: "folder_locked" });
  }
  async checkOwnership(validate: (marker: string | null) => void) {
    let marker: string | null = null;
    try { marker = await this.readText(".mdbase/host.json"); }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw new Error("Unreadable ownership marker; waiting for desktop/manual recovery"); }
    validate(marker); await this.checkLock();
  }
  async hash(bytes: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes)));
    return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  async publish(staged: string, target: string, expectedHash: string | undefined, digest: string, guard: () => HostResult<void>, active?: () => void) {
    this.assertPath(staged); this.assertPath(target);
    const stagedBytes = await this.readBytes(staged);
    if (await this.hash(stagedBytes) !== digest) throw new Error("Downloaded file digest mismatch before publication");
    await guard();
    let current: string | undefined;
    try { current = await this.hash(await this.readBytes(target)); }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    if (current !== expectedHash) throw Object.assign(new Error("Local file changed before publication; retained"), { code: "local_changed" });
    active?.();
    if (current === undefined) await this.adapter.rename(staged, target);
    else {
      // No await between active() and starting the write: retain newer editors.
      // Overwrite emits modify, not delete/create. A crash can tear the file,
      // just as with Obsidian's own non-atomic mobile saves.
      await this.adapter.writeBinary(target, buffer(stagedBytes));
      await this.adapter.remove(staged);
    }
  }
  async stageDownload(options: DownloadOptions) {
    if (!requireApiVersion("1.12.3")) throw new Error("Sync on this device needs Obsidian 1.12.3 or later. Update Obsidian, then restart sync.");
    const staged = this.join(options.directory, `${this.uuid()}.tmp`);
    try {
      await this.mkdir(options.directory);
      await this.writeBytes(staged, new Uint8Array(), true);
      for (;;) {
        const reply = await options.next();
        if (reply.done) break;
        if (!reply.bytes || reply.bytes.length > BRIDGE_CHUNK_BYTES) throw new Error("Invalid download chunk");
        await this.adapter.appendBinary(staged, buffer(reply.bytes));
      }
      if (await this.hash(await this.readBytes(staged)) !== options.digest) throw new Error("Downloaded file digest mismatch");
      await options.publish(staged);
    } finally {
      try { if (await this.exists(staged)) await this.remove(staged); }
      finally { await options.close(); }
    }
  }
  open(options: EngineOptions) {
    if (this.closed) return Promise.reject(new Error("Sync host stopped"));
    this.opening = this.openPage(options);
    return this.opening;
  }
  private async openPage(options: EngineOptions) {
    const stopped = () => this.closed || options.stopped();
    // Downloads append in chunks (adapter.appendBinary, Obsidian 1.12.3);
    // the plugin's minAppVersion is lower because desktop doesn't need it.
    if (!requireApiVersion("1.12.3") || typeof this.adapter.appendBinary !== "function")
      throw new Error("Sync on this device needs Obsidian 1.12.3 or later. Update Obsidian, then restart sync.");
    const origin = mobileOrigin(resolveWindowOrigin(window.location));
    const directory = this.join(this.pluginDir, "sync-engine");
    for (const [asset, packed] of Object.entries(packedAssets)) {
      if (asset === "/index.html") continue;
      if (stopped()) throw new Error("Sync host stopped");
      const file = `${directory}${asset}`;
      await this.mkdir(this.dirname(file));
      const bytes = await decodeAsset(packed);
      await this.writeBytes(file, bytes);
      if (stopped()) throw new Error("Sync host stopped");
      if (asset === "/sdk/application/worker.js") this.workerPage = URL.createObjectURL(new Blob([buffer(bytes)], { type: "text/javascript" }));
    }
    const resource = this.adapter.getResourcePath(this.join(directory, "app.js"));
    const base = resource.split(/[?#]/)[0].replace(/app\.js$/, "");
    if (!this.workerPage) throw new Error("Missing sync Worker asset");
    const config = { namespace: vaultNamespace(options.data.vaultId), collection: options.data.collectionId, origin, capability: options.capability, workerUrl: this.workerPage };
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const html = `<!doctype html><html><head><meta charset="utf-8"><base href="${escape(base)}"></head><body><script type="module">globalThis.mdbaseHost=${JSON.stringify(config).replace(/</g, "\\u003c")}; await import("./app.js");</script></body></html>`;
    if (stopped()) throw new Error("Sync host stopped");
    this.page = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    return { origin, url: this.page };
  }
  async close() {
    this.closed = true;
    await this.opening?.catch(() => {});
    if (this.page) URL.revokeObjectURL(this.page);
    if (this.workerPage) URL.revokeObjectURL(this.workerPage);
    this.page = null;
    this.workerPage = null;
    await this.writes;
  }
}
