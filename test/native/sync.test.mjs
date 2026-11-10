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
      export function parseYaml(text) { return JSON.parse(text); } // fixtures write JSON, which is YAML
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
  const remote = new Map(), resources = new Map(); let count = 0, resourceRevision = 0;
  const putResource = (p, doc) => resources.set(p, { id: p, path: p, document: doc, revision: `res-${++resourceRevision}`, confirmed: true });
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
    if (method === "resourcesAll") return [...resources.values()];
    if (method === "resourcePut") {
      const [p, doc, base] = args, current = resources.get(p);
      if (base ? current?.revision !== base : current) throw Object.assign(new Error("CAS"), { code: "conflict", reason: "revision" });
      putResource(p, doc); return resources.get(p);
    }
    if (method === "resourceDelete") {
      if (resources.get(args[0])?.revision !== args[1]) throw Object.assign(new Error("CAS"), { code: "conflict", reason: "revision" });
      resources.delete(args[0]); return true;
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  const baseline = (p = "note.md") => {
    put(p, "base"); putRemote(p, "base");
    native.data.paths[p] = { id: "original", kind: "record", revision: "r1", hash: digest("base"), disk: native.diskIdentity(p) }; native.persist();
  };
  t.after(() => { for (const timer of ["settleTimer", "persistTimer", "commitTimer"]) if (native[timer]) clearTimeout(native[timer]); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, native, remote, resources, put, putRemote, putResource, baseline, read: p => fs.readFileSync(path.join(root, p), "utf8") };
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

test("definitions sync as definitions, before the notes that use them", async t => {
  const f = fixture(t), order = [];
  f.put("mdbase.yaml", JSON.stringify({ settings: { types_folder: "_types" } }));
  f.put("_types/book.md", "---\nname: book\n---\n");
  f.put("Library/Dune.md", "---\ntype: book\n---\n");
  const call = f.native.call;
  f.native.call = async (method, ...args) => {
    if (["create", "resourcePut", "upload"].includes(method)) order.push(`${method} ${args[0]}`);
    if (method === "create" && !f.resources.has("_types/book.md")) throw Object.assign(new Error("unknown type"), { code: "invalid_record" });
    return call(method, ...args);
  };
  assert.equal(await f.native.reconcileAll(), true);
  assert.deepEqual(order, ["resourcePut mdbase.yaml", "resourcePut _types/book.md", "create Library/Dune.md"]);
  assert.equal(f.native.data.paths["_types/book.md"].kind, "resource");
  assert.ok(!f.remote.has("_types/book.md") && !f.remote.has("mdbase.yaml"), "never sent as records or files");
});
test("hidden, node_modules and settings.exclude paths are never sent", async t => {
  const f = fixture(t), sent = [];
  f.put("mdbase.yaml", JSON.stringify({ settings: { exclude: ["drafts/**", "*.tmp"] } }));
  for (const p of [".gitignore", "node_modules/x/index.md", "drafts/a/b.md", "scratch.tmp", "keep.md"]) f.put(p, "text");
  const call = f.native.call;
  f.native.call = async (method, ...args) => { if (["create", "upload"].includes(method)) sent.push(args[0]); return call(method, ...args); };
  assert.equal(await f.native.reconcileAll(), true);
  assert.deepEqual(sent, ["keep.md"]);
  assert.deepEqual(f.native.view().failures, []);
});
test("a refused note doesn't stop the others and retries once the definitions change", async t => {
  const f = fixture(t); f.put("bad.md", "bad"); f.put("good.md", "good"); f.putResource("_types/note.md", "v1");
  f.native.data.paths["_types/note.md"] = { id: "_types/note.md", kind: "resource", revision: "res-1", hash: digest("v1") };
  f.put("_types/note.md", "v1");
  const call = f.native.call; let strict = true;
  f.native.call = async (method, ...args) => {
    if (method === "create" && args[0] === "bad.md" && strict)
      throw Object.assign(new Error("invalid"), { code: "invalid_record", issues: [{ code: "missing_required", severity: "error", message: "Missing required field title" }] });
    return call(method, ...args);
  };
  assert.equal(await f.native.reconcileAll(), false);
  assert.ok(f.remote.has("good.md"));
  assert.deepEqual(f.native.view().failures.map(x => [x.path, x.title, x.detail]), [["bad.md", "Doesn't match its type", "Missing required field title. Fix the note and it will sync."]]);
  assert.equal(await f.native.reconcileAll(), false, "unchanged input is not resent");
  strict = false; f.putResource("_types/note.md", "v2"); // the type changed elsewhere
  assert.equal(await f.native.reconcileAll(), true);
  assert.ok(f.remote.has("bad.md")); assert.equal(f.read("_types/note.md"), "v2");
});
test("a refused or misclassified saved upload is dropped instead of failing every pass", async t => {
  const f = fixture(t); const uploadsDir = path.join(f.root, ".mdbase/uploads"); fs.mkdirSync(uploadsDir, { recursive: true });
  const ids = { ".gitignore": "11111111-1111-1111-1111-111111111111", "image.bin": "22222222-2222-2222-2222-222222222222" };
  f.native.data.uploads = {};
  for (const [p, id] of Object.entries(ids)) {
    f.put(p, "bytes"); fs.writeFileSync(path.join(uploadsDir, id), "bytes");
    f.native.data.uploads[p] = { transferId: id, mutationId: id, hash: digest("bytes") };
  }
  const calls = [];
  f.native.call = async (method, ...args) => {
    calls.push(`${method} ${args[0]}`);
    if (method === "upload") throw Object.assign(new Error("refused"), { code: "invalid_request" });
    return true;
  };
  await f.native.resumeUploads();
  assert.deepEqual(f.native.data.uploads, {});
  assert.ok(!calls.includes("upload .gitignore"), "an excluded path is never resent");
  assert.equal(f.read(".gitignore"), "bytes"); assert.equal(f.read("image.bin"), "bytes");
});
test("a definition changed on both sides waits for the user's choice, without a conflict copy", async t => {
  const f = fixture(t); const p = "_types/book.md";
  f.putResource(p, "base"); f.put(p, "base");
  f.native.data.paths[p] = { id: p, kind: "resource", revision: "res-1", hash: digest("base") };
  f.put(p, "local edit"); f.putResource(p, "remote edit");
  assert.equal(await f.native.reconcileAll(), false);
  const [failure] = f.native.view().failures;
  assert.equal(failure.path, p); assert.equal(failure.choose, true);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "_types")), ["book.md"], "no second type file");
  f.native.admitting = true;
  await f.native.resolveDefinition(p, "remote"); await f.native.jobs;
  assert.equal(f.read(p), "remote edit"); assert.deepEqual(f.native.view().failures, []);
  const [stamp] = fs.readdirSync(path.join(f.root, ".mdbase/replaced"));
  assert.equal(fs.readFileSync(path.join(f.root, ".mdbase/replaced", stamp, p), "utf8"), "local edit");
});
test("first sync asks before combining a vault and a collection that both have notes", async t => {
  const f = fixture(t), phase = { kind: "ready", collectionId: "c1", collections: [{ id: "c1", name: "Test" }] };
  f.native.phase = phase; f.put("mine.md", "mine");
  assert.equal(await f.native.needsMergeConfirmation(phase), false, "empty collection: nothing to combine");
  f.putRemote("theirs.md", "theirs");
  assert.equal(await f.native.needsMergeConfirmation(phase), true);
  assert.deepEqual(f.native.view().merge, { collectionId: "c1", name: "Test", local: 1, remote: 1 });
  f.native.data.mergeConfirmed = "c1";
  assert.equal(await f.native.needsMergeConfirmation(phase), false, "asked once per collection");
  f.native.data.mergeConfirmed = undefined; f.native.data.cursor = "after-first-sync";
  assert.equal(await f.native.needsMergeConfirmation(phase), false, "never asked again once synced");
});

