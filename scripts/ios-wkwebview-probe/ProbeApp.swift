import Foundation
import UIKit
import WebKit

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let assetsDir: URL
    private var stopped = Set<ObjectIdentifier>()

    init(assetsDir: URL) {
        self.assetsDir = assetsDir
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "Probe", code: 400))
            return
        }
        let path = url.path
        let response: (Data, String)?
        switch path {
        case "/", "/index.html":
            response = (Data(ProbeHTML.index.utf8), "text/html; charset=utf-8")
        case "/_capacitor_file_/vault/.plugin/sync-engine/direct.html":
            response = (Data(ProbeHTML.directFrame.utf8), "text/html; charset=utf-8")
        case "/_capacitor_file_/vault/.plugin/sync-engine/helper.js":
            response = (Data("export const ok = 42;\n".utf8), "text/javascript; charset=utf-8")
        case "/_capacitor_file_/vault/.plugin/sync-engine/worker.js":
            response = (Data(ProbeHTML.worker.utf8), "text/javascript; charset=utf-8")
        case "/_capacitor_file_/vault/.plugin/sync-engine/sdk/native/sqlite3.js":
            response = loadAsset("sqlite3.js", mime: "text/javascript; charset=utf-8")
        case "/_capacitor_file_/vault/.plugin/sync-engine/sdk/native/sqlite3.wasm":
            response = loadAsset("sqlite3.wasm", mime: "application/wasm")
        case "/_capacitor_file_/vault/.plugin/sync-engine/sdk/native/runtime.wasm":
            response = loadAsset("runtime.wasm", mime: "application/wasm")
        default:
            response = nil
        }

        if stopped.contains(id) { return }
        guard let (data, mime) = response else {
            let notFound = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
            urlSchemeTask.didReceive(notFound)
            urlSchemeTask.didFinish()
            return
        }
        let headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(data.count)",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
        ]
        let http = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(http)
        urlSchemeTask.didReceive(data)
        if !stopped.contains(id) {
            urlSchemeTask.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func loadAsset(_ name: String, mime: String) -> (Data, String)? {
        let file = assetsDir.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: file) else { return nil }
        return (data, mime)
    }
}

