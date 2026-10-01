import "fake-indexeddb/auto";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { TFile } from "obsidian";
import { MemoryAuthority, type SyncTransport } from "@mdbase-dev/connect-sync";
import {
  MemoryMirrorBlobStore,
  MemoryMirrorStateStore,
  WritableDirectoryMirror,
} from "@mdbase-dev/connect-sync/mirror";
import type { MirrorEnrollmentClient } from "@mdbase-dev/connect-sync/enrollment";
import { ConnectSyncController, ObsidianMirrorFileSystem, type MirrorProfile } from "../src/connectSync";
import { MemoryVault } from "./memoryVault";

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
    stateStoreFactory: () => state,
    blobStoreFactory: () => new MemoryMirrorBlobStore(),
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    transportFactory: () => options.wrapTransport?.(hosted.transport(replicaId)) ?? hosted.transport(replicaId),
    ...(options.enrollmentClient ? { enrollmentClient: options.enrollmentClient as MirrorEnrollmentClient } : {}),
  });
  const syncOnce = async () => {
    const { preview } = await controller.inspect();
    return controller.sync(preview);
  };
  return { vault, controller, state, secrets, replicaId, profile: () => profile, syncOnce };
}

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
  assert.equal(resolution?.copyPath, "plan (local conflict copy).md");
  assert.equal(here.vault.read("plan.md"), "remote line\n");
  assert.equal(here.vault.read("plan (local conflict copy).md"), "local line\n");

  await here.syncOnce();
  await there.mirror.sync();
  assert.equal(there.vault.read("plan (local conflict copy).md"), "local line\n", "the kept copy reaches every device");
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
  assert.equal(controller.isEngineWrite("notes/a.md"), true);
  assert.equal(controller.isEngineWrite("notes/other.md"), false);
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
