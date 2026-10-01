import "fake-indexeddb/auto";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CollectionFileDescriptor } from "@mdbase-dev/connect-protocol";
import { test } from "node:test";
import type { TFile } from "obsidian";
import { MemoryAuthority, type SyncTransport } from "@mdbase-dev/connect-sync";
import { MemoryMirrorBlobStore, MemoryMirrorStateStore, WritableDirectoryMirror, type MirrorState } from "@mdbase-dev/connect-sync/mirror";
import { ConnectSyncController, ObsidianMirrorFileSystem, type MirrorProfile } from "../src/connectSync";
import { MemoryVault } from "./memoryVault";

async function pair(document = "base line\n", extraRecords: { record_id: string; path: string; document: string }[] = []) {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "plan", path: "plan.md", frontmatter: {}, body: document, document, types: [] },
    ...extraRecords.map((record) => ({ ...record, frontmatter: {}, body: record.document, types: [] }))]);
  const replicaId = hosted.registerReplica({ name: "Here", mode: "read_write" });
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  const blobs = new MemoryMirrorBlobStore();
  await vault.createFolder(".mdbase");
  await vault.create(".mdbase/connect-role.json", JSON.stringify({ version: 1, role: "mirror", collection_id: hosted.collectionId }));
  let profile: MirrorProfile | null = {
    version: 1, syncUrl: `https://sync.example/v1/authorities/${hosted.collectionId}/sync`,
    controlUrl: "https://connect.example", collectionId: hosted.collectionId, replicaId,
    mode: "read_write", name: "Here", enrollmentId: "11111111-1111-4111-8111-111111111111",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    selectiveSync: { file_classes: ["image"], excluded_folders: [] },
  };
  let wrapTransport = (transport: SyncTransport) => transport;
  const controller = new ConnectSyncController({ vault, secretStorage: {
    getSecret: () => "test-credential", setSecret: () => undefined,
  } } as never, {
    getMirrorProfile: () => profile, saveMirrorProfile: async (next) => { profile = next; },
    deviceId: () => "test-device",
  }, {
    stateStoreFactory: () => state, blobStoreFactory: () => blobs,
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    transportFactory: () => wrapTransport(hosted.transport(replicaId)),
  });
  const remoteVault = new MemoryVault();
  const remoteReplica = hosted.registerReplica({ name: "There", mode: "read_write" });
  const remoteMirror = new WritableDirectoryMirror(remoteReplica, hosted.transport(remoteReplica), {
    fileSystem: new ObsidianMirrorFileSystem(remoteVault as never), stateStore: new MemoryMirrorStateStore(),
  });
  const sync = async () => controller.sync((await controller.inspect()).preview);
  await sync();
  await remoteMirror.sync();
  const conflict = async (local = "local line\n", remote = "remote line\n") => {
    await remoteVault.modify(remoteVault.getAbstractFileByPath("plan.md") as TFile, remote);
    await remoteMirror.sync();
    await vault.modify(vault.getAbstractFileByPath("plan.md") as TFile, local);
    assert.equal((await sync()).status, "attention");
  };
  return { hosted, vault, state, controller, remoteVault, remoteMirror, sync, conflict,
    wrap: (wrapper: typeof wrapTransport) => { wrapTransport = wrapper; } };
}

const copies = (vault: MemoryVault) => vault.getFiles().map((file) => file.path).filter((path) => path.includes("conflict copy"));

function interceptSnapshot(transport: SyncTransport, intercept: () => Promise<void>): SyncTransport {
  return { ...transport, openSession: () => transport.openSession(), changes: (after, limit) => transport.changes(after, limit),
    mutate: (mutation) => transport.mutate(mutation),
    snapshot: async (id, page) => { await intercept(); return transport.snapshot(id, page); } };
}

