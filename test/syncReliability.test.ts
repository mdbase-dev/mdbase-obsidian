import "fake-indexeddb/auto";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { TFile } from "obsidian";
import { MemoryAuthority, type SyncTransport } from "@mdbase-dev/connect-sync";
import {
  DirectoryMirror,
  MemoryMirrorBlobStore,
  MemoryMirrorStateStore,
  type MirrorBinaryInfo,
  type MirrorState,
  WritableDirectoryMirror,
} from "@mdbase-dev/connect-sync/mirror";
import type { MirrorEnrollmentClient } from "@mdbase-dev/connect-sync/enrollment";
import { ConnectSyncController, DeviceMirrorLease, normalizeMirrorProfile, ObsidianMirrorFileSystem, type MirrorProfile } from "../src/connectSync";
import { MemoryVault } from "./memoryVault";
import { SyncSession } from "../src/syncSession";

/** Enforces Obsidian's SecretStorage ID rule, which the plugin must respect. */
class MemorySecrets {
  readonly values = new Map<string, string>();
  setSecret(id: string, value: string): void {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) {
      throw new Error("Secret ID is invalid. Use only lowercase letters, numbers and dashes. 64 characters max.");
    }
    this.values.set(id, value);
  }
  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  listSecrets(): string[] {
    return [...this.values.keys()];
  }
}

interface DeviceOptions {
  deviceId?: string;
  profileDeviceId?: string;
  secrets?: MemorySecrets;
  state?: MemoryMirrorStateStore;
  enrollmentClient?: Partial<MirrorEnrollmentClient>;
  expiresAt?: string;
  wrapTransport?: (transport: SyncTransport) => SyncTransport;
}

/** One Obsidian vault with this plugin's controller, connected to a shared authority. */
async function device(hosted: MemoryAuthority, collectionId: string, options: DeviceOptions = {}) {
  const replicaId = hosted.registerReplica({ name: "Device", mode: "read_write" });
  const vault = new MemoryVault();
  await vault.createFolder(".mdbase");
  await vault.create(".mdbase/connect-role.json", `${JSON.stringify({ version: 1, role: "mirror", collection_id: collectionId })}\n`);
  const state = options.state ?? new MemoryMirrorStateStore();
  const states = new Map([[replicaId, state]]);
  const secrets = options.secrets ?? new MemorySecrets();
  let profile: MirrorProfile | null = {
    version: 1,
    syncUrl: `https://sync.example/v1/authorities/${collectionId}/sync`,
    controlUrl: "https://connect.example",
    collectionId,
    replicaId,
    mode: "read_write",
    name: "Device",
    enrollmentId: "11111111-1111-4111-8111-111111111111",
    accessTokenExpiresAt: options.expiresAt ?? "2099-01-01T00:00:00.000Z",
    ...(options.profileDeviceId ? { deviceId: options.profileDeviceId } : {}),
  };
  secrets.setSecret(`mdbase-connect-access-${replicaId}`, "access");
  secrets.setSecret(`mdbase-connect-refresh-${replicaId}`, "refresh");
  const controller = new ConnectSyncController({ vault, secretStorage: secrets } as never, {
    getMirrorProfile: () => profile && structuredClone(profile),
    saveMirrorProfile: async (next) => {
      profile = next;
    },
    deviceId: () => options.deviceId ?? "this-device",
  }, {
    stateStoreFactory: (current) => {
      let store = states.get(current.replicaId);
      if (!store) {
        store = new MemoryMirrorStateStore();
        states.set(current.replicaId, store);
      }
      return store;
    },
    blobStoreFactory: () => new MemoryMirrorBlobStore(),
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    transportFactory: (current) => options.wrapTransport?.(hosted.transport(current.replicaId)) ?? hosted.transport(current.replicaId),
    ...(options.enrollmentClient ? { enrollmentClient: options.enrollmentClient as MirrorEnrollmentClient } : {}),
  });
  const syncOnce = async () => {
    const { preview } = await controller.inspect();
    return controller.sync(preview);
  };
  return { vault, controller, state, states, secrets, replicaId, profile: () => profile, syncOnce };
}

/** An independently loaded controller for the same physical vault (another window). */
function sameVaultController(hosted: MemoryAuthority, here: Awaited<ReturnType<typeof device>>, options: {
  profile?: MirrorProfile;
  enrollmentClient?: Partial<MirrorEnrollmentClient>;
} = {}) {
  let profile: MirrorProfile | null = structuredClone(options.profile ?? here.profile());
  assert.ok(profile);
  here.secrets.setSecret(`mdbase-connect-access-${profile.replicaId}`, "access");
  here.secrets.setSecret(`mdbase-connect-refresh-${profile.replicaId}`, "refresh");
  const controller = new ConnectSyncController({ vault: here.vault, secretStorage: here.secrets } as never, {
    getMirrorProfile: () => profile && structuredClone(profile),
    saveMirrorProfile: async (next) => { profile = next; },
    deviceId: () => "this-device",
  }, {
    stateStoreFactory: (current) => {
      let state = here.states.get(current.replicaId);
      if (!state) { state = new MemoryMirrorStateStore(); here.states.set(current.replicaId, state); }
      return state;
    },
    blobStoreFactory: () => new MemoryMirrorBlobStore(),
    fileSystem: new ObsidianMirrorFileSystem(here.vault as never),
    transportFactory: (current) => hosted.transport(current.replicaId),
    ...(options.enrollmentClient ? { enrollmentClient: options.enrollmentClient as MirrorEnrollmentClient } : {}),
  });
  return { controller, profile: () => profile };
}

