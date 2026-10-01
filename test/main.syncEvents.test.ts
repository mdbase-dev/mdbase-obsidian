import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import MdbasePlugin from "../main";
import { MemoryVault, TestFolder } from "./memoryVault";

function fixture() {
  const vault = new MemoryVault();
  const handlers = new Map<string, (file: TFile | TFolder, oldPath?: string) => void>();
  const plugin = new MdbasePlugin({
    vault: Object.assign(vault, {
      configDir: ".obsidian",
      on: (event: string, callback: (file: TFile | TFolder, oldPath?: string) => void) => { handlers.set(event, callback); },
    }),
    workspace: { getLeavesOfType: () => [] },
  } as never, { id: "mdbase", version: "test" } as never);
  plugin.settings = {
    autoSync: true, validateOnSave: false, validateOnOpen: false, showNoticeOnSave: false, interopEnabled: false,
    typeDrafts: {}, archivedTypeDrafts: [],
    mirrorProfile: { version: 1, collectionId: "c", replicaId: "r", enrollmentId: "e", mode: "read_write", name: "Notes", syncUrl: "https://example.com", controlUrl: "https://example.com", accessTokenExpiresAt: "2099-01-01" },
  };
  let observed = 0;
  let scheduled = 0;
  plugin.sync = { observeLocalChange: () => { observed++; } } as never;
  const internal = plugin as unknown as {
    registerVaultEvents(): void;
    syncScheduler: { noteLocalChange(): void };
    recordCache: Map<string, unknown> | null;
    recordList: unknown[] | null;
  };
  internal.syncScheduler = { noteLocalChange: () => { scheduled++; } };
  internal.registerVaultEvents();
  return { plugin, internal, handlers, observed: () => observed, scheduled: () => scheduled };
}

test("folder-only rename events schedule sync and invalidate cached descendant records", () => {
  const f = fixture();
  f.internal.recordCache = new Map([["Old/note.md", { path: "Old/note.md" }]]);
  f.internal.recordList = [{ path: "Old/note.md" }];
  f.handlers.get("rename")!(new TestFolder("New"), "Old");
  assert.ok(f.observed() > 0, "folder events must not be dropped when Obsidian emits no child events");
  assert.ok(f.scheduled() > 0);
  assert.equal(f.internal.recordCache, null);
  assert.equal(f.internal.recordList, null);
  f.plugin.connectSync.dispose();
});

test("paused sync takes precedence over a previous offline problem in scheduler wiring", () => {
  const f = fixture();
  f.plugin.sync = { state: { paused: true, problem: { kind: "offline" } } } as never;
  const internal = f.plugin as unknown as {
    startSyncScheduler(): void;
    syncScheduler: { host: { problemKind(): string | null }; stop(): void };
  };
  internal.startSyncScheduler();
  // Clear the real timer immediately; this is a wiring test, not a live sync.
  internal.syncScheduler.stop();
  assert.equal(internal.syncScheduler.host.problemKind(), "paused");
  f.plugin.connectSync.dispose();
});

test("folder-only deletion events schedule sync while reserved folders stay ignored", () => {
  const f = fixture();
  f.handlers.get("delete")!(new TestFolder("Notes"));
  assert.ok(f.scheduled() > 0);
  const before = f.scheduled();
  f.handlers.get("delete")!(new TestFolder(".obsidian"));
  assert.equal(f.scheduled(), before);
  f.plugin.connectSync.dispose();
});
