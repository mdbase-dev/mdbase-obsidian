/* eslint-disable */
// SPIKE ONLY (never released). Stage 1-3 engine host for Obsidian mobile:
// no Node. The SDK assets are written as plain files into the plugin folder
// (gzip-decoded with DecompressionStream), loaded by a blob: iframe whose
// <base> points at that folder, and driven over the same MessagePort RPC as
// the desktop host. Everything learned goes to `mdbase-engine-status.md`.
// Driven by `mdbase-engine-control.json` (pushed with adb): {seq, action, args}.
import { Notice, Plugin, normalizePath } from "obsidian";
import packed from "embedded:engine";

const STATUS = "mdbase-engine-status.md";
const CONTROL = "mdbase-engine-control.json";
const DOWNLOADS = "mdbase-spike-download";
const TRACE = "mdbase-engine-trace.log";

async function gunzip(b64: string): Promise<Uint8Array> {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), b => b.toString(16).padStart(2, "0")).join("");
}

export default class Engine extends Plugin {
  log: { t: string; m: string }[] = [];
  phases: any[] = [];
  results: Record<string, any> = {};
  frame: HTMLIFrameElement | null = null;
  bridge: MessagePort | null = null;
  calls = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  next = 1;
  lastSeq = -1;
  writing: Promise<void> = Promise.resolve();
  config: { platform: "native" | "omit"; patchWorker: boolean; hideHistory: boolean; blockFreeze: boolean; vault: string; urlToFile?: boolean } = { platform: "native", patchWorker: true, hideHistory: false, blockFreeze: false, vault: "" };
  downloaded: { id: string; path: string; revision: string; local: string } | null = null;

  async onload() {
    this.registerDomEvent(window, "message", e => this.onMessage(e));
    // SPIKE B4: the main window's own lifecycle, for comparison with the iframe's.
    for (const name of ["visibilitychange", "freeze", "resume"]) this.registerDomEvent(document, name as any, () => this.note(`main ${name} vis=${document.visibilityState}`));
    for (const name of ["pagehide", "pageshow", "focus", "blur"]) this.registerDomEvent(window, name as any, () => this.note(`main ${name}`));
    this.app.workspace.onLayoutReady(async () => {
      try { const c = JSON.parse(await this.app.vault.adapter.read(CONTROL)); this.lastSeq = c.seq ?? -1; if (c.config) Object.assign(this.config, c.config); } catch { /* none yet */ }
      this.note(`plugin loaded; config ${JSON.stringify(this.config)}; control seq ${this.lastSeq}`);
      this.registerInterval(window.setInterval(() => void this.poll(), 2000));
    });
  }
  onunload() { this.bridge?.close(); this.frame?.remove(); }

  traceLines: string[] = [];
  traceTimer: number | null = null;
  // SPIKE B4: one line per event, wall clock first. Buffered; appended at most once a second.
  trace(line: string) {
    this.traceLines.push(line);
    if (this.traceTimer === null) this.traceTimer = window.setTimeout(() => {
      this.traceTimer = null;
      const text = this.traceLines.splice(0).join("\n") + "\n";
      this.writing = this.writing.then(async () => { const a = this.app.vault.adapter; if (await a.exists(TRACE)) await a.append(TRACE, text); else await a.write(TRACE, text); }).catch(() => {});
    }, 1000);
  }
  note(m: string) {
    const t = new Date().toISOString();
    this.log.push({ t, m });
    this.trace(`${t} [plugin] ${m}`);
    this.save();
  }
  save() {
    const text = "# mdbase engine spike\n\n```json\n" + JSON.stringify({ config: this.config, results: this.results, phases: this.phases.slice(-40), log: this.log.slice(-200) }, null, 2) + "\n```\n";
    this.writing = this.writing.then(() => this.app.vault.adapter.write(STATUS, text)).catch(() => {});
  }

