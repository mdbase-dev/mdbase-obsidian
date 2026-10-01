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
  findAdoptionPathConflicts,
  normalizeSelectiveSync,
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

  getAllLoadedFiles(): Array<TFile | TFolder> {
    return [...this.getFiles(), ...[...this.folders].map(path => new TestFolder(path))];
  }

  async rename(file: TFile, to: string): Promise<void> {
    assert.equal(await this.adapter.exists(to), false);
    const entry = this.files.get(file.path);
    assert.equal(entry?.file, file);
    this.files.delete(file.path);
    file.path = to;
    this.files.set(to, entry!);
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
  cancelCalls = 0;
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
    this.cancelCalls++;
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
  const renameCalls: Array<{ from: string; to: string }> = [];
  const app = {
    vault,
    fileManager: { renameFile: async (file: TFile, to: string) => {
      renameCalls.push({ from: file.path, to });
      await vault.rename(file, to);
    } },
    secretStorage: {
      setSecret: (id: string, value: string) => secrets.set(id, value),
      getSecret: (id: string) => secrets.get(id) || null,
    },
  };
  const settings = new TestSettings();
  const adoption = new FakeAdoption(collectionId, options);
  const adoptionBlobs = new MemoryMirrorBlobStore();
  const enrollment = new FakeEnrollment(collectionId);
  const controller = new ConnectSyncController(
    app as never,
    settings,
    {
      adoptionClient: adoption as unknown as AuthorityAdoptionClient,
      enrollmentClient: enrollment as unknown as MirrorEnrollmentClient,
      adoptionBlobStoreFactory: () => adoptionBlobs,
    },
  );
  await controller.initialize();
  return { app, vault, settings, adoption, enrollment, controller, collectionId, renameCalls };
}

async function lostCredential(phase: "waiting_for_approval" | "uploading" | "fenced" | "activating" | "adopted", expired = true) {
  const state = await fixture();
  const { credential: _credential, ...session } = state.adoption.session;
  session.expiresAt = new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString();
  await state.vault.put(".mdbase/authority-adoption.json", JSON.stringify({
    version: 1, phase, session, manifest_digest: null, source_revision: null, source_head: null,
    selective_sync: { file_classes: ["image"], excluded_folders: ["Private"] },
  }));
  await state.controller.initialize();
  return state;
}

test("expired pre-activation setup can be reset without a credential or changing collection bytes", async () => {
  for (const phase of ["waiting_for_approval", "uploading"] as const) {
    const s = await lostCredential(phase);
    const before = await Promise.all(s.vault.getMarkdownFiles().map(file => s.vault.cachedRead(file)));
    const config = await s.vault.adapter.read("mdbase.yaml");
    assert.deepEqual(s.controller.getAdoptionRecovery(), { canReset: true, canReconnect: false });
    s.app.secretStorage.setSecret = () => { throw new Error("keyring locked"); };
    await s.controller.resetExpiredAdoption();
    assert.equal(s.controller.getAdoptionMarker(), null);
    assert.equal(await s.vault.adapter.exists(".mdbase/authority-adoption.json"), false);
    assert.equal(s.adoption.cancelCalls, 0, "do not claim remote cancellation without authorization");
    assert.equal(s.settings.profile, null);
    assert.deepEqual(await Promise.all(s.vault.getMarkdownFiles().map(file => s.vault.cachedRead(file))), before);
    assert.equal(await s.vault.adapter.read("mdbase.yaml"), config);
    await s.controller.initialize();
    assert.equal(s.controller.getAdoptionMarker(), null, "reset survives restart");
  }
});

test("recovery never resets a live request, a usable credential, or a fenced/unknown activation", async () => {
  for (const phase of ["waiting_for_approval", "uploading", "fenced", "activating", "adopted"] as const) {
    const s = await lostCredential(phase, false);
    await assert.rejects(s.controller.resetExpiredAdoption(), /never froze/);
    assert.equal(s.controller.getAdoptionMarker()?.phase, phase);
    if (["fenced", "activating", "adopted"].includes(phase)) assert.throws(() => s.controller.assertLocalAuthorityWritable());
  }
  const s = await lostCredential("uploading");
  s.app.secretStorage.setSecret(`mdbase-connect-adoption-${s.adoption.adoptionId}`, "available");
  assert.equal(s.controller.getAdoptionRecovery(), null);
  await assert.rejects(s.controller.resetExpiredAdoption(), /never froze/);
});

