import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const assets = Object.fromEntries(Object.entries({
  "/index.html": "unused",
  "/app.js": "export const app = true;",
  "/sdk/application/worker.js": "self.onmessage = () => {}; // import.meta.url stays unchanged",
  "/sdk/application/sdk.js": "export const sdk = true;",
  "/sdk/native/runtime.wasm": "runtime",
}).map(([file, text]) => [file, gzipSync(text).toString("base64")]));
let nodeLoads = 0;
globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, location: { origin: "http://localhost" }, require() { nodeLoads++; throw new Error("Mobile has no Node"); } };
const result = await build({
  stdin: { contents: `export * from './src/sync/native/mobile.ts';
    export * from './src/sync/native/host.ts';
    export * from './src/sync/native/declaration.ts';
    export { default as NativeSync } from './src/sync/native/plugin.ts';
    export { SyncController } from './src/sync/controller.ts';
    export { TFile } from 'obsidian';`, resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "mobile-mocks", setup(builder) {
    builder.onResolve({ filter: /^obsidian$|^embedded:assets$/ }, args => ({ path: args.path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian" ? `
      export const Platform = { isMobile: true, isMobileApp: true };
      export class Component {} export class Notice {} export class SuggestModal {} export class App {}
      export const parseYaml = JSON.parse;
      export class TAbstractFile {} export class TFile extends TAbstractFile { constructor(path) { super(); this.path = path; } }
    ` : `export default ${JSON.stringify(assets)};`, loader: "js" }));
  } }],
});
const { MobileHost, NativeSync, SyncController, TFile, mobileOrigin, vaultNamespace, decodeAsset, engineManifest } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);
const delay = () => new Promise(resolve => setTimeout(resolve, 1));

class Adapter {
  files = new Map();
  folders = new Set(["", ".plugin"]);
  events = [];
  beforeRename;
  failWrite = false;
  getResourcePath(file) { return `http://localhost/_capacitor_file_/vault/${file}?v=1`; }
  async exists(file) { await delay(); return this.files.has(file) || this.folders.has(file); }
  async read(file) { return decode(new Uint8Array(await this.readBinary(file))); }
  async readBinary(file) { await delay(); if (!this.files.has(file)) throw Object.assign(new Error("Missing"), { code: "ENOENT" }); return this.files.get(file).slice().buffer; }
  async write(file, text) { return this.writeBinary(file, encode(text).buffer); }
  async writeBinary(file, bytes) { await delay(); if (this.failWrite) throw new Error("Storage full"); this.events.push(`write ${file}`); this.files.set(file, new Uint8Array(bytes).slice()); }
  async appendBinary(file, bytes) { const previous = this.files.get(file); const next = new Uint8Array(previous.length + bytes.byteLength); next.set(previous); next.set(new Uint8Array(bytes), previous.length); await this.writeBinary(file, next.buffer); }
  async mkdir(directory) { await delay(); this.folders.add(directory); }
  async rename(from, to) { await delay(); await this.beforeRename?.(from, to); this.events.push(`rename ${from} ${to}`); assert.ok(this.files.has(from)); this.files.set(to, this.files.get(from)); this.files.delete(from); }
  async remove(file) { await delay(); this.files.delete(file); }
  async list(directory) {
    await delay();
    const direct = file => file !== directory && file.split("/").slice(0, -1).join("/") === directory;
    return { files: [...this.files.keys()].filter(direct), folders: [...this.folders].filter(direct) };
  }
}
function fixture(t) {
  const adapter = new Adapter();
  const app = { workspace: { getLeavesOfType: () => [] }, vault: { configDir: ".plugin", adapter,
    getAbstractFileByPath: file => adapter.files.has(file) ? new TFile(file) : null,
    createFolder: directory => adapter.mkdir(directory),
    on: () => ({}),
  } };
  const host = new MobileHost(app, { dir: ".plugin" });
  const native = new NativeSync(app, { dir: ".plugin" }, () => {});
  native.pluginDir = host.pluginDir; native.root = host.root;
  native.data = { version: 1, vaultId: "mobile-vault", paths: {} };
  native.mirroring = true;
  native.checkOwnership = () => {}; native.log = () => {};
  t.after(async () => {
    for (const timer of [native.persistTimer, native.commitTimer, native.activityTimer, native.settleTimer, native.reconcileRetryTimer]) if (timer !== null) clearTimeout(timer);
    await host.close(); await native.host.close();
  });
  return { adapter, app, host, native };
}

test("loading and constructing the mobile host never acquires Node", t => {
  fixture(t);
  assert.equal(nodeLoads, 0);
});
test("mobile sign-in opens through Obsidian's browser without Electron", async t => {
  const { native } = fixture(t);
  const opened = [];
  const previousOpen = window.open;
  window.open = url => { opened.push(url); };
  t.after(() => { window.open = previousOpen; });
  native.openSignIn("https://example.test/sign-in");
  await delay();
  assert.deepEqual(opened, ["https://example.test/sign-in"]);
  assert.equal(native.signInUrl, "https://example.test/sign-in");
  assert.equal(nodeLoads, 0);
});
test("mobile identity omits native platform and derives a stable isolated namespace", () => {
  assert.equal(mobileOrigin("http://localhost"), "http://localhost");
  for (const origin of ["http://localhost:48300", "https://evil.example", "null", "capacitor://localhost", "http://localhost/"]) assert.throws(() => mobileOrigin(origin));
  assert.equal(vaultNamespace("a-123"), vaultNamespace("a-123"));
  assert.notEqual(vaultNamespace("a-123"), vaultNamespace("b-456"));
  assert.throws(() => vaultNamespace("../other"));
  const mobile = engineManifest("http://localhost", true);
  assert.equal("platform" in mobile, false);
  assert.equal(mobile.homepage, "http://localhost/");
  assert.deepEqual(mobile.redirect_uris, ["http://localhost/auth/mdbase/callback"]);
  const desktop = engineManifest("http://127.0.0.1:48300", false);
  assert.equal(desktop.platform, "native");
  assert.equal(desktop.homepage, "http://127.0.0.1:48300/");
});
test("gzip assets decode exactly and corrupt input is refused", async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.deepEqual(await decodeAsset(gzipSync(bytes).toString("base64")), bytes);
  await assert.rejects(decodeAsset("bad gzip"));
});
test("adapter IO hashes exact bytes, discovers unindexed files, and refuses traversal", async t => {
  const { adapter, host, native } = fixture(t);
  await host.mkdir("notes/nested");
  await host.writeBytes("notes/nested/note.md", encode("hello\n"), true);
  assert.equal((await native.local("notes/nested/note.md")).hash, digest("hello\n"));
  assert.deepEqual(await native.localPaths(), ["notes/nested/note.md"]);
  await host.mkdir(".mdbase/private"); await host.writeBytes(".mdbase/private/secret.md", encode("private"));
  assert.deepEqual(await native.localPaths(), ["notes/nested/note.md"]);
  assert.equal(await host.hash(encode("hello")), digest("hello"));
  for (const file of ["/absolute", "../outside", "notes/../outside", "a\\b"]) await assert.rejects(host.readBytes(file));
  await assert.rejects(host.writeBytes("notes/nested/note.md", encode("overwrite"), true));
  assert.equal(await adapter.read("notes/nested/note.md"), "hello\n");
});
test("journals serialize async writes and copied vault state cannot share a namespace", async t => {
  const { adapter, host, native, app } = fixture(t);
  await Promise.all([host.writeAtomic(".plugin/state.json", "one"), host.writeAtomic(".plugin/state.json", "two")]);
  assert.equal(await adapter.read(".plugin/state.json"), "two");
  native.bindVault(); await native.persist();
  const copiedAdapter = new Adapter(); copiedAdapter.getResourcePath = file => `http://localhost/_capacitor_file_/other/${file}`;
  const other = new NativeSync({ ...app, vault: { ...app.vault, adapter: copiedAdapter } }, { dir: ".plugin" }, () => {});
  other.data = await native.readData();
  assert.throws(() => other.bindVault(), /another vault or host/);
  assert.equal(other.data.vaultId, native.data.vaultId);
});
test("a durable journal failure rejects before sending", async t => {
  const { adapter, native } = fixture(t);
  adapter.failWrite = true;
  await assert.rejects(native.durable(), /Storage full/);
  assert.equal(adapter.events.length, 0);
});
test("adapter-backed notes stage before publication and retain newer local bytes", async t => {
  const { host, adapter, native } = fixture(t);
  await host.writeBytes("note.md", encode("old"));
  await native.put("note.md", encode("new"), digest("old"));
  assert.equal(await adapter.read("note.md"), "new");
  await assert.rejects(native.put("note.md", encode("remote"), digest("old")), { code: "local_changed" });
  assert.equal(await adapter.read("note.md"), "new");
  assert.equal([...adapter.files.keys()].some(file => file.startsWith(".mdbase/incoming/")), false);
});
test("downloads verify EOF and digest before replacing a file, clean staging on errors", async t => {
  const { host, adapter } = fixture(t);
  await host.writeBytes("attachment.bin", encode("original"));
  let closed = 0, chunk = 0;
  const options = { directory: ".mdbase/incoming", digest: digest("download"),
    next: async () => chunk++ ? { done: true } : { done: false, bytes: encode("download") },
    close: async () => { closed++; },
    publish: staged => host.publish(staged, "attachment.bin", digest("original"), () => {}),
  };
  await host.stageDownload(options);
  assert.equal(await adapter.read("attachment.bin"), "download");
  chunk = 0;
  await assert.rejects(host.stageDownload({ ...options, digest: digest("wrong") }), /digest mismatch/);
  assert.equal(await adapter.read("attachment.bin"), "download");
  assert.equal(closed, 2);
  assert.equal([...adapter.files.keys()].some(file => file.endsWith(".tmp")), false);
  await host.mkdir(".mdbase"); await host.writeBytes(".mdbase/host.lock", encode("lock"));
  await assert.rejects(host.checkLock(), /cannot verify/);
});
test("mobile boot serves a blob iframe with a resource base and exact blob Worker bytes", async t => {
  const { host, adapter } = fixture(t);
  const options = { data: { vaultId: "first-vault", collectionId: "collection" }, capability: "secret", stopped: () => false, save: async () => {}, log() {} };
  const page = await host.open(options);
  assert.equal(page.origin, "http://localhost"); assert.match(page.url, /^blob:/);
  const html = await (await fetch(page.url)).text();
  assert.match(html, /<base href="http:\/\/localhost\/_capacitor_file_\/vault\/\.plugin\/sync-engine\/">/);
  const config = JSON.parse(html.match(/globalThis.mdbaseHost=(.*?); await import/)[1]);
  assert.equal(config.namespace, "obsidian-vault-first-vault");
  assert.equal(config.collection, "collection");
  const worker = await (await fetch(config.workerUrl)).text();
  assert.equal(worker, await adapter.read(".plugin/sync-engine/sdk/application/worker.js"));
  assert.match(worker, /import.meta.url stays unchanged/);
  await host.close();
  await assert.rejects(fetch(page.url)); await assert.rejects(fetch(config.workerUrl));
  await assert.rejects(host.open({ ...options, stopped: () => true }), /stopped/);
  assert.equal(nodeLoads, 0);
});
test("mobile controller uses the shared SDK UI path without invoking desktop discovery", async t => {
  let created = 0;
  const controller = new SyncController({ vaultPath: () => null, vaultTopLevel: () => [], workspace: () => ({}), binaryOverride() { throw new Error("Desktop discovery on mobile"); }, appVersion: "test", openUrl() {},
    createNative: async () => { created++; return { load() {}, unload() {}, released: Promise.resolve() }; },
  }, true);
  controller.stopped = false;
  t.after(() => controller.stop());
  await controller.refresh();
  assert.equal(created, 1);
  assert.equal(controller.snapshot.direct.text, "Starting sync");
  assert.equal(nodeLoads, 0);
});
test("the shared reconciler uploads mobile notes with durable intent, preserves conflicts, and downloads deletions", async t => {
  const { native, host, adapter } = fixture(t);
  const remote = new Map(); let sequence = 0;
  native.call = async (method, ...args) => {
    if (method === "inclusion") return null;
    if (method === "all") return [...remote.values()];
    if (["filesAll", "resourcesAll", "rejectedWrites"].includes(method)) return [];
    if (method === "create") {
      const saved = JSON.parse(await adapter.read(".plugin/sync-state.json"));
      assert.equal(saved.sending[args[0]], digest(args[1]));
      const item = { path: args[0], document: args[1], id: `record-${++sequence}`, revision: `revision-${sequence}`, confirmed: true };
      remote.set(item.path, item); return item;
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  await host.writeBytes("note.md", encode("initial"));
  await native.reconcileAll();
  assert.equal(remote.get("note.md").document, "initial");
  await host.writeBytes("note.md", encode("offline edit"));
  remote.set("note.md", { ...remote.get("note.md"), document: "remote edit", revision: "second" });
  await native.reconcileAll();
  assert.equal(await adapter.read("note.md"), "remote edit");
  const copies = (await native.localPaths()).filter(file => file.includes("(conflict "));
  assert.equal(copies.length, 1);
  assert.equal(await adapter.read(copies[0]), "offline edit");
  assert.equal(remote.get(copies[0]).document, "offline edit");
  remote.delete("note.md");
  await native.reconcileAll();
  assert.equal(await host.exists("note.md"), false);
  assert.equal(nodeLoads, 0);
});
test("mobile attachment sends retain recovery bytes and transfer identities until confirmation", async t => {
  const { native, host, adapter } = fixture(t);
  const bytes = Uint8Array.of(0, 255, 17, 42);
  await host.writeBytes("photo.png", bytes);
  let transfer;
  native.call = async (method, ...args) => {
    if (method === "upload") {
      const [path, sent, , , identity] = args;
      const saved = JSON.parse(await adapter.read(".plugin/sync-state.json"));
      transfer = identity.transferId;
      assert.deepEqual(saved.uploads[path], { transferId: identity.transferId, mutationId: identity.mutationId, hash: digest(bytes) });
      assert.deepEqual(await host.readBytes(`.mdbase/uploads/${transfer}`), bytes);
      assert.deepEqual(sent, bytes);
      return { id: "photo", path, digest: digest(bytes), confirmed: true };
    }
    assert.equal(method, "uploadForget"); return true;
  };
  await native.push("photo.png", await native.local("photo.png"));
  assert.equal(await host.exists(`.mdbase/uploads/${transfer}`), false);
  assert.equal(native.data.uploads["photo.png"], undefined);
  assert.equal(native.data.paths["photo.png"].hash, digest(bytes));
});
test("mobile host teardown waits for an in-progress asset extraction before releasing", async t => {
  const { host, adapter } = fixture(t);
  let started, finish;
  const writing = new Promise(resolve => { started = resolve; });
  const unblock = new Promise(resolve => { finish = resolve; });
  const write = adapter.writeBinary.bind(adapter);
  adapter.writeBinary = async (...args) => { started(); await unblock; return write(...args); };
  const opening = host.open({ data: { vaultId: "vault" }, capability: "x", stopped: () => false, save: async () => {}, log() {} });
  await writing;
  let released = false;
  const closing = host.close().then(() => { released = true; });
  await delay(); assert.equal(released, false);
  finish(); await assert.rejects(opening, /stopped/); await closing;
  assert.equal(released, true);
  assert.equal([...adapter.files.keys()].length, 1);
});
test("the engine page uses the SDK Worker factory and explicit selection without URL mutation", async t => {
  const calls = [], workers = [];
  const previous = { location: globalThis.location, parent: globalThis.parent, Worker: globalThis.Worker, secure: globalThis.isSecureContext };
  const listeners = new Map();
  window.mdbaseHost = { namespace: "obsidian-vault-test", collection: "selected", workerUrl: "blob:worker" };
  window.document = { baseURI: "http://localhost/_capacitor_file_/vault/.plugin/sync-engine/" };
  window.addEventListener = (type, listener) => listeners.set(type, listener);
  globalThis.location = { origin: "http://localhost", href: "blob:http://localhost/engine" };
  globalThis.parent = { postMessage() {} }; globalThis.isSecureContext = true;
  globalThis.Worker = class { constructor(...args) { workers.push(args); } };
  globalThis.mobileSdk = { setForeground() {}, subscribe() {}, getSnapshot: () => ({ phase: { kind: "ready" } }), select: async id => calls.push(["select", id]), start: async () => calls.push(["start"]) };
  t.after(() => {
    Object.assign(globalThis, { location: previous.location, parent: previous.parent, Worker: previous.Worker, isSecureContext: previous.secure });
    for (const key of ["mdbaseHost", "document", "addEventListener"]) delete window[key];
    delete globalThis.mobileSdk; delete globalThis.mobileDeclaration; delete globalThis.mobileOptions;
  });
  const page = await build({ entryPoints: ["src/sync/native/page.ts"], bundle: true, format: "esm", platform: "browser", write: false,
    define: { __MDBASE_ENVIRONMENT__: '"production"' },
    plugins: [{ name: "sdk", setup(builder) {
      builder.onResolve({ filter: /^@mdbase-dev\/sdk$/ }, () => ({ path: "sdk", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export function createMdbase(declaration, options) { globalThis.mobileDeclaration=declaration; globalThis.mobileOptions=options; return globalThis.mobileSdk; }", loader: "js" }));
    } }],
  });
  await import(`data:text/javascript;base64,${Buffer.from(page.outputFiles[0].contents).toString("base64")}`);
  assert.equal(globalThis.mobileOptions.urlSelection, false);
  assert.equal(globalThis.mobileDeclaration.storage.applicationNamespace, "obsidian-vault-test");
  assert.equal("platform" in globalThis.mobileDeclaration.manifest, false);
  globalThis.mobileOptions.worker("http://localhost/_capacitor_file_/vault/.plugin/sync-engine/sdk/application/worker.js");
  assert.deepEqual(workers, [["blob:worker", { type: "module" }]]);
  assert.throws(() => globalThis.mobileOptions.worker("https://other/worker.js"));
  let receive;
  const port = { postMessage() {}, set onmessage(handler) { receive = handler; } };
  listeners.get("message")({ source: parent, data: { type: "connect" }, ports: [port] });
  await receive({ data: { type: "call", id: 1, method: "start", args: [] } });
  assert.deepEqual(calls, [["select", "selected"], ["start"]]);
});
test("mobile ownership refuses missing, foreign, unreadable, and desktop-locked markers", async t => {
  const { native, host, adapter } = fixture(t);
  const check = () => NativeSync.prototype.checkOwnership.call(native);
  await assert.rejects(check(), /owned elsewhere/);
  await host.mkdir(".mdbase");
  await host.writeAtomic(".mdbase/host.json", JSON.stringify({ host: "daemon" }));
  await assert.rejects(check(), /owned elsewhere/);
  assert.deepEqual(JSON.parse(await adapter.read(".mdbase/host.json")), { host: "daemon" });
  await host.writeAtomic(".mdbase/host.json", "corrupt");
  await assert.rejects(check(), /Unreadable ownership/);
  native.data.markerSince = 123;
  await native.writeMarker(); await check();
  const own = JSON.parse(await adapter.read(".mdbase/host.json"));
  assert.equal("pid" in own, false);
  await host.writeBytes(".mdbase/host.lock", new Uint8Array());
  await assert.rejects(check(), /cannot verify/);
  assert.deepEqual(JSON.parse(await adapter.read(".mdbase/host.json")), own);
});
test("mobile restart waits for old asynchronous journal IO instead of starting a second writer", async t => {
  let finish, created = 0;
  const released = new Promise(resolve => { finish = resolve; });
  const controller = new SyncController({ vaultPath: () => null, vaultTopLevel: () => [], workspace: () => ({}), binaryOverride: () => "", appVersion: "test", openUrl() {},
    createNative: async () => { created++; return { load() {}, unload() {}, released: created === 1 ? released : Promise.resolve() }; },
  }, true);
  controller.stopped = false; t.after(() => controller.stop());
  await controller.refresh();
  const restarting = controller.restartNative();
  await delay(); assert.equal(created, 1);
  finish(); await restarting; assert.equal(created, 2);
});
test("unloading during an asynchronous mobile claim never resurrects the iframe or writes a late marker", async t => {
  const { native, adapter, app } = fixture(t);
  native.mirroring = false;
  let reached, finish, frames = 0;
  const claiming = new Promise(resolve => { reached = resolve; });
  const unblock = new Promise(resolve => { finish = resolve; });
  const mkdir = adapter.mkdir.bind(adapter);
  adapter.mkdir = async directory => { if (directory === ".mdbase") { reached(); await unblock; } return mkdir(directory); };
  app.workspace.containerEl = { createEl() { frames++; return { style: {}, remove() {} }; } };
  native.registerDomEvent = () => {}; native.registerEvent = () => {};
  const initializing = native.initialize();
  await claiming;
  native.onunload(); await native.released;
  finish(); await initializing;
  assert.equal(frames, 0);
  assert.equal(native.frame, null);
  assert.equal(await adapter.exists(".mdbase/host.json"), false);
});
test("an editor opened during the final async disk read keeps its newer buffer and disk bytes", async t => {
  const { native, host, app, adapter } = fixture(t);
  await host.writeBytes("note.md", encode("initial"));
  let reads = 0, views = [];
  app.workspace.getLeavesOfType = () => views;
  const read = native.host.readBytes.bind(native.host);
  native.host.readBytes = async file => {
    const bytes = await read(file);
    if (file === "note.md" && ++reads === 3) views = [{ view: { file: new TFile(file), editor: {}, getViewData: () => "new typing" } }];
    return bytes;
  };
  await assert.rejects(native.put("note.md", encode("remote"), digest("initial")), { code: "local_changed" });
  assert.equal(await adapter.read("note.md"), "initial");
  assert.equal(views[0].view.getViewData(), "new typing");
});