test("the remote change probe uses the state store's lean checkpoint port", async () => {
  class ProbeState extends MemoryMirrorStateStore {
    reads = 0;
    checkpoint: { cursor: number; scope_epoch: number; recovery_required: boolean } | null = {
      cursor: 0, scope_epoch: 1, recovery_required: false,
    };
    override async read(): Promise<MirrorState | null> {
      this.reads++;
      throw new Error("A probe must not read the full state");
    }
    async readCheckpoint() { return this.checkpoint; }
  }
  const hosted = new MemoryAuthority();
  const state = new ProbeState();
  let changes = 0;
  const here = await device(hosted, hosted.collectionId, { state, wrapTransport: transport => ({
    ...transport, changes: async (...args) => { changes++; return transport.changes(...args); },
  }) });
  assert.equal(await here.controller.remoteChangesWaiting(), false);
  assert.equal(state.reads, 0);
  assert.equal(changes, 1);
  state.checkpoint!.recovery_required = true;
  assert.equal(await here.controller.remoteChangesWaiting(), true, "a prepared batch must recover without probing Connect");
  state.checkpoint = null;
  assert.equal(await here.controller.remoteChangesWaiting(), true, "an uninitialized mirror always has work");
  assert.equal(changes, 1);
  here.controller.dispose();
});
/** A second device that edits through the bare SDK engine. */
function otherDevice(hosted: MemoryAuthority) {
  const replica = hosted.registerReplica({ name: "Other", mode: "read_write" });
  const vault = new MemoryVault();
  const mirror = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new MemoryMirrorStateStore(),
  });
  return { vault, mirror };
}

async function edit(vault: MemoryVault, path: string, content: string): Promise<void> {
  await vault.modify(vault.getAbstractFileByPath(path) as TFile, content);
}

async function collectionId(hosted: MemoryAuthority): Promise<string> {
  const probe = hosted.registerReplica({ name: "Probe", mode: "read_only" });
  return (await hosted.transport(probe).openSession()).collection_id;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const note = (status: string, priority: string, body = "Body\n") => `---\nstatus: ${status}\npriority: ${priority}\n---\n${body}`;

test("edits to different fields on two devices are merged and synced without asking", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "plan", path: "plan.md", frontmatter: { status: "open", priority: "low" }, body: "Body\n", types: [] }]);
  const id = await collectionId(hosted);
  const here = await device(hosted, id);
  const there = otherDevice(hosted);
  await here.syncOnce();
  await there.mirror.sync();
  const base = here.vault.read("plan.md")!;
  await edit(there.vault, "plan.md", base.replace("priority: low", "priority: high"));
  await there.mirror.sync();
  await edit(here.vault, "plan.md", base.replace("status: open", "status: done"));

  const outcome = await here.syncOnce();
  assert.equal(outcome.status, "attention", "the engine records the conflict instead of overwriting");
  const resolutions = await here.controller.autoResolveConflicts();
  assert.deepEqual(resolutions.map((resolution) => resolution.outcome), ["merged"]);
  const merged = here.vault.read("plan.md")!;
  assert.match(merged, /status: done/);
  assert.match(merged, /priority: high/);

  assert.equal((await here.syncOnce()).status, "applied");
  await there.mirror.sync();
  assert.equal(there.vault.read("plan.md"), merged, "both devices end with both edits");
  assert.equal((await here.controller.status())?.conflicts.length, 0);
});

test("edits made at the same moment, reported by Connect on upload, still merge", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "plan", path: "plan.md", frontmatter: { status: "open", priority: "low" }, body: "Body\n", types: [] }]);
  const id = await collectionId(hosted);
  const there = otherDevice(hosted);
  let base = "";
  let raced = false;
  // The other device uploads its edit between this device's plan and its upload.
  const here = await device(hosted, id, {
    wrapTransport: (transport) => ({
      ...transport,
      openSession: () => transport.openSession(),
      snapshot: (snapshotId, page) => transport.snapshot(snapshotId, page),
      changes: (after, limit) => transport.changes(after, limit),
      mutate: async (mutation) => {
        if (base && !raced) {
          raced = true;
          await edit(there.vault, "plan.md", base.replace("priority: low", "priority: high"));
          await there.mirror.sync();
        }
        return transport.mutate(mutation);
      },
    }),
  });
  await here.syncOnce();
  await there.mirror.sync();
  base = here.vault.read("plan.md")!;
  await edit(here.vault, "plan.md", base.replace("status: open", "status: done"));
  assert.equal((await here.syncOnce()).status, "attention");
  assert.equal(raced, true);
  const resolutions = await here.controller.autoResolveConflicts();
  assert.deepEqual(resolutions.map((resolution) => resolution.outcome), ["merged"]);
  await here.syncOnce();
  await there.mirror.sync();
  assert.match(there.vault.read("plan.md")!, /status: done[\s\S]*priority: high/);
});

test("the same line edited on two devices keeps both versions and loses nothing", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "plan", path: "plan.md", frontmatter: {}, body: "line\n", types: [] }]);
  const id = await collectionId(hosted);
  const here = await device(hosted, id);
  const there = otherDevice(hosted);
  await here.syncOnce();
  await there.mirror.sync();
  await edit(there.vault, "plan.md", "remote line\n");
  await there.mirror.sync();
  await edit(here.vault, "plan.md", "local line\n");
  await here.syncOnce();

  const [resolution] = await here.controller.autoResolveConflicts();
  assert.equal(resolution?.outcome, "kept_both");
  assert.match(resolution!.copyPath!, /^plan \(local conflict copy [a-zA-Z0-9%_-]+\)\.md$/);
  assert.equal(here.vault.read("plan.md"), "remote line\n");
  assert.equal(here.vault.read(resolution!.copyPath!), "local line\n");

  await here.syncOnce();
  await there.mirror.sync();
  assert.equal(there.vault.read(resolution!.copyPath!), "local line\n", "the kept copy reaches every device");
});

test("an edit beats a deletion in either direction", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([
    { record_id: "a", path: "a.md", frontmatter: {}, body: "a\n", types: [] },
    { record_id: "b", path: "b.md", frontmatter: {}, body: "b\n", types: [] },
  ]);
  const id = await collectionId(hosted);
  const here = await device(hosted, id);
  const there = otherDevice(hosted);
  await here.syncOnce();
  await there.mirror.sync();
  // a: deleted here, edited there. b: edited here, deleted there.
  await edit(there.vault, "a.md", "a edited there\n");
  await there.vault.delete(there.vault.getAbstractFileByPath("b.md") as TFile);
  await there.mirror.sync();
  await here.vault.delete(here.vault.getAbstractFileByPath("a.md") as TFile);
  await edit(here.vault, "b.md", "b edited here\n");
  await here.syncOnce();

  const outcomes = (await here.controller.autoResolveConflicts()).map((resolution) => `${resolution.path}:${resolution.outcome}`).sort();
  assert.deepEqual(outcomes, ["a.md:restored", "b.md:kept_local"]);
  await here.syncOnce();
  await there.mirror.sync();
  assert.equal(here.vault.read("a.md"), "a edited there\n");
  assert.equal(there.vault.read("b.md"), "b edited here\n");
});