test("reset rechecks the durable phase instead of trusting stale in-memory state", async () => {
  const s = await lostCredential("uploading");
  const marker = JSON.parse(await s.vault.adapter.read(".mdbase/authority-adoption.json"));
  marker.phase = "activating";
  await s.vault.put(".mdbase/authority-adoption.json", JSON.stringify(marker));
  await assert.rejects(s.controller.resetExpiredAdoption(), /never froze/);
  assert.throws(() => s.controller.assertLocalAuthorityWritable());
});

test("late credential loss recovers only through fresh approval of the same hosted collection", async () => {
  for (const phase of ["fenced", "activating", "adopted"] as const) {
    const s = await lostCredential(phase);
    const record = await s.vault.adapter.read("tasks/one.md");
    assert.deepEqual(s.controller.getAdoptionRecovery(), { canReset: false, canReconnect: true });
    const profile = await s.controller.reconnectAdoption({ onVerification: () => undefined });
    assert.equal(profile.collectionId, s.collectionId);
    assert.deepEqual(profile.selectiveSync, { file_classes: ["image"], excluded_folders: ["Private"] });
    assert.equal(s.controller.getAdoptionMarker(), null);
    assert.equal(await s.vault.adapter.read("tasks/one.md"), record);
    assert.equal(s.adoption.completionCalls, 0, "recovery must not start another activation");
  }
});

test("failed or wrong-collection approval preserves the checkpoint and local write fence", async () => {
  const s = await lostCredential("activating");
  const path = ".mdbase/authority-adoption.json";
  const before = await s.vault.adapter.read(path);
  const enrolled = await s.enrollment.enroll();
  s.enrollment.enroll = async () => { throw new Error("hosted authority is not active"); };
  await assert.rejects(s.controller.reconnectAdoption({ onVerification: () => undefined }), /not active/);
  s.enrollment.enroll = async () => ({ ...enrolled, collectionId: randomUUID() });
  await assert.rejects(s.controller.reconnectAdoption({ onVerification: () => undefined }), /different collection/);
  assert.equal(await s.vault.adapter.read(path), before);
  assert.equal(s.settings.profile, null);
  assert.throws(() => s.controller.assertLocalAuthorityWritable());
});

test("recovery cannot race another move operation", async () => {
  const s = await lostCredential("activating");
  const enrollment = await s.enrollment.enroll();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  s.enrollment.enroll = async () => { await waiting; return enrollment; };
  const pending = s.controller.reconnectAdoption({ onVerification: () => undefined });
  await assert.rejects(s.controller.resetExpiredAdoption(), /Stop the current move/);
  await assert.rejects(s.controller.cancelAdoption(), /Stop the current move/);
  await assert.rejects(s.controller.resumeAdoption(), /Stop the current move/);
  release();
  await pending;
});

test("aborted hosted recovery preserves the original checkpoint even if enrollment resolves", async () => {
  const s = await lostCredential("activating");
  const before = await s.vault.adapter.read(".mdbase/authority-adoption.json");
  const abort = new AbortController();
  const enrollment = await s.enrollment.enroll();
  s.enrollment.enroll = async () => { abort.abort(); return enrollment; };
  await assert.rejects(s.controller.reconnectAdoption({ signal: abort.signal, onVerification: () => undefined }), { name: "AbortError" });
  assert.equal(await s.vault.adapter.read(".mdbase/authority-adoption.json"), before);
  assert.equal(s.settings.profile, null);
});

test("reset remains retryable if checkpoint removal fails", async () => {
  const s = await lostCredential("uploading");
  const remove = s.vault.adapter.remove;
  s.vault.adapter.remove = async () => { throw new Error("disk failure"); };
  await assert.rejects(s.controller.resetExpiredAdoption(), /disk failure/);
  assert.equal(s.controller.getAdoptionMarker()?.phase, "uploading");
  s.vault.adapter.remove = remove;
  await s.controller.resetExpiredAdoption();
  assert.equal(s.controller.getAdoptionMarker(), null);
});

test("unavailable secret storage does not block safe expired-setup cleanup", async () => {
  const s = await lostCredential("uploading");
  s.app.secretStorage.getSecret = () => { throw new Error("keyring locked"); };
  s.app.secretStorage.setSecret = () => { throw new Error("keyring locked"); };
  assert.deepEqual(s.controller.getAdoptionRecovery(), { canReset: true, canReconnect: false });
  await s.controller.resetExpiredAdoption();
  assert.equal(s.controller.getAdoptionMarker(), null);
});

