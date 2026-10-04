import assert from "node:assert/strict";
import test from "node:test";
import type { Vault } from "obsidian";
import { MdbaseMutationBackend, type MdbaseWriteClient } from "../src/mdbaseMutationBackend";
import MdbasePlugin from "../main";
import { parseFrontmatter } from "../src/mdbaseCore";
import { MemoryVault } from "./memoryVault";

function fixture() {
  const vault = new MemoryVault();
  const calls: unknown[][] = [];
  const record = { id: "record", path: "note.md", frontmatter: {}, document: "runtime bytes" };
  let fail: Error | null = null;
  const write = { mutation: "m" };
  const client: MdbaseWriteClient = {
    collectionPath: path => path.startsWith("Notes/") ? path.slice(6) : null,
    isRecordPath: path => path === "note.md",
    isResourcePath: path => path === "_types/note.md",
    find: async (path, opts) => { calls.push(["find", path, opts]); return record; },
    replaceDocument: async (seen, doc) => {
      calls.push(["replace", seen, doc]);
      if (fail) throw fail;
      return write;
    },
    create: async (path, doc) => { calls.push(["create", path, doc]); if (fail) throw fail; return write; },
    resources: async ops => { calls.push(["resources", ops]); if (fail) throw fail; return write; },
    settle: async (receipt, path) => { calls.push(["settle", receipt, path]); },
  };
  const backend = new MdbaseMutationBackend(client);
  return { vault, calls, record, client, backend, fail: (error: Error) => { fail = error; } };
}

test("document transforms read the replica view, preserving the client's base token", async () => {
  const f = fixture();
  await f.vault.create("Notes/note.md", "stale vault bytes");
  await f.backend.transform("Notes/note.md", raw => `${raw}!`);
  assert.equal(f.calls[1]?.[1], f.record);
  assert.equal(f.calls[1]?.[2], "runtime bytes!");
  assert.equal(f.calls[2]?.[0], "settle");
  assert.equal(f.vault.read("Notes/note.md"), "stale vault bytes", "backend never writes directly");
});

test("a no-op does not submit; a missing document fails rather than reading stale vault bytes", async () => {
  const f = fixture();
  await f.backend.transform("Notes/note.md", raw => raw);
  assert.equal(f.calls.length, 1);
  f.client.find = async () => null;
  await assert.rejects(f.backend.transform("Notes/note.md", () => "new"), /unavailable/);
  f.client.find = async () => ({ id: "r", path: "note.md", frontmatter: {} });
  await assert.rejects(f.backend.transform("Notes/note.md", () => "new"), /unavailable/);
});

test("create waits for publication/indexing and never calls vault.create as fallback", async () => {
  const f = fixture();
  const file = await f.vault.create("Notes/note.md", "published by host");
  assert.equal(await f.backend.create(f.vault as unknown as Vault, file.path, "new"), file);
  assert.deepEqual(f.calls.map(call => call[0]), ["create", "settle"]);
  f.fail(new Error("held"));
  await assert.rejects(f.backend.create(f.vault as unknown as Vault, file.path, "new"), /held/);
  assert.equal(f.vault.read(file.path), "published by host");
});

test("resource creation carries null (must-not-exist); edits carry exact base bytes", async () => {
  const f = fixture();
  const path = "Notes/_types/note.md";
  await f.vault.create(path, "host-published type");
  for (const base of [null, "original type bytes"]) {
    await f.backend.putResource(f.vault as unknown as Vault, path, "new type", base);
    assert.deepEqual(f.calls[f.calls.length - 2], ["resources", [{ kind: "put", path: "_types/note.md", doc: "new type", base }]]);
  }
  f.fail(new Error("conflict"));
  await assert.rejects(f.backend.putResource(f.vault as unknown as Vault, path, "new type", "old"), /conflict/);
  assert.equal(f.vault.read(path), "host-published type");
});

test("outside collection and wrong path class never reach a mutation", async () => {
  const f = fixture();
  await assert.rejects(f.backend.transform("Elsewhere/note.md", raw => raw), /not a collection/);
  await assert.rejects(f.backend.transform("Notes/_types/note.md", raw => raw), /not a collection/);
  await assert.rejects(f.backend.create(f.vault as unknown as Vault, "Notes/image.png", "bytes"), /not a collection/);
  await assert.rejects(f.backend.putResource(f.vault as unknown as Vault, "Notes/note.md", "new", null), /not a collection/);
  assert.deepEqual(f.calls, []);
});

test("a published create without an indexed TFile fails without attempting another create", async () => {
  const f = fixture();
  await assert.rejects(f.backend.create(f.vault as unknown as Vault, "Notes/note.md", "new"), /not indexed/);
  assert.equal(f.vault.files.size, 0);
});

function pluginFixture() {
  const f = fixture();
  const plugin = new MdbasePlugin({ vault: f.vault, workspace: { getLeavesOfType: () => [] } } as never, { id: "mdbase", version: "test" } as never);
  plugin.settings = { mirrorProfile: null, autoSync: false, typeDrafts: {}, archivedTypeDrafts: [], validateOnSave: false, validateOnOpen: false, showNoticeOnSave: false, interopEnabled: false };
  return { ...f, plugin };
}

test("plugin defaults to legacy creates; explicit backend attachment routes typed-note creation", async () => {
  const f = pluginFixture();
  await f.plugin.createTypedNote("legacy.md", { type: "note" });
  assert.equal(parseFrontmatter(f.vault.read("legacy.md") ?? "").frontmatter.type, "note");
  assert.deepEqual(f.calls, []);
  await f.vault.create("Notes/note.md", "host bytes");
  f.plugin.setMdbaseMutationBackend(f.backend);
  await f.plugin.createTypedNote("Notes/note.md", { type: "note" });
  assert.equal(f.calls[0]?.[0], "create");
  assert.equal(f.vault.read("Notes/note.md"), "host bytes");
  f.plugin.connectSync.dispose();
});

test("attached runtime blocks unported disk migrations/packs and legacy enrolment", async () => {
  const f = pluginFixture();
  f.plugin.setMdbaseMutationBackend(f.backend);
  await assert.rejects(f.plugin.initializeCollection(), /not yet available/);
  await assert.rejects(f.plugin.openContractCatalog(), /not yet available/);
  await assert.rejects(f.plugin.applyMigration({} as never, false), /not yet available/);
  await assert.rejects(f.plugin.connectSync.enroll({} as never, {} as never), /not yet available/);
  await assert.rejects(f.plugin.connectSync.adoptLocalCollection({} as never, {} as never), /not yet available/);
  assert.equal(f.vault.files.size, 0);
  f.plugin.connectSync.dispose();
});

test("in-flight legacy work prevents attachment until its finally block runs", async () => {
  const f = pluginFixture();
  let finish: () => void = () => {};
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const internal = f.plugin.connectSync as unknown as { withLifetime(signal: undefined, operation: () => Promise<void>): Promise<void> };
  const operation = internal.withLifetime(undefined, () => pending);
  assert.throws(() => f.plugin.setMdbaseMutationBackend(f.backend), /Wait for the old Connect operation/);
  finish();
  await operation;
  f.plugin.setMdbaseMutationBackend(f.backend);
  f.plugin.connectSync.dispose();
});

test("a configured old mirror prevents backend attachment", () => {
  const f = pluginFixture();
  f.plugin.settings.mirrorProfile = { version: 1 } as never;
  assert.throws(() => f.plugin.setMdbaseMutationBackend(f.backend), /Disconnect/);
  f.plugin.connectSync.dispose();
});