enum ProbeHTML {
    static let worker = #"""
const BASE = "capacitor://localhost/_capacitor_file_/vault/.plugin/sync-engine/";

function urlOrigin(url) {
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : `${url.protocol}//${url.host}`;
}
function currentAppOrigin() {
  const loc = globalThis.location;
  if (!loc) return null;
  if (typeof loc.origin === "string" && loc.origin !== "null") return loc.origin;
  try {
    const url = new URL(loc.href);
    if (url.protocol === "blob:") {
      const origin = urlOrigin(new URL(url.pathname));
      return origin.startsWith("capacitor://") ? origin : null;
    }
    return urlOrigin(url);
  } catch { return null; }
}

self.onmessage = async (event) => {
  const poolTag = event.data?.poolTag || "probe";
  const out = {
    href: location.href,
    origin: location.origin,
    currentAppOrigin: currentAppOrigin(),
    isSecureContext,
    hasOpfs: typeof navigator.storage?.getDirectory === "function",
    hasLocks: typeof navigator.locks?.request === "function",
    hasBroadcast: typeof BroadcastChannel === "function",
    hasIndexedDB: typeof indexedDB !== "undefined",
    hasAbortAny: typeof AbortSignal?.any === "function",
    hasDecompression: typeof DecompressionStream === "function",
  };

  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    out.x25519 = { ok: true };
  } catch (e) { out.x25519 = { ok: false, error: String(e) }; }

  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(`probe-${poolTag}`, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { req.result.close(); resolve(); };
    });
    out.idb = { ok: true };
  } catch (e) { out.idb = { ok: false, error: String(e) }; }

  try {
    const got = await navigator.locks.request(`probe-lock-${poolTag}`, async () => "held");
    out.locks = { ok: got === "held" };
  } catch (e) { out.locks = { ok: false, error: String(e) }; }

  try {
    const bc = new BroadcastChannel(`probe-bc-${poolTag}`);
    bc.close();
    out.broadcast = { ok: true };
  } catch (e) { out.broadcast = { ok: false, error: String(e) }; }

  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(".probe-sah", { create: true });
    const fh = await dir.getFileHandle(`${poolTag}.bin`, { create: true });
    const h = await fh.createSyncAccessHandle();
    const written = new Uint8Array([0x6d, 0x64, 0x62, 0x6e]);
    const read = new Uint8Array(4);
    const w = h.write(written, { at: 0 });
    h.flush();
    const r = h.read(read, { at: 0 });
    h.close();
    await dir.removeEntry(`${poolTag}.bin`);
    out.opfsSah = { ok: w === 4 && r === 4 && read[0] === 0x6d && read[3] === 0x6e };
  } catch (e) { out.opfsSah = { ok: false, error: String(e) }; }

  try {
    const res = await fetch(`${BASE}sdk/native/runtime.wasm`, { credentials: "omit", redirect: "error" });
    const bytes = new Uint8Array(await res.arrayBuffer());
    out.fetchRuntimeWasm = { ok: res.ok && bytes.length > 100000, status: res.status, bytes: bytes.length, url: res.url };
  } catch (e) { out.fetchRuntimeWasm = { ok: false, error: String(e) }; }

  try {
    const res = await fetch(`${BASE}sdk/native/sqlite3.wasm`, { credentials: "omit", redirect: "error" });
    const wasmBytes = new Uint8Array(await res.arrayBuffer());
    const { default: initSqlite } = await import(`${BASE}sdk/native/sqlite3.js`);
    globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
    const sqlite3 = await initSqlite({ wasmBinary: wasmBytes, print() {}, printErr() {} });
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: `mdbase-${poolTag}`, directory: `.mdbase-${poolTag}`, initialCapacity: 6 });
    const db = new pool.OpfsSAHPoolDb("/app.db");
    db.exec("CREATE TABLE IF NOT EXISTS t(x TEXT); DELETE FROM t; INSERT INTO t VALUES ('ios-ok');");
    const rows = db.selectArrays("SELECT x FROM t;");
    db.close();
    await pool.pauseVfs();
    out.sqliteSahPool = { ok: rows?.[0]?.[0] === "ios-ok", wasmBytes: wasmBytes.length, rows };
  } catch (e) { out.sqliteSahPool = { ok: false, error: String(e), stack: String(e?.stack || "").slice(0, 400) }; }

  self.postMessage(out);
};
"""#

    static let directFrame = #"""
<!doctype html>
<html>
<head><meta charset="utf-8"><base href="capacitor://localhost/_capacitor_file_/vault/.plugin/sync-engine/"></head>
<body>
<script type="module">
const info = {
  href: location.href,
  origin: location.origin,
  baseURI: document.baseURI,
  isSecureContext,
};
try {
  const m = await import("./helper.js");
  info.baseImport = { ok: m.ok === 42 };
} catch (e) { info.baseImport = { ok: false, error: String(e) }; }

try {
  await navigator.storage.getDirectory();
  info.opfs = { ok: true };
} catch (e) { info.opfs = { ok: false, error: String(e) }; }

async function runWorker(url, poolTag) {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 15000);
    try {
      const w = new Worker(url, { type: "module" });
      w.onmessage = (ev) => { clearTimeout(timer); w.terminate(); resolve(ev.data); };
      w.onerror = (ev) => { clearTimeout(timer); w.terminate(); resolve({ ok: false, error: ev.message || "worker error" }); };
      w.postMessage({ poolTag });
    } catch (e) { clearTimeout(timer); resolve({ ok: false, error: String(e) }); }
  });
}

info.directWorker = await runWorker("capacitor://localhost/_capacitor_file_/vault/.plugin/sync-engine/worker.js", "direct-frame-direct-worker");

window.addEventListener("message", (ev) => {
  if (ev.data?.type === "connect" && ev.ports[0]) {
    ev.ports[0].postMessage({ type: "pong", from: "direct-frame" });
  }
});
parent.postMessage({ type: "direct-result", info }, "*");
</script>
</body>
</html>
"""#

    static let index = #"""