test("silent secret-store failure is detected before publishing an adoption checkpoint", async () => {
  const s = await fixture();
  s.app.secretStorage.getSecret = () => null;
  let approvalShown = false;
  await assert.rejects(s.controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian" }, {
    onVerification: () => { approvalShown = true; },
  }), /could not save this device/);
  assert.equal(approvalShown, false);
  assert.equal(s.adoption.uploads.length, 0);
  assert.equal(s.adoption.cancelCalls, 1);
  assert.equal(await s.vault.adapter.exists(".mdbase/authority-adoption.json"), false);
});

test("reconnect does not discard recovery state when fresh secrets cannot be saved", async () => {
  const s = await lostCredential("activating");
  s.app.secretStorage.getSecret = () => null;
  await assert.rejects(s.controller.reconnectAdoption({ onVerification: () => undefined }), /could not save this device/);
  assert.equal(s.controller.getAdoptionMarker()?.phase, "adopted");
  assert.equal(s.settings.profile, null);
  assert.throws(() => s.controller.assertLocalAuthorityWritable());
});

test("portable path preflight matches case and Unicode aliases without folding distinct Greek characters", () => {
  assert.deepEqual(findAdoptionPathConflicts([
    "Tasks/A.md", "tasks/a.md", "CAFÉ.md", "cafe\u0301.md", "ΟΣ.md", "οσ.md", "ος.md", "same.md", "same.md",
  ]), [["Tasks/A.md", "tasks/a.md"], ["CAFÉ.md", "cafe\u0301.md"], ["ΟΣ.md", "οσ.md"], ["same.md", "same.md"]]);
});

test("filename conflicts stop before approval or upload and preflight does not read record bodies", async () => {
  const s = await fixture();
  await s.vault.put("tasks/ONE.md", "Other content");
  let begun = false;
  s.adoption.begin = async () => { begun = true; return s.adoption.session; };
  const read = s.vault.cachedRead.bind(s.vault);
  let bodies = 0;
  s.vault.cachedRead = async file => { if (file.path.startsWith("tasks/")) bodies++; return read(file); };
  const preview = await s.controller.previewAdoption();
  assert.equal(preview.conflicts.length, 1);
  assert.deepEqual(new Set(preview.conflicts[0]), new Set(["tasks/one.md", "tasks/ONE.md"]));
  assert.equal(bodies, 0);
  await assert.rejects(s.controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian" }, {
    onVerification: () => assert.fail("must not ask for approval"),
  }), /filename conflicts/);
  assert.equal(begun, false);
  assert.equal(s.adoption.uploads.length, 0);
  assert.equal(s.controller.getAdoptionMarker(), null);
  assert.equal(await s.vault.adapter.read("tasks/ONE.md"), "Other content");
});

test("conflicts introduced while approving are checked again before upload and can be resumed after correction", async () => {
  const s = await fixture();
  await assert.rejects(s.controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian" }, {
    onVerification: async () => { await s.vault.put("tasks/ONE.md", "Other content"); },
  }), /filename conflicts/);
  assert.equal(s.adoption.uploads.length, 0);
  assert.equal(s.controller.getAdoptionMarker()?.phase, "uploading", "approval was received even though preflight stopped the upload");
  await s.vault.put("tasks/other.md", await s.vault.adapter.read("tasks/ONE.md"));
  await s.vault.adapter.remove("tasks/ONE.md");
  const stages: string[] = [];
  await s.controller.resumeAdoption({ onProgress: progress => stages.push(progress.stage) });
  assert.deepEqual(stages, ["checking", "uploading", "checking", "uploading", "activating", "connecting"]);
  assert.equal(s.settings.profile?.collectionId, s.collectionId);
});

test("preflight includes resource-record overlaps and selected attachment paths", async () => {
  const s = await fixture();
  await s.vault.put("_TYPES/task.md", "Resource alias");
  await s.vault.putBinary("assets/A.png", Uint8Array.of(1));
  await s.vault.putBinary("assets/a.png", Uint8Array.of(2));
  assert.equal((await s.controller.previewAdoption()).conflicts.length, 1);
  assert.equal((await s.controller.previewAdoption({ file_classes: ["image"], excluded_folders: [] })).conflicts.length, 2);
  assert.equal((await s.controller.previewAdoption({ file_classes: ["image"], excluded_folders: ["assets"] })).conflicts.length, 1);
});