test("repeated settling of a stale local decision does not multiply identical copies", async () => {
  const here = await pair();
  await here.conflict();
  await here.vault.modify(here.vault.getAbstractFileByPath("plan.md") as TFile, "local changed again\n");
  for (let attempt = 0; attempt < 3; attempt++) await here.controller.autoResolveConflicts();
  assert.ok(copies(here.vault).length <= 1, "stale decisions must not create the same copy on every attempt");
  assert.equal(here.vault.read("plan.md"), "local changed again\n");
  await here.sync();
  await here.controller.autoResolveConflicts();
  assert.equal(here.vault.read("plan.md"), "remote line\n");
  assert.equal(copies(here.vault).length, 1);
  assert.equal(here.vault.read(copies(here.vault)[0]!), "local changed again\n");
});

test("a conflict that changes on Connect mid-settle leaves at most one recoverable copy", async () => {
  const here = await pair();
  await here.conflict();
  let raced = false;
  here.wrap((transport) => interceptSnapshot(transport, async () => {
    if (raced) return;
    raced = true;
    await here.remoteVault.modify(here.remoteVault.getAbstractFileByPath("plan.md") as TFile, "hosted changed again\n");
    await here.remoteMirror.sync();
  }));
  for (let attempt = 0; attempt < 3; attempt++) await here.controller.autoResolveConflicts();
  assert.ok(copies(here.vault).length <= 1);
  assert.equal(here.vault.read("plan.md"), "local line\n");
  assert.equal((await here.controller.status())?.conflicts.length, 1);
  await here.sync();
  await here.controller.autoResolveConflicts();
  assert.equal(here.vault.read("plan.md"), "hosted changed again\n");
  assert.equal(copies(here.vault).length, 1);
});

test("a merged write racing a user edit preserves the edit and the hosted half", async () => {
  const base = "---\nstatus: open\npriority: low\n---\nBody\n";
  const here = await pair(base);
  const local = base.replace("status: open", "status: done");
  const remote = base.replace("priority: low", "priority: high");
  await here.conflict(local, remote);
  const process = here.vault.process.bind(here.vault);
  here.vault.process = async (file, transform) => {
    await here.vault.modify(file, local + "user edit during merge\n");
    return process(file, transform);
  };
  const results = await here.controller.autoResolveConflicts();
  assert.deepEqual(results, [], "a stale atomic merge stays open for the next sync");
  assert.equal(here.vault.read("plan.md"), local + "user edit during merge\n");
  assert.equal(here.remoteVault.read("plan.md"), remote);
  assert.ok((await here.state.read())?.planned_conflicts?.plan);
  assert.deepEqual(copies(here.vault), []);
});

test("restart at the merged-write boundary cannot upload unmerged local over hosted edits", async () => {
  const base = "---\nstatus: open\npriority: low\n---\nBody\n";
  const here = await pair(base);
  const local = base.replace("status: open", "status: done");
  const remote = base.replace("priority: low", "priority: high");
  await here.conflict(local, remote);
  let atWrite: MirrorState | null = null;
  const process = here.vault.process.bind(here.vault);
  here.vault.process = async (file, transform) => {
    atWrite = structuredClone(await here.state.read());
    return process(file, transform);
  };
  await here.controller.autoResolveConflicts();
  assert.ok(atWrite);
  // Reconstruct only durable state and bytes available immediately before the
  // merged write, as if Obsidian had crashed at that exact async boundary.
  const recoveredState = new MemoryMirrorStateStore();
  await recoveredState.write(atWrite);
  const recoveredVault = new MemoryVault();
  await recoveredVault.create("plan.md", local);
  const replicaId = (atWrite as MirrorState).replica_id;
  const restarted = new WritableDirectoryMirror(replicaId, here.hosted.transport(replicaId), {
    fileSystem: new ObsidianMirrorFileSystem(recoveredVault as never), stateStore: recoveredState,
    blobStore: new MemoryMirrorBlobStore(), selectiveSync: { file_classes: ["image"], excluded_folders: [] },
  });
  await restarted.sync();
  await here.remoteMirror.sync();
  assert.equal(here.remoteVault.read("plan.md"), remote, "a restart must leave the hosted half intact until the merge is durable");
  assert.equal(recoveredVault.read("plan.md"), local);
});

