/* eslint-disable */
// SPIKE ONLY (never released). Stage 0 probe: can the mdbase SDK engine's
// browser requirements be met inside Obsidian on a phone, without Node?
// Writes everything it learns to `mdbase-mobile-probe-results.md` in the vault.
import { Notice, Platform, Plugin, requestUrl } from "obsidian";

const CP = "https://connect-lab.mdbase.dev";
const LOG = "https://mdbase-next-log-lab-20261005.callumalpass.workers.dev";
const RESULTS = "mdbase-mobile-probe-results.md";
// (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const WASM = [0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11];

// ---- code that runs in a Worker (classic or module; no imports) -------------
const WORKER_SRC = `
self.onmessage = async (e) => {
  const r = {};
  const t = async (k, f) => { try { r[k] = await f(); } catch (err) { r[k] = "ERR " + (err && ((err.name || "") + ": " + (err.message || err))); } };
  r.origin = self.location.origin; r.protocol = self.location.protocol;
  r.isSecureContext = self.isSecureContext; r.crossOriginIsolated = self.crossOriginIsolated;
  r.sharedArrayBuffer = typeof SharedArrayBuffer; r.atomicsWait = typeof Atomics !== "undefined" && typeof Atomics.wait;
  await t("opfsGetDirectory", async () => { const d = await navigator.storage.getDirectory(); return "ok"; });
  await t("createSyncAccessHandle", async () => {
    const d = await navigator.storage.getDirectory();
    const fh = await d.getFileHandle("probe-sah-" + (e.data.label || "w") + ".bin", { create: true });
    if (typeof fh.createSyncAccessHandle !== "function") return "missing";
    const h = await fh.createSyncAccessHandle();
    const n = h.write(new Uint8Array([1, 2, 3, 4]), { at: 0 }); h.flush(); const size = h.getSize(); h.close();
    return "ok wrote " + n + " size " + size;
  });
  await t("locks", async () => navigator.locks ? await navigator.locks.request("probe-worker", async () => "ok") : "missing");
  await t("broadcastChannel", async () => typeof BroadcastChannel === "function" ? "present" : "missing");
  await t("indexedDB", async () => await new Promise((res, rej) => { const q = indexedDB.open("probe-worker-idb", 1); q.onsuccess = () => { q.result.close(); res("ok"); }; q.onerror = () => rej(q.error); }));
  await t("wasmFromBytes", async () => { const m = await WebAssembly.instantiate(new Uint8Array(e.data.wasm)); return m.instance.exports.add(2, 3) === 5 ? "ok" : "wrong"; });
  if (e.data.wasmUrl) await t("wasmStreamingByUrl", async () => { const m = await WebAssembly.instantiateStreaming(fetch(e.data.wasmUrl)); return m.instance.exports.add(2, 3) === 5 ? "ok" : "wrong"; });
  await t("cryptoSubtle", async () => typeof crypto.subtle?.digest === "function" ? "present" : "missing");
  postMessage(r);
};`;

