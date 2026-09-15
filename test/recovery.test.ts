import assert from "node:assert/strict";
import test from "node:test";
import { ConnectSyncController, type MirrorProfile } from "../src/connectSync";
import { initializationProblem, recoveryDiagnostic } from "../src/recovery";

function fixture(profile: MirrorProfile | null = null) {
  const files = new Map<string, string>([["note.md", "Important local note\n"]]);
  const effects: string[] = [];
  const controller = new ConnectSyncController({
    vault: { adapter: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path),
      write: async () => { effects.push("write"); },
      remove: async () => { effects.push("remove"); },
    } },
  } as never, {
    getMirrorProfile: () => profile,
    saveMirrorProfile: async () => { effects.push("settings"); },
  }, {
    transportFactory: () => { effects.push("transport"); throw new Error("Unexpected transport"); },
    enrollmentClient: { enroll: async () => { effects.push("enrollment"); } } as never,
    adoptionClient: { begin: async () => { effects.push("adoption"); } } as never,
  });
  return { controller, files, effects };
}

async function assertWritesBlocked(controller: ConnectSyncController): Promise<void> {
  assert.throws(() => controller.assertLocalAuthorityWritable(), /recovery workspace/);
  await assert.rejects(controller.preview(), /recovery workspace/);
  await assert.rejects(controller.status(), /recovery workspace/);
  await assert.rejects(controller.sync({} as never), /recovery workspace/);
  await assert.rejects(controller.resolveConflict("id", "decision", "local"), /recovery workspace/);
  await assert.rejects(controller.preserveConflictCopy("note.md"), /recovery workspace/);
  await assert.rejects(controller.disconnect(true), /recovery workspace/);
  await assert.rejects(controller.reconnect(), /recovery workspace/);
  await assert.rejects(controller.configureSelectiveSync({ file_classes: [], excluded_folders: [] }), /recovery workspace/);
  await assert.rejects(controller.enroll({ controlUrl: "https://unused.invalid", mirrorName: "Test", mode: "read_write" }, { onVerification() {} }), /recovery workspace/);
  await assert.rejects(controller.adoptLocalCollection({ controlUrl: "https://unused.invalid", mirrorName: "Test" }, { onVerification() {} }), /recovery workspace/);
  await assert.rejects(controller.resumeAdoption(), /recovery workspace/);
  await assert.rejects(controller.cancelAdoption(), /recovery workspace/);
}

test("corrupt adoption metadata latches recovery and fences every write entry point until repaired", async () => {
  const { controller, files, effects } = fixture();
  await assertWritesBlocked(controller);
  files.set(".mdbase/authority-adoption.json", "invalid secret payload");
  await assert.rejects(controller.initialize());
  assert.equal(controller.getRecoveryStatus()?.code, "invalid_authority_adoption_checkpoint");
  await assertWritesBlocked(controller);
  assert.deepEqual(effects, []);
  assert.equal(files.get("note.md"), "Important local note\n");
  assert.equal(files.get(".mdbase/authority-adoption.json"), "invalid secret payload");
  // Test-only repair of a checkpoint this test created. The product has no delete/reset shortcut.
  files.delete(".mdbase/authority-adoption.json");
  await controller.initialize();
  assert.equal(controller.getRecoveryStatus(), null);
  controller.assertLocalAuthorityWritable();
});

test("initialization retries are single-flight and never unlock writes while checking", async () => {
  const { controller } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let prepares = 0;
  const first = controller.initialize(async () => { prepares++; await gate; });
  const second = controller.initialize(async () => { prepares++; });
  assert.equal(first, second);
  await assertWritesBlocked(controller);
  assert.equal(controller.getRecoveryStatus()?.state, "checking");
  release();
  await first;
  assert.equal(prepares, 1);
  controller.assertLocalAuthorityWritable();
});

test("settings failure stays blocked; a retry rereads settings without persisting defaults", async () => {
  const { controller, effects } = fixture();
  await assert.rejects(controller.initialize(async () => { throw { code: "invalid_plugin_settings", message: "secret settings contents" }; }));
  assert.equal(controller.getRecoveryStatus()?.code, "invalid_plugin_settings");
  assert.deepEqual(effects, []);
  let reread = false;
  await controller.initialize(async () => { reread = true; });
  assert.equal(reread, true);
  assert.equal(controller.getRecoveryStatus(), null);
});

test("disposing during initialization cannot reopen the write gate", async () => {
  const { controller } = fixture();
  await assert.rejects(controller.initialize(async () => { controller.dispose(); }), /unloaded/);
  assert.throws(() => controller.assertReady(), /unloaded/);
  assert.notEqual(controller.getRecoveryStatus(), null);
});

test("configured mirrors with missing role markers enter recovery instead of appearing writable", async () => {
  const { controller, effects } = fixture({ collectionId: "22222222-2222-4222-8222-222222222222" } as MirrorProfile);
  await assert.rejects(controller.initialize(), /role marker/);
  assert.equal(controller.getRecoveryStatus()?.code, "mirror_marker_missing");
  await assertWritesBlocked(controller);
  assert.deepEqual(effects, []);
});

test("diagnostics never serialize exception messages, paths, credentials or unknown error codes", () => {
  for (const code of ["invalid_plugin_settings", "file:///private/secret-token", "__proto__"]) {
    const status = initializationProblem({ code, message: "secret-token", credential: "secret-token" });
    const result = JSON.stringify(status) + recoveryDiagnostic(status);
    assert.equal(result.includes("secret-token"), false);
    assert.equal(result.includes("file:///"), false);
    assert.equal(JSON.parse(recoveryDiagnostic(status)).plugin_writes, "blocked");
  }
});