test("the remote-change probe is cheap and accurate", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "a", path: "a.md", frontmatter: {}, body: "a\n", types: [] }]);
  const id = await collectionId(hosted);
  const here = await device(hosted, id);
  const there = otherDevice(hosted);
  assert.equal(await here.controller.remoteChangesWaiting(), true, "an uninitialized mirror always has work");
  await here.syncOnce();
  assert.equal(await here.controller.remoteChangesWaiting(), false);
  await there.mirror.sync();
  await edit(there.vault, "a.md", "changed\n");
  await there.mirror.sync();
  assert.equal(await here.controller.remoteChangesWaiting(), true);
  await here.syncOnce();
  assert.equal(await here.controller.remoteChangesWaiting(), false);
});

test("the mirror's own writes are recognised as echoes, not edits", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "a", path: "notes/a.md", frontmatter: {}, body: "a\n", types: [] }]);
  const id = await collectionId(hosted);
  const vault = new MemoryVault();
  await vault.createFolder(".mdbase");
  await vault.create(".mdbase/connect-role.json", `${JSON.stringify({ version: 1, role: "mirror", collection_id: id })}\n`);
  const replicaId = hosted.registerReplica({ name: "Echo", mode: "read_write" });
  const secrets = new MemorySecrets();
  secrets.setSecret(`mdbase-connect-access-${replicaId}`, "access");
  const controller = new ConnectSyncController({
    vault,
    secretStorage: secrets,
    fileManager: { trashFile: async (file: TFile) => vault.delete(file) },
  } as never, {
    getMirrorProfile: () => ({
      version: 1, syncUrl: `https://sync.example/v1/authorities/${id}/sync`, controlUrl: "https://connect.example",
      collectionId: id, replicaId, mode: "read_write", name: "Echo",
      enrollmentId: "11111111-1111-4111-8111-111111111111", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    saveMirrorProfile: async () => undefined,
  }, {
    stateStoreFactory: () => new MemoryMirrorStateStore(),
    blobStoreFactory: () => new MemoryMirrorBlobStore(),
    transportFactory: () => hosted.transport(replicaId),
  });
  const { preview } = await controller.inspect();
  await controller.sync(preview);
  assert.equal(vault.read("notes/a.md")?.endsWith("a\n"), true);
  assert.equal(controller.consumeEngineWrite("notes/a.md"), true);
  await edit(vault, "notes/a.md", "typed immediately after the download\n");
  assert.equal(controller.consumeEngineWrite("notes/a.md"), false, "the next edit event is not another echo just because it arrived within two seconds");
  assert.equal(controller.consumeEngineWrite("notes/other.md"), false);
});

test("bulk mirror echo tracking expires ordered entries without scanning every live path", () => {
  const controller = new ConnectSyncController({ vault: new MemoryVault() } as never, {
    getMirrorProfile: () => null, saveMirrorProfile: async () => undefined,
  });
  const tracker = controller as unknown as {
    engineWrites: Map<string, number>; noteEngineWrite(path: string): void;
  };
  let clock = 10_000;
  const now = performance.now;
  const wallNow = Date.now;
  performance.now = () => clock;
  Date.now = () => clock;
  let visited = 0;
  const iterator = tracker.engineWrites[Symbol.iterator].bind(tracker.engineWrites);
  tracker.engineWrites[Symbol.iterator] = function* () {
    for (const entry of iterator()) { visited++; yield entry; }
  };
  try {
    for (let index = 0; index < 10_000; index++) tracker.noteEngineWrite(`${index}.md`);
    assert.ok(visited <= 20_000, `Bulk writes visited ${visited} live echo entries`);
    clock += 1_000;
    tracker.noteEngineWrite("0.md"); // Refreshing an old key must move it to the tail.
    clock += 1_001;
    tracker.noteEngineWrite("new.md");
    assert.equal(tracker.engineWrites.size, 2, "expired entries behind a refreshed key must be removed");
    Date.now = () => 9e12;
    assert.equal(controller.consumeEngineWrite("0.md"), true, "wall-clock jumps do not change the echo's age");
    assert.equal(controller.consumeEngineWrite("0.md"), false, "one echo only; the next edit is real");
    clock += 2_001;
    assert.equal(controller.consumeEngineWrite("new.md"), false, "expired writes cannot hide an edit");
  } finally {
    performance.now = now;
    Date.now = wallNow;
    controller.dispose();
  }
});

test("text downloads cannot follow a TFile renamed while Vault.process is queued", async () => {
  const vault = new MemoryVault();
  const file = await vault.create("note.md", "base\n");
  const fs = new ObsidianMirrorFileSystem(vault as never);
  const process = vault.process.bind(vault);
  vault.process = async (target, transform) => {
    // Real Obsidian renames the TFile object in place, unlike MemoryVault.rename.
    const entry = vault.files.get(target.path)!;
    vault.files.delete(target.path);
    target.path = "moved.md";
    vault.files.set(target.path, entry);
    return process(target, transform);
  };
  await assert.rejects(fs.write("note.md", "hosted update\n", "base\n"), (error: unknown) =>
    (error as { code?: string }).code === "sync_plan_stale");
  assert.equal(file.path, "moved.md");
  assert.equal(vault.read("moved.md"), "base\n", "the engine must not write through the moved object");
});

