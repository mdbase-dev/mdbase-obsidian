import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";

globalThis.window = { require: createRequire(import.meta.url), setTimeout, setInterval, clearTimeout, clearInterval };
const result = await build({
  stdin: { contents: `export {default as NativeSync} from './src/sync/native/plugin.ts';
    export * from './src/sync/native/download.ts'; export * from './src/sync/native/downloadPull.ts';
    export * from './src/sync/native/upload.ts'; export * from './src/sync/ownership.ts';
    export { SyncController } from './src/sync/controller.ts';
    export {TFile, FileSystemAdapter} from 'obsidian';`, resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "mocks", setup(b) {
    b.onResolve({ filter: /^obsidian$|^embedded:assets$/ }, args => ({ path: args.path, namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian" ? `
      export class Component {} export class Notice {} export class SuggestModal {} export class App {}
      export class TAbstractFile {} export class TFile extends TAbstractFile { constructor(path) { super(); this.path = path; } }
      export class FileSystemAdapter { constructor(root) { this.root=root; } getBasePath() { return this.root; } }
    ` : 'export default {};', loader: "js" }));
  } }],
});
const { NativeSync, TFile, FileSystemAdapter, stageDownload, DownloadPull, BRIDGE_CHUNK_BYTES, RetryUploads, retryUpload, folderHost, SyncController } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.resolve("test/native/.fixture-"));
  fs.mkdirSync(path.join(root, ".plugin"));
  const files = () => {
    const out = [];
    const walk = dir => { for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = path.posix.join(dir, entry.name); if (p.startsWith(".")) continue;
      if (entry.isDirectory()) walk(p); else out.push(new TFile(p));
    } }; walk(""); return out;
  };
  const app = { workspace: { getLeavesOfType: () => [] }, vault: {
    configDir: ".plugin", adapter: new FileSystemAdapter(root), getFiles: files,
    getAbstractFileByPath: p => fs.existsSync(path.join(root, p)) ? new TFile(p) : null,
    createFolder: async p => fs.mkdirSync(path.join(root, p), { recursive: true }),
    rename: async (f, to) => fs.renameSync(path.join(root, f.path), path.join(root, to)),
  } };
  const native = new NativeSync(app, { dir: ".plugin" }, () => {});
  native.root = root; native.pluginDir = path.join(root, ".plugin");
  native.data = { version: 1, vaultId: "test-vault", paths: {} }; native.mirroring = true;
  native.checkOwnership = () => {}; native.log = () => {};
  const remote = new Map(); let count = 0;
  const putRemote = (p, doc, revision = "r1", id = "original") => remote.set(p, { id, path: p, document: doc, revision, confirmed: true });
  const put = (p, doc) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), doc); };
  native.call = async (method, ...args) => {
    if (method === "all") return [...remote.values()];
    if (method === "filesAll" || method === "rejectedWrites") return [];
    if (method === "create") { putRemote(args[0], args[1], "created", `new-${++count}`); return remote.get(args[0]); }
    if (method === "replace") {
      const [id, _base, next] = args; for (const [p, r] of remote) if (r.id === id) remote.delete(p);
      putRemote(next.path, next.doc, "replaced", id); return remote.get(next.path);
    }
    if (method === "remove") { for (const [p, r] of remote) if (r.id === args[0]) remote.delete(p); return true; }
    throw new Error(`Unexpected RPC ${method}`);
  };
  const baseline = (p = "note.md") => {
    put(p, "base"); putRemote(p, "base");
    native.data.paths[p] = { id: "original", kind: "record", revision: "r1", hash: digest("base"), disk: native.diskIdentity(p) }; native.persist();
  };
  t.after(() => { if (native.settleTimer) clearTimeout(native.settleTimer); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, native, remote, put, putRemote, baseline, read: p => fs.readFileSync(path.join(root, p), "utf8") };
}
for (const scenario of ["offline edit plus remote edit", "remote delete versus local edit", "remote rename versus local edit", "local rename versus remote edit"]) {
  test(scenario + " retains both versions", async t => {
    const f = fixture(t); f.baseline();
    if (scenario.startsWith("local rename")) {
      fs.renameSync(path.join(f.root, "note.md"), path.join(f.root, "moved.md"));
      f.putRemote("note.md", "remote edit", "r2");
    } else {
      f.put("note.md", "offline edit");
      if (scenario.startsWith("remote delete")) f.remote.clear();
      else if (scenario.startsWith("remote rename")) { f.remote.clear(); f.putRemote("moved.md", "remote edit", "r2"); }
      else f.putRemote("note.md", "remote edit", "r2");
    }
    await f.native.reconcileAll();
    const localDocuments = f.native.localPaths().map(f.read);
    assert.ok(localDocuments.includes(scenario.startsWith("local rename") ? "base" : "offline edit"));
    if (!scenario.startsWith("remote delete")) assert.ok(localDocuments.includes("remote edit"));
    assert.ok(!f.native.data.pathFailures || !Object.keys(f.native.data.pathFailures).length);
  });
}
test("crash after upload submission resumes saved bytes with the same identity", async t => {
  const f = fixture(t); f.put("image.bin", "original bytes");
  const identities = [];
  f.native.call = async (method, ...args) => {
    assert.equal(method, "upload"); identities.push(args[4]);
    throw Object.assign(new Error("timeout"), { code: "outcome_unknown" });
  };
  await assert.rejects(f.native.push("image.bin", await f.native.local("image.bin")));
  assert.equal(identities.length, 2);
  assert.deepEqual(identities[0], identities[1]);
  f.put("image.bin", "new edit after crash");
  f.native.data = f.native.readData();
  f.native.call = async (method, ...args) => {
    if (method === "uploadForget") return true;
    assert.equal(method, "upload"); assert.equal(args[4].transferId, identities[0].transferId); assert.equal(args[4].mutationId, identities[0].mutationId);
    assert.equal(Buffer.from(args[1]).toString(), "original bytes");
    return { id: "attachment", path: "image.bin", digest: digest("original bytes"), confirmed: true };
  };
  await f.native.resumeUploads();
  assert.equal(f.read("image.bin"), "new edit after crash");
  assert.equal(f.native.data.paths["image.bin"].hash, digest("original bytes"));
  assert.deepEqual(f.native.data.uploads, {});
});
test("crash after conflict publication reuses the journaled copy", async t => {
  const f = fixture(t); f.baseline(); f.put("note.md", "offline edit"); f.putRemote("note.md", "remote edit", "r2");
  const call = f.native.call; let failed = false;
  f.native.call = async (method, ...args) => {
    const result = await call(method, ...args);
    if (method === "create" && !failed) { failed = true; throw Object.assign(new Error("crash after confirmation"), { code: "outcome_unknown" }); }
    return result;
  };
  await f.native.reconcileAll();
  assert.ok(Object.keys(f.native.data.conflictCopies).length);
  f.native.data = f.native.readData(); f.native.call = call;
  await f.native.reconcileAll();
  const copies = f.native.localPaths().filter(p => p.includes("(conflict "));
  assert.equal(copies.length, 1); assert.equal(f.read(copies[0]), "offline edit"); assert.equal(f.read("note.md"), "remote edit");
});
test("handover removes only its own marker after reconcile, drain and stop", async t => {
  const f = fixture(t), order = []; f.native.data.collectionId = "collection";
  f.native.data.markerSince = 1; f.native.writeMarker();
  f.native.reconcileAll = async () => { order.push("reconcile"); return true; };
  f.native.call = async method => { order.push(method); assert.ok(fs.existsSync(f.native.markerPath)); };
  await f.native.handover();
  assert.deepEqual(order, ["reconcile", "unwatch", "drain", "stop"]); assert.equal(fs.existsSync(f.native.markerPath), false);
});
test("failed drain retains the marker and all local files", async t => {
  const f = fixture(t); f.native.data.collectionId = "collection"; f.native.data.markerSince = 1; f.native.writeMarker(); f.put("note.md", "unsent");
  f.native.reconcileAll = async () => true;
  f.native.call = async method => { if (method === "drain") throw new Error("offline"); };
  await f.native.handover();
  assert.ok(fs.existsSync(f.native.markerPath)); assert.equal(f.read("note.md"), "unsent");
});
test("RPC timeout joins the running SDK upload instead of enqueueing another", async () => {
  const uploads = new RetryUploads(); const identity = { transferId: "transfer", mutationId: "mutation" };
  let finish, calls = 0; const promise = new Promise(resolve => { finish = resolve; });
  const send = () => { calls++; return promise; };
  const first = uploads.run(identity, send), second = uploads.run(identity, send);
  assert.equal(first, second); finish("receipt"); assert.equal(await second, "receipt"); assert.equal(calls, 1);
  let tries = 0; await retryUpload(async () => { if (!tries++) throw { code: "outcome_unknown" }; return true; });
  assert.equal(tries, 2);
});
test("ownership selection never falls back because desktop is unreachable or stale", () => {
  assert.equal(folderHost(null), "plugin");
  assert.equal(folderHost({ host: "obsidian" }), "plugin");
  assert.equal(folderHost({ host: "daemon", heartbeat_ms: 0 }), "desktop");
  for (const marker of [{}, [], { host: "other" }, "invalid"]) assert.equal(folderHost(marker), "wait");
});
test("controller starts the SDK only without a desktop marker and changes both directions", async t => {
  const f = fixture(t), events = [];
  let created = 0;
  const controller = new SyncController({ vaultPath: () => f.root, vaultTopLevel: () => [], workspace: () => ({}), binaryOverride: () => "", appVersion: "test", openUrl() {},
    createNative: async (_changed, id) => { created++; events.push(id); return { load() {}, unload() { events.push("stopped"); } }; },
  }, false);
  controller.stopped = false;
  controller.cli.status = async () => { throw new Error("Desktop unreachable"); };
  t.after(() => controller.stop());
  await controller.refresh(); assert.equal(created, 1); assert.ok(controller.snapshot.direct);
  fs.mkdirSync(path.join(f.root, ".mdbase"), { recursive: true });
  const marker = path.join(f.root, ".mdbase/host.json");
  fs.writeFileSync(marker, JSON.stringify({ host: "daemon", collection_id: "same-collection", heartbeat_ms: 0 }));
  await controller.refresh(); assert.equal(controller.native, null); assert.equal(controller.snapshot.direct, undefined); assert.ok(events.includes("stopped"));
  await controller.refresh(); assert.equal(created, 1, "unreachable/stale desktop is never permission to take ownership");
  fs.unlinkSync(marker); await controller.refresh(); assert.equal(created, 2); assert.equal(events.at(-1), "same-collection");
  fs.writeFileSync(marker, "unreadable JSON"); await controller.refresh(); assert.equal(controller.native, null); assert.equal(created, 2);
});
test("copied vault journals cannot share a writable SDK namespace", t => {
  const f = fixture(t); f.native.bindVault(); const saved = structuredClone(f.native.data);
  const otherRoot = path.join(f.root, "another-vault"); fs.mkdirSync(otherRoot);
  const other = new NativeSync(f.native.app, {}, () => {}); other.root = otherRoot; other.data = saved;
  assert.throws(() => other.bindVault(), /another vault or host/);
  assert.equal(other.data.vaultId, f.native.data.vaultId, "refusal does not reset or discard the old journal");
});
test("a vault reuses its saved port and refuses to move when it is occupied", async t => {
  const f = fixture(t); await f.native.startServer(); const port = f.native.data.port;
  assert.equal((await fetch(f.native.origin)).status, 403, "untrusted pages cannot load the authenticated iframe without its memory-only capability");
  await new Promise(resolve => f.native.server.close(resolve));
  f.native.data = f.native.readData(); await f.native.startServer(); assert.equal(f.native.data.port, port);
  const other = new NativeSync(f.native.app, {}, () => {}); other.data = { port }; other.persist = () => {};
  await assert.rejects(other.startServer(), /not switching origins/);
  await new Promise(resolve => f.native.server.close(resolve));
});
test("50 MiB download crosses bridge in at most 4 MiB replies with one outstanding pull", async t => {
  const f = fixture(t), size = 50 * 1024 * 1024; let produced = 0, largest = 0, outstanding = 0, peak = 0;
  const hash = createHash("sha256");
  const stream = new DownloadPull((async function* () {
    while (produced < size) { const chunk = new Uint8Array(Math.min(BRIDGE_CHUNK_BYTES, size - produced)).fill(73); produced += chunk.length; hash.update(chunk); yield chunk; }
  })());
  const expected = createHash("sha256"); for (let n = 0; n < 50; n++) expected.update(Buffer.alloc(1024 * 1024, 73));
  const channel = new MessageChannel(); let resolveReply;
  t.after(() => { channel.port1.close(); channel.port2.close(); });
  channel.port1.on("message", reply => resolveReply(reply));
  channel.port2.on("message", async () => {
    const reply = await stream.next();
    channel.port2.postMessage(reply, reply.bytes ? [reply.bytes.buffer] : []);
  });
  const pullRpc = () => new Promise(resolve => { resolveReply = resolve; channel.port1.postMessage({ method: "downloadNext" }); });
  const target = path.join(f.root, "large.bin");
  await stageDownload({ directory: path.join(f.root, ".mdbase/incoming"), digest: `sha256:${expected.digest("hex")}`,
    next: async () => { outstanding++; peak = Math.max(peak, outstanding); const reply = await pullRpc(); outstanding--; largest = Math.max(largest, reply.bytes?.length ?? 0); return reply; },
    publish: async staged => fs.renameSync(staged, target), close: () => stream.close(),
  });
  assert.equal(fs.statSync(target).size, size); assert.equal(produced, size); assert.equal(peak, 1); assert.equal(largest, BRIDGE_CHUNK_BYTES);
});
for (const failure of ["verified EOF rejects", "digest mismatch"]) test(failure + " discards provisional bytes and leaves vault file untouched", async t => {
  const f = fixture(t); f.put("attachment.bin", "existing bytes");
  const stream = new DownloadPull((async function* () { yield new Uint8Array([1, 2, 3]); if (failure.startsWith("verified")) throw new Error("verification failed"); })());
  await assert.rejects(stageDownload({ directory: path.join(f.root, ".mdbase/incoming"), digest: digest("different bytes"), next: () => stream.next(),
    publish: async staged => fs.renameSync(staged, path.join(f.root, "attachment.bin")), close: () => stream.close(),
  }));
  assert.equal(f.read("attachment.bin"), "existing bytes"); assert.deepEqual(fs.readdirSync(path.join(f.root, ".mdbase/incoming")), []);
});