test("failed merged write keeps the conflict durable without requiring a recovery-copy write", async () => {
  const base = "---\nstatus: open\npriority: low\n---\nBody\n";
  const here = await pair(base);
  const local = base.replace("status: open", "status: done");
  const remote = base.replace("priority: low", "priority: high");
  await here.conflict(local, remote);
  const process = here.vault.process.bind(here.vault);
  const createBinary = here.vault.createBinary.bind(here.vault);
  here.vault.process = async () => { throw new Error("disk full on merged write"); };
  here.vault.createBinary = async () => { throw new Error("disk full on recovery copy"); };
  const [result] = await here.controller.autoResolveConflicts();
  assert.equal(result?.outcome, "unresolved");
  assert.equal(here.vault.read("plan.md"), local);
  assert.ok((await here.state.read())?.planned_conflicts?.plan, "failed recovery must not authorize a later upload over hosted edits");
  here.vault.process = process;
  here.vault.createBinary = createBinary;
  await here.sync();
  await here.controller.autoResolveConflicts();
  await here.sync();
  await here.remoteMirror.sync();
  assert.match(here.remoteVault.read("plan.md")!, /status: done[\s\S]*priority: high/);
});

test("taking hosted after keeping a copy cannot overwrite a newer local edit during snapshot loading", async () => {
  const here = await pair();
  await here.conflict();
  let snapshots = 0;
  here.wrap((transport) => interceptSnapshot(transport, async () => {
    snapshots += 1;
    // One snapshot for merging, then the SDK's conflict-resolution snapshot.
    if (snapshots === 2) {
      await here.vault.modify(here.vault.getAbstractFileByPath("plan.md") as TFile, "new user edit after copy\n");
    }
  }));
  await here.controller.autoResolveConflicts();
  const texts = here.vault.getMarkdownFiles().map((file) => here.vault.read(file.path));
  assert.ok(texts.includes("new user edit after copy\n"), "newer edit must survive somewhere");
  assert.ok(texts.includes("local line\n"), "the original kept copy survives too");
});

test("an old conflict without ancestor capture keeps both and settles only once", async () => {
  const here = await pair();
  await here.conflict();
  const state = (await here.state.read())!;
  delete state.planned_conflicts!.plan!.ancestor_document;
  await here.state.write(state);
  const [result] = await here.controller.autoResolveConflicts();
  assert.equal(result?.outcome, "kept_both");
  assert.equal(here.vault.read(result!.copyPath!), "local line\n");
  assert.deepEqual(await here.controller.autoResolveConflicts(), []);
  await here.sync();
  assert.deepEqual(await here.controller.autoResolveConflicts(), []);
  assert.equal(copies(here.vault).length, 1);
});

test("existing copy-name collisions preserve older files", async () => {
  const here = await pair();
  await here.conflict();
  await here.vault.create("plan (local conflict copy).md", "older copy\n");
  await here.vault.createFolder("plan (local conflict copy 2).md");
  const [result] = await here.controller.autoResolveConflicts();
  assert.equal(result?.copyPath, "plan (local conflict copy 3).md");
  assert.equal(here.vault.read("plan (local conflict copy).md"), "older copy\n");
  assert.equal(here.vault.read(result!.copyPath!), "local line\n");
});

test("a collision created after naming a binary copy is never overwritten", async () => {
  const here = await pair();
  const content = new Uint8Array([0, 255, 1, 128]);
  await here.vault.createBinary("image.png", content.buffer);
  const exists = here.vault.adapter.exists.bind(here.vault.adapter);
  let raced = false;
  here.vault.adapter.exists = async (path) => {
    const occupied = await exists(path);
    if (path === "image (local conflict copy).png" && !raced) {
      raced = true;
      await here.vault.createBinary(path, new Uint8Array([7, 8, 9]).buffer);
    }
    return occupied;
  };
  try { await here.controller.preserveConflictCopy("image.png"); } catch { /* Refusing the copy is safe. */ }
  assert.deepEqual(here.vault.readBytes("image (local conflict copy).png"), new Uint8Array([7, 8, 9]));
  assert.deepEqual(here.vault.readBytes("image.png"), content);
});