test("a stale conditional text write does not reserve an echo for a user's edit", async () => {
  const vault = new MemoryVault();
  await vault.create("note.md", "base\n");
  const writes: string[] = [];
  const fs = new ObsidianMirrorFileSystem(vault as never, undefined, undefined, (path) => writes.push(path));
  const process = vault.process.bind(vault);
  vault.process = async (file, transform) => {
    await vault.modify(file, "user edit\n");
    return process(file, transform);
  };
  await assert.rejects(fs.write("note.md", "hosted\n", "base\n"), (error: unknown) =>
    (error as { code?: string }).code === "sync_plan_stale");
  assert.deepEqual(writes, [], "an abandoned write must not hide the real modify event");
});

test("receive-only UTF-8 repair cannot overwrite an edit queued before the Vault write", async () => {
  const vault = new MemoryVault();
  await vault.createBinary("note.md", Uint8Array.of(0x80).buffer);
  const fs = new ObsidianMirrorFileSystem(vault as never);
  const modify = vault.modify.bind(vault);
  const process = vault.process.bind(vault);
  vault.modify = async (file, value) => {
    await modify(file, "user repaired the note\n");
    await modify(file, value);
  };
  vault.process = async (file, transform) => {
    await modify(file, "user repaired the note\n");
    return process(file, transform);
  };
  await assert.rejects(fs.write("note.md", "hosted version\n"), (error: unknown) =>
    (error as { code?: string }).code === "sync_plan_stale");
  assert.equal(await fs.read("note.md"), "user repaired the note\n");
});

test("receive-only UTF-8 repair still writes when the invalid text is unchanged", async () => {
  const vault = new MemoryVault();
  await vault.createBinary("note.md", Uint8Array.of(0x80).buffer);
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await fs.write("note.md", "hosted version\n");
  assert.equal(await fs.read("note.md"), "hosted version\n");
});

test("binary edits made while a download stream is consumed are not overwritten", async () => {
  const vault = new MemoryVault();
  const original = new Uint8Array([1, 2, 3]).buffer;
  const edited = new Uint8Array([7, 8, 9]).buffer;
  const file = await vault.createBinary("photo.png", original);
  const fs = new ObsidianMirrorFileSystem(vault as never);
  const source = (async function* () {
    yield new Uint8Array([4]);
    await vault.modifyBinary(file, edited);
    yield new Uint8Array([5, 6]);
  })();
  await assert.rejects(fs.writeBinary("photo.png", source), (error: unknown) =>
    (error as { code?: string }).code === "sync_plan_stale");
  assert.deepEqual(vault.readBytes("photo.png"), new Uint8Array(edited));
});

test("a binary file created during a download is not silently overwritten", async () => {
  const vault = new MemoryVault();
  const fs = new ObsidianMirrorFileSystem(vault as never);
  const source = (async function* () {
    await vault.createBinary("photo.png", new Uint8Array([7, 8, 9]).buffer);
    yield new Uint8Array([4, 5, 6]);
  })();
  await assert.rejects(fs.writeBinary("photo.png", source), (error: unknown) =>
    (error as { code?: string }).code === "sync_plan_stale");
  assert.deepEqual(vault.readBytes("photo.png"), new Uint8Array([7, 8, 9]));
});

test("SDK binary preflight expectations protect a file created before adapter materialization", async () => {
  const hosted = new MemoryAuthority();
  const replica = hosted.registerReplica({ name: "Binary reader", mode: "read_only" });
  const base = hosted.transport(replica);
  const bytes = Uint8Array.of(4, 5, 6);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = `sha256:${Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")}` as const;
  const file = {
    file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path: "photo.png", revision: digest,
    content_digest: digest, size: bytes.byteLength, media_class: "image" as const,
    modified_at: "2026-01-01T00:00:00.000Z",
  };
  const vault = new MemoryVault();
  class RacyFileSystem extends ObsidianMirrorFileSystem {
    override async writeBinary(path: string, source: AsyncIterable<Uint8Array>, expected?: MirrorBinaryInfo | null): Promise<void> {
      await vault.createBinary(path, Uint8Array.of(7, 8, 9).buffer);
      return super.writeBinary(path, source, expected);
    }
  }
  const mirror = new DirectoryMirror(replica, {
    ...base,
    fileSnapshot: async (snapshotId, page) => ({ ...await base.fileSnapshot(snapshotId, page), files: [file] }),
    downloadFile: async function* () { yield bytes; },
  }, {
    fileSystem: new RacyFileSystem(vault as never), stateStore: new MemoryMirrorStateStore(),
    blobStore: new MemoryMirrorBlobStore(), selectiveSync: { file_classes: ["image"], excluded_folders: [] },
  });
  const outcome = await mirror.apply(await mirror.inspect());
  assert.equal(outcome.status, "stale");
  assert.deepEqual(vault.readBytes("photo.png"), Uint8Array.of(7, 8, 9));
});

test("SDK delete preflight expectations protect an edit made before adapter removal", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "a", path: "a.md", frontmatter: {}, body: "base\n", types: [] }]);
  const replica = hosted.registerReplica({ name: "Reader", mode: "read_only" });
  const vault = new MemoryVault();
  class RacyFileSystem extends ObsidianMirrorFileSystem {
    override async remove(path: string, expected?: string | MirrorBinaryInfo | null): Promise<void> {
      await edit(vault, path, "edited before trash\n");
      return super.remove(path, expected);
    }
  }
  const mirror = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new RacyFileSystem(vault as never), stateStore: new MemoryMirrorStateStore(),
  });
  await mirror.sync();
  const there = otherDevice(hosted);
  await there.mirror.sync();
  await there.vault.delete(there.vault.getAbstractFileByPath("a.md") as TFile);
  await there.mirror.sync();
  const outcome = await mirror.apply(await mirror.inspect());
  assert.equal(outcome.status, "stale");
  assert.equal(vault.read("a.md"), "edited before trash\n");
});

test("conditional binary removal refuses changed bytes and still trashes an exact file", async () => {
  const vault = new MemoryVault();
  const file = await vault.createBinary("photo.png", Uint8Array.of(1, 2, 3).buffer);
  const fs = new ObsidianMirrorFileSystem(vault as never);
  const expected = await fs.inspectBinary("photo.png");
  await vault.modifyBinary(file, Uint8Array.of(7, 8, 9).buffer);
  await assert.rejects(fs.remove("photo.png", expected), (error: unknown) =>
    (error as { code?: string }).code === "sync_plan_stale");
  assert.deepEqual(vault.readBytes("photo.png"), Uint8Array.of(7, 8, 9));
  await fs.remove("photo.png", await fs.inspectBinary("photo.png"));
  assert.equal(vault.readBytes("photo.png"), null);
});

