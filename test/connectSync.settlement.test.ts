import "fake-indexeddb/auto";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { TFile } from "obsidian";
import { MemoryAuthority, type SyncTransport } from "@mdbase-dev/connect-sync";
import { MemoryMirrorBlobStore, MemoryMirrorStateStore, WritableDirectoryMirror } from "@mdbase-dev/connect-sync/mirror";
import { ConnectSyncController, ObsidianMirrorFileSystem, type MirrorProfile } from "../src/connectSync";
import { MemoryVault } from "./memoryVault";

async function pair(document = "base line\n") {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "plan", path: "plan.md", frontmatter: {}, body: document, document, types: [] }]);
  const replicaId = hosted.registerReplica({ name: "Here", mode: "read_write" });
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  await vault.createFolder(".mdbase");
  await vault.create(".mdbase/connect-role.json", JSON.stringify({ version: 1, role: "mirror", collection_id: hosted.collectionId }));
  let profile: MirrorProfile | null = {
    version: 1, syncUrl: `https://sync.example/v1/authorities/${hosted.collectionId}/sync`,
    controlUrl: "https://connect.example", collectionId: hosted.collectionId, replicaId,
    mode: "read_write", name: "Here", enrollmentId: "11111111-1111-4111-8111-111111111111",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  let wrapTransport = (transport: SyncTransport) => transport;
  const controller = new ConnectSyncController({ vault, secretStorage: {
    getSecret: () => "test-credential", setSecret: () => undefined,
  } } as never, {
    getMirrorProfile: () => profile, saveMirrorProfile: async (next) => { profile = next; },
    deviceId: () => "test-device",
  }, {
    stateStoreFactory: () => state, blobStoreFactory: () => new MemoryMirrorBlobStore(),
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
  const [result] = await here.controller.autoResolveConflicts();
  assert.equal(result?.outcome, "kept_both");
  assert.equal(here.vault.read("plan.md"), local + "user edit during merge\n");
  assert.equal(here.vault.read(result!.copyPath!), remote);
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