test("a failure recorded when a definition was sent as a note doesn't block it now", async t => {
  const f = fixture(t); f.put("_types/book.md", "type");
  // What an earlier build saved after sending it as a record and being refused.
  f.native.data.pathFailures = { "_types/book.md": { signature: JSON.stringify([digest("type"), undefined, undefined, undefined]), code: "invalid_request", reason: "not_a_record_path" } };
  assert.equal(await f.native.reconcileAll(), true);
  assert.equal(f.resources.get("_types/book.md")?.document, "type");
});

test("leaving a folder out forgets it here without deleting anything, and turning it back on restores it", async t => {
  const f = fixture(t); f.baseline("Archive/note.md");
  await f.native.setDevice({ skip: [], folders: ["Archive"] });
  assert.equal(f.native.data.paths["Archive/note.md"], undefined, "no synced state for a skipped path");
  assert.equal(f.read("Archive/note.md"), "base", "the local copy stays");
  assert.ok(f.remote.has("Archive/note.md"), "the collection keeps it");
  fs.rmSync(path.join(f.root, "Archive/note.md"));
  await f.native.reconcileAll();
  assert.ok(f.remote.has("Archive/note.md"), "deleting a skipped file here is not a delete");
  await f.native.setDevice({ skip: [], folders: [] });
  assert.equal(f.read("Archive/note.md"), "base", "turning the folder back on brings it here again");
  assert.equal(f.native.activity[0].kind, "downloaded");
});