<!doctype html>
<html>
<head><meta charset="utf-8"><title>WKWebView Probe</title></head>
<body>
<script type="module">
const BASE = "capacitor://localhost/_capacitor_file_/vault/.plugin/sync-engine/";
try {
const report = {
  userAgent: navigator.userAgent,
  top: {
    href: location.href,
    origin: location.origin,
    isSecureContext,
    sampleBlobUrl: URL.createObjectURL(new Blob(["hi"], { type: "text/plain" })),
    hasOpfs: typeof navigator.storage?.getDirectory === "function",
    hasLocks: typeof navigator.locks?.request === "function",
    hasBroadcast: typeof BroadcastChannel === "function",
    hasIndexedDB: typeof indexedDB !== "undefined",
    hasAbortAny: typeof AbortSignal?.any === "function",
    hasDecompression: typeof DecompressionStream === "function",
  },
};

try {
  await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  report.top.x25519 = { ok: true };
} catch (e) { report.top.x25519 = { ok: false, error: String(e) }; }

try {
  await navigator.storage.getDirectory();
  report.top.opfsGetDirectory = { ok: true };
} catch (e) { report.top.opfsGetDirectory = { ok: false, error: String(e) }; }

try {
  const compressed = new Uint8Array([0x1f,0x8b,0x08,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0xcb,0x48,0xcd,0xc9,0xc9,0x07,0x00,0x86,0xa6,0x10,0x36,0x05,0x00,0x00,0x00]);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  report.top.gzip = { ok: text === "hello" };
} catch (e) { report.top.gzip = { ok: false, error: String(e) }; }

async function runTopWorker(url, poolTag) {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 15000);
    try {
      const w = new Worker(url, { type: "module" });
      w.onmessage = (ev) => { clearTimeout(timer); w.terminate(); resolve(ev.data); };
      w.onerror = (ev) => { clearTimeout(timer); w.terminate(); resolve({ ok: false, error: ev.message || "worker error" }); };
      w.postMessage({ poolTag });
    } catch (e) { clearTimeout(timer); resolve({ ok: false, error: String(e) }); }
  });
}

// 1) Fetch worker.js text and test top-level blob Worker & direct Worker
const workerText = await (await fetch(`${BASE}worker.js`)).text();
const workerBlobUrl = URL.createObjectURL(new Blob([workerText], { type: "text/javascript" }));
report.workerBlobUrl = workerBlobUrl;
report.topBlobWorker = await runTopWorker(workerBlobUrl, "top-blob-worker");
report.topDirectWorker = await runTopWorker(`${BASE}worker.js`, "top-direct-worker");

// 2) Blob iframe + blob Worker (exact MobileHost architecture)
report.blobIframe = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 20000);
  const frameHtml = `<!doctype html><html><head><meta charset="utf-8"><base href="${BASE}"></head><body><script type="module">
    const info = { href: location.href, origin: location.origin, baseURI: document.baseURI, isSecureContext };
    try { const m = await import("./helper.js"); info.baseImport = { ok: m.ok === 42 }; }
    catch (e) { info.baseImport = { ok: false, error: String(e) }; }
    try { await navigator.storage.getDirectory(); info.opfs = { ok: true }; }
    catch (e) { info.opfs = { ok: false, error: String(e) }; }
    try { await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]); info.x25519 = { ok: true }; }
    catch (e) { info.x25519 = { ok: false, error: String(e) }; }
    try {
      await new Promise((res, rej) => { const req = indexedDB.open("probe-blob-iframe", 1); req.onerror = () => rej(req.error); req.onsuccess = () => { req.result.close(); res(); }; });
      info.idb = { ok: true };
    } catch (e) { info.idb = { ok: false, error: String(e) }; }
    try {
      const got = await navigator.locks.request("probe-blob-iframe-lock", async () => "held");
      info.locks = { ok: got === "held" };
    } catch (e) { info.locks = { ok: false, error: String(e) }; }
    info.blobWorker = await new Promise((res) => {
      const t = setTimeout(() => res({ ok: false, error: "timeout" }), 15000);
      try {
        const w = new Worker(${JSON.stringify(workerBlobUrl)}, { type: "module" });
        w.onmessage = (ev) => { clearTimeout(t); w.terminate(); res(ev.data); };
        w.onerror = (ev) => { clearTimeout(t); w.terminate(); res({ ok: false, error: ev.message || "worker error" }); };
        w.postMessage({ poolTag: "blob-iframe-blob-worker" });
      } catch (e) { clearTimeout(t); res({ ok: false, error: String(e) }); }
    });
    window.addEventListener("message", (ev) => {
      if (ev.data?.type === "connect" && ev.ports[0]) {
        ev.ports[0].postMessage({ type: "pong", receivedOrigin: ev.origin });
      }
    });
    parent.postMessage({ type: "blob-result", info }, "*");
  <\\/script></body></html>`;
  const frame = document.createElement("iframe");
  const handler = (ev) => {
    if (ev.source !== frame.contentWindow || ev.data?.type !== "blob-result") return;
    window.removeEventListener("message", handler);
    const ch = new MessageChannel();
    const pongTimer = setTimeout(() => {
      clearTimeout(timer);
      frame.remove();
      resolve({ messageEventOrigin: ev.origin, portHandshake: { ok: false, error: "pong timeout" }, info: ev.data.info });
    }, 3000);
    ch.port1.onmessage = (pev) => {
      clearTimeout(pongTimer);
      clearTimeout(timer);
      ch.port1.close();
      frame.remove();
      resolve({ messageEventOrigin: ev.origin, portHandshake: { ok: true, reply: pev.data }, info: ev.data.info });
    };
    frame.contentWindow.postMessage({ type: "connect" }, ev.origin === "null" ? "*" : "capacitor://localhost", [ch.port2]);
  };
  window.addEventListener("message", handler);
  frame.src = URL.createObjectURL(new Blob([frameHtml], { type: "text/html" }));
  document.body.append(frame);
});