test("adoption never uploads case/Unicode aliases of excluded attachment folders", async () => {
  for (const [disk, excluded] of [["Private", "private"], ["Cafe\u0301", "CAFÉ"], ["ΟΣ", "οσ"]]) {
    const s = await fixture();
    await s.vault.putBinary(`${disk}/secret.png`, Uint8Array.of(1));
    const sibling = `${excluded}-sibling/public.png`;
    await s.vault.putBinary(sibling, Uint8Array.of(2));
    const policy = { file_classes: ["image" as const], excluded_folders: [excluded] };
    assert.equal((await s.controller.previewAdoption(policy)).files, 1, "portable exclusions must apply before approval");
    await s.controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian", selectiveSync: policy }, {
      onVerification: () => undefined,
    });
    assert.deepEqual(s.adoption.uploads[0].files.map(file => file.path), [sibling]);
    assert.ok(s.vault.getAbstractFileByPath(`${disk}/secret.png`), "excluded original stays local");
  }
});

test("selective-sync settings reject canonically equivalent and scalar-case duplicate folders", () => {
  for (const folders of [["Café", "Cafe\u0301"], ["ΟΣ", "οσ"]]) {
    assert.throws(() => normalizeSelectiveSync({ excluded_folders: folders }), /unique/);
  }
});

test("approved moves retain the server import deadline rather than the shorter approval deadline", async () => {
  const s = await fixture();
  const prepared = await s.adoption.waitForApproval();
  const expires = new Date(Date.now() + 60 * 60_000).toISOString();
  s.adoption.waitForApproval = async () => ({ ...prepared, adoption: { ...prepared.adoption, expires_at: expires } });
  s.adoption.uploadSnapshot = async () => { throw new Error("upload interrupted"); };
  await assert.rejects(s.controller.adoptLocalCollection({ controlUrl: "https://connect.example", mirrorName: "Obsidian" }, { onVerification: () => undefined }), /upload interrupted/);
  assert.equal(s.controller.getAdoptionMarker()?.session.expiresAt, expires);
});

test("reviewed adoption renames use FileManager and preserve both note bodies", async () => {
  const s = await fixture();
  await s.vault.put("tasks/ONE.md", "Other content");
  const original = await s.vault.adapter.read("tasks/one.md");
  const plan = await s.controller.planAdoptionRenames();
  assert.deepEqual(plan.renames, [{ from: "tasks/one.md", to: "tasks/one (2).md" }]);
  assert.equal(s.renameCalls.length, 0, "review must not mutate files");
  assert.equal(await s.controller.applyAdoptionRenames(plan), 1);
  assert.deepEqual(s.renameCalls, plan.renames);
  assert.equal(await s.vault.adapter.read("tasks/one (2).md"), original);
  assert.equal(await s.vault.adapter.read("tasks/ONE.md"), "Other content");
  assert.equal((await s.controller.previewAdoption()).conflicts.length, 0);
  await assert.rejects(s.controller.applyAdoptionRenames(plan), /Files changed/);
});

test("rename review includes empty folders in the occupied portable namespace", async () => {
  const s = await fixture();
  await s.vault.put("tasks/ONE.md", "Other content");
  await s.vault.createFolder("tasks/ONE (2).MD");
  assert.equal((await s.controller.planAdoptionRenames()).renames[0].to, "tasks/one (3).md");
});

test("stale or edited rename proposals cannot move files", async () => {
  const s = await fixture();
  await s.vault.put("tasks/ONE.md", "Other content");
  const plan = await s.controller.planAdoptionRenames();
  const forged = structuredClone(plan);
  forged.renames[0].to = "different.md";
  await assert.rejects(s.controller.applyAdoptionRenames(forged), /Files changed/);
  await s.vault.put("tasks/ONE (2).md", "Arrived after review");
  await assert.rejects(s.controller.applyAdoptionRenames(plan), /Files changed/);
  assert.equal(s.renameCalls.length, 0);
  assert.equal(await s.vault.adapter.read("tasks/ONE (2).md"), "Arrived after review");
});