test("a hosted deletion conflict decision cannot discard an edit made just before trash", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "a", path: "a.md", frontmatter: {}, body: "base\n", types: [] }]);
  const replica = hosted.registerReplica({ name: "Writer", mode: "read_write" });
  const vault = new MemoryVault();
  let race = false;
  class RacyFileSystem extends ObsidianMirrorFileSystem {
    override async remove(path: string, expected?: string | MirrorBinaryInfo | null): Promise<void> {
      if (race) await edit(vault, path, "newer local edit\n");
      return super.remove(path, expected);
    }
  }
  const mirror = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new RacyFileSystem(vault as never), stateStore: new MemoryMirrorStateStore(),
  });
  await mirror.sync();
  const there = otherDevice(hosted);
  await there.mirror.sync();
  await there.vault.delete(there.vault.getAbstractFileByPath("a.md") as TFile);
  await there.mirror.sync();
  await edit(vault, "a.md", "local edit\n");
  await mirror.sync();
  const conflict = (await mirror.status()).conflicts[0]!;
  assert.ok(conflict);
  race = true;
  await assert.rejects(mirror.resolveConflict(conflict.object_id, conflict.decision_id, "remote"), (error: unknown) =>
    ["sync_plan_stale", "conflict_decision_stale"].includes((error as { code: string }).code));
  assert.equal(vault.read("a.md"), "newer local edit\n");
});

test("independently loaded plugin windows share a browser mirror lease", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const held = new Set<string>();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  } } });
  const moduleUrl = new URL("../src/connectSync.js", import.meta.url);
  moduleUrl.search = "?second-window";
  const other = await import(moduleUrl.href) as typeof import("../src/connectSync");
  const key = crypto.randomUUID();
  const first = new DeviceMirrorLease(key);
  const second = new other.DeviceMirrorLease(key);
  const gate = deferred();
  const running = first.runExclusive(() => gate.promise);
  try {
    await assert.rejects(second.runExclusive(async () => "concurrent writer"), (error: unknown) =>
      (error as { code?: string }).code === "mirror_busy");
    gate.release();
    await running;
    assert.equal(await second.runExclusive(async () => "released"), "released");
  } finally {
    gate.release();
    await running;
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("disconnect cannot retire a mirror while another controller holds its SDK lease", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const entered = deferred();
  const gate = deferred();
  const here = await device(hosted, id, {
    wrapTransport: (transport) => ({ ...transport, openSession: async () => {
      entered.release();
      await gate.promise;
      return transport.openSession();
    } }),
  });
  const running = here.controller.inspect();
  await entered.promise;
  let otherProfile = structuredClone(here.profile());
  const other = new ConnectSyncController({ vault: here.vault, secretStorage: here.secrets } as never, {
    getMirrorProfile: () => otherProfile,
    saveMirrorProfile: async (next) => { otherProfile = next; },
    deviceId: () => "this-device",
  }, {
    stateStoreFactory: () => here.state, blobStoreFactory: () => new MemoryMirrorBlobStore(),
    fileSystem: new ObsidianMirrorFileSystem(here.vault as never),
    transportFactory: () => hosted.transport(here.replicaId),
  });
  try {
    await assert.rejects(other.disconnect(false), (error: unknown) => (error as { code?: string }).code === "mirror_busy");
    assert.ok(otherProfile);
    assert.equal(await here.vault.adapter.exists(".mdbase/connect-role.json"), true);
  } finally {
    gate.release();
    await running;
  }
  await other.disconnect(false);
  assert.equal(otherProfile, null);
  here.controller.dispose();
  other.dispose();
});

test("another replica enrollment on the same vault still shares the directory lease", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const entered = deferred();
  const gate = deferred();
  const here = await device(hosted, id, {
    wrapTransport: (transport) => ({ ...transport, openSession: async () => {
      entered.release(); await gate.promise; return transport.openSession();
    } }),
  });
  const running = here.controller.inspect();
  await entered.promise;
  const replica = hosted.registerReplica({ name: "New approval", mode: "read_write" });
  const other = sameVaultController(hosted, here, { profile: { ...here.profile()!, replicaId: replica } });
  try {
    await assert.rejects(other.controller.inspect(), (error: unknown) => (error as { code?: string }).code === "mirror_busy");
  } finally { gate.release(); await running; }
  here.controller.dispose(); other.controller.dispose();
});

test("reauthorization cannot migrate credentials and checkpoint during another window's SDK operation", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const entered = deferred();
  const gate = deferred();
  const here = await device(hosted, id, {
    wrapTransport: (transport) => ({ ...transport, openSession: async () => {
      entered.release(); await gate.promise; return transport.openSession();
    } }),
  });
  const running = here.controller.inspect();
  await entered.promise;
  const replica = hosted.registerReplica({ name: "New approval", mode: "read_write" });
  const other = sameVaultController(hosted, here, { enrollmentClient: { enroll: async () => ({
    ...here.profile()!, replicaId: replica, accessToken: "new-access", refreshCredential: "new-refresh",
  }) } });
  try {
    await assert.rejects(other.controller.reauthorize({ onVerification: () => undefined }), (error: unknown) =>
      (error as { code?: string }).code === "mirror_busy");
    assert.equal(other.profile()?.replicaId, here.replicaId);
    assert.equal(here.secrets.getSecret(`mdbase-connect-access-${here.replicaId}`), "access");
  } finally { gate.release(); await running; }
  here.controller.dispose(); other.controller.dispose();
});

