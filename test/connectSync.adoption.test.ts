import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { normalizePath, TFile, TFolder } from "obsidian";
import type { AuthorityImportSnapshot } from "@mdbase-dev/connect-protocol";
import { MemoryMirrorBlobStore } from "@mdbase-dev/connect-sync/mirror";
import {
  AuthorityAdoptionError,
  AuthorityAdoptionOutcomeUnknownError,
  type AuthorityAdoptionClient,
  type AuthorityAdoptionSession,
  type CompletedAuthorityAdoption,
  type PreparedAuthorityAdoption,
} from "@mdbase-dev/connect-sync/adoption";
import type {
  MirrorEnrollment,
  MirrorEnrollmentClient,
} from "@mdbase-dev/connect-sync/enrollment";
import {
  ConnectSyncController,
  type ConnectSyncSettingsHost,
  type MirrorProfile,
} from "../src/connectSync";

const TestFile = TFile as unknown as { new(path: string): TFile };
const TestFolder = TFolder as unknown as { new(path: string): TFolder };

class TestVault {
  private readonly files = new Map<string, { file: TFile; content: string }>();
  private readonly binaryFiles = new Map<string, { file: TFile; content: ArrayBuffer }>();
  private readonly folders = new Set<string>();
  onReadBinary: (() => void) | null = null;

  readonly adapter = {
    exists: async (path: string) => this.files.has(normalizePath(path)) || this.binaryFiles.has(normalizePath(path)) || this.folders.has(normalizePath(path)),
    read: async (path: string) => {
      const entry = this.files.get(normalizePath(path));
      if (!entry) throw new Error(`Missing file: ${path}`);
      return entry.content;
    },
    write: async (path: string, content: string) => {
      await this.put(path, content);
    },
    remove: async (path: string) => {
      this.files.delete(normalizePath(path));
    },
  };

  getName(): string {
    return "Adoption test vault";
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    return this.files.get(normalized)?.file
      ?? this.binaryFiles.get(normalized)?.file
      ?? (this.folders.has(normalized) ? new TestFolder(normalized) : null);
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((file) => file.extension === "md");
  }

  getFiles(): TFile[] {
    return [
      ...[...this.files.values()].map(({ file }) => file),
      ...[...this.binaryFiles.values()].map(({ file }) => file),
    ];
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }

  async put(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    const file = this.files.get(normalized)?.file ?? new TestFile(normalized);
    this.files.set(normalized, { file, content });
    return file;
  }

  async putBinary(path: string, content: Uint8Array): Promise<TFile> {
    const normalized = normalizePath(path);
    const file = this.binaryFiles.get(normalized)?.file ?? new TestFile(normalized);
    this.binaryFiles.set(normalized, { file, content: Uint8Array.from(content).buffer });
    return file;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    this.onReadBinary?.();
    const content = this.binaryFiles.get(file.path)?.content;
    if (!content) throw new Error(`Missing binary file: ${file.path}`);
    return content.slice(0);
  }
}

class TestSettings implements ConnectSyncSettingsHost {
  profile: MirrorProfile | null = null;

  getMirrorProfile(): MirrorProfile | null {
    return this.profile;
  }

  async saveMirrorProfile(profile: MirrorProfile | null): Promise<void> {
    this.profile = profile;
  }
}

interface FakeAdoptionOptions {
  failFinalUploadOnce?: boolean;
  loseFirstCompletionResponse?: boolean;
  editAfterFinalUpload?: () => Promise<void>;
}

class FakeAdoption {
  readonly collectionId: string;
  readonly adoptionId = randomUUID();
  readonly session: AuthorityAdoptionSession;
  uploads: AuthorityImportSnapshot[] = [];
  uploadedFileBytes: Uint8Array[][] = [];
  completionCalls = 0;
  state: "ready" | "activating" | "completed" = "ready";
  exchangeError: Error | null = null;
  private failedFinalUpload = false;

