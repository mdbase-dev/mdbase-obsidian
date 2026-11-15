import type { App, FileSystemAdapter, PluginManifest } from "obsidian";
import type { EngineHost, EngineOptions, HostResult } from "./host";
import { nativeModule } from "./node";
import { stageDownload } from "./download";
import { validVaultPort } from "../ownership";
import { vaultNamespace } from "./host";
import packedAssets from "embedded:assets";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" };
export class DesktopHost implements EngineHost {
  private readonly fs = nativeModule<typeof import("node:fs")>("fs");
  private readonly path = nativeModule<typeof import("node:path")>("path");
  private readonly os = nativeModule<typeof import("node:os")>("os");
  private readonly crypto = nativeModule<typeof import("node:crypto")>("crypto");
  private readonly http = nativeModule<typeof import("node:http")>("http");
  private readonly spawnSync = nativeModule<typeof import("node:child_process")>("child_process").spawnSync;
  private readonly gunzipSync = nativeModule<typeof import("node:zlib")>("zlib").gunzipSync;
  readonly processId = process.pid;
  readonly root: string;
  readonly pluginDir: string;
  server: import("node:http").Server | null = null;
  private closing: Promise<void> | null = null;
  private origin = "";
  private assets = new Map<string, Buffer>();
  private served = new Set<string>();
  constructor(app: App, manifest: PluginManifest) {
    this.root = (app.vault.adapter as FileSystemAdapter).getBasePath();
    this.pluginDir = this.join(this.root, manifest.dir ?? "");
  }
  location() { return `${this.os.hostname()}:${this.fs.realpathSync(this.root)}`; }
  join(...parts: string[]) { return this.path.join(...parts); }
  dirname(file: string) { return this.path.dirname(file); }
  uuid() { return this.crypto.randomUUID(); }
  openExternal(url: string): Promise<void> { return nativeModule<{ shell: { openExternal(url: string): Promise<void> } }>("electron").shell.openExternal(url); }
  assertPath(file: string) {
    let current = this.root;
    for (const part of ["", ...file.split("/")]) {
      if (part) current = this.join(current, part);
      try { if (this.fs.lstatSync(current).isSymbolicLink()) throw Object.assign(new Error("Symlink mirror path refused"), { code: "unsafe_symlink" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }
  }
  readText(file: string) { return this.fs.readFileSync(file, "utf8"); }
  async readBytes(file: string) { return new Uint8Array(await this.fs.promises.readFile(file)); }
  writeAtomic(file: string, text: string, exclusiveTemporary = false) {
    const temporary = exclusiveTemporary ? `${file}.obsidian-${this.uuid()}.tmp` : `${file}.tmp`;
    this.fs.writeFileSync(temporary, text, { mode: 0o600, flag: exclusiveTemporary ? "wx" : "w" });
    this.fs.renameSync(temporary, file);
  }
  writeBytes(file: string, bytes: Uint8Array, exclusive = false) { this.fs.writeFileSync(file, bytes, { flag: exclusive ? "wx" : "w", mode: 0o600 }); }
  mkdir(directory: string) { this.fs.mkdirSync(directory, { recursive: true }); }
  exists(file: string) { return this.fs.existsSync(file); }
  remove(file: string) { this.fs.unlinkSync(file); }
  rename(from: string, to: string) { this.fs.renameSync(from, to); }
  list(directory: string) { return this.fs.readdirSync(directory, { withFileTypes: true }).map(entry => ({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() })); }
  identity(file: string) { const stat = this.fs.statSync(file); return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }; }
  checkLock() {
    const lock = this.join(this.root, ".mdbase/host.lock");
    if (this.exists(lock) && (process.platform !== "linux" || this.spawnSync("flock", ["-n", lock, "true"], { timeout: 1000 }).status !== 0))
      throw new Error("Desktop folder lock held or lock probe unavailable; waiting");
  }
  checkOwnership(validate: (marker: string | null) => void) {
    this.assertPath(".mdbase/host.json"); this.assertPath(".mdbase/host.lock");
    let marker: string | null = null;
    try { marker = this.readText(this.join(this.root, ".mdbase/host.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unreadable ownership marker; waiting for desktop/manual recovery"); }
    validate(marker); this.checkLock();
  }
  hash(bytes: Uint8Array) { return `sha256:${this.crypto.createHash("sha256").update(bytes).digest("hex")}`; }
  async publish(staged: string, target: string, expectedHash: string | undefined, guard: () => HostResult<void>, active?: () => void) {
    const checked = guard();
    if (checked) await checked;
    let current: string | undefined;
    try { current = this.hash(new Uint8Array(this.fs.readFileSync(target))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current !== expectedHash) throw Object.assign(new Error("Local file changed before publication; retained"), { code: "local_changed" });
    active?.();
    this.fs.renameSync(staged, target);
  }
  stageDownload = stageDownload;
  close(): Promise<void> {
    const server = this.server; this.server = null;
    if (!server) return this.closing ?? Promise.resolve();
    this.closing = new Promise(resolve => {
      const timer = window.setTimeout(resolve, 3000);
      try { server.close(() => { window.clearTimeout(timer); resolve(); }); }
      catch { window.clearTimeout(timer); resolve(); }
      try { server.closeAllConnections(); } catch { resolve(); }
    });
    return this.closing;
  }
  async open(options: EngineOptions) {
    const server = this.server = this.http.createServer((req, res) => {
      // A stopped host serves nothing, even on a connection still open to it.
      if (options.stopped()) { res.writeHead(503, { connection: "close" }).end(); return; }
      let request: URL;
      try { request = new URL(req.url ?? "/", this.origin); } catch { res.writeHead(400).end(); return; }
      let rel = request.pathname;
      if (rel.startsWith("/auth/")) { res.writeHead(200, { "content-type": "text/plain" }).end("Return to Obsidian to finish signing in."); return; }
      if (rel === "/" || rel === "/index.html") {
        if (request.searchParams.get("bridge") !== options.capability) { res.writeHead(403).end(); return; }
        rel = "/index.html";
      }
      const packed = (packedAssets)[rel];
      if (!packed) { res.writeHead(404).end(); return; }
      let bytes = this.assets.get(rel);
      if (!bytes) { bytes = this.gunzipSync(Buffer.from(packed, "base64")); this.assets.set(rel, bytes); }
      if (!this.served.has(rel)) { this.served.add(rel); options.log(`memory asset ${rel} (${bytes.length} bytes)`); }
      res.writeHead(200, { "content-type": TYPES[this.path.extname(rel)] ?? "application/octet-stream", "content-length": bytes.length, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
      res.end(bytes);
    });
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      // Unloaded meanwhile: this server is nobody's, so it must not open a port.
      if (options.stopped()) { reject(Object.assign(new Error("Sync host stopped"), { code: "unloaded" })); return; }
      const done = () => { server.off("error", failed); server.off("listening", ready); server.off("close", closed); };
      const failed = (e: Error) => { done(); reject(e); };
      const ready = () => { done(); resolve(); };
      // Closed (by unload) before the port opened: Node then reports neither listening nor error.
      const closed = () => { done(); reject(Object.assign(new Error("Sync host stopped"), { code: "unloaded" })); };
      server.once("error", failed); server.once("listening", ready); server.once("close", closed);
      this.origin = `http://127.0.0.1:${port}`; server.listen(port, "127.0.0.1");
    });
    // Unloaded while the port opened (listening completes asynchronously): close it again.
    const abandoned = () => {
      if (!options.stopped()) return;
      try { server.close(); server.closeAllConnections(); } catch { /* not listening */ }
      throw Object.assign(new Error("Sync host stopped"), { code: "unloaded" });
    };
    if (options.data.port !== undefined) {
      if (!validVaultPort(options.data.port)) throw new Error("Invalid saved native port");
      // A host that just stopped (Restart sync, plugin reload) may still be letting go of it.
      for (const until = Date.now() + 2000; ;) {
        try { await listen(options.data.port); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "unloaded") throw error;
          if (code !== "EADDRINUSE" || Date.now() >= until)
            throw new Error(`Saved port ${options.data.port} unavailable (${code}); not switching origins. Close the other listener and reload.`);
          await new Promise(resolve => window.setTimeout(resolve, 100));
        }
      }
    } else {
      const first = Math.floor(Math.random() * 100);
      for (let n = 0; n < 100; n++) {
        const port = 48300 + ((first + n) % 100);
        try { await listen(port); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; continue; }
        abandoned(); options.data.port = port; await options.save(); break;
      }
      if (!options.data.port) throw new Error("No free native port in 48300–48399");
    }
    abandoned();
    options.log(`native host ${this.origin}; assets embedded in main.js`);
    return { origin: this.origin, url: `${this.origin}/?bridge=${options.capability}&vault=${encodeURIComponent(vaultNamespace(options.data.vaultId))}${options.data.collectionId ? `&collection=${encodeURIComponent(options.data.collectionId)}` : ""}` };
  }
}