test("a renewal in another window cannot restore credentials after the vault disconnected", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const here = await device(hosted, id);
  const entered = deferred();
  const gate = deferred();
  const other = sameVaultController(hosted, here, { enrollmentClient: { renew: async (enrollment) => {
    entered.release(); await gate.promise;
    return { ...enrollment, accessToken: "late-token" };
  } } });
  const renewing = other.controller.reconnect();
  const completed = Promise.allSettled([renewing]);
  await entered.promise;
  await here.controller.disconnect(false);
  gate.release();
  const [result] = await completed;
  assert.equal(result!.status, "rejected");
  assert.equal(here.secrets.getSecret(`mdbase-connect-access-${here.replicaId}`), "", "shared credentials stay retired even though the other window cached its old profile");
  here.controller.dispose(); other.controller.dispose();
});

test("a retired replica's late renewal cannot undo another window's new approval", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const approved = hosted.registerReplica({ name: "Reapproved", mode: "read_write" });
  const here = await device(hosted, id, { enrollmentClient: { enroll: async () => ({
    controlUrl: "https://connect.example", syncUrl: `https://sync.example/v1/authorities/${id}/sync`,
    collectionId: id, replicaId: approved, mode: "read_write", name: "Reapproved",
    enrollmentId: "22222222-2222-4222-8222-222222222222", accessToken: "approved-access",
    refreshCredential: "approved-refresh", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  }) } });
  const entered = deferred();
  const gate = deferred();
  const other = sameVaultController(hosted, here, { enrollmentClient: { renew: async (enrollment) => {
    entered.release(); await gate.promise; return { ...enrollment, accessToken: "late-token" };
  } } });
  const renewing = other.controller.reconnect();
  const completed = Promise.allSettled([renewing]);
  await entered.promise;
  await here.controller.reauthorize({ onVerification: () => undefined });
  gate.release();
  const [result] = await completed;
  assert.equal(result!.status, "rejected");
  assert.equal(here.profile()?.replicaId, approved);
  assert.equal(here.secrets.getSecret(`mdbase-connect-access-${here.replicaId}`), "");
  here.controller.dispose(); other.controller.dispose();
});

test("token renewal inside an SDK operation can commit under the lease it already owns", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  let here!: Awaited<ReturnType<typeof device>>;
  let renewals = 0;
  let renewed = false;
  here = await device(hosted, id, {
    enrollmentClient: { renew: async (enrollment) => {
      renewals++; return { ...enrollment, accessToken: "fresh-token" };
    } },
    wrapTransport: (transport) => ({ ...transport, snapshot: async (snapshotId, page) => {
      if (!renewed) {
        renewed = true;
        // This is the same credentials callback used after an HTTP 401.
        const source = (here.controller as unknown as { transportCredentials(profile: MirrorProfile): { renew(token: string): Promise<string> } }).transportCredentials(here.profile()!);
        assert.equal(await source.renew("access"), "fresh-token");
      }
      return transport.snapshot(snapshotId, page);
    } }),
  });
  await here.controller.inspect();
  assert.equal(renewals, 1);
  assert.equal(here.secrets.getSecret(`mdbase-connect-access-${here.replicaId}`), "fresh-token");
  here.controller.dispose();
});

test("a vault copied to another device or folder refuses to sync until it is set up there", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "a", path: "a.md", frontmatter: {}, body: "a\n", types: [] }]);
  const id = await collectionId(hosted);
  const original = await device(hosted, id, { deviceId: "original", profileDeviceId: "original" });
  await original.syncOnce();
  const before = structuredClone(await original.state.read());

  // Same IndexedDB state store and secrets: a copy of the vault on the same machine.
  const copy = await device(hosted, id, {
    deviceId: "copy",
    profileDeviceId: "original",
    state: original.state,
    secrets: original.secrets,
  });
  await assert.rejects(copy.controller.inspect(), (error: unknown) =>
    (error as { code?: string }).code === "mirror_other_device");
  await assert.rejects(copy.controller.reconnect(), (error: unknown) =>
    (error as { code?: string }).code === "mirror_other_device");

  await copy.controller.disconnect(false);
  assert.deepEqual(await original.state.read(), before, "the original's checkpoint survives the copy disconnecting");
  assert.ok(original.secrets.listSecrets().some((secretId) => original.secrets.getSecret(secretId) === "refresh"));
  assert.equal((await original.syncOnce()).status, "applied");
});

test("malformed stored selective-sync policies fail closed without losing the enrollment", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const here = await device(hosted, id);
  for (const policy of [null, false, "bad", [], {}, { file_classes: "image", excluded_folders: [] }, { file_classes: [], excluded_folders: null }]) {
    const normalized = normalizeMirrorProfile({ ...here.profile(), selectiveSync: policy });
    assert.equal(normalized?.replicaId, here.replicaId, `policy ${JSON.stringify(policy)} retains credentials' identity`);
    assert.deepEqual(normalized?.selectiveSync, { file_classes: [], excluded_folders: [] });
  }
  for (const input of [null, [], "bad", { ...here.profile(), collectionId: 12 }]) assert.equal(normalizeMirrorProfile(input), null);
});

test("profiles from before device ownership are claimed by the first device to open them", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const here = await device(hosted, id, { deviceId: "first" });
  assert.equal(here.profile()?.deviceId, undefined);
  await here.controller.inspect();
  assert.equal(here.profile()?.deviceId, "first");
});

test("credentials stored under the old collection-only key are found and carried forward", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const secrets = new MemorySecrets();
  const renewals: string[] = [];
  const here = await device(hosted, id, {
    secrets,
    expiresAt: "2000-01-01T00:00:00.000Z",
    enrollmentClient: {
      renew: async (enrollment) => {
        renewals.push(enrollment.refreshCredential);
        return { ...enrollment, accessToken: "renewed", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z" } as never;
      },
    },
  });
  secrets.values.clear();
  secrets.setSecret(`mdbase-connect-access-${id}`, "legacy-access");
  secrets.setSecret(`mdbase-connect-refresh-${id}`, "legacy-refresh");
  await here.controller.inspect();
  assert.deepEqual(renewals, ["legacy-refresh"]);
  assert.equal(secrets.getSecret(`mdbase-connect-refresh-${here.replicaId}`), "legacy-refresh");
  assert.equal(secrets.getSecret(`mdbase-connect-access-${here.replicaId}`), "renewed");
});

