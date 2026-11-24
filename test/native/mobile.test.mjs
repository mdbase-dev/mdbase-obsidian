import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { linguiMacros } from "../../scripts/lingui-macros.mjs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { validateAppManifest } from "@mdbase-dev/sdk/manifest";

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
    export { TFile, setApiSupport } from 'obsidian';`, resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [linguiMacros({ production: false }), { name: "mobile-mocks", setup(builder) {
    builder.onResolve({ filter: /^obsidian$|^embedded:assets$/ }, args => ({ path: args.path, namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian" ? `
      export const Platform = { isMobile: true, isMobileApp: true };
      let apiSupported = true;
      export const requireApiVersion = version => { if (version !== "1.12.3") throw new Error("Unexpected API version"); return apiSupported; };
      export const setApiSupport = value => { apiSupported = value; };
      export class Component {} export class Notice {} export class SuggestModal {} export class App {}
      export const parseYaml = JSON.parse;
      export class TAbstractFile {} export class TFile extends TAbstractFile { constructor(path) { super(); this.path = path; } }
    ` : `export default ${JSON.stringify(assets)};`, loader: "js" }));
  } }],
});
const { MobileHost, NativeSync, SyncController, TFile, setApiSupport, mobileOrigin, resolveWindowOrigin, normalizeMobileResourcePath, vaultNamespace, decodeAsset, engineManifest } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
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
  async writeBinary(file, bytes) { await delay(); if (this.failWrite) throw new Error("Storage full"); this.events.push(`${this.files.has(file) ? "modify" : "create"} ${file}`); this.files.set(file, new Uint8Array(bytes).slice()); }
  async appendBinary(file, bytes) { const previous = this.files.get(file); const next = new Uint8Array(previous.length + bytes.byteLength); next.set(previous); next.set(new Uint8Array(bytes), previous.length); await this.writeBinary(file, next.buffer); }
  async mkdir(directory) { await delay(); this.folders.add(directory); }
  async rename(from, to) {
    if (from === to) return;
    await delay(); await this.beforeRename?.(from, to);
    if ((this.files.has(to) || this.folders.has(to)) && from.toLowerCase() !== to.toLowerCase()) throw new Error("Destination file already exists!");
    this.events.push(`rename ${from} ${to}`); assert.ok(this.files.has(from)); this.files.set(to, this.files.get(from)); this.files.delete(from);
  }
  async remove(file) { await delay(); this.events.push(`delete ${file}`); this.files.delete(file); }
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
  assert.equal(mobileOrigin("capacitor://localhost"), "capacitor://localhost");
  assert.equal(resolveWindowOrigin({ origin: "http://localhost", href: "http://localhost/index.html" }), "http://localhost");
  assert.equal(resolveWindowOrigin({ origin: "null", href: "capacitor://localhost/index.html" }), "capacitor://localhost");
  for (const origin of ["http://localhost:48300", "https://evil.example", "null", "capacitor://evil.example", "capacitor://localhost:8080", "capacitor://localhost/", "http://localhost/"]) assert.throws(() => mobileOrigin(origin));
  assert.equal(vaultNamespace("a-123"), vaultNamespace("a-123"));
  assert.notEqual(vaultNamespace("a-123"), vaultNamespace("b-456"));
  assert.throws(() => vaultNamespace("../other"));
  const android = engineManifest("http://localhost", true, "production");
  assert.equal("platform" in android, false);
  assert.equal("installation_origins" in android, false);
  assert.equal(android.homepage, "http://localhost/");
  assert.deepEqual(android.redirect_uris, ["http://localhost/auth/mdbase/callback"]);
  const ios = engineManifest("capacitor://localhost", true, "production");
  assert.equal("platform" in ios, false);
  assert.equal(ios.homepage, "http://localhost/");
  assert.deepEqual(ios.redirect_uris, ["http://localhost/auth/mdbase/callback"]);
  assert.deepEqual(ios.installation_origins, { production: { mobile: ["capacitor://localhost"] } });
  for (const manifest of [android, ios, engineManifest("capacitor://localhost", true, "lab"), engineManifest("capacitor://localhost", true, "staging")]) {
    assert.deepEqual(validateAppManifest(manifest, { allowLocal: true }), { valid: true, issues: [] });
  }
  const desktop = engineManifest("http://127.0.0.1:48300", false);
  assert.equal(desktop.platform, "native");
  assert.equal(desktop.homepage, "http://127.0.0.1:48300/");
  assert.deepEqual(validateAppManifest(desktop, { allowLocal: true }), { valid: true, issues: [] });
});
test("iOS vaultLocation normalizes volatile app container UUIDs across app updates but rejects copied vaults", async t => {
  const before = "capacitor://localhost/_capacitor_file_/private/var/mobile/Containers/Data/Application/11111111-2222-3333-4444-555555555555/Documents/VaultA/.plugin/sync-state.json?v=1";
  const afterUpdate = "capacitor://localhost/_capacitor_file_/private/var/mobile/Containers/Data/Application/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/Documents/VaultA/.plugin/sync-state.json?v=2";
  const otherVault = "capacitor://localhost/_capacitor_file_/private/var/mobile/Containers/Data/Application/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/Documents/VaultB/.plugin/sync-state.json?v=2";
  assert.equal(normalizeMobileResourcePath(before), normalizeMobileResourcePath(afterUpdate));
  assert.notEqual(normalizeMobileResourcePath(before), normalizeMobileResourcePath(otherVault));
  const { app, adapter } = fixture(t);
  adapter.getResourcePath = () => before;
  const first = new NativeSync(app, { dir: ".plugin" }, () => {});
  first.data = { version: 1, vaultId: "ios-vault", collectionId: "c1", paths: {} };
  first.log = () => {};
  first.bindVault(); await first.persist();
  const updatedAdapter = new Adapter(); updatedAdapter.getResourcePath = () => afterUpdate;
  const updated = new NativeSync({ ...app, vault: { ...app.vault, adapter: updatedAdapter } }, { dir: ".plugin" }, () => {});
  updated.data = await first.readData(); updated.log = () => {};
  updated.bindVault();
  assert.equal(updated.data.vaultId, "ios-vault");
  const copiedAdapter = new Adapter(); copiedAdapter.getResourcePath = () => otherVault;
  const copied = new NativeSync({ ...app, vault: { ...app.vault, adapter: copiedAdapter } }, { dir: ".plugin" }, () => {});
  copied.data = await first.readData(); copied.log = () => {};
  assert.throws(() => copied.bindVault(), e => e.code === "folder_owned" && e.owner === "copied");
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
  await Promise.all([host.writeAtomic(".plugin/state.json", JSON.stringify("one")), host.writeAtomic(".plugin/state.json", JSON.stringify("two"))]);
  assert.equal(await adapter.read(".plugin/state.json"), JSON.stringify("two"));
  native.bindVault(); await native.persist();
  const copiedAdapter = new Adapter(); copiedAdapter.getResourcePath = file => `http://localhost/_capacitor_file_/other/${file}`;
  const other = new NativeSync({ ...app, vault: { ...app.vault, adapter: copiedAdapter } }, { dir: ".plugin" }, () => {});
  other.data = await native.readData();
  other.log = () => {};
  other.bindVault();
  assert.notEqual(other.data.vaultId, native.data.vaultId, "settings that never synced start afresh");
  native.data.collectionId = "c1"; await native.persist();
  other.data = await native.readData();
  assert.throws(() => other.bindVault(), e => e.code === "folder_owned" && e.owner === "copied");
  assert.equal(other.data.vaultId, native.data.vaultId);
});
test("the Android adapter refuses replacement but permits case-only renames", async () => {
  const adapter = new Adapter();
  await adapter.write("one.md", "one"); await adapter.write("two.md", "two");
  await assert.rejects(adapter.rename("one.md", "two.md"), { message: "Destination file already exists!" });
  assert.equal(await adapter.read("two.md"), "two");
  await adapter.rename("one.md", "ONE.md");
  assert.equal(await adapter.read("ONE.md"), "one");
});
for (const count of [2, 3]) test(`${count} successive JSON journal writes replace the destination and leave no temporary`, async t => {
  const { host, adapter } = fixture(t);
  for (let revision = 1; revision <= count; revision++) await host.writeAtomic(".plugin/state.json", JSON.stringify({ revision }), true);
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { revision: count });
  assert.deepEqual([...adapter.files.keys()], [".plugin/state.json"]);
  assert.equal(adapter.events.filter(event => event === "create .plugin/state.json.tmp").length, count);
});
test("mobile startup persists, claims, persists again, and heartbeats its JSON marker", async t => {
  const { native, adapter } = fixture(t);
  native.checkOwnership = NativeSync.prototype.checkOwnership.bind(native);
  native.mirroring = false;
  native.bindVault(); await native.persist();
  await native.claim(); await native.persist();
  const previous = JSON.parse(await adapter.read(native.markerPath));
  await native.writeMarker(); await native.checkOwnership();
  const marker = JSON.parse(await adapter.read(native.markerPath));
  assert.equal(marker.since_ms, native.data.markerSince);
  assert.ok(marker.heartbeat_ms > previous.heartbeat_ms);
  assert.equal((await native.readData()).markerSince, marker.since_ms);
  await native.writeActivity(); await native.writeActivity();
  for (const file of [".plugin/sync-state.json", native.markerPath, native.activityFile()]) assert.doesNotThrow(() => JSON.parse(decode(adapter.files.get(file))));
  assert.equal([...adapter.files.keys()].some(file => file.endsWith(".tmp")), false);
});
for (const file of [".plugin/sync-state.json", ".mdbase/host.json", ".plugin/sync-activity.json"]) {
  test(`missing ${file} recovers complete JSON temporary bytes`, async t => {
    const { host, adapter } = fixture(t);
    const text = JSON.stringify({ recovered: true });
    await adapter.write(`${file}.tmp`, text);
    assert.equal(await host.readText(file), text);
    assert.equal(await adapter.read(file), text);
    assert.equal(await adapter.exists(`${file}.tmp`), false);
  });
}
test("an incomplete first JSON write is discarded and reported as ENOENT", async t => {
  const { host, adapter } = fixture(t);
  await adapter.write(".plugin/state.json.tmp", '{"incomplete":');
  await assert.rejects(host.readText(".plugin/state.json"), { code: "ENOENT" });
  assert.equal(await adapter.exists(".plugin/state.json.tmp"), false);
  await host.writeAtomic(".plugin/state.json", JSON.stringify({ complete: true }));
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { complete: true });
});
test("an existing JSON destination wins over a stale temporary and the next write works", async t => {
  const { host, adapter } = fixture(t);
  await adapter.write(".plugin/state.json", JSON.stringify({ revision: 1 }));
  await adapter.write(".plugin/state.json.tmp", JSON.stringify({ revision: 0 }));
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { revision: 1 });
  await host.writeAtomic(".plugin/state.json", JSON.stringify({ revision: 2 }));
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { revision: 2 });
  assert.equal(await adapter.exists(".plugin/state.json.tmp"), false);
});
test("JSON readers wait through replacement and durable resolves only after publication", async t => {
  const { native, adapter } = fixture(t);
  await native.persist();
  const remove = adapter.remove.bind(adapter);
  let removed, resume;
  const gap = new Promise(resolve => { removed = resolve; });
  const blocked = new Promise(resolve => { resume = resolve; });
  adapter.remove = async file => { await remove(file); if (file === ".plugin/sync-state.json") { removed(); await blocked; } };
  native.data.markerSince = 123;
  let durableFinished = false, readFinished = false;
  const durable = native.durable().then(() => { durableFinished = true; });
  await gap;
  const read = native.readData().then(data => { readFinished = true; return data; });
  await delay();
  assert.equal(durableFinished, false); assert.equal(readFinished, false);
  resume(); await durable;
  assert.equal((await read).markerSince, 123);
  assert.equal(await adapter.exists(".plugin/sync-state.json.tmp"), false);
});
test("a failed JSON replacement leaves a recoverable complete temporary", async t => {
  const { host, adapter } = fixture(t);
  await host.writeAtomic(".plugin/state.json", JSON.stringify({ revision: 1 }));
  adapter.beforeRename = () => { throw new Error("Interrupted rename"); };
  await assert.rejects(host.writeAtomic(".plugin/state.json", JSON.stringify({ revision: 2 })), /Interrupted rename/);
  assert.equal(await adapter.exists(".plugin/state.json"), false);
  adapter.beforeRename = undefined;
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { revision: 2 });
  await host.writeAtomic(".plugin/state.json", JSON.stringify({ revision: 3 }));
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { revision: 3 });
});
test("a failed temporary write retains the existing JSON destination", async t => {
  const { host, adapter } = fixture(t);
  await host.writeAtomic(".plugin/state.json", JSON.stringify({ revision: 1 }));
  adapter.failWrite = true;
  await assert.rejects(host.writeAtomic(".plugin/state.json", JSON.stringify({ revision: 2 })), /Storage full/);
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { revision: 1 });
  adapter.failWrite = false;
  await host.writeAtomic(".plugin/state.json", JSON.stringify({ revision: 3 }));
  assert.deepEqual(JSON.parse(await host.readText(".plugin/state.json")), { revision: 3 });
});
test("generic mobile rename refuses existing files and folders without calling the adapter", async t => {
  const { host, adapter } = fixture(t);
  await host.writeBytes("source.md", encode("source"));
  await host.writeBytes("target.md", encode("target"));
  await host.mkdir("folder");
  adapter.beforeRename = () => { assert.fail("Refused rename reached the adapter"); };
  await assert.rejects(host.rename("source.md", "target.md"), /existing destination: target.md/);
  await assert.rejects(host.rename("source.md", "folder"), /existing destination: folder/);
  assert.equal(await adapter.read("source.md"), "source");
  assert.equal(await adapter.read("target.md"), "target");
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
for (const existing of [true, false]) test(`publication ${existing ? "modifies an existing target" : "renames a new target"} after the final guards`, async t => {
  const { host, adapter } = fixture(t);
  const staged = ".plugin/download.tmp", target = "note.md", order = [];
  await host.writeBytes(staged, encode("remote"));
  if (existing) await host.writeBytes(target, encode("local"));
  adapter.events.length = 0;
  const read = adapter.readBinary.bind(adapter);
  adapter.readBinary = async file => { order.push(`read ${file}`); return read(file); };
  const operation = existing ? "writeBinary" : "rename";
  const write = adapter[operation].bind(adapter);
  let yielded = false;
  adapter[operation] = (...args) => { assert.equal(yielded, false); order.push("write"); return write(...args); };
  await host.publish(staged, target, existing ? digest("local") : undefined, digest("remote"), async () => {
    order.push("guard"); await delay(); order.push("guard finished");
  }, () => { order.push("active"); queueMicrotask(() => { yielded = true; }); });
  assert.deepEqual(order, existing
    ? [`read ${staged}`, "guard", "guard finished", `read ${target}`, "active", "write"]
    : [`read ${staged}`, "guard", "guard finished", "active", "write"]);
  assert.deepEqual(adapter.events, existing ? [`modify ${target}`, `delete ${staged}`] : [`rename ${staged} ${target}`]);
  assert.equal(await adapter.read(target), "remote");
  assert.equal(await adapter.exists(staged), false);
});
test("publication rechecks the target after ownership and refuses local changes before active", async t => {
  const { host, adapter } = fixture(t);
  await host.writeBytes(".plugin/download.tmp", encode("remote"));
  await host.writeBytes("note.md", encode("local"));
  await assert.rejects(host.publish(".plugin/download.tmp", "note.md", digest("local"), digest("remote"), async () => {
    await adapter.write("note.md", "new typing");
  }, () => { assert.fail("Changed target reached active"); }), { code: "local_changed" });
  assert.equal(await adapter.read("note.md"), "new typing");
  assert.equal(await adapter.exists(".plugin/download.tmp"), true);
});
for (const guard of ["ownership", "active"]) test(`a failed ${guard} guard refuses publication without mutating either file`, async t => {
  const { host, adapter } = fixture(t);
  await host.writeBytes(".plugin/download.tmp", encode("remote"));
  await host.writeBytes("note.md", encode("local"));
  adapter.events.length = 0;
  const refuse = () => { throw new Error(`${guard} refused`); };
  await assert.rejects(host.publish(".plugin/download.tmp", "note.md", digest("local"), digest("remote"),
    guard === "ownership" ? refuse : () => {}, guard === "active" ? refuse : () => { assert.fail("Ownership refusal reached active"); }), new RegExp(`${guard} refused`));
  assert.deepEqual(adapter.events, []);
  assert.equal(await adapter.read("note.md"), "local");
  assert.equal(await adapter.read(".plugin/download.tmp"), "remote");
});
for (const existing of [true, false]) test(`a changed staged digest leaves ${existing ? "an existing" : "a missing"} target untouched`, async t => {
  const { host, adapter } = fixture(t);
  await host.writeBytes(".plugin/download.tmp", encode("verified"));
  if (existing) await host.writeBytes("note.md", encode("local"));
  await adapter.write(".plugin/download.tmp", "corrupted after verification");
  adapter.events.length = 0;
  await assert.rejects(host.publish(".plugin/download.tmp", "note.md", existing ? digest("local") : undefined, digest("verified"),
    () => { assert.fail("Corrupt stage reached publication guards"); }), /digest mismatch/);
  assert.deepEqual(adapter.events, []);
  assert.equal(await adapter.exists("note.md"), existing);
  if (existing) assert.equal(await adapter.read("note.md"), "local");
  assert.equal(await adapter.exists(".plugin/download.tmp"), true);
});
test("put refuses corrupted staged bytes and cleans its staging file", async t => {
  const { native, host, adapter } = fixture(t);
  await host.writeBytes("note.md", encode("local"));
  const write = adapter.writeBinary.bind(adapter);
  adapter.writeBinary = (file, bytes) => write(file, file.startsWith(".mdbase/incoming/") ? encode("corrupt").buffer : bytes);
  await assert.rejects(native.put("note.md", encode("remote"), digest("local")), /digest mismatch/);
  assert.equal(await adapter.read("note.md"), "local");
  assert.equal([...adapter.files.keys()].some(file => file.startsWith(".mdbase/incoming/")), false);
});
test("downloads verify EOF and digest before replacing a file, clean staging on errors", async t => {
  const { host, adapter } = fixture(t);
  await host.writeBytes("attachment.bin", encode("original"));
  let closed = 0, chunk = 0;
  const options = { directory: ".mdbase/incoming", digest: digest("download"),
    next: async () => chunk++ ? { done: true } : { done: false, bytes: encode("download") },
    close: async () => { closed++; },
    publish: staged => host.publish(staged, "attachment.bin", digest("original"), digest("download"), () => {}),
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
test("mobile boot on an Obsidian without appendBinary stops with an update message and writes nothing", async t => {
  const { host, adapter } = fixture(t);
  adapter.appendBinary = undefined;
  const options = { data: { vaultId: "first-vault" }, capability: "secret", stopped: () => false, save: async () => {}, log() {} };
  await assert.rejects(host.open(options), /needs Obsidian 1\.12\.3 or later/);
  assert.equal([...adapter.files.keys()].filter(file => file.includes("sync-engine")).length, 0);
});
test("mobile boot respects requireApiVersion even if an adapter supplies appendBinary", async t => {
  const { host, adapter } = fixture(t);
  const options = { data: { vaultId: "first-vault" }, capability: "secret", stopped: () => false, save: async () => {}, log() {} };
  setApiSupport(false);
  try {
    await assert.rejects(host.open(options), /needs Obsidian 1\.12\.3 or later/);
    assert.equal(adapter.events.length, 0);
  } finally { setApiSupport(true); }
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
test("mobile remote rename preserves an unindexed local occupant and continues syncing", async t => {
  const { native, host, app, adapter } = fixture(t);
  app.vault.rename = (file, to) => adapter.rename(file.path, to);
  const lookup = app.vault.getAbstractFileByPath;
  app.vault.getAbstractFileByPath = file => file === "target.md" ? null : lookup(file);
  const source = "source\r\n", occupant = "unsynced café\r\n";
  await host.writeBytes("source.md", encode(source)); await host.writeBytes("target.md", encode(occupant));
  native.data.paths["source.md"] = { id: "source", kind: "record", revision: "r1", hash: digest(source) };
  const remote = new Map([
    ["target.md", { path: "target.md", id: "source", revision: "r2", document: source, confirmed: true }],
    ["incoming.md", { path: "incoming.md", id: "incoming", revision: "r1", document: "independent", confirmed: true }],
  ]);
  native.call = async (method, ...args) => {
    if (method === "inclusion") return null;
    if (method === "all") return [...remote.values()];
    if (["filesAll", "resourcesAll", "rejectedWrites"].includes(method)) return [];
    if (method === "create") {
      const item = { path: args[0], document: args[1], id: "copy", revision: "r1", confirmed: true };
      remote.set(item.path, item); return item;
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  assert.equal(await native.reconcileAll(), true);
  assert.equal(await adapter.read("target.md"), source);
  const [copy] = native.view().conflicts;
  assert.equal(copy.path, "target.md");
  assert.deepEqual(new Uint8Array(await adapter.readBinary(copy.copy)), encode(occupant));
  assert.equal(remote.get(copy.copy).document, occupant);
  assert.equal(await adapter.read("incoming.md"), "independent");
  assert.equal(await host.exists("source.md"), false);
  assert.deepEqual(native.view().failures, []);
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
  const watches = [];
  const records = { watchChanges(onChanges, options) {
    assert.equal(typeof onChanges, "function");
    assert.deepEqual(options, { cursor: "retained-cursor" });
    let finish;
    const watch = { stopped: 0, finish: () => { onChanges({ cursor: "next-cursor", reset: true, changes: [] }); finish(); } };
    watches.push(watch);
    return Object.assign(() => { watch.stopped++; }, { ready: new Promise(resolve => { finish = resolve; }) });
  } };
  globalThis.mobileSdk = { setForeground() {}, subscribe() {}, getSnapshot: () => ({ phase: { kind: "ready", connection: { records } } }), select: async id => calls.push(["select", id]), start: async () => calls.push(["start"]), close: async () => calls.push(["close"]) };
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
  const messages = [];
  const port = { postMessage(message) { messages.push(message); }, set onmessage(handler) { receive = handler; } };
  listeners.get("message")({ source: parent, data: { type: "connect" }, ports: [port] });
  await receive({ data: { type: "call", id: 1, method: "start", args: [] } });
  assert.deepEqual(calls, [["select", "selected"], ["start"]]);
  const first = receive({ data: { type: "call", id: 2, method: "watch", args: ["retained-cursor"] } });
  assert.equal(messages.some(message => message.type === "result" && message.id === 2), false);
  watches[0].finish(); await first;
  assert.deepEqual(messages.slice(-2), [{ type: "changes", batch: { cursor: "next-cursor", reset: true, changes: [] } }, { type: "result", id: 2, ok: true, value: true }]);
  const second = receive({ data: { type: "call", id: 3, method: "watch", args: ["retained-cursor"] } });
  assert.equal(watches[0].stopped, 1);
  watches[1].finish(); await second;
  await receive({ data: { type: "call", id: 4, method: "unwatch" } });
  assert.equal(watches[1].stopped, 1);
  const third = receive({ data: { type: "call", id: 5, method: "watch", args: ["retained-cursor"] } });
  watches[2].finish(); await third;
  // page.ts written(): receipt shortcut when revision matches, read-back when lifecycle rewrote the document.
  const plainDoc = "---\ntitle: Plain\n---\n";
  const draftDoc = "---\ntype: event\ntitle: Guarded Party\n---\n";
  const postLifecycleDoc = "---\ntype: event\ntitle: Guarded Party\nid: 13e1bbc6-0000-4000-8000-000000000001\nends: 2099-12-31T23:00:00Z\n---\n";
  let getCalls = 0;
  records.create = async ({ path: p, document: d }) => {
    const rewritten = d === draftDoc ? postLifecycleDoc : d;
    const rev = digest(rewritten);
    return { recordId: p, confirmed: Promise.resolve({ state: "confirmed", status: "applied", records: [{ id: p, path: p, revision: rev }] }) };
  };
  records.get = async id => {
    getCalls++;
    return { id, path: id, revision: digest(postLifecycleDoc), document: postLifecycleDoc, state: { state: "confirmed" } };
  };
  await receive({ data: { type: "call", id: 7, method: "create", args: ["Plain.md", plainDoc] } });
  const plainResult = messages.find(m => m.type === "result" && m.id === 7);
  assert.equal(plainResult.ok, true);
  assert.equal(plainResult.value.via, "receipt");
  assert.equal(getCalls, 0);
  await receive({ data: { type: "call", id: 8, method: "create", args: ["Guarded Party.md", draftDoc] } });
  const rewrittenResult = messages.find(m => m.type === "result" && m.id === 8);
  assert.equal(rewrittenResult.ok, true);
  assert.equal(rewrittenResult.value.document, postLifecycleDoc, "page.ts must read back post-lifecycle document when revision differs");
  assert.equal(getCalls, 1);
  await receive({ data: { type: "call", id: 6, method: "stop" } });
  assert.deepEqual(watches.map(watch => watch.stopped), [1, 1, 1]);
  assert.deepEqual(calls.at(-1), ["close"]);
});
test("mobile ownership refuses missing, foreign, unreadable, and desktop-locked markers", async t => {
  const { native, host, adapter } = fixture(t);
  const check = () => NativeSync.prototype.checkOwnership.call(native);
  await assert.rejects(check(), { code: "folder_owned", owner: "unknown" });
  await host.mkdir(".mdbase");
  await host.writeAtomic(".mdbase/host.json", JSON.stringify({ host: "daemon" }));
  await assert.rejects(check(), { code: "folder_owned", owner: "desktop", takeover: false, message: /the mdbase desktop app/ });
  assert.deepEqual(JSON.parse(await adapter.read(".mdbase/host.json")), { host: "daemon" });
  await adapter.write(".mdbase/host.json", "corrupt");
  await assert.rejects(check(), { code: "folder_owned", owner: "unreadable" });
  native.data.markerSince = 123;
  await native.writeMarker(); await check();
  const own = JSON.parse(await adapter.read(".mdbase/host.json"));
  assert.equal("pid" in own, false);
  await host.writeBytes(".mdbase/host.lock", new Uint8Array());
  await assert.rejects(check(), { code: "folder_owned", owner: "desktop", takeover: false });
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
test("a fresh mobile install over an earlier install's quiet marker raises no notice; the desktop app's still blocks", async t => {
  for (const [marker, owner, takeover] of [
    [{ host: "obsidian", collection_id: null, since_ms: 1, heartbeat_ms: Date.now() - 60 * 60_000 }, "obsidian", true],
    [{ host: "obsidian", collection_id: null, since_ms: 1, heartbeat_ms: Date.now() }, "obsidian", false],
    [{ host: "daemon", heartbeat_ms: 0 }, "desktop", false],
  ]) {
    const { native, adapter } = fixture(t);
    delete native.checkOwnership; native.mirroring = false;
    const failures = []; native.fail = (...args) => failures.push(args);
    native.registerDomEvent = () => {}; native.registerEvent = () => {};
    await adapter.mkdir(".mdbase"); await adapter.write(".mdbase/host.json", JSON.stringify(marker));
    await native.initialize();
    t.after(() => native.onunload());
    assert.deepEqual([native.phase.kind, native.phase.owner, native.phase.takeover], ["blocked", owner, takeover]);
    assert.deepEqual(failures, []);
    assert.deepEqual(JSON.parse(await adapter.read(".mdbase/host.json")), marker);
  }
});
test("iOS capacitor://localhost boots with opaque location.origin and completes capability-checked hello handshake", async t => {
  const { native, adapter, app } = fixture(t);
  delete native.checkOwnership; native.mirroring = false;
  const previousLocation = window.location;
  window.location = { origin: "null", href: "capacitor://localhost/index.html" };
  adapter.getResourcePath = file => `capacitor://localhost/_capacitor_file_/private/var/mobile/Containers/Data/Application/11111111-2222-3333-4444-555555555555/Documents/Vault/${file}?v=1`;
  t.after(() => { window.location = previousLocation; });
  const posted = [];
  const frameWindow = { postMessage(msg, targetOrigin, transfer) { posted.push({ msg, targetOrigin, transfer }); } };
  let frameSrc = "";
  app.workspace.containerEl = { createEl(_tag, opts) { frameSrc = opts.attr.src; return { style: {}, contentWindow: frameWindow, remove() {} }; } };
  native.registerDomEvent = () => {}; native.registerEvent = () => {};
  await native.initialize();
  t.after(() => native.onunload());
  assert.equal(native.origin, "capacitor://localhost");
  assert.match(frameSrc, /^blob:/);
  const html = await (await fetch(frameSrc)).text();
  assert.match(html, /<base href="capacitor:\/\/localhost\/_capacitor_file_\/private\/var\/mobile\/Containers\/Data\/Application\/11111111-2222-3333-4444-555555555555\/Documents\/Vault\/\.plugin\/sync-engine\/">/);
  const config = JSON.parse(html.match(/globalThis.mdbaseHost=(.*?); await import/)[1]);
  assert.equal(config.origin, "capacitor://localhost");
  assert.equal(typeof config.capability, "string");
  assert.ok(config.capability.length > 0);
  // Opaque hello without the matching capability is dropped.
  await native.onMessage({ origin: "null", source: frameWindow, data: { type: "hello", origin: "capacitor://localhost", capability: "wrong", opfs: true, isSecureContext: true } });
  assert.equal(native.bridge, null);
  assert.equal(posted.length, 0);
  // Opaque hello with the matching capability establishes the MessageChannel using "*" targetOrigin.
  native.checkOwnership = () => {};
  native.call = async () => ({ kind: "signed_out" });
  await native.onMessage({ origin: "null", source: frameWindow, data: { type: "hello", origin: "capacitor://localhost", capability: config.capability, opfs: true, isSecureContext: true } });
  assert.notEqual(native.bridge, null);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].msg, { type: "connect" });
  assert.equal(posted[0].targetOrigin, "*");
  assert.equal(posted[0].transfer.length, 1);
});
test("the engine page on capacitor://localhost uses embedded origin, mobile installation_origins, and echoes capability", async t => {
  const workers = [], helloMessages = [];
  const previous = { location: globalThis.location, parent: globalThis.parent, Worker: globalThis.Worker, secure: globalThis.isSecureContext };
  window.mdbaseHost = { namespace: "obsidian-vault-ios", origin: "capacitor://localhost", capability: "cap-ios-1", workerUrl: "blob:capacitor://localhost/worker" };
  window.document = { baseURI: "capacitor://localhost/_capacitor_file_/vault/.plugin/sync-engine/" };
  window.addEventListener = () => {};
  globalThis.location = { origin: "null", href: "blob:capacitor://localhost/engine" };
  globalThis.parent = { postMessage(msg) { helloMessages.push(msg); } }; globalThis.isSecureContext = true;
  globalThis.Worker = class { constructor(...args) { workers.push(args); } };
  globalThis.iosSdk = { setForeground() {}, subscribe() {}, getSnapshot: () => ({ phase: { kind: "signed_out" } }) };
  t.after(() => {
    Object.assign(globalThis, { location: previous.location, parent: previous.parent, Worker: previous.Worker, isSecureContext: previous.secure });
    for (const key of ["mdbaseHost", "document", "addEventListener"]) delete window[key];
    delete globalThis.iosSdk; delete globalThis.iosDeclaration; delete globalThis.iosOptions;
  });
  const page = await build({ entryPoints: ["src/sync/native/page.ts"], bundle: true, format: "esm", platform: "browser", write: false,
    define: { __MDBASE_ENVIRONMENT__: '"production"' },
    plugins: [{ name: "sdk", setup(builder) {
      builder.onResolve({ filter: /^@mdbase-dev\/sdk$/ }, () => ({ path: "sdk", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export function createMdbase(declaration, options) { globalThis.iosDeclaration=declaration; globalThis.iosOptions=options; return globalThis.iosSdk; }", loader: "js" }));
    } }],
  });
  await import(`data:text/javascript;base64,${Buffer.from(page.outputFiles[0].contents).toString("base64")}`);
  assert.equal(globalThis.iosDeclaration.origin, "capacitor://localhost");
  assert.equal(globalThis.iosDeclaration.manifest.homepage, "http://localhost/");
  assert.deepEqual(globalThis.iosDeclaration.manifest.installation_origins, { production: { mobile: ["capacitor://localhost"] } });
  globalThis.iosOptions.worker("capacitor://localhost/_capacitor_file_/vault/.plugin/sync-engine/sdk/application/worker.js");
  assert.deepEqual(workers, [["blob:capacitor://localhost/worker", { type: "module" }]]);
  assert.equal(helloMessages.length, 1);
  assert.equal(helloMessages[0].origin, "capacitor://localhost");
  assert.equal(helloMessages[0].capability, "cap-ios-1");
});
test("on mobile, Set up sync here replaces an earlier install's quiet marker from the fresh host", async t => {
  const { native, adapter, app } = fixture(t);
  delete native.checkOwnership; native.mirroring = false;
  native.registerDomEvent = () => {}; native.registerEvent = () => {};
  app.workspace.containerEl = { createEl() { return { style: {}, remove() {} }; } };
  const old = JSON.stringify({ host: "obsidian", collection_id: null, since_ms: 1, heartbeat_ms: Date.now() - 60 * 60_000 });
  await adapter.mkdir(".mdbase"); await adapter.write(".mdbase/host.json", old);
  native.takeOverFrom = { marker: old };
  await native.initialize();
  t.after(() => native.onunload());
  const mine = JSON.parse(await adapter.read(".mdbase/host.json"));
  assert.equal(mine.since_ms, native.data.markerSince);
  assert.notEqual(native.phase.kind, "blocked");
});