test("a conflict on a conflict copy does not nest copy labels", async () => {
  const here = await pair();
  await here.vault.create("plan (local conflict copy).md", "copy edited again\n");
  const path = await here.controller.preserveConflictCopy("plan (local conflict copy).md");
  assert.equal(path, "plan (local conflict copy 2).md");
});

test("concurrent settling reports one resolution, not a spurious missing-conflict error", async () => {
  const here = await pair();
  await here.conflict();
  const outcomes = (await Promise.all([
    here.controller.autoResolveConflicts(),
    here.controller.autoResolveConflicts(),
  ])).flat();
  assert.deepEqual(outcomes.map((result) => result.outcome), ["kept_both"]);
  assert.equal(copies(here.vault).length, 1);
});

test("inspection cannot see a cleared conflict before its merged write completes", async () => {
  const base = "---\nstatus: open\npriority: low\n---\nBody\n";
  const here = await pair(base);
  await here.conflict(base.replace("status: open", "status: done"), base.replace("priority: low", "priority: high"));
  let writing!: () => void;
  const enteredWrite = new Promise<void>((resolve) => { writing = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const process = here.vault.process.bind(here.vault);
  here.vault.process = async (file, transform) => { writing(); await gate; return process(file, transform); };
  const settle = here.controller.autoResolveConflicts();
  await enteredWrite;
  let inspected = false;
  const inspection = here.controller.inspect().then((value) => { inspected = true; return value; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(inspected, false, "inspection must queue behind the whole settlement");
  } finally {
    release();
    await settle;
    await inspection;
  }
  assert.match(here.vault.read("plan.md")!, /status: done[\s\S]*priority: high/);
});

test("Connect-rejected changes remain explicit and are not retried as copies", async () => {
  const here = await pair();
  let mutations = 0;
  here.wrap((transport) => ({ ...transport, mutate: async (mutation) => {
    mutations += 1;
    return { mutation_id: mutation.mutation_id, status: "rejected", error: { code: "schema_validation_failed", message: "Record rejected by collection rules." } };
  } }));
  await here.vault.modify(here.vault.getAbstractFileByPath("plan.md") as TFile, "rejected local edit\n");
  await here.sync();
  assert.equal((await here.state.read())?.planned_conflicts?.plan?.conflict_kind, "rejected");
  const before = mutations;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [result] = await here.controller.autoResolveConflicts();
    assert.equal(result?.outcome, "unresolved");
  }
  assert.equal(mutations, before);
  assert.deepEqual(copies(here.vault), []);
  assert.equal(here.vault.read("plan.md"), "rejected local edit\n");
});

test("recorded path_occupied conflicts keep both rather than attempting a text merge", async () => {
  const here = await pair();
  await here.conflict();
  const state = (await here.state.read())!;
  // The SDK can persist this kind for move collisions. Exercise the host's
  // settlement branch independently of identity/path-matching heuristics.
  state.planned_conflicts!.plan!.conflict_kind = "path_occupied";
  await here.state.write(state);
  const [result] = await here.controller.autoResolveConflicts();
  assert.equal(result?.outcome, "kept_both");
  assert.equal(here.vault.read("plan.md"), "remote line\n");
  assert.equal(here.vault.read(result!.copyPath!), "local line\n");
  assert.deepEqual(await here.controller.autoResolveConflicts(), []);
});

test("local rename into a hosted occupied path settles without copy loops", async () => {
  const here = await pair("base line\n", [{ record_id: "other", path: "occupied.md", document: "unrelated hosted note\n" }]);
  await here.remoteVault.modify(here.remoteVault.getAbstractFileByPath("occupied.md") as TFile, "unrelated hosted note revised\n");
  await here.remoteMirror.sync();
  await here.vault.delete(here.vault.getAbstractFileByPath("occupied.md") as TFile);
  await here.vault.rename(here.vault.getAbstractFileByPath("plan.md") as TFile, "occupied.md");
  await here.sync();
  assert.ok(Object.keys((await here.state.read())!.planned_conflicts!).length > 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const results = await here.controller.autoResolveConflicts();
    assert.ok(results.every((result) => result.outcome !== "unresolved"), JSON.stringify(results));
    await here.sync();
  }
  assert.equal((await here.controller.status())?.conflicts.length, 0);
  assert.equal(here.vault.read("occupied.md"), "unrelated hosted note revised\n");
  assert.ok(copies(here.vault).length <= 1);
  assert.ok(here.vault.getMarkdownFiles().some((file) => here.vault.read(file.path) === "base line\n"));
});

test("local rename plus hosted edit retains both changes without repeated settling", async () => {
  const here = await pair();
  await here.remoteVault.modify(here.remoteVault.getAbstractFileByPath("plan.md") as TFile, "hosted edit while renamed\n");
  await here.remoteMirror.sync();
  await here.vault.rename(here.vault.getAbstractFileByPath("plan.md") as TFile, "renamed.md");
  await here.sync();
  await here.controller.autoResolveConflicts();
  await here.sync();
  assert.equal((await here.controller.status())?.conflicts.length, 0);
  const texts = here.vault.getMarkdownFiles().map((file) => here.vault.read(file.path));
  assert.ok(texts.includes("hosted edit while renamed\n"));
  assert.ok(texts.includes("base line\n"));
  assert.deepEqual(await here.controller.autoResolveConflicts(), []);
});

test("binary conflicts keep exact bytes on both sides and settle only once", async () => {
  const here = await pair();
  const bytes = new Uint8Array([0, 255, 1, 128]);
  const descriptor = (content: Uint8Array): CollectionFileDescriptor => {
    const digest = createHash("sha256").update(content).digest("hex");
    return { file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path: "image.png", revision: `file:${digest}`,
      content_digest: `sha256:${digest}`, size: content.length, media_class: "image", media_type: "image/png",
      modified_at: "2026-10-01T00:00:00.000Z" };
  };
  let hostedBytes = bytes;
  here.wrap((transport) => ({ ...transport,
    fileSnapshot: async (id, page) => ({ ...await transport.fileSnapshot(id, page), files: [descriptor(hostedBytes)] }),
    changes: async (after, limit) => ({ ...await transport.changes(after, limit), reset_required: true }),
    downloadFile: async function* () { yield hostedBytes; },
  }));
  const firstFileSync = await here.sync();
  assert.deepEqual(here.vault.readBytes("image.png"), bytes, JSON.stringify(firstFileSync));
  const localBytes = new Uint8Array([0, 254, 1, 128, 42]);
  await here.vault.modifyBinary(here.vault.getAbstractFileByPath("image.png") as TFile, localBytes.buffer);
  hostedBytes = new Uint8Array([0, 253, 1, 127, 43]);
  await here.sync();
  const [result] = await here.controller.autoResolveConflicts();
  assert.equal(result?.outcome, "kept_both");
  assert.deepEqual(here.vault.readBytes("image.png"), hostedBytes);
  assert.deepEqual(here.vault.readBytes(result!.copyPath!), localBytes);
  assert.deepEqual(await here.controller.autoResolveConflicts(), []);
  assert.equal(copies(here.vault).length, 1);
});

test("hosted rename plus local edit retains both versions without waiting", async () => {
  const here = await pair();
  await here.remoteVault.rename(here.remoteVault.getAbstractFileByPath("plan.md") as TFile, "renamed.md");
  await here.remoteMirror.sync();
  await here.vault.modify(here.vault.getAbstractFileByPath("plan.md") as TFile, "local edit while renamed\n");
  await here.sync();
  const results = await here.controller.autoResolveConflicts();
  assert.ok(results.every((result) => result.outcome !== "unresolved"));
  await here.sync();
  const texts = here.vault.getMarkdownFiles().map((file) => here.vault.read(file.path));
  assert.ok(texts.includes("local edit while renamed\n"));
  assert.equal((await here.controller.status())?.conflicts.length, 0);
});