// 3) Direct _capacitor_file_ iframe + direct Worker
report.directIframe = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), 20000);
  const frame = document.createElement("iframe");
  const handler = (ev) => {
    if (ev.source !== frame.contentWindow || ev.data?.type !== "direct-result") return;
    window.removeEventListener("message", handler);
    const ch = new MessageChannel();
    const pongTimer = setTimeout(() => {
      clearTimeout(timer);
      frame.remove();
      resolve({ messageEventOrigin: ev.origin, portHandshake: { ok: false, error: "pong timeout" }, info: ev.data.info });
    }, 3000);
    ch.port1.onmessage = (pev) => {
      clearTimeout(pongTimer);
      clearTimeout(timer);
      ch.port1.close();
      frame.remove();
      resolve({ messageEventOrigin: ev.origin, portHandshake: { ok: true, reply: pev.data }, info: ev.data.info });
    };
    frame.contentWindow.postMessage({ type: "connect" }, ev.origin === "null" ? "*" : "capacitor://localhost", [ch.port2]);
  };
  window.addEventListener("message", handler);
  frame.src = `${BASE}direct.html`;
  document.body.append(frame);
});

window.webkit.messageHandlers.probe.postMessage(JSON.stringify(report, null, 2));
} catch (err) {
  window.webkit.messageHandlers.probe.postMessage(JSON.stringify({ fatal: String(err), stack: String(err?.stack || "") }, null, 2));
}
</script>
</body>
</html>
"""#
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: UIWindow?
    private var webView: WKWebView?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let assetsDir = Bundle.main.bundleURL.appendingPathComponent("assets")
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(assetsDir: assetsDir), forURLScheme: "capacitor")
        config.userContentController.add(self, name: "probe")

        let wv = WKWebView(frame: UIScreen.main.bounds, configuration: config)
        wv.navigationDelegate = self
        self.webView = wv

        let vc = UIViewController()
        vc.view = wv
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.rootViewController = vc
        win.makeKeyAndVisible()
        self.window = win

        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            fputs("PROBE_TIMEOUT\n", stderr)
            fflush(stderr)
            exit(1)
        }

        wv.load(URLRequest(url: URL(string: "capacitor://localhost/index.html")!))
        return true
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? String {
            print("PROBE_RESULT_BEGIN")
            print(body)
            print("PROBE_RESULT_END")
            fflush(stdout)
            exit(0)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fputs("NAV_FAIL: \(error)\n", stderr)
        fflush(stderr)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("PROV_NAV_FAIL: \(error)\n", stderr)
        fflush(stderr)
    }
}