test("a token renewal finishing after disconnect cannot recreate the connection", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const entered = deferred();
  const finish = deferred();
  const here = await device(hosted, id, {
    enrollmentClient: {
      renew: async (enrollment) => {
        entered.release();
        await finish.promise;
        return { ...enrollment, accessToken: "renewed", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z" };
      },
    },
  });
  const renewal = here.controller.reconnect();
  // Install the rejection handler before releasing either operation.
  const completed = Promise.allSettled([renewal]);
  await entered.promise;
  await here.controller.disconnect(false);
  assert.equal(here.profile(), null);
  finish.release();
  await completed;
  assert.equal(here.profile(), null, "a late response must not resurrect a disconnected profile");
  assert.equal(here.secrets.getSecret(`mdbase-connect-access-${here.replicaId}`), "");
});

test("normal mirror must not upload a provider-equivalent Greek excluded-folder alias", {
  // P1: beta.120 (and current SDK source) lowercases whole strings; the Rust
  // provider and adoption key lowercase each scalar. Remove TODO after the
  // SDK's canonical policy is aligned, not by adding a second plugin filter.
  todo: "SDK/provider Unicode exclusion policy mismatch; see merge report MP12",
}, async () => {
  const hosted = new MemoryAuthority();
  const attempted: string[] = [];
  const here = await device(hosted, hosted.collectionId, { wrapTransport: transport => ({
    ...transport,
    uploadFile: async (request, source) => {
      for await (const _chunk of source) { /* drain the immutable synthetic snapshot */ }
      attempted.push(request.path);
      throw new Error("Synthetic no-op: stop before any hosted effect");
    },
  }) });
  try {
    await here.vault.createBinary("ΟΣ/private.png", Uint8Array.of(1).buffer);
    await here.controller.configureSelectiveSync({ file_classes: ["image"], excluded_folders: ["οσ"] });
    await here.syncOnce();
    assert.deepEqual(attempted, [], "excluded bytes must not reach the upload transport");
  } finally { here.controller.dispose(); }
});

test("token renewal preserves selective-sync settings changed while it was in flight", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  const entered = deferred();
  const finish = deferred();
  const here = await device(hosted, id, {
    enrollmentClient: {
      renew: async (enrollment) => {
        entered.release();
        await finish.promise;
        return { ...enrollment, accessToken: "renewed", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z" };
      },
    },
  });
  await here.controller.configureSelectiveSync({ file_classes: [], excluded_folders: [] });
  const renewal = here.controller.reconnect();
  await entered.promise;
  const policy = { file_classes: ["image" as const], excluded_folders: ["private"] };
  await here.controller.configureSelectiveSync(policy);
  finish.release();
  await renewal;
  assert.deepEqual(here.profile()?.selectiveSync, policy);
});

test("reauthorization migrates the latest checkpoint, not the checkpoint from before browser approval", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "a", path: "a.md", frontmatter: {}, body: "original\n", types: [] }]);
  const id = await collectionId(hosted);
  const approvedReplica = hosted.registerReplica({ name: "Reapproved", mode: "read_write" });
  const entered = deferred();
  const finish = deferred();
  const here = await device(hosted, id, {
    enrollmentClient: {
      enroll: async () => {
        entered.release();
        await finish.promise;
        return {
          controlUrl: "https://connect.example", syncUrl: `https://sync.example/v1/authorities/${id}/sync`,
          collectionId: id, replicaId: approvedReplica, mode: "read_write", name: "Reapproved",
          enrollmentId: "22222222-2222-4222-8222-222222222222", accessToken: "approved-access",
          refreshCredential: "approved-refresh", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
  });
  await here.syncOnce();
  const approval = here.controller.reauthorize({ onVerification: () => undefined });
  await entered.promise;
  await edit(here.vault, "a.md", "edited while approval was open\n");
  await here.syncOnce();
  await here.syncOnce();
  const latest = await here.state.read();
  finish.release();
  await approval;
  const migrated = await here.states.get(approvedReplica)!.read();
  assert.equal(migrated?.cursor, latest?.cursor, "approval must not roll back the checkpoint");
  assert.deepEqual(migrated?.records, latest?.records);
  assert.equal(here.vault.read("a.md"), "edited while approval was open\n");
});

test("reauthorization refuses to discard a batch prepared while browser approval was open", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{ record_id: "a", path: "a.md", frontmatter: {}, body: "original\n", types: [] }]);
  const id = await collectionId(hosted);
  const approvedReplica = hosted.registerReplica({ name: "Reapproved", mode: "read_write" });
  const entered = deferred();
  const finish = deferred();
  const here = await device(hosted, id, {
    enrollmentClient: {
      enroll: async () => {
        entered.release();
        await finish.promise;
        return {
          controlUrl: "https://connect.example", syncUrl: `https://sync.example/v1/authorities/${id}/sync`,
          collectionId: id, replicaId: approvedReplica, mode: "read_write", name: "Reapproved",
          enrollmentId: "22222222-2222-4222-8222-222222222222", accessToken: "approved-access",
          refreshCredential: "approved-refresh", accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
    },
  });
  await here.syncOnce();
  const approval = here.controller.reauthorize({ onVerification: () => undefined });
  const refused = assert.rejects(approval, (error: unknown) =>
    (error as { code?: string }).code === "mirror_recovery_required");
  await entered.promise;
  const there = otherDevice(hosted);
  await there.mirror.sync();
  await there.vault.create("b.md", "new note\n");
  await there.mirror.sync();
  here.vault.failCreatePath = "b.md";
  assert.equal((await here.syncOnce()).status, "failed");
  const latest = structuredClone(await here.state.read());
  assert.ok(latest?.batch, "the failed write leaves its approved batch durable");
  finish.release();
  await refused;
  assert.equal(here.profile()?.replicaId, here.replicaId);
  assert.deepEqual(await here.state.read(), latest);
  here.vault.failCreatePath = null;
  assert.equal((await here.syncOnce()).status, "applied", "the original checkpoint can still resume");
  assert.equal(here.vault.read("b.md"), "new note\n");
});