  constructor(
    collectionId: string,
    private readonly options: FakeAdoptionOptions = {},
  ) {
    this.collectionId = collectionId;
    this.session = {
      controlUrl: "https://connect.example",
      adoptionId: this.adoptionId,
      credential: "adp_test_secret_abcdefghijklmnopqrstuvwxyz",
      verificationUri: `https://connect.example/adopt/${this.adoptionId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requested: {
        collectionId,
        displayName: "Test collection",
        sourceName: "Obsidian",
        retainMirror: true,
        mirrorName: "Obsidian",
      },
    };
  }

  async begin(input: { collectionId: string }): Promise<AuthorityAdoptionSession> {
    assert.equal(input.collectionId, this.collectionId);
    return this.session;
  }

  async waitForApproval(): Promise<PreparedAuthorityAdoption> {
    return this.prepared();
  }

  async exchange() {
    if (this.exchangeError) throw this.exchangeError;
    if (this.state === "completed") return this.completed();
    if (this.state === "activating") {
      return { status: "activating" as const, adoption: this.adoptionView("activating") };
    }
    return this.prepared();
  }

  async uploadSnapshot(
    _session: AuthorityAdoptionSession,
    _prepared: PreparedAuthorityAdoption,
    snapshot: AuthorityImportSnapshot,
    options?: { fileSource?: (file: AuthorityImportSnapshot["files"][number]) => Promise<ArrayBuffer> },
  ): Promise<void> {
    if (this.options.failFinalUploadOnce && this.uploads.length === 1 && !this.failedFinalUpload) {
      this.failedFinalUpload = true;
      throw new Error("connection dropped during final upload");
    }
    this.uploads.push(structuredClone(snapshot));
    const uploadedBytes: Uint8Array[] = [];
    for (const file of snapshot.files) {
      const source = await options?.fileSource?.(file);
      if (source) uploadedBytes.push(new Uint8Array(source));
    }
    this.uploadedFileBytes.push(uploadedBytes);
    if (this.uploads.length >= 2) await this.options.editAfterFinalUpload?.();
  }

  async complete(
    _session: AuthorityAdoptionSession,
    snapshot: AuthorityImportSnapshot,
  ): Promise<CompletedAuthorityAdoption> {
    this.completionCalls += 1;
    this.state = "activating";
    if (this.options.loseFirstCompletionResponse && this.completionCalls === 1) {
      throw new AuthorityAdoptionOutcomeUnknownError("response lost after activation");
    }
    this.state = "completed";
    return {
      status: "completed",
      adoption: {
        ...this.adoptionView("completed"),
        manifest_digest: snapshot.manifest_digest,
        source_revision: snapshot.source_revision,
        final_head: snapshot.source_head,
      },
    };
  }

  mirrorEnrollmentSession() {
    return {
      controlUrl: this.session.controlUrl,
      pairingId: this.session.adoptionId,
      refreshCredential: this.session.credential,
      verificationUri: `https://connect.example/mirror/${this.session.adoptionId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requested: {
        mirrorName: "Obsidian",
        mode: "read_write" as const,
        collectionId: this.collectionId,
      },
    };
  }

  async cancel(): Promise<void> {
    this.state = "ready";
  }

  private prepared(): PreparedAuthorityAdoption {
    return {
      status: "ready",
      adoption: this.adoptionView("prepared"),
      import: {
        import_id: this.adoptionId,
        manifest_url: `https://provider.example/v1/authority-imports/${this.adoptionId}/manifest`,
        records_url: `https://provider.example/v1/authority-imports/${this.adoptionId}/records`,
        files_url: `https://provider.example/v1/authority-imports/${this.adoptionId}/files`,
        finalize_url: `https://provider.example/v1/authority-imports/${this.adoptionId}/finalize`,
        access_token: "ati_test_secret_abcdefghijklmnopqrstuvwxyz",
      },
      staged: {
        state: "receiving",
        manifest_digest: null,
        source_revision: null,
        source_head: null,
      },
    };
  }

  private completed(): CompletedAuthorityAdoption {
    const snapshot = this.uploads.at(-1)!;
    return {
      status: "completed",
      adoption: {
        ...this.adoptionView("completed"),
        manifest_digest: snapshot.manifest_digest,
        source_revision: snapshot.source_revision,
        final_head: snapshot.source_head,
      },
    };
  }

  private adoptionView(state: "prepared" | "activating" | "completed") {
    return {
      id: this.adoptionId,
      collection_id: this.collectionId,
      display_name: "Test collection",
      source_name: "Obsidian",
      retain_mirror: true,
      mirror_name: "Obsidian",
      state,
      authority_epoch: 2,
      final_head: null,
      manifest_digest: null,
      source_revision: null,
      expires_at: this.session.expiresAt,
    };
  }
}