  async poll() {
    let c: any;
    try { c = JSON.parse(await this.app.vault.adapter.read(CONTROL)); } catch { return; }
    if (typeof c.seq !== "number" || c.seq === this.lastSeq) return;
    this.lastSeq = c.seq;
    if (c.config) Object.assign(this.config, c.config);
    const action = String(c.action);
    this.note(`control #${c.seq}: ${action}`);
    new Notice(`mdbase engine: ${action}`);
    try {
      const value = await this.act(action, c.args ?? []);
      this.results[`${c.seq}:${action}`] = { ok: true, value };
      this.note(`control #${c.seq} ${action} ok`);
    } catch (e: any) {
      this.results[`${c.seq}:${action}`] = { ok: false, error: { code: e?.code ?? null, reason: e?.reason ?? null, message: String(e?.message ?? e).slice(0, 400) } };
      this.note(`control #${c.seq} ${action} failed: ${e?.code ?? ""} ${e?.reason ?? ""} ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  async act(action: string, args: any[]): Promise<any> {
    switch (action) {
      case "install": return this.install();
      case "boot": return this.boot();
      case "unboot": this.bridge?.close(); this.bridge = null; this.frame?.remove(); this.frame = null; return "removed";
      case "list": {
        const all: any[] = await this.call("all");
        return { count: all.length, items: all.slice(0, 20).map(r => ({ id: r.id, path: r.path, revision: r.revision, bytes: r.document?.length ?? null, confirmed: r.confirmed })) };
      }
      case "download": {
        const all: any[] = await this.call("all");
        const pick = args[0] ? all.find(r => r.path === args[0]) : all.find(r => typeof r.document === "string" && r.path.endsWith(".md"));
        if (!pick) throw new Error("no record to download");
        const local = normalizePath(`${DOWNLOADS}/${pick.path}`);
        const dirs = local.split("/").slice(0, -1);
        for (let i = 1; i <= dirs.length; i++) { const d = dirs.slice(0, i).join("/"); if (!(await this.app.vault.adapter.exists(d))) await this.app.vault.createFolder(d); }
        const existing = this.app.vault.getFileByPath(local);
        if (existing) await this.app.vault.modify(existing, pick.document); else await this.app.vault.create(local, pick.document);
        const back = await this.app.vault.adapter.read(local);
        this.downloaded = { id: pick.id, path: pick.path, revision: pick.revision, local };
        return { id: pick.id, path: pick.path, revision: pick.revision, local, bytes: pick.document.length, sha256Remote: await sha256(pick.document), sha256OnDisk: await sha256(back) };
      }
      case "edit": {
        if (!this.downloaded) throw new Error("download first");
        const d = this.downloaded;
        const file = this.app.vault.getFileByPath(d.local);
        if (!file) throw new Error("downloaded file missing");
        const base = (await this.call("get", d.id)).document;
        const next = await this.app.vault.process(file, text => text.replace(/\n*$/, "\n") + `\nEdited on Android by the mdbase mobile spike at ${new Date().toISOString()}.\n`);
        const w = await this.call("replace", d.id, { path: d.path, doc: base }, { path: d.path, doc: next }, d.revision);
        this.downloaded = { ...d, revision: w.revision };
        const confirm = await this.call("get", d.id);
        return { written: { id: w.id, path: w.path, revision: w.revision, via: w.via }, readBack: { revision: confirm.revision, confirmed: confirm.confirmed, matchesLocal: confirm.document === next, sha256: await sha256(confirm.document) } };
      }
      default: return this.call(action, ...args);
    }
  }

  get engineDir() { return normalizePath(`${this.manifest.dir}/engine`); }

  // Write SDK assets as plain files. Returns timing and what was written.
  async install() {
    const a = this.app.vault.adapter, started = performance.now(), out: any = {};
    for (const [rel, entry] of Object.entries(packed as Record<string, { gz: string; bytes: number; sha256: string }>)) {
      const path = normalizePath(`${this.engineDir}/${rel}`);
      const dirs = path.split("/").slice(0, -1);
      for (let i = 1; i <= dirs.length; i++) { const d = dirs.slice(0, i).join("/"); if (!(await a.exists(d))) await a.mkdir(d); }
      const t0 = performance.now();
      const bytes = await gunzip(entry.gz);
      const digest = await sha256(bytes);
      if (bytes.length !== entry.bytes || digest !== entry.sha256) throw new Error(`asset mismatch ${rel}`);
      await a.writeBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      const back = new Uint8Array(await a.readBinary(path));
      out[rel] = { bytes: bytes.length, ms: Math.round(performance.now() - t0), readBackOk: (await sha256(back)) === digest };
    }
    out.totalMs = Math.round(performance.now() - started);
    return out;
  }

  async boot() {
    if (!this.config.vault) this.config.vault = `obsidian-vault-spike-${(this.app as any).appId ?? "x"}`;
    this.bridge?.close(); this.bridge = null; this.frame?.remove();
    const res = (this.app.vault.adapter as any).getResourcePath(`${this.engineDir}/app.js`) as string;
    const base = res.replace(/\?.*$/, "").replace(/app\.js$/, "");
    const cfg = { vault: this.config.vault, platform: this.config.platform };
    const html = `<!doctype html><html><head><meta charset="utf-8"><base href="${base}"></head><body><script type="module">
globalThis.__mdbaseSpike = ${JSON.stringify(cfg)};
if (${JSON.stringify(this.config.hideHistory)}) {
  // SPIKE HACK: the SDK reads ?collection= from location.href; a blob: URL has
  // no app origin, so hide history to make the SDK use its no-URL policy.
  try { Object.defineProperty(window, "history", { value: undefined, configurable: true }); } catch (e) { parent.postMessage({ mdbaseEngine: true, type: "boot", text: "history hide failed " + e }, "*"); }
}
const send = (m) => parent.postMessage({ mdbaseEngine: true, ...m }, "*");
window.addEventListener("error", (e) => send({ type: "boot", text: "window error: " + e.message + " " + (e.filename || "") + ":" + (e.lineno || "") }));
window.addEventListener("unhandledrejection", (e) => send({ type: "boot", text: "unhandled rejection: " + (e.reason && (e.reason.code || "") + " " + (e.reason.reason || "") + " " + (e.reason.message || e.reason)) }));
for (const [target, names] of [[window, ["pagehide", "pageshow", "focus", "blur", "online", "offline"]], [document, ["visibilitychange", "freeze", "resume"]]]) {
  for (const name of names) target.addEventListener(name, (e) => {
    const block = ${JSON.stringify(this.config.blockFreeze)} && (name === "freeze" || name === "resume" || name === "pagehide" || name === "pageshow");
    if (block) e.stopImmediatePropagation();
    send({ type: "boot", text: "lifecycle " + name + " at " + new Date().toISOString() + " vis=" + document.visibilityState + (e.persisted !== undefined ? " persisted=" + e.persisted : "") + (block ? " (hidden from SDK)" : "") });
  }, { capture: true });
}
try {
  send({ type: "boot", text: "frame origin " + location.origin + " secure " + isSecureContext + " history " + typeof window.history });
  if (${JSON.stringify(this.config.patchWorker)}) {
    const workerUrl = new URL("./sdk/application/worker.js", document.baseURI).href;
    const text = await (await fetch(workerUrl, { cache: "no-store" })).text();
    const n = text.split("import.meta.url").length - 1;
    const blobUrl = URL.createObjectURL(new Blob([text.replaceAll("import.meta.url", JSON.stringify(workerUrl))], { type: "text/javascript" }));
    const Orig = window.Worker;
    window.Worker = class extends Orig { constructor(url, opts) { const u = String(url); super(u === workerUrl ? blobUrl : url, opts); send({ type: "boot", text: "Worker(" + (u === workerUrl ? "sdk worker -> blob" : u) + ")" }); } };
    send({ type: "boot", text: "Worker patched; import.meta.url occurrences replaced: " + n });
  } else {
    const Orig = window.Worker;
    window.Worker = class extends Orig { constructor(url, opts) { super(url, opts); send({ type: "boot", text: "Worker(" + String(url).replace(/^.*\\/plugins\\//, ".../plugins/") + ") unpatched" }); } };
  }
  await import("./app.js");
  send({ type: "boot", text: "app.js imported" });
} catch (err) { send({ type: "boot-error", text: String((err && (err.message || err)) || err).slice(0, 400), code: err && err.code, reason: err && err.reason }); }
</script></body></html>`;
    this.frame = document.body.createEl("iframe", { attr: { "data-mdbase-spike": "1" } });
    Object.assign(this.frame.style, { position: "fixed", width: "1px", height: "1px", border: "0", left: "-10px", top: "-10px" });
    this.frame.src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    this.note(`booting blob iframe, base ${base.replace(/^.*\/plugins\//, ".../plugins/")}, cfg ${JSON.stringify(cfg)}`);
    return "booting";
  }

  onMessage(e: MessageEvent) {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const m = e.data;
    if (m?.mdbaseEngine) { this.note(`${m.type}: ${m.text}${m.code ? ` code=${m.code}` : ""}${m.reason ? ` reason=${m.reason}` : ""}`); return; }
    if (m?.type === "hello" && !this.bridge) {
      this.note(`hello from page: origin ${m.origin}, opfs ${m.opfs}, secure ${m.isSecureContext}`);
      const ch = new MessageChannel();
      this.bridge = ch.port1;
      this.bridge.onmessage = ev => this.onBridge(ev.data);
      this.frame.contentWindow!.postMessage({ type: "connect" }, "*", [ch.port2]);
    }
  }

  onBridge(m: any) {
    switch (m.type) {
      case "phase": {
        this.phases.push({ t: new Date().toISOString(), ...m.phase });
        this.note(`phase ${m.phase.kind}${m.phase.problem ? ` problem ${m.phase.problem.code}/${m.phase.problem.reason} action=${m.phase.problem.action}: ${m.phase.problem.message}` : ""}`);
        new Notice(`mdbase engine phase: ${m.phase.kind}`);
        break;
      }
      case "log": this.note(`page: ${m.text}`); break;
      case "trace": { const { t, ctx, tag, ...rest } = m.ev ?? {}; this.trace(`${t} [${ctx}] ${tag} ${JSON.stringify(rest)}`); break; }
      // The sign-in URL is a bearer secret: open it, never log or store it.
      // B4 control (a): approve on another machine while Obsidian stays in front. The URL goes
      // to a plugin-private file (pulled over adb, never logged) instead of opening the browser.
      case "open-url": if (this.config.urlToFile) { this.note("open-url written to pending-url.txt (URL not logged)"); void this.app.vault.adapter.write(normalizePath(`${this.manifest.dir}/pending-url.txt`), m.url); } else { this.note("open-url requested (URL not logged)"); window.open(m.url, "_blank"); } break;
      case "result": {
        const c = this.calls.get(m.id); if (!c) return; this.calls.delete(m.id);
        if (m.ok) c.resolve(m.value); else c.reject(Object.assign(new Error(m.error?.message ?? "error"), m.error ?? {}));
        break;
      }
      case "changes": this.note(`changes: ${m.batch.changes.length} (reset ${m.batch.reset})`); break;
      case "transfer": break;
    }
  }

  call(method: string, ...args: any[]): Promise<any> {
    if (!this.bridge) return Promise.reject(new Error("engine not connected"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.bridge!.postMessage({ type: "call", id, method, args });
      window.setTimeout(() => { if (this.calls.delete(id)) reject(new Error(`timeout ${method}`)); }, 180_000);
    });
  }
}