test("every checkpoint-write boundary survives a quota error and a retry without losing files", async () => {
  class FaultStore extends MemoryMirrorStateStore {
    writes = 0;
    failAt: number | null = null;
    failures = 0;
    override async write(state: MirrorState): Promise<void> {
      this.writes++;
      if (this.writes === this.failAt) {
        this.failures++;
        throw new DOMException("Injected quota failure", "QuotaExceededError");
      }
      return super.write(state);
    }
  }
  for (let boundary = 1; boundary <= 20; boundary++) {
    const hosted = new MemoryAuthority();
    hosted.seed(["a", "b", "c"].map((name) => ({ record_id: name, path: `${name}.md`, frontmatter: {}, body: `${name}\n`, types: [] })));
    const id = await collectionId(hosted);
    const state = new FaultStore();
    const here = await device(hosted, id, { state });
    const there = otherDevice(hosted);
    await here.syncOnce();
    await there.mirror.sync();
    await edit(there.vault, "b.md", "hosted edit\n");
    await there.mirror.sync();
    await edit(here.vault, "a.md", "local edit\n");
    await here.vault.create("d.md", "new local note\n");
    await here.vault.delete(here.vault.getAbstractFileByPath("c.md") as TFile);
    state.failAt = state.writes + boundary;
    const session = new SyncSession(here.controller, here.profile, null);
    let result = await session.autoSync();
    state.failAt = null;
    for (let retry = 0; retry < 8 && !["applied", "up_to_date"].includes(result); retry++) result = await session.syncNow();
    assert.ok(["applied", "up_to_date"].includes(result), `write boundary ${boundary}: ${result}, ${session.state.problem?.message}`);
    await session.syncNow();
    await there.mirror.sync();
    for (const vault of [here.vault, there.vault]) {
      assert.equal(vault.read("a.md"), "local edit\n", `write boundary ${boundary}`);
      assert.equal(vault.read("b.md"), "hosted edit\n", `write boundary ${boundary}`);
      assert.equal(vault.read("c.md"), null, `write boundary ${boundary}`);
      assert.equal(vault.read("d.md"), "new local note\n", `write boundary ${boundary}`);
    }
    assert.equal((await state.read())?.batch, undefined, `write boundary ${boundary}: no wedged batch`);
    here.controller.dispose();
  }
});

test("offline edit bursts converge despite intermittent quota errors, with every latest field edit intact", async () => {
  const seeds = Number(process.env.MDBASE_RELIABILITY_SEEDS ?? 3);
  const offset = Number(process.env.MDBASE_RELIABILITY_SEED_OFFSET ?? 0);
  for (let seed = offset + 1; seed <= offset + seeds; seed++) {
    let randomState = seed;
    const randomIndex = (count: number) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return Math.floor(randomState / 2 ** 32 * count);
    };
    const hosted = new MemoryAuthority();
    const count = 16;
    hosted.seed(Array.from({ length: count }, (_, index) => ({
      record_id: `n${index}`, path: `notes/n${index}.md`, frontmatter: { left: 0, right: 0 }, body: "Body\n", types: [],
    })));
    const id = await collectionId(hosted);
    const state = new MemoryMirrorStateStore();
    const here = await device(hosted, id, { state });
    const there = otherDevice(hosted);
    const session = new SyncSession(here.controller, here.profile, null);
    await here.syncOnce();
    await there.mirror.sync();
    const left = new Array<number>(count).fill(0);
    const right = new Array<number>(count).fill(0);
    for (let editNumber = 1; editNumber <= 200; editNumber++) {
      const localIndex = randomIndex(count);
      const remoteIndex = randomIndex(count);
      const localPath = `notes/n${localIndex}.md`;
      const remotePath = `notes/n${remoteIndex}.md`;
      left[localIndex] = editNumber;
      right[remoteIndex] = editNumber;
      await edit(here.vault, localPath, here.vault.read(localPath)!.replace(/left: \d+/, `left: ${editNumber}`));
      await edit(there.vault, remotePath, there.vault.read(remotePath)!.replace(/right: \d+/, `right: ${editNumber}`));
    }
    await there.mirror.sync();
    if (seed % 2 === 0) {
      const quotaBoundary = randomIndex(12) + 1;
      let writes = 0;
      const write = state.write.bind(state);
      state.write = async (next) => {
        if (++writes === quotaBoundary) throw new DOMException("Intermittent quota error", "QuotaExceededError");
        return write(next);
      };
    }
    for (let round = 0; round < 8; round++) {
      const result = await session.autoSync();
      assert.ok(["applied", "up_to_date", "pending", "failed", "needs_review"].includes(result), `seed ${seed}: ${result}`);
      if (["applied", "up_to_date"].includes(result) && !session.state.status?.conflicts.length
        && !session.state.preview?.plan.actions.length) break;
    }
    await there.mirror.sync();
    for (let index = 0; index < count; index++) {
      const path = `notes/n${index}.md`;
      const document = here.vault.read(path)!;
      assert.match(document, new RegExp(`left: ${left[index]}\\n`), `seed ${seed}: latest local edit at ${path}`);
      assert.match(document, new RegExp(`right: ${right[index]}\\n`), `seed ${seed}: latest hosted edit at ${path}`);
      assert.equal(there.vault.read(path), document, `seed ${seed}: devices agree at ${path}`);
    }
    assert.equal((await here.controller.status())?.conflicts.length, 0);
    assert.equal((await here.controller.status())?.pending, 0);
    here.controller.dispose();
  }
});

test("overlapping operations share one token renewal instead of revoking each other's token", async () => {
  const hosted = new MemoryAuthority();
  const id = await collectionId(hosted);
  let renewals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const here = await device(hosted, id, {
    expiresAt: "2000-01-01T00:00:00.000Z",
    enrollmentClient: {
      renew: async (enrollment) => {
        renewals += 1;
        await gate;
        return { ...enrollment, accessToken: `token-${renewals}`, accessTokenExpiresAt: "2099-01-01T00:00:00.000Z" } as never;
      },
    },
  });
  const work = Promise.all([
    here.controller.remoteChangesWaiting(),
    here.controller.reconnect(),
    here.controller.remoteChangesWaiting(),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await work;
  assert.equal(renewals, 1);
});