test("moving a note into a folder this device leaves out is a move for other devices", async t => {
  const f = fixture(t); f.baseline("note.md");
  await f.native.setDevice({ skip: [], folders: ["Archive"] });
  fs.mkdirSync(path.join(f.root, "Archive"));
  fs.renameSync(path.join(f.root, "note.md"), path.join(f.root, "Archive/note.md"));
  await f.native.reconcileAll();
  assert.deepEqual([...f.remote.keys()], ["Archive/note.md"], "moved, not deleted");
  assert.equal(f.native.data.paths["Archive/note.md"], undefined);
  assert.equal(f.native.data.paths["note.md"], undefined);
  assert.deepEqual([f.native.activity[0].kind, f.native.activity[0].to], ["moved", "Archive/note.md"]);
});

test("a note moved elsewhere into a folder this device leaves out goes from here only", async t => {
  const f = fixture(t); f.baseline("note.md");
  await f.native.setDevice({ skip: [], folders: ["Archive"] });
  f.remote.delete("note.md"); f.putRemote("Archive/note.md", "base", "r2");
  await f.native.reconcileAll();
  assert.equal(fs.existsSync(path.join(f.root, "note.md")), false, "removed here");
  assert.equal(fs.existsSync(path.join(f.root, "Archive/note.md")), false, "not downloaded into the skipped folder");
  assert.ok(f.remote.has("Archive/note.md"), "kept in the collection");
});
test("an edit whose send was cut off by a reload is not a conflict when the server kept it", async t => {
  for (const known of [true, false]) {
    const f = fixture(t);
    if (known) f.baseline(); else f.put("note.md", "base");
    // The server applies the send, but the reply never arrives (plugin unloads).
    const call = f.native.call;
    f.native.call = async (method, ...args) => {
      if (method === "replace" || method === "create") { await call(method, ...args); throw new Error("unloaded"); }
      return call(method, ...args);
    };
    f.put("note.md", "typed i");
    await assert.rejects(f.native.push("note.md", await f.native.local("note.md"), known ? f.remote.get("note.md") && { ...f.remote.get("note.md"), kind: "record", hash: digest("base") } : undefined));
    f.native.call = call;
    // Reload: state comes back from disk, and typing continued meanwhile.
    f.native.data = f.native.readData();
    f.put("note.md", "typed it");
    await f.native.reconcileAll();
    assert.equal(f.remote.get("note.md").document, "typed it", known ? "the newer edit is sent on" : "a cut-off create is adopted");
    assert.deepEqual(fs.readdirSync(f.root).filter(n => /conflict/.test(n)), [], "no conflict copy");
    assert.deepEqual(f.native.data.sending, {});
  }
});
test("files the collection's own settings leave out are neither sent, fetched nor deleted", async t => {
  const f = fixture(t);
  f.put("clip.mp4", "local video"); f.put("photo.png", "local image"); f.put("note.md", "note");
  const sent = [], call = f.native.call;
  f.native.call = async (method, ...args) => {
    if (method === "inclusion") return { include: ["image", "audio", "pdf", "other"], maxSize: 5 };
    if (method === "filesAll") return [{ id: "v2", path: "remote.mp4", size: 3, digest: digest("abc"), confirmed: true }];
    if (["create", "upload"].includes(method)) sent.push(args[0]);
    return call(method, ...args);
  };
  await f.native.reconcileAll();
  assert.deepEqual(sent, ["note.md"], "neither the video nor the image over the size limit is sent");
  assert.equal(f.read("clip.mp4"), "local video", "a left-out file stays here");
  assert.ok(!fs.existsSync(path.join(f.root, "remote.mp4")), "a left-out file isn't fetched");
  assert.equal(f.native.totals.byCollection, 1);
  assert.equal(f.native.view().inclusion.maxSize, 5);
});
test("device choices that match no file yet survive a reload (QA-1)", async t => {
  const f = fixture(t); f.put("note.md", "n"); await f.native.reconcileAll();
  await f.native.setDevice({ skip: ["video"], folders: ["future-private"] });
  f.native.data = f.native.readData();
  assert.deepEqual(f.native.device, { skip: ["video"], folders: ["future-private"] });
  f.put("future-private/secret.md", "s");
  await f.native.reconcileAll();
  assert.ok(!f.remote.has("future-private/secret.md"), "nothing in a left-out folder is sent after reload");
});
test("leaving out a folder of refused notes clears their records, so Last synced updates (QA-5)", async t => {
  const f = fixture(t); f.put("note.md", "n"); await f.native.reconcileAll();
  f.native.data.pathFailures = { "qa/bad.md": { signature: "x", code: "invalid_request", reason: "invalid_frontmatter" } };
  f.native.data.pendingPaths = { "qa/bad.md": Date.now() + 60_000 };
  f.native.data.sending = { "qa/bad.md": "sha256:abc" };
  f.put("qa/bad.md", "bad");
  f.native.lastSynced = null;
  await f.native.setDevice({ skip: [], folders: ["qa"] });
  assert.deepEqual([f.native.data.pathFailures, f.native.data.pendingPaths, f.native.data.sending], [{}, {}, {}]);
  assert.ok(f.native.lastSynced, "a clean full pass records Last synced");
});
test("a pending full-scan retry keeps the status busy when the SDK reports synced (QA-2)", async t => {
  const f = fixture(t); const seen = [];
  f.native.changed = text => seen.push(text);
  f.native.admitting = true; f.native.syncingFiles = false;
  f.native.phase = { kind: "ready", collectionId: "c" };
  f.native.reconcileRetryTimer = 1;
  await f.native.onPhase({ kind: "ready", collectionId: "c", sync: { kind: "synced", text: "Synced through 9", pending: 0 } });
  assert.ok(!seen.includes("Synced through 9"));
});
test("going offline during an upload reaches the UI without replacing the progress text (QA2-1)", async t => {
  const f = fixture(t); const seen = [];
  f.native.changed = (text, phase) => seen.push([text, phase.sync?.kind]);
  f.native.admitting = true; f.native.syncingFiles = true;
  f.native.statusText = "Uploading 83 of 500 notes";
  f.native.phase = { kind: "ready", collectionId: "c", sync: { kind: "synced", text: "Synced through 9, 16 changes waiting", pending: 16 } };
  await f.native.onPhase({ kind: "ready", collectionId: "c", sync: { kind: "synced", text: "Synced through 10, 15 changes waiting", pending: 15 } });
  assert.deepEqual(seen, [], "routine progress during a pass is not republished");
  await f.native.onPhase({ kind: "ready", collectionId: "c", sync: { kind: "offline", text: "Can't reach the sync service.", pending: 16 } });
  await f.native.onPhase({ kind: "ready", collectionId: "c", sync: { kind: "synced", text: "Synced through 11", pending: 14 } });
  assert.deepEqual(seen, [["Uploading 83 of 500 notes", "offline"], ["Uploading 83 of 500 notes", "synced"]]);
});
test("a locked Private collection waits for its key instead of stopping sync", async t => {
  const f = fixture(t); const seen = [], calls = [];
  f.native.changed = text => seen.push(text);
  f.native.admitting = true; f.native.mirroring = false;
  f.native.writeMarker = () => {}; f.native.ownsMarker = () => true;
  f.native.call = async (method, ...args) => { calls.push([method, ...args]); return {}; };
  const locked = { kind: "needs_unlock", collectionId: "c", unlock: { mode: "password", unlocking: false, name: "Journal" }, collections: [{ id: "c", name: "Journal", private: true }] };
  await f.native.onPhase(locked);
  assert.equal(f.native.data.collectionId, "c", "the vault is bound to the collection it is waiting on");
  assert.match(seen.at(-1), /encryption password/);
  await f.native.unlock({ password: "correct horse" });
  assert.deepEqual(calls, [["unlock", "c", { password: "correct horse" }]]);
  // A wrong password comes back on the phase. It is the form's to show.
  await f.native.onPhase({ ...locked, problem: { key: "wrong_secret", title: "That isn't right", message: "The password or recovery key doesn't match." } });
  assert.ok(!seen.some(text => /Sync stopped/.test(text)), "a wrong password is not a sync failure");
  await f.native.onPhase({ ...locked, unlock: { ...locked.unlock, unlocking: true } });
  assert.equal(seen.at(-1), "Unlocking your collection.");
  await f.native.unlock({ password: "again" });
  assert.equal(calls.length, 1, "no second attempt while one is running");
  await f.native.onPhase({ ...locked, unlock: { mode: "strict", unlocking: false, name: "Journal" } });
  assert.match(seen.at(-1), /can't be unlocked in Obsidian/);
  assert.equal(f.native.canChooseAnother, true, "nothing has synced, so another collection can still be chosen");
  f.native.data.paths["note.md"] = { id: "x", kind: "record", revision: "r", hash: "h" };
  assert.equal(f.native.canChooseAnother, false);
});
test("access removed: one clean sentence that later notices and a finishing pass don't replace (LAB F1, F4)", async t => {
  const f = fixture(t); const seen = [], calls = [];
  f.native.changed = (text, phase) => seen.push([text, phase.kind]);
  f.native.admitting = true; f.native.mirroring = true;
  f.native.phase = { kind: "ready", collectionId: "c", sync: { kind: "synced", text: "Synced through 9", pending: 0 } };
  const problem = { code: "access_removed", reason: null, key: "installation_scope_removed", action: "approve", title: "Access was removed",
    message: "This app's previous installation cannot regain access to this collection. Request access again to approve a new installation for this collection. Your other collections keep their access." };
  const stopped = { kind: "problem", collectionId: "c", sync: { kind: "synced", text: "Synced through 9", pending: 0 }, problem };
  await f.native.onPhase(stopped);
  const [text, kind] = seen.at(-1);
  assert.equal(kind, "problem");
  assert.match(text, /^Sync stopped\. Access to this collection was removed/);
  assert.doesNotMatch(text, /: |\.\.|Check Sync/);
  // The replica keeps publishing (counts, collection list) with the same problem.
  await f.native.onPhase({ ...stopped, sync: { ...stopped.sync, pending: 1 }, collections: [] });
  assert.deepEqual(seen.at(-1), [text, "problem"], "a later notice keeps the reason");
  // A pass that was running when access went keeps its counts but not "Synced".
  f.native.passStatus("Synced through 9");
  f.native.passStatus("Checking your files");
  assert.deepEqual(seen.at(-1), [text, "problem"]);
  // Request access again uses the SDK's approve for this collection.
  f.native.call = async (method, ...args) => { calls.push([method, ...args]); return {}; };
  await f.native.requestAccess();
  assert.deepEqual(calls, [["approve", "c"]]);
  f.native.phase = { ...stopped, problem: { ...problem, action: "retry" } };
  await f.native.requestAccess();
  assert.equal(calls.length, 1, "only a stop that asks for approval requests it");
});
test("unlock does nothing unless a collection is waiting for its key", async t => {
  const f = fixture(t); const calls = [];
  f.native.call = async (method, ...args) => { calls.push([method, ...args]); return {}; };
  f.native.phase = { kind: "ready", collectionId: "c" };
  await f.native.unlock({ password: "x" }); await f.native.recheckLock();
  assert.deepEqual(calls, []);
});
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
test("plain note sends run several at once, and every note arrives", async t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) f.put(`bulk/n${i}.md`, `note ${i}`);
  const call = f.native.call; let flying = 0, most = 0;
  f.native.call = async (method, ...args) => {
    if (method !== "create") return call(method, ...args);
    most = Math.max(most, ++flying); await tick();
    try { return await call(method, ...args); } finally { flying--; }
  };
  const persist = f.native.persist.bind(f.native); let saves = 0;
  f.native.persist = () => { saves++; persist(); };
  assert.equal(await f.native.reconcileAll(), true);
  assert.equal(f.remote.size, 100);
  for (let i = 0; i < 100; i++) assert.equal(f.remote.get(`bulk/n${i}.md`).document, `note ${i}`);
  assert.ok(most > 1 && most <= 16, `between 2 and 16 sends in flight, saw ${most}`);
  assert.ok(saves < 50, `state is saved per batch, not per note: ${saves} saves for 100 notes`);
  const saved = f.native.readData();
  assert.equal(Object.keys(saved.paths).length, 100, "the finished pass is all on disk");
  assert.deepEqual(saved.sending, {});
  assert.equal(f.native.activity.filter(a => a.kind === "uploaded").length, 100);
});
test("every send is journaled on disk before it leaves", async t => {
  const f = fixture(t);
  for (let i = 0; i < 40; i++) f.put(`n${i}.md`, `note ${i}`);
  const call = f.native.call;
  f.native.call = async (method, ...args) => {
    if (method === "create") assert.equal(f.native.readData().sending?.[args[0]], digest(args[1]), `${args[0]} is journaled before sending`);
    return call(method, ...args);
  };
  assert.equal(await f.native.reconcileAll(), true);
  assert.equal(f.remote.size, 40);
});
test("a conflict among concurrent sends is resolved alone, after the others finish", async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) {
    const p = `n${i}.md`; f.put(p, "base"); f.putRemote(p, "base", "r1", `id-${i}`);
    f.native.data.paths[p] = { id: `id-${i}`, kind: "record", revision: "r1", hash: digest("base"), disk: f.native.diskIdentity(p) };
  }
  f.native.persist();
  for (let i = 0; i < 30; i++) f.put(`n${i}.md`, `edit ${i}`);
  const call = f.native.call; let flying = 0; const duringConflict = [];
  f.native.call = async (method, ...args) => {
    if (method !== "replace") return call(method, ...args);
    flying++; await tick();
    try {
      // Another device changed n7 after this pass listed the collection.
      if (args[2].path === "n7.md") { f.putRemote("n7.md", "theirs", "r2", "id-7"); throw Object.assign(new Error("CAS"), { code: "conflict", reason: "revision" }); }
      return await call(method, ...args);
    } finally { flying--; }
  };
  const conflict = f.native.conflict.bind(f.native);
  f.native.conflict = async (...args) => { duringConflict.push(flying); return conflict(...args); };
  await f.native.reconcileAll();
  assert.deepEqual(duringConflict, [0], "no send is in flight while the conflict is resolved");
  for (let i = 0; i < 30; i++) if (i !== 7) assert.equal(f.remote.get(`n${i}.md`).document, `edit ${i}`);
  assert.equal(f.read("n7.md"), "theirs", "the other device's version takes the original path");
  const copy = fs.readdirSync(f.root).find(n => /^n7 \(conflict/.test(n));
  assert.equal(f.read(copy), "edit 7", "this device's edit is kept as a conflict copy");
});
test("a refused note among concurrent sends is listed; the rest still arrive", async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.put(`n${i}.md`, `note ${i}`);
  const call = f.native.call;
  f.native.call = async (method, ...args) => {
    if (method === "create" && args[0] === "n3.md") { await tick(); throw Object.assign(new Error("refused"), { code: "invalid_request", reason: "invalid_frontmatter" }); }
    return call(method, ...args);
  };
  assert.equal(await f.native.reconcileAll(), false);
  assert.equal(f.remote.size, 29);
  assert.deepEqual(f.native.view().failures.map(x => [x.path, x.title]), [["n3.md", "Properties can't be read"]]);
  assert.equal(f.native.readData().sending?.["n3.md"], undefined, "a refused send leaves no journal entry");
});
test("sync stopping mid-batch starts no further sends, and a restart finishes without conflicts", async t => {
  const f = fixture(t);
  for (let i = 0; i < 60; i++) f.put(`n${i}.md`, `note ${i}`);
  const call = f.native.call; let sent = 0;
  f.native.call = async (method, ...args) => {
    if (method !== "create") return call(method, ...args);
    await tick();
    // The plugin unloads partway: sends already out reach the server, their replies don't arrive.
    if (++sent === 20) f.native.mirroring = false;
    const r = await call(method, ...args);
    if (!f.native.mirroring) throw new Error("unloaded");
    return r;
  };
  await assert.rejects(f.native.reconcileAll());
  assert.ok(sent < 60, `stopped early: ${sent} sends started`);
  const landed = f.remote.size;
  // Restart: state from disk, and one note edited while the plugin was down.
  f.native.call = call; f.native.mirroring = true; f.native.data = f.native.readData();
  f.put("n0.md", "note 0 edited");
  assert.equal(await f.native.reconcileAll(), true);
  assert.ok(landed > 0 && f.remote.size === 60);
  assert.equal(f.remote.get("n0.md").document, "note 0 edited");
  assert.deepEqual(fs.readdirSync(f.root).filter(n => /conflict/.test(n)), [], "no conflict copies");
  assert.equal(new Set([...f.remote.values()].map(r => r.id)).size, 60, "no note was created twice");
});