class FakeEnrollment {
  constructor(private readonly collectionId: string) {}

  async waitForApproval(): Promise<MirrorEnrollment> {
    return this.enrollment();
  }

  async enroll(): Promise<MirrorEnrollment> {
    return this.enrollment();
  }

  private enrollment(): MirrorEnrollment {
    return {
      controlUrl: "https://connect.example",
      syncUrl: `https://provider.example/v1/authorities/${this.collectionId}/sync`,
      collectionId: this.collectionId,
      replicaId: randomUUID(),
      mode: "read_write",
      name: "Obsidian",
      enrollmentId: randomUUID(),
      accessToken: "access-token",
      refreshCredential: "refresh-token",
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

async function fixture(options: FakeAdoptionOptions = {}) {
  const collectionId = randomUUID();
  const vault = new TestVault();
  await vault.put("mdbase.yaml", JSON.stringify({
    spec_version: "0.3.0",
    name: "Test collection",
    settings: {
      types_folder: "_types",
      explicit_type_keys: ["type", "types"],
      default_strict: false,
      include_subfolders: true,
      exclude: ["_types", ".obsidian", ".git", ".trash", ".mdbase"],
    },
    "x-mdbase-connect": { collection_id: collectionId },
    "x-obsidian": { bases: { include: ["views/**/*.base"] } },
  }));
  await vault.put("_types/task.md", `---\n${JSON.stringify({
    kind: "mdbase.type",
    name: "task",
    version: 1,
    match: { path_glob: "tasks/**/*.md" },
    schema: {
      dialect: "json-schema-2020-12",
      value: { type: "object", properties: { title: { type: "string" } } },
    },
  })}\n---\n\nTask`);
  await vault.put("tasks/one.md", `---\n${JSON.stringify({ title: "One" })}\n---\n\nBody`);
  await vault.put("views/tasks.base", "views: []\n");
  const secrets = new Map<string, string>();
  const app = {
    vault,
    secretStorage: {
      setSecret: (id: string, value: string) => secrets.set(id, value),
      getSecret: (id: string) => secrets.get(id) || null,
    },
  };
  const settings = new TestSettings();
  const adoption = new FakeAdoption(collectionId, options);
  const adoptionBlobs = new MemoryMirrorBlobStore();
  const controller = new ConnectSyncController(
    app as never,
    settings,
    {
      adoptionClient: adoption as unknown as AuthorityAdoptionClient,
      enrollmentClient: new FakeEnrollment(collectionId) as unknown as MirrorEnrollmentClient,
      adoptionBlobStoreFactory: () => adoptionBlobs,
    },
  );
  await controller.initialize();
  return { app, vault, settings, adoption, controller, collectionId };
}

test("restart completes cleanup after enrollment is saved but adoption marker removal fails", async () => {
  const { app, vault, settings, controller } = await fixture();
  const remove = vault.adapter.remove;
  vault.adapter.remove = async (path) => {
    if (path === ".mdbase/authority-adoption.json") throw new Error("injected cleanup failure");
    await remove(path);
  };
  await assert.rejects(controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian" }, callbacks), /cleanup failure/);
  assert.ok(settings.profile);
  assert.equal(await vault.adapter.exists(".mdbase/authority-adoption.json"), true);
  vault.adapter.remove = remove;
  const restarted = new ConnectSyncController(app as never, settings, { adoptionBlobStoreFactory: () => new MemoryMirrorBlobStore() });
  await restarted.initialize();
  assert.equal(restarted.getAdoptionMarker(), null);
  assert.equal(await vault.adapter.exists(".mdbase/authority-adoption.json"), false);
  restarted.assertLocalAuthorityWritable();
});

test("adoption restart does not erase a checkpoint belonging to another collection", async () => {
  const { app, vault, settings, controller } = await fixture();
  const remove = vault.adapter.remove;
  vault.adapter.remove = async (path) => {
    if (path === ".mdbase/authority-adoption.json") throw new Error("injected cleanup failure");
    await remove(path);
  };
  await assert.rejects(controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian" }, callbacks));
  assert.ok(settings.profile);
  settings.profile = { ...settings.profile, collectionId: randomUUID() };
  vault.adapter.remove = remove;
  const restarted = new ConnectSyncController(app as never, settings);
  await assert.rejects(restarted.initialize(), /both an authority-adoption checkpoint and a mirror profile/);
  assert.equal(await vault.adapter.exists(".mdbase/authority-adoption.json"), true);
});

test("disposing during approval cancels adoption and prevents later activation", async () => {
  const { controller, settings } = await fixture();
  await assert.rejects(controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian" }, {
    onVerification: () => controller.dispose(),
  }));
  assert.equal(settings.profile, null);
  assert.throws(() => controller.assertLocalAuthorityWritable(), /unloaded/);
  await assert.rejects(controller.preview(), /unloaded/);
});

const callbacks = {
  onVerification: () => undefined,
  onStatus: () => undefined,
};

test("adopts every canonical resource and retains the existing vault as a mirror", async () => {
  const { vault, settings, adoption, controller, collectionId } = await fixture();
  const opaqueDocument = "---\ntitle: [unterminated\n---\nOpaque body\n";
  await vault.put("tasks/opaque.md", opaqueDocument);
  const profile = await controller.adoptLocalCollection({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian",
  }, callbacks);

  assert.equal(profile.collectionId, collectionId);
  assert.equal(settings.profile?.mode, "read_write");
  assert.equal(adoption.uploads.length, 2);
  const final = adoption.uploads[1]!;
  assert.deepEqual(
    final.resources.documents!.map(({ kind, path }) => [kind, path]),
    [
      ["configuration", "mdbase.yaml"],
      ["type", "_types/task.md"],
      ["view", "views/tasks.base"],
    ],
  );
  assert.deepEqual(final.records.map(({ path }) => path), ["tasks/one.md", "tasks/opaque.md"]);
  assert.equal(
    final.records.find(({ path }) => path === "tasks/opaque.md")?.document,
    opaqueDocument,
  );
  assert.equal(await vault.adapter.exists(".mdbase/connect-role.json"), true);
  assert.equal(await vault.adapter.exists(".mdbase/authority-adoption.json"), false);
  assert.equal(await vault.adapter.exists(".mdbase/authority-adoption-snapshot.json"), false);
});

test("adoption includes selected binary files and supplies their exact bytes", async () => {
  const { vault, adoption, controller } = await fixture();
  const bytes = Uint8Array.from([0, 4, 8, 15, 16, 23, 42, 255]);
  await vault.putBinary("Attachments/empty.png", new Uint8Array());
  await vault.putBinary("Attachments/evidence.png", bytes);
  await vault.putBinary("Attachments/unselected.pdf", Uint8Array.of(9, 9, 9));
  await controller.adoptLocalCollection({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian",
    selectiveSync: { file_classes: ["image"], excluded_folders: [] },
  }, callbacks);
  const final = adoption.uploads.at(-1)!;
  assert.deepEqual(final.files.map((file) => [file.path, file.media_class, file.size]), [
    ["Attachments/empty.png", "image", 0],
    ["Attachments/evidence.png", "image", bytes.byteLength],
  ]);
  assert.deepEqual(adoption.uploadedFileBytes.at(-1), [new Uint8Array(), bytes]);
});

test("adoption snapshot cancellation stops before hashing the next heavy file", async () => {
  const { vault, adoption, controller } = await fixture();
  await vault.putBinary("Attachments/first.png", new Uint8Array(8 * 1024 * 1024));
  await vault.putBinary("Attachments/second.png", new Uint8Array(8 * 1024 * 1024));
  const abort = new AbortController();
  let binaryReads = 0;
  vault.onReadBinary = () => {
    binaryReads += 1;
    abort.abort();
  };

  await assert.rejects(
    controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
      selectiveSync: { file_classes: ["image"], excluded_folders: [] },
    }, { ...callbacks, signal: abort.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(binaryReads, 1);
  assert.equal(adoption.uploads.length, 0);
  assert.equal(controller.getAdoptionMarker()?.phase, "waiting_for_approval");

  vault.onReadBinary = null;
  await controller.cancelAdoption();
  assert.equal(controller.getAdoptionMarker(), null);
});

test("a lost activation response keeps the exact snapshot fenced across restart", async () => {
  const state = await fixture({ loseFirstCompletionResponse: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
    (error: unknown) => error instanceof AuthorityAdoptionOutcomeUnknownError,
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "activating");
  assert.throws(() => state.controller.assertLocalAuthorityWritable(), /frozen|authoritative/i);
  const digest = state.adoption.uploads.at(-1)?.manifest_digest;

  const resumed = new ConnectSyncController(
    state.app as never,
    state.settings,
    {
      adoptionClient: state.adoption as unknown as AuthorityAdoptionClient,
      enrollmentClient: new FakeEnrollment(state.collectionId) as unknown as MirrorEnrollmentClient,
    },
  );
  await resumed.initialize();
  await resumed.resumeAdoption(callbacks);

  assert.equal(state.adoption.uploads.at(-1)?.manifest_digest, digest);
  assert.equal(state.adoption.uploads.length, 2);
  assert.equal(resumed.getAdoptionMarker(), null);
  assert.equal(state.settings.profile?.collectionId, state.collectionId);
});

test("an interrupted final upload resumes from the persisted fenced snapshot", async () => {
  const state = await fixture({ failFinalUploadOnce: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
    /connection dropped/,
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "fenced");
  assert.throws(() => state.controller.assertLocalAuthorityWritable(), /frozen/i);

  await state.controller.resumeAdoption(callbacks);
  assert.equal(state.adoption.uploads.length, 2);
  assert.equal(state.adoption.completionCalls, 1);
  assert.equal(state.settings.profile?.collectionId, state.collectionId);
});

test("edits arriving after the fence remain local for the new mirror instead of changing the activated snapshot", async () => {
  let state: Awaited<ReturnType<typeof fixture>>;
  state = await fixture({
    editAfterFinalUpload: async () => {
      await state.vault.put("tasks/one.md", `---\n${JSON.stringify({ title: "After fence" })}\n---\n\nBody`);
    },
  });
  await state.controller.adoptLocalCollection({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian",
  }, callbacks);

  assert.match(state.adoption.uploads.at(-1)?.records[0]?.document ?? "", /"title":"One"/);
  assert.match(await state.vault.adapter.read("tasks/one.md"), /After fence/);
  assert.equal(state.settings.profile?.mode, "read_write");
});

test("a pre-activation checkpoint can be cancelled without leaving the vault fenced", async () => {
  const state = await fixture({ failFinalUploadOnce: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "fenced");
  await state.controller.cancelAdoption();
  assert.equal(state.controller.getAdoptionMarker(), null);
  assert.doesNotThrow(() => state.controller.assertLocalAuthorityWritable());
});

test("an expired server checkpoint safely unfreezes the local authority", async () => {
  const state = await fixture({ loseFirstCompletionResponse: true });
  await assert.rejects(
    state.controller.adoptLocalCollection({
      controlUrl: "https://connect.example",
      mirrorName: "Obsidian",
    }, callbacks),
  );
  assert.equal(state.controller.getAdoptionMarker()?.phase, "activating");
  state.adoption.exchangeError = new AuthorityAdoptionError(
    "authority_adoption_expired",
    "expired",
    409,
  );

  await assert.rejects(
    state.controller.resumeAdoption(callbacks),
    /remains the writable local authority/,
  );
  assert.equal(state.controller.getAdoptionMarker(), null);
  assert.doesNotThrow(() => state.controller.assertLocalAuthorityWritable());
});