test("rename batch stops rather than overwriting a destination created midway", async () => {
  const s = await fixture();
  await s.vault.put("tasks/ONE.md", "Other content");
  await s.vault.put("tasks/two.md", "Two");
  await s.vault.put("tasks/TWO.md", "Other two");
  const plan = await s.controller.planAdoptionRenames();
  const rename = s.app.fileManager.renameFile;
  s.app.fileManager.renameFile = async (file, to) => {
    await rename(file, to);
    await s.vault.put(plan.renames[1].to.toUpperCase(), "Concurrent arrival");
  };
  await assert.rejects(s.controller.applyAdoptionRenames(plan), /after 1 of 2/);
  assert.equal(s.renameCalls.length, 1);
  assert.equal(await s.vault.adapter.read(plan.renames[1].to.toUpperCase()), "Concurrent arrival");
  assert.equal(await s.vault.adapter.exists(plan.renames[1].from), true);
  assert.equal((await s.controller.planAdoptionRenames()).renames.length, 1, "retry reviews only remaining collisions");
});

test("post-rename link failure reports partial completion without trying to undo it", async () => {
  const s = await fixture();
  await s.vault.put("tasks/ONE.md", "Other content");
  const plan = await s.controller.planAdoptionRenames();
  const rename = s.app.fileManager.renameFile;
  s.app.fileManager.renameFile = async (file, to) => { await rename(file, to); throw new Error("link update failed"); };
  await assert.rejects(s.controller.applyAdoptionRenames(plan), /after 1 of 1.*Check filenames and links.*link update failed/);
  assert.equal(s.renameCalls.length, 1);
  assert.equal(await s.vault.adapter.exists(plan.renames[0].to), true);
});

test("frozen collections refuse automatic renames", async () => {
  const s = await lostCredential("activating");
  await s.vault.put("tasks/ONE.md", "Other content");
  const plan = await s.controller.planAdoptionRenames();
  await assert.rejects(s.controller.applyAdoptionRenames(plan), /frozen/);
  assert.equal(s.renameCalls.length, 0);
});

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
  assert.equal(controller.getAdoptionMarker()?.phase, "uploading");

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

test("Stop waiting preserves the adoption checkpoint and secret across restart for Resume", async () => {
  const state = await fixture();
  const abort = new AbortController();
  const wait = state.adoption.waitForApproval.bind(state.adoption);
  state.adoption.waitForApproval = async () => {
    abort.abort();
    // This is the real SDK's polling-abort error, not a DOM AbortError.
    throw new AuthorityAdoptionError("authority_adoption_cancelled", "Collection adoption was cancelled.");
  };
  await assert.rejects(state.controller.adoptLocalCollection({
    controlUrl: "https://connect.example", mirrorName: "Obsidian",
  }, { ...callbacks, signal: abort.signal }), (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(state.adoption.cancelCalls, 0);
  assert.equal(state.controller.getAdoptionMarker()?.phase, "waiting_for_approval");
  assert.ok(await state.vault.adapter.exists(".mdbase/authority-adoption.json"));
  assert.ok(state.app.secretStorage.getSecret(`mdbase-connect-adoption-${state.adoption.adoptionId}`));
  state.controller.dispose();
  state.adoption.waitForApproval = wait;
  const restarted = new ConnectSyncController(state.app as never, state.settings, {
    adoptionClient: state.adoption as unknown as AuthorityAdoptionClient,
    enrollmentClient: new FakeEnrollment(state.collectionId) as unknown as MirrorEnrollmentClient,
    adoptionBlobStoreFactory: () => new MemoryMirrorBlobStore(),
  });
  await restarted.initialize();
  await restarted.resumeAdoption(callbacks);
  assert.equal(restarted.getAdoptionMarker(), null);
  assert.equal(state.settings.profile?.collectionId, state.collectionId);
});

test("server-side cancellation without a local abort still retires the checkpoint", async () => {
  const state = await fixture();
  state.adoption.waitForApproval = async () => {
    throw new AuthorityAdoptionError("authority_adoption_cancelled", "Cancelled in Connect", 409);
  };
  await assert.rejects(state.controller.adoptLocalCollection({
    controlUrl: "https://connect.example", mirrorName: "Obsidian",
  }, callbacks), /start a new adoption/);
  assert.equal(state.controller.getAdoptionMarker(), null);
  assert.equal(state.adoption.cancelCalls, 1);
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