// ---- code that runs in a page (Obsidian's window or any iframe) -------------
// Defined as a real function so it can be both called here and stringified into
// iframes. It must not close over anything outside itself.
async function pageProbe(cfg: { label: string; wasm: number[]; workerSrc: string; wasmUrl?: string; workerUrl?: string; network?: { cp: string; log: string } }): Promise<any> {
  const r: any = { label: cfg.label };
  const t = async (k: string, f: () => any, ms = 15000) => {
    try { r[k] = await Promise.race([Promise.resolve().then(f), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms + "ms")), ms))]); }
    catch (err: any) { r[k] = "ERR " + (err && ((err.name || "") + ": " + (err.message || err))); }
  };
  r.origin = location.origin; r.protocol = location.protocol;
  r.hrefShape = location.href.replace(/[?#].*$/, "").replace(/[0-9a-f]{16,}/g, "<hex>").slice(0, 200);
  r.isSecureContext = isSecureContext; r.crossOriginIsolated = (self as any).crossOriginIsolated;
  r.sharedArrayBuffer = typeof SharedArrayBuffer;
  r.cspMeta = Array.from(document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')).map((m: any) => m.content);
  await t("cspHeaderOfDocument", async () => {
    if (!/^https?:$/.test(location.protocol)) return "n/a (" + location.protocol + ")";
    const res = await fetch(location.href, { cache: "no-store" }); return res.headers.get("content-security-policy");
  });
  await t("evalAllowed", () => new Function("return 1")() === 1 ? "yes" : "no");
  await t("localStorage", () => { localStorage.setItem("mdbase-probe", cfg.label); return "ok"; });
  await t("opfsGetDirectory", async () => { await navigator.storage.getDirectory(); return "ok"; });
  // Storage sharing: every context drops a marker; listing shows who shares.
  await t("opfsMarkersSeen", async () => {
    const d: any = await navigator.storage.getDirectory();
    await d.getFileHandle("probe-marker-" + cfg.label.replace(/[^a-z0-9-]/gi, "_"), { create: true });
    const names: string[] = []; for await (const k of d.keys()) if (String(k).startsWith("probe-marker-")) names.push(String(k).slice(13));
    return names.sort();
  });
  await t("storagePersisted", async () => navigator.storage.persisted ? await navigator.storage.persisted() : "missing");
  await t("storageEstimate", async () => { const e: any = await navigator.storage.estimate(); return { quotaMB: Math.round(e.quota / 1048576), usageMB: Math.round(e.usage / 1048576) }; });
  await t("locks", async () => (navigator as any).locks ? await (navigator as any).locks.request("probe-page-" + cfg.label, async () => "ok") : "missing");
  await t("broadcastChannel", async () => {
    const a = new BroadcastChannel("probe-bc-" + cfg.label), b = new BroadcastChannel("probe-bc-" + cfg.label);
    const got = new Promise(res => { b.onmessage = e => res(e.data); });
    a.postMessage("ping"); const v = await got; a.close(); b.close(); return v === "ping" ? "ok" : "wrong";
  }, 3000);
  await t("indexedDB", async () => await new Promise((res, rej) => { const q = indexedDB.open("probe-page-idb", 1); q.onsuccess = () => { q.result.close(); res("ok"); }; q.onerror = () => rej(q.error); }));
  await t("wasmCompileFromBytes", async () => { const m = await WebAssembly.instantiate(new Uint8Array(cfg.wasm)); return (m.instance.exports as any).add(2, 3) === 5 ? "ok" : "wrong"; });
  if (cfg.wasmUrl) {
    await t("wasmFetchByUrl", async () => { const res = await fetch(cfg.wasmUrl!); return { status: res.status, type: res.headers.get("content-type"), bytes: (await res.arrayBuffer()).byteLength }; });
    await t("wasmStreamingByUrl", async () => { const m = await WebAssembly.instantiateStreaming(fetch(cfg.wasmUrl!)); return (m.instance.exports as any).add(2, 3) === 5 ? "ok" : "wrong"; });
  }
  await t("decompressionStream", () => {
    const out: any = {};
    for (const f of ["gzip", "deflate", "deflate-raw", "br", "brotli"]) { try { new DecompressionStream(f as any); out[f] = "yes"; } catch { out[f] = "no"; } }
    return out;
  });
  await t("cryptoRandomUUID", () => typeof crypto.randomUUID === "function" ? "present" : "missing");
  const runWorker = (w: Worker) => new Promise((res, rej) => {
    w.onmessage = e => { res(e.data); w.terminate(); };
    w.onerror = (e: any) => { rej(new Error("worker error: " + (e.message || "no message"))); w.terminate(); };
    (w as any).onmessageerror = () => rej(new Error("messageerror"));
    w.postMessage({ wasm: cfg.wasm, wasmUrl: cfg.wasmUrl, label: cfg.label });
  });
  await t("blobClassicWorker", async () => runWorker(new Worker(URL.createObjectURL(new Blob([cfg.workerSrc], { type: "text/javascript" })))));
  await t("blobModuleWorker", async () => runWorker(new Worker(URL.createObjectURL(new Blob([cfg.workerSrc], { type: "text/javascript" })), { type: "module" })));
  if (cfg.workerUrl) await t("moduleWorkerByUrl", async () => runWorker(new Worker(cfg.workerUrl!, { type: "module" })));
  if (cfg.network) {
    const net = async (method: string, url: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(url, { method, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", ...init });
        const text = await res.text();
        return { status: res.status, acao: res.headers.get("access-control-allow-origin"), body: text.slice(0, 240) };
      } catch (err: any) { return "ERR " + (err?.name || "") + ": " + (err?.message || err); }
    };
    const json = { "content-type": "application/json" };
    r.network = {
      cpHealth: await net("GET", cfg.network.cp + "/health"),
      cpAppsRegisterEmpty: await net("POST", cfg.network.cp + "/v1/apps/register", { headers: json, body: "{}" }),
      cpPairingEmpty: await net("POST", cfg.network.cp + "/v1/pairing-requests", { headers: json, body: JSON.stringify({ installation: {} }) }),
      logHealth: await net("GET", cfg.network.log + "/health"),
      logNonce: await net("GET", cfg.network.log + "/v1/nonce"),
      logRpcBogus: await net("POST", cfg.network.log + "/v1/rpc", { headers: { authorization: "Bearer probe", "content-type": "application/cbor", "x-mdbase-nonce": "00", "x-mdbase-sig": "00" }, body: new Uint8Array([0xa0]) }),
    };
    await t("relayWebSocket", () => new Promise(res => {
      const ws = new WebSocket(cfg.network!.cp.replace(/^https/, "wss") + "/v1/next/relay/client");
      const events: string[] = []; const done = () => res(events);
      ws.onopen = () => { events.push("open"); setTimeout(() => ws.close(), 1500); };
      ws.onerror = () => events.push("error");
      ws.onclose = e => { events.push("close " + e.code + " " + (e.reason || "")); done(); };
      setTimeout(done, 8000);
    }), 10000);
  }
  return r;
}

const RELATIVE_DEP = `export const dep = "relative import ok";`;

function framePage(kind: string, probeCall: string, extraHead = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">${extraHead}</head><body><script type="module">
const pageProbe = ${pageProbe.toString()};
let relativeImport; try { relativeImport = (await import("./dep.js")).dep; } catch (err) { relativeImport = "ERR " + err.name + ": " + err.message; }
let result; try { result = await ${probeCall}; result.relativeImport = relativeImport; } catch (err) { result = { fatal: String(err) }; }
parent.postMessage({ mdbaseProbe: ${JSON.stringify(kind)}, result }, "*");
</script></body></html>`;
}

export default class MobileProbe extends Plugin {
  results: any = {};
  async onload() {
    this.registerObsidianProtocolHandler("mdbase-probe", async params => {
      const entry = { at: new Date().toISOString(), params: { ...params } };
      this.results.protocolHandler = [...(this.results.protocolHandler ?? []), entry];
      new Notice("mdbase probe: protocol handler fired");
      await this.save();
    });
    this.addCommand({ id: "run", name: "Run mobile probe", callback: () => void this.run() });
    this.app.workspace.onLayoutReady(() => void this.run());
  }

  async save() {
    const text = "# mdbase mobile probe\n\n```json\n" + JSON.stringify(this.results, null, 2) + "\n```\n";
    await this.app.vault.adapter.write(RESULTS, text);
  }

  async run() {
    new Notice("mdbase probe: running");
    const a: any = this.app.vault.adapter;
    const dir = `${this.manifest.dir}/host`;
    const r: any = this.results = { ...this.results, startedAt: new Date().toISOString(), finished: false };
    try {
      r.obsidian = { apiVersion: (window as any).apiVersion ?? null, adapter: a.constructor?.name, basePath: typeof a.getBasePath === "function" ? "has getBasePath" : "none", pluginDir: this.manifest.dir };
      r.platform = Object.fromEntries(["isDesktop", "isMobile", "isDesktopApp", "isMobileApp", "isIosApp", "isAndroidApp", "isPhone", "isTablet", "isMacOS", "isWin", "isLinux", "isSafari"].map(k => [k, (Platform as any)[k]]));
      r.userAgent = navigator.userAgent;
      try { r.uaFullVersionList = await (navigator as any).userAgentData?.getHighEntropyValues?.(["fullVersionList", "platformVersion"]); } catch (e) { r.uaFullVersionList = String(e); }
      r.nodeRequire = typeof (window as any).require;
      r.hasProcess = typeof (window as any).process;
      await this.save();

      // Assets for hosting method (a): plain files in the plugin folder.
      if (!(await a.exists(dir))) await a.mkdir(dir);
      await a.write(`${dir}/dep.js`, RELATIVE_DEP);
      await a.write(`${dir}/worker.js`, WORKER_SRC);
      await a.writeBinary(`${dir}/tiny.wasm`, new Uint8Array(WASM).buffer);
      await a.write(`${dir}/main.js`, `import { dep } from "./dep.js";
const pageProbe = ${pageProbe.toString()};
let result; try { result = await pageProbe({ label: "a-resource", wasm: ${JSON.stringify(WASM)}, workerSrc: ${JSON.stringify(WORKER_SRC)}, wasmUrl: new URL("./tiny.wasm", import.meta.url).href, workerUrl: new URL("./worker.js", import.meta.url).href, network: ${JSON.stringify({ cp: CP, log: LOG })} }); result.relativeImport = dep; } catch (err) { result = { fatal: String(err) }; }
parent.postMessage({ mdbaseProbe: "a-resource", result }, "*");`);
      await a.write(`${dir}/index.html`, `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="./main.js"></script></body></html>`);
      const res = (p: string) => a.getResourcePath(`${dir}/${p}`) as string;
      const shape = (u: string) => u.replace(/\?.*$/, "?<q>").replace(/[0-9a-f]{16,}/g, "<hex>");
      r.resourcePathShape = { index: shape(res("index.html")), wasm: shape(res("tiny.wasm")) };
      // Resource URLs: Obsidian appends ?<mtime>; strip it for derived URLs.
      const base = res("index.html").replace(/\?.*$/, "").replace(/index\.html$/, "");
      await this.headers(r, base);

      // (d) no iframe: Obsidian's own window.
      r.d_window = await pageProbe({ label: "d-window", wasm: WASM, workerSrc: WORKER_SRC, wasmUrl: base + "tiny.wasm", workerUrl: base + "worker.js", network: { cp: CP, log: LOG } });
      r.requestUrl = await this.viaRequestUrl();
      await this.save();

      const probeCall = (label: string) => `pageProbe({ label: ${JSON.stringify(label)}, wasm: ${JSON.stringify(WASM)}, workerSrc: ${JSON.stringify(WORKER_SRC)}, wasmUrl: ${JSON.stringify(base + "tiny.wasm")}, workerUrl: ${JSON.stringify(base + "worker.js")} })`;
      // (a) iframe on the resource path.
      r.a_resource = await this.frame("a-resource", f => { f.src = res("index.html"); });
      await this.save();
      // (b) blob: iframe, without and with <base> pointing at the plugin folder.
      r.b_blob = await this.frame("b-blob", f => { f.src = URL.createObjectURL(new Blob([framePage("b-blob", probeCall("b-blob"))], { type: "text/html" })); });
      r.b_blob_base = await this.frame("b-blob-base", f => { f.src = URL.createObjectURL(new Blob([framePage("b-blob-base", probeCall("b-blob-base"), `<base href="${base}">`)], { type: "text/html" })); });
      await this.save();
      // (c) srcdoc, without and with <base>.
      r.c_srcdoc = await this.frame("c-srcdoc", f => { f.srcdoc = framePage("c-srcdoc", probeCall("c-srcdoc")); });
      r.c_srcdoc_base = await this.frame("c-srcdoc-base", f => { f.srcdoc = framePage("c-srcdoc-base", probeCall("c-srcdoc-base"), `<base href="${base}">`); });
    } catch (e: any) {
      r.fatal = String(e?.stack ?? e);
    }
    r.finished = true; r.finishedAt = new Date().toISOString();
    await this.save();
    new Notice("mdbase probe: done, see " + RESULTS, 8000);
  }

  async headers(r: any, base: string) {
    const out: any = {};
    for (const p of ["index.html", "main.js", "tiny.wasm"]) {
      try {
        const res = await fetch(base + p, { cache: "no-store" });
        out[p] = { status: res.status, type: res.headers.get("content-type"), csp: res.headers.get("content-security-policy"), coop: res.headers.get("cross-origin-opener-policy"), coep: res.headers.get("cross-origin-embedder-policy") };
      } catch (e: any) { out[p] = "ERR " + e?.name + ": " + e?.message; }
    }
    r.resourceFetchHeaders = out;
  }

  frame(kind: string, set: (f: HTMLIFrameElement) => void, ms = 60000): Promise<any> {
    return new Promise(resolve => {
      const f = document.body.createEl("iframe");
      Object.assign(f.style, { position: "fixed", width: "1px", height: "1px", border: "0", left: "-10px", top: "-10px" });
      const events: string[] = [];
      f.addEventListener("load", () => events.push("load"));
      f.addEventListener("error", () => events.push("error"));
      const done = (v: any) => { window.removeEventListener("message", on); window.clearTimeout(timer); f.remove(); resolve({ ...v, frameEvents: events }); };
      const on = (e: MessageEvent) => { if (e.data?.mdbaseProbe === kind) done({ result: e.data.result, messageOrigin: e.origin }); };
      window.addEventListener("message", on);
      const timer = window.setTimeout(() => done({ result: null, error: `no message within ${ms}ms` }), ms);
      try { set(f); } catch (e: any) { done({ result: null, error: "set failed: " + e?.message }); }
    });
  }

  async viaRequestUrl() {
    const call = async (method: string, url: string, body?: string, headers: Record<string, string> = {}) => {
      try {
        const res = await requestUrl({ url, method, body, headers, throw: false });
        return { status: res.status, body: res.text.slice(0, 240) };
      } catch (e: any) { return "ERR " + e?.name + ": " + e?.message; }
    };
    return {
      cpHealth: await call("GET", CP + "/health"),
      cpPairingEmpty: await call("POST", CP + "/v1/pairing-requests", JSON.stringify({ installation: {} }), { "content-type": "application/json" }),
      logNonce: await call("GET", LOG + "/v1/nonce"),
    };
  }
}
