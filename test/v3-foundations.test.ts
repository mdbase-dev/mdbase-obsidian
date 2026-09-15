import "fake-indexeddb/auto";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { normalizePath, TFile, TFolder } from "obsidian";
import { MemoryAuthority, SyncError } from "@mdbase-dev/connect-sync";
import type { SyncTransport } from "@mdbase-dev/connect-sync";
import type { CollectionFileDescriptor } from "@mdbase-dev/connect-protocol";
import {
  DirectoryMirror,
  MemoryMirrorBlobStore,
  MemoryMirrorLease,
  MemoryMirrorStateStore,
  WritableDirectoryMirror,
} from "@mdbase-dev/connect-sync/mirror";
import {
  ConnectSyncController,
  DeviceMirrorLease,
  IndexedDbMirrorStateStore,
  ObsidianMirrorFileSystem,
} from "../src/connectSync";
import { MirrorEnrollmentClient } from "@mdbase-dev/connect-sync/enrollment";
import {
  analyzeV02Migration,
  applyV02Migration,
} from "../src/migration";
import {
  frontmatterFromTypeModel,
  typeModelFromDocument,
  validateMdbaseTypeName,
} from "../src/typeModel";
import {
  getTypesForFile,
  schemaFromV03Fields,
  type MdbaseConfig,
  type MdbaseTypeDef,
  parseFrontmatter,
} from "../src/mdbaseCore";

interface StoredFile {
  file: TFile;
  content: string;
}

const TestFile = TFile as unknown as { new (path: string): TFile };
const TestFolder = TFolder as unknown as { new (path: string): TFolder };

function sha256Revision(document: string): string {
  return `sha256:${createHash("sha256").update(document).digest("hex")}`;
}

function fileDescriptor(path: string, bytes: Uint8Array, fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"): CollectionFileDescriptor {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    file_id: fileId,
    path,
    revision: `file:${digest}`,
    content_digest: `sha256:${digest}`,
    size: bytes.byteLength,
    media_class: path.endsWith(".png") ? "image" : "other",
    media_type: path.endsWith(".png") ? "image/png" : "application/octet-stream",
    modified_at: "2026-08-05T00:00:00.000Z",
  };
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class MemoryVault {
  readonly files = new Map<string, StoredFile>();
  readonly binaryFiles = new Map<string, { file: TFile; content: ArrayBuffer }>();
  readonly folders = new Map<string, TFolder>();
  failTargetPath: string | null = null;
  failCreatePath: string | null = null;
  failReadPath: string | null = null;
  corruptTargetPath: string | null = null;
  targetWrites = 0;

  adapter = {
    exists: async (path: string): Promise<boolean> => {
      const normalized = normalizePath(path);
      return this.files.has(normalized) || this.binaryFiles.has(normalized) || this.folders.has(normalized);
    },
    read: async (path: string): Promise<string> => {
      const entry = this.files.get(normalizePath(path));
      if (!entry) throw new Error(`missing ${path}`);
      return entry.content;
    },
    readBinary: async (path: string): Promise<ArrayBuffer> => {
      const normalized = normalizePath(path);
      if (normalized === this.failReadPath) throw new Error(`unreadable ${path}`);
      const text = this.files.get(normalized);
      if (text) return new TextEncoder().encode(text.content).buffer;
      const binary = this.binaryFiles.get(normalized);
      if (binary) return binary.content.slice(0);
      throw new Error(`missing ${path}`);
    },
    write: async (path: string, content: string): Promise<void> => {
      const normalized = normalizePath(path);
      const existing = this.files.get(normalized)?.file ?? new TestFile(normalized);
      this.files.set(normalized, { file: existing, content });
    },
    remove: async (path: string): Promise<void> => {
      const normalized = normalizePath(path);
      this.files.delete(normalized);
      this.binaryFiles.delete(normalized);
    },
    copy: async (source: string, target: string): Promise<void> => {
      const sourcePath = normalizePath(source);
      const targetPath = normalizePath(target);
      const text = this.files.get(sourcePath);
      if (text) {
        const file = new TestFile(targetPath);
        this.files.set(targetPath, { file, content: text.content });
        return;
      }
      const binary = this.binaryFiles.get(sourcePath);
      if (binary) {
        const file = new TestFile(targetPath);
        this.binaryFiles.set(targetPath, { file, content: binary.content.slice(0) });
        return;
      }
      throw new Error(`missing ${source}`);
    },
  };

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    return this.files.get(normalized)?.file ?? this.binaryFiles.get(normalized)?.file ?? this.folders.get(normalized) ?? null;
  }

  getMarkdownFiles(): TFile[] {
    return [
      ...[...this.files.values()].map((entry) => entry.file),
      ...[...this.binaryFiles.values()].map((entry) => entry.file),
    ].filter((file) => file.extension === "md");
  }

  getFiles(): TFile[] {
    return [
      ...[...this.files.values()].map((entry) => entry.file),
      ...[...this.binaryFiles.values()].map((entry) => entry.file),
    ];
  }

  async cachedRead(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing ${file.path}`);
    return entry.content;
  }

  async create(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (normalized === this.failCreatePath) throw new Error("injected adapter create failure");
    if (this.files.has(normalized) || this.folders.has(normalized)) throw new Error(`exists ${normalized}`);
    const file = new TestFile(normalized);
    this.files.set(normalized, { file, content });
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    if (
      file.path === this.failTargetPath
      && (content.includes("kind: mdbase.type") || content.includes('"kind": "mdbase.type"'))
    ) {
      this.targetWrites += 1;
      throw new Error("injected migration target write failure");
    }
    if (
      file.path === this.corruptTargetPath
      && (content.includes("kind: mdbase.type") || content.includes('"kind": "mdbase.type"'))
    ) {
      this.files.set(file.path, { file, content: `${content}# injected corruption\n` });
      return;
    }
    this.files.set(file.path, { file, content });
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const entry = this.binaryFiles.get(file.path);
    if (!entry) throw new Error(`missing binary ${file.path}`);
    return entry.content.slice(0);
  }

  async createBinary(path: string, content: ArrayBuffer): Promise<TFile> {
    const normalized = normalizePath(path);
    if (this.files.has(normalized) || this.binaryFiles.has(normalized) || this.folders.has(normalized)) throw new Error(`exists ${normalized}`);
    const file = new TestFile(normalized);
    this.binaryFiles.set(normalized, { file, content: content.slice(0) });
    return file;
  }

  async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
    this.binaryFiles.set(file.path, { file, content: content.slice(0) });
  }

  async createFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!this.folders.has(normalized)) this.folders.set(normalized, new TestFolder(normalized));
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
    this.binaryFiles.delete(file.path);
  }

  async rename(file: TFile, target: string): Promise<void> {
    const normalized = normalizePath(target);
    if (this.getAbstractFileByPath(normalized)) throw new Error(`exists ${normalized}`);
    const text = this.files.get(file.path);
    const binary = this.binaryFiles.get(file.path);
    if (text) {
      this.files.delete(file.path);
      const renamed = new TestFile(normalized);
      this.files.set(normalized, { file: renamed, content: text.content });
      return;
    }
    if (binary) {
      this.binaryFiles.delete(file.path);
      const renamed = new TestFile(normalized);
      this.binaryFiles.set(normalized, { file: renamed, content: binary.content });
      return;
    }
    throw new Error(`missing ${file.path}`);
  }

  read(path: string): string | null {
    return this.files.get(normalizePath(path))?.content ?? null;
  }

  readBytes(path: string): Uint8Array | null {
    const content = this.binaryFiles.get(normalizePath(path))?.content;
    return content ? new Uint8Array(content.slice(0)) : null;
  }
}

class LaggyFolderMetadataVault extends MemoryVault {
  override getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    if (this.folders.has(normalized)) return null;
    return this.files.get(normalized)?.file ?? null;
  }
}

function v02Config(): string {
  return `${JSON.stringify({
    spec_version: "0.2.0",
    name: "TaskNotes",
    settings: {
      types_folder: "_types",
      default_strict: false,
      exclude: ["_types"],
    },
  }, null, 2)}\n`;
}

function typeDocument(frontmatter: Record<string, unknown>, body = "# Type"): string {
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${body}\n`;
}

function taskType(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "task",
    description: "Task type",
    display_name_key: "title",
    strict: false,
    match: { where: { tags: { contains: "task" } } },
    fields: {
      title: { type: "string", required: true, tn_role: "title" },
      tags: { type: "list", items: { type: "string" }, tn_role: "tags" },
      status: {
        type: "enum",
        values: ["open", "done"],
        default: "open",
        tn_role: "status",
        tn_completed_values: ["done"],
      },
      dateCreated: { type: "datetime", generated: "now", tn_role: "dateCreated" },
      projects: { type: "list", items: { type: "link", target: "project" } },
    },
    ...overrides,
  };
}

async function collectionVault(
  type = taskType(),
  vault: MemoryVault = new MemoryVault(),
): Promise<MemoryVault> {
  await vault.create("mdbase.yaml", v02Config());
  await vault.createFolder("_types");
  await vault.create("_types/task.md", typeDocument(type, "# Task"));
  await vault.create("records/unchanged.md", typeDocument({ tags: ["task"], title: "Keep me" }, "Record body"));
  await vault.create("records/body-only.md", "# Plain Markdown\n");
  return vault;
}

test("v0.2 TaskNotes contains match works before migration", () => {
  const config: MdbaseConfig = {
    spec_version: "0.2.0",
    settings: {
      types_folder: "_types",
      explicit_type_keys: ["type", "types"],
      default_strict: false,
      include_subfolders: true,
      exclude: ["_types"],
    },
  };
  const types = new Map<string, MdbaseTypeDef>([
    ["task", {
      name: "task",
      fields: {},
      filePath: "_types/task.md",
      match: { where: { tags: { contains: "task" } } },
    }],
  ]);
  assert.deepEqual(getTypesForFile("a.md", { tags: ["inbox", "task"] }, config, types), ["task"]);
  assert.deepEqual(getTypesForFile("a.md", { tags: ["inbox"] }, config, types), []);
});

test("migration analysis converts TaskNotes semantics and never proposes record rewrites", async () => {
  const vault = await collectionVault();
  const recordBefore = vault.read("records/unchanged.md");
  const plan = await analyzeV02Migration(vault as never);
  assert.equal(plan.sourceVersion, "0.2.0");
  assert.equal(plan.targetVersion, "0.3.0");
  assert.equal(plan.recordFilesRewritten, 0);
  assert.equal(plan.recordsVerified, 2);
  assert.equal(plan.recordsSkipped, 0);
  assert.deepEqual(plan.operations.map((entry) => entry.path), ["mdbase.yaml", "_types/task.md"]);
  assert.equal(plan.typeSummaries[0].taskNotes, true);
  assert.deepEqual(plan.typeSummaries[0].defaultsMoved, ["status"]);
  assert.deepEqual(plan.typeSummaries[0].generatedFieldsMoved, ["dateCreated"]);
  assert.deepEqual(plan.typeSummaries[0].linksMoved, ["projects[]"]);
  const migrated = parseFrontmatter(plan.operations[1].target).frontmatter;
  assert.equal(migrated.kind, "mdbase.type");
  assert.deepEqual((migrated.match as Record<string, unknown>).where, { tags: { contains: "task" } });
  assert.ok(isObject(migrated["x-tasknotes"]));
  assert.equal(vault.read("records/unchanged.md"), recordBefore);
  assert.equal(vault.read("records/body-only.md"), "# Plain Markdown\n");
});

test("migration applies from verified inputs, writes recovery backups, and leaves records byte-identical", async () => {
  const vault = await collectionVault();
  const recordBefore = vault.read("records/unchanged.md");
  const bodyOnlyBefore = vault.read("records/body-only.md");
  const plan = await analyzeV02Migration(vault as never);
  const result = await applyV02Migration(vault as never, plan);
  assert.equal(result.applied, true);
  assert.match(vault.read("mdbase.yaml") ?? "", /"spec_version": "0.3.0"/);
  assert.match(vault.read("_types/task.md") ?? "", /kind(?:"|):\s*"?(?:mdbase\.type)/);
  assert.equal(vault.read("records/unchanged.md"), recordBefore);
  assert.equal(vault.read("records/body-only.md"), bodyOnlyBefore);
  assert.equal(vault.read(`${plan.backupLocation}/files/mdbase.yaml`), plan.operations[0].source);
  const manifest = JSON.parse(vault.read(result.manifestPath) ?? "{}") as { status?: string; written?: string[] };
  assert.equal(manifest.status, "applied");
  assert.deepEqual(manifest.written, ["mdbase.yaml", "_types/task.md"]);
});

test("migration refuses stale analysis and rolls back injected mid-apply failures", async () => {
  const staleVault = await collectionVault();
  const stalePlan = await analyzeV02Migration(staleVault as never);
  const configFile = staleVault.getAbstractFileByPath("mdbase.yaml") as TFile;
  await staleVault.modify(configFile, `${v02Config()}# external edit\n`);
  await assert.rejects(
    applyV02Migration(staleVault as never, stalePlan),
    /changed after migration analysis/,
  );

  const failingVault = await collectionVault();
  const plan = await analyzeV02Migration(failingVault as never);
  failingVault.failTargetPath = "_types/task.md";
  const result = await applyV02Migration(failingVault as never, plan);
  assert.equal(result.applied, false);
  assert.equal(result.restored, true);
  assert.equal(failingVault.read("mdbase.yaml"), plan.operations[0].source);
  assert.equal(failingVault.read("_types/task.md"), plan.operations[1].source);
  const manifest = JSON.parse(failingVault.read(result.manifestPath) ?? "{}") as { status?: string };
  assert.equal(manifest.status, "rolled_back");

  const corruptingVault = await collectionVault();
  const corruptingPlan = await analyzeV02Migration(corruptingVault as never);
  corruptingVault.corruptTargetPath = "_types/task.md";
  const corruptingResult = await applyV02Migration(corruptingVault as never, corruptingPlan);
  assert.equal(corruptingResult.applied, false);
  assert.equal(corruptingResult.restored, true);
  assert.equal(corruptingVault.read("mdbase.yaml"), corruptingPlan.operations[0].source);
  assert.equal(corruptingVault.read("_types/task.md"), corruptingPlan.operations[1].source);
});

test("migration and mirror tolerate Obsidian folder metadata cache lag", async () => {
  const vault = await collectionVault(taskType(), new LaggyFolderMetadataVault());
  const plan = await analyzeV02Migration(vault as never);
  const result = await applyV02Migration(vault as never, plan);
  assert.equal(result.applied, true);
  assert.equal(JSON.parse(vault.read(result.manifestPath) ?? "{}").status, "applied");

  const mirrorVault = new LaggyFolderMetadataVault();
  const fileSystem = new ObsidianMirrorFileSystem(mirrorVault as never);
  await fileSystem.write("deeply/nested/mobile/note.md", "content");
  assert.equal(await fileSystem.read("deeply/nested/mobile/note.md"), "content");
});

test("lossy v0.2 migrations require explicit reviewed consent", async () => {
  const vault = await collectionVault(taskType({
    extends: "base",
    fields: {
      title: { type: "string", computed: "record.name" },
    },
  }));
  const plan = await analyzeV02Migration(vault as never);
  assert.equal(plan.applicable, false);
  assert.ok(plan.diagnostics.some((entry) => entry.severity === "lossy"));
  await assert.rejects(applyV02Migration(vault as never, plan), /explicitly allow lossy/);
  const applied = await applyV02Migration(vault as never, plan, { allowLossy: true });
  assert.equal(applied.applied, true);
});

test("migration preserves list bounds and unsupported generated strategies", async () => {
  const generated = { strategy: "custom-sequence", prefix: "T-" };
  const vault = await collectionVault(taskType({
    fields: {
      tags: { type: "list", items: { type: "string" }, min_length: 1, max_length: 3 },
      token: { type: "string", generated },
    },
  }));
  const plan = await analyzeV02Migration(vault as never);
  const migrated = parseFrontmatter(plan.operations[1].target).frontmatter;
  const schema = (migrated.schema as { value: Record<string, unknown> }).value;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const legacy = migrated["x-legacy-v0.2"] as { fields: Record<string, unknown> };

  assert.equal(properties.tags.minItems, 1);
  assert.equal(properties.tags.maxItems, 3);
  assert.equal(properties.tags.minLength, undefined);
  assert.equal(properties.tags.maxLength, undefined);
  assert.deepEqual(legacy.fields["token.generated"], generated);
  assert.ok(plan.diagnostics.some((entry) => entry.severity === "lossy" && entry.message.includes("token.generated")));
  assert.equal(plan.applicable, false);
});

test("type model preserves unknown v0.3 extensions and blocks v0.2 writes", () => {
  const frontmatter = {
    kind: "mdbase.type",
    name: "note",
    version: 4,
    schema: {
      dialect: "json-schema-2020-12",
      "x-schema-note": "preserve",
      value: {
        type: "object",
        oneOf: [{ required: ["title"] }],
        properties: {
          title: { type: "string", "x-field": "preserve" },
        },
      },
    },
    collection: {
      display: { name_field: "title", "x-display": "preserve" },
      "x-placement": true,
    },
    match: {
      path_glob: "Notes/**/*.md",
      expr: { $expr: "record.published == true" },
    },
    lifecycle: { on_create: { set: { id: { uuid: true } } } },
    "x-plugin": { enabled: true },
  };
  const model = typeModelFromDocument(frontmatter, "# Note", "note");
  model.description = "Edited";
  model.fields[0].definition.description = "Visible field description";
  const output = frontmatterFromTypeModel(model);
  assert.deepEqual(output["x-plugin"], { enabled: true });
  assert.deepEqual(output.lifecycle, frontmatter.lifecycle);
  assert.equal(((output.schema as Record<string, unknown>)["x-schema-note"]), "preserve");
  const schema = (output.schema as { value: Record<string, unknown> }).value;
  assert.deepEqual(schema.oneOf, [{ required: ["title"] }]);
  assert.equal(((schema.properties as Record<string, Record<string, unknown>>).title)["x-field"], "preserve");
  assert.equal(
    ((schema.properties as Record<string, Record<string, unknown>>).title).description,
    "Visible field description",
  );
  assert.equal((output.collection as Record<string, unknown>)["x-placement"], true);
  assert.equal(
    ((output.collection as Record<string, Record<string, unknown>>).display)["x-display"],
    "preserve",
  );
  assert.deepEqual((output.match as Record<string, unknown>).expr, { $expr: "record.published == true" });

  const legacy = typeModelFromDocument(taskType(), "# Task", "task");
  assert.throws(() => frontmatterFromTypeModel(legacy), /read-only/);
});

test("type editing protects schema references, v0.3 names, and required-field removal", () => {
  const referenced = typeModelFromDocument({
    kind: "mdbase.type",
    name: "external",
    schema: {
      dialect: "json-schema-2020-12",
      ref: "../schemas/external.schema.json",
    },
  }, "# External", "external");
  assert.equal(referenced.fields.length, 0);
  assert.match(referenced.readOnlyReason ?? "", /schema\.ref/);
  assert.throws(() => frontmatterFromTypeModel(referenced), /referenced JSON Schema/);

  assert.equal(validateMdbaseTypeName("work-item_2"), "work-item_2");
  assert.throws(() => validateMdbaseTypeName("../escape"), /start with a letter|only letters/);
  assert.throws(() => validateMdbaseTypeName("file"), /reserved/);
  assert.throws(() => validateMdbaseTypeName(`a${"b".repeat(63)}`), /shorter than 64/);

  const schema = schemaFromV03Fields(
    { title: { type: "string", required: false } },
    {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  );
  assert.equal("required" in schema, false);
});

test("type model edits recursive lists, objects, and nested links without flattening schema", () => {
  const frontmatter = {
    kind: "mdbase.type",
    name: "catalog",
    version: 1,
    schema: {
      dialect: "json-schema-2020-12",
      value: {
        type: "object",
        properties: {
          matrix: {
            type: "array",
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["owner"],
                properties: {
                  owner: { type: "string", "x-field": "preserve" },
                },
              },
            },
          },
        },
      },
    },
    collection: {
      links: {
        "matrix[][].owner": {
          target_type: "person",
          validate_exists: true,
          "x-link": "preserve",
        },
      },
    },
  };
  const model = typeModelFromDocument(frontmatter, "# Catalog", "catalog");
  const matrix = model.fields[0].definition;
  const firstItems = matrix.items as Record<string, unknown>;
  const secondItems = firstItems.items as Record<string, unknown>;
  const objectFields = secondItems.fields as Record<string, Record<string, unknown>>;
  assert.equal(matrix.type, "list");
  assert.equal(firstItems.type, "list");
  assert.equal(secondItems.type, "object");
  assert.equal(objectFields.owner.type, "link");
  assert.equal(objectFields.owner.target, "person");
  objectFields.details = {
    type: "object",
    required: true,
    fields: {
      labels: {
        type: "list",
        items: {
          type: "object",
          fields: {
            value: { type: "string", required: true },
          },
        },
      },
    },
  };

  const output = frontmatterFromTypeModel(model);
  const schema = (output.schema as { value: Record<string, unknown> }).value;
  const matrixSchema = (schema.properties as Record<string, Record<string, unknown>>).matrix;
  const innerObject = ((matrixSchema.items as Record<string, unknown>).items as Record<string, unknown>);
  const innerProperties = innerObject.properties as Record<string, Record<string, unknown>>;
  assert.equal(matrixSchema.type, "array");
  assert.equal((matrixSchema.items as Record<string, unknown>).type, "array");
  assert.equal(innerObject.type, "object");
  assert.equal(innerObject.additionalProperties, false);
  assert.deepEqual(innerObject.required, ["owner", "details"]);
  assert.equal(innerProperties.owner.type, "string");
  assert.equal(innerProperties.owner["x-field"], "preserve");
  const labels = ((innerProperties.details.properties as Record<string, Record<string, unknown>>).labels);
  assert.equal(labels.type, "array");
  assert.equal((labels.items as Record<string, unknown>).type, "object");
  assert.deepEqual((labels.items as Record<string, unknown>).required, ["value"]);
  const link = ((output.collection as Record<string, unknown>).links as Record<string, Record<string, unknown>>)["matrix[][].owner"];
  assert.equal(link.target_type, "person");
  assert.equal(link.validate_exists, true);
  assert.equal(link["x-link"], "preserve");

  const collapsedModel = typeModelFromDocument(frontmatter, "# Catalog", "catalog");
  const collapsedMatrix = collapsedModel.fields[0].definition;
  const collapsedFirstItems = collapsedMatrix.items as Record<string, unknown>;
  const collapsedInner = collapsedFirstItems.items as Record<string, unknown>;
  collapsedInner.type = "string";
  const collapsedOutput = frontmatterFromTypeModel(collapsedModel);
  const collapsedSchema = (collapsedOutput.schema as { value: Record<string, unknown> }).value;
  const collapsedMatrixSchema = (collapsedSchema.properties as Record<string, Record<string, unknown>>).matrix;
  const collapsedInnerSchema = ((collapsedMatrixSchema.items as Record<string, unknown>).items as Record<string, unknown>);
  assert.equal(collapsedInnerSchema.type, "string");
  for (const staleKeyword of ["properties", "required", "additionalProperties", "items"]) {
    assert.equal(staleKeyword in collapsedInnerSchema, false);
  }
  assert.equal(
    collapsedOutput.collection === undefined
      || !("links" in (collapsedOutput.collection as Record<string, unknown>)),
    true,
  );

  objectFields.owner.type = "string";
  const withoutLink = frontmatterFromTypeModel(model);
  assert.equal(
    withoutLink.collection === undefined
      || !("links" in (withoutLink.collection as Record<string, unknown>)),
    true,
  );
});

test("Obsidian mirror adapter rejects traversal and reserved paths", async () => {
  const vault = new MemoryVault();
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await assert.rejects(fs.write("../escape.md", "x"), /escapes the collection root/);
  await assert.rejects(fs.write(".obsidian/plugins/evil.js", "x"), /reserved path/);
  await assert.rejects(fs.write(".mdbase/connect-role.json", "x"), /reserved path/);
  await fs.write("notes/ok.md", "hello");
  assert.equal(await fs.read("notes/ok.md"), "hello");
  await fs.remove("notes/ok.md");
  assert.equal(await fs.read("notes/ok.md"), null);
});

test("Obsidian mirror adapter classifies text bytes, missing files, and read failures", async () => {
  const vault = new MemoryVault();
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await vault.create("notes/valid.md", "---\ntitle: Café\n---\n");
  assert.equal(await fs.readText("notes/valid.md"), "---\ntitle: Café\n---\n");
  assert.equal(await fs.readText("notes/missing.md"), null);

  const invalidBytes = Uint8Array.of(0x66, 0x80, 0x6f);
  await vault.createBinary("notes/invalid.md", invalidBytes.buffer);
  assert.deepEqual(await fs.readText("notes/invalid.md"), {
    kind: "invalid",
    code: "invalid_utf8",
    reason: "File is not valid UTF-8.",
    revision: `sha256:${createHash("sha256").update(invalidBytes).digest("hex")}`,
  });
  await assert.rejects(
    fs.read("notes/invalid.md"),
    (error: unknown) => error instanceof SyncError && error.code === "invalid_utf8",
  );

  vault.failReadPath = "notes/valid.md";
  await assert.rejects(
    fs.readText("notes/valid.md"),
    (error: unknown) => error instanceof SyncError && error.code === "file_read_failed",
  );
});

test("Connect enrollment keeps credentials out of plugin data and refuses local-authority vaults", async () => {
  const pairingId = "11111111-1111-4111-8111-111111111111";
  const collectionId = "22222222-2222-4222-8222-222222222222";
  const replicaId = "33333333-3333-4333-8333-333333333333";
  let requests = 0;
  const pairingCollectionIds: unknown[] = [];
  const client = new MirrorEnrollmentClient({
    request: async (request) => {
      requests += 1;
      if (request.url.endsWith("/v1/mirror-pairing-requests")) {
        pairingCollectionIds.push((request.body as Record<string, unknown>).collection_id);
        return {
          status: 201,
          body: {
            pairing_id: pairingId,
            pairing_secret: "refresh-secret-with-sufficient-entropy-123",
            verification_uri: `https://connect.example/mirror/${pairingId}`,
            expires_in: 60,
          },
        };
      }
      return {
        status: 200,
        body: {
          status: "paired",
          replica: {
            id: replicaId,
            collection_id: collectionId,
            name: "Obsidian mobile",
            mode: "read_write",
          },
          token: "access-token-with-sufficient-entropy-456",
          token_expires_at: "2099-01-01T00:00:00.000Z",
          sync_url: `https://sync.example/v1/authorities/${collectionId}/sync`,
        },
      };
    },
  });
  const secrets = new Map<string, string>();
  const vault = new MemoryVault();
  let storedProfile: import("../src/connectSync").MirrorProfile | null = null;
  const controller = new ConnectSyncController({
    vault,
    secretStorage: {
      setSecret: (id: string, value: string) => void secrets.set(id, value),
      getSecret: (id: string) => secrets.get(id) ?? null,
      listSecrets: () => [...secrets.keys()],
    },
  } as never, {
    getMirrorProfile: () => storedProfile,
    saveMirrorProfile: async (profile) => {
      storedProfile = profile;
    },
  }, { enrollmentClient: client });
  await controller.initialize();
  let verification = "";
  const profile = await controller.enroll({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian mobile",
    mode: "read_write",
    collectionId,
  }, {
    onVerification: (value) => {
      verification = value.verificationUri;
    },
  });
  assert.equal(verification, `https://connect.example/mirror/${pairingId}`);
  assert.equal(profile.collectionId, collectionId);
  assert.equal(JSON.stringify(storedProfile).includes("access-token"), false);
  assert.equal(JSON.stringify(storedProfile).includes("refresh-secret"), false);
  assert.equal(secrets.size, 2);
  assert.deepEqual(JSON.parse(vault.read(".mdbase/connect-role.json") ?? "{}"), {
    version: 1,
    role: "mirror",
    collection_id: collectionId,
  });

  const localVault = new MemoryVault();
  await localVault.create(
    "mdbase.yaml",
    `${JSON.stringify({
      spec_version: "0.3.0",
      "x-mdbase-connect": { collection_id: collectionId },
    }, null, 2)}\n`,
  );
  const localController = new ConnectSyncController({
    vault: localVault,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => null,
    saveMirrorProfile: async () => undefined,
  }, { enrollmentClient: client });
  await localController.initialize();
  const beforeRefusal = requests;
  await assert.rejects(
    localController.enroll({
      controlUrl: "https://connect.example",
      mirrorName: "Unsafe",
      mode: "read_only",
    }, { onVerification: () => undefined }),
    /Transfer authority explicitly/,
  );
  assert.equal(requests, beforeRefusal);

  const transferredVault = new MemoryVault();
  await transferredVault.create(
    "mdbase.yaml",
    `${JSON.stringify({
      spec_version: "0.3.0",
      "x-mdbase-connect": { collection_id: collectionId },
    }, null, 2)}\n`,
  );
  await transferredVault.createFolder(".mdbase");
  await transferredVault.create(".mdbase/connect-role.json", `${JSON.stringify({
    version: 1,
    role: "mirror",
    collection_id: collectionId,
  })}\n`);
  let transferredProfile: import("../src/connectSync").MirrorProfile | null = null;
  const transferredController = new ConnectSyncController({
    vault: transferredVault,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => transferredProfile,
    saveMirrorProfile: async (profile) => {
      transferredProfile = profile;
    },
  }, { enrollmentClient: client });
  await transferredController.initialize();
  const transferred = await transferredController.enroll({
    controlUrl: "https://connect.example",
    mirrorName: "Obsidian mobile",
    mode: "read_write",
  }, { onVerification: () => undefined });
  assert.equal(transferred.collectionId, collectionId);
  assert.equal(transferred.syncUrl, `https://sync.example/v1/authorities/${collectionId}/sync`);
  assert.deepEqual(pairingCollectionIds, [collectionId, collectionId]);

  const existingCollection = new MemoryVault();
  await existingCollection.create("mdbase.yaml", v02Config());
  const existingController = new ConnectSyncController({
    vault: existingCollection,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => null,
    saveMirrorProfile: async () => undefined,
  }, { enrollmentClient: client });
  await existingController.initialize();
  const beforeExistingRefusal = requests;
  await assert.rejects(
    existingController.enroll({
      controlUrl: "https://connect.example",
      mirrorName: "Existing",
      mode: "read_only",
    }, { onVerification: () => undefined }),
    /already contains an mdbase collection/,
  );
  assert.equal(requests, beforeExistingRefusal);
});

test("failed enrollment persistence removes its temporary mirror-role marker", async () => {
  const collectionId = "22222222-2222-4222-8222-222222222222";
  const enrollmentClient = {
    enroll: async () => ({
      controlUrl: "https://connect.example",
      syncUrl: `https://sync.example/v1/authorities/${collectionId}/sync`,
      collectionId,
      replicaId: "33333333-3333-4333-8333-333333333333",
      mode: "read_write" as const,
      name: "Retryable",
      enrollmentId: "11111111-1111-4111-8111-111111111111",
      accessToken: "access-token",
      refreshCredential: "refresh-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    renew: async () => {
      throw new Error("not used");
    },
  };
  const vault = new MemoryVault();
  const controller = new ConnectSyncController({
    vault,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => null,
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => null,
    saveMirrorProfile: async () => {
      throw new Error("injected settings failure");
    },
  }, { enrollmentClient: enrollmentClient as never });
  await controller.initialize();
  await assert.rejects(
    controller.enroll({
      controlUrl: "https://connect.example",
      mirrorName: "Retryable",
      mode: "read_write",
    }, { onVerification: () => undefined }),
    /injected settings failure/,
  );
  assert.equal(vault.read(".mdbase/connect-role.json"), null);
});

test("device lease rejects concurrent mirror ownership and releases after failure", async () => {
  const lease = new DeviceMirrorLease("vault:collection");
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = lease.runExclusive(async () => blocker);
  await assert.rejects(
    lease.runExclusive(async () => undefined),
    /already running/,
  );
  release();
  await first;
  await assert.rejects(
    lease.runExclusive(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  await lease.runExclusive(async () => undefined);
});

test("beta.91 fences invalid or unreadable local Markdown and every valid sibling until repair", async () => {
  const invalidCases: Array<[string, string | Uint8Array]> = [
    ["broken.md", "---\nbroken: [\n---\nBody"],
    ["duplicate.md", "---\na: 1\na: 2\n---\nBody"],
    ["scalar.md", "---\nhello\n---\nBody"],
    ["null.md", "---\nnull\n---\nBody"],
    ["list.md", "---\n- one\n- two\n---\nBody"],
    ["bytes.md", Uint8Array.of(0x62, 0x61, 0x64, 0xff)],
  ];
  for (const [path, invalid] of invalidCases) {
    const hosted = new MemoryAuthority();
    const replica = hosted.registerReplica({ name: "Obsidian writer", mode: "read_write" });
    const vault = new MemoryVault();
    if (typeof invalid === "string") await vault.create(path, invalid);
    else await vault.createBinary(path, Uint8Array.from(invalid).buffer);
    await vault.create("valid.md", "# Valid sibling");
    const mirror = new WritableDirectoryMirror(replica, hosted.transport(replica), {
      fileSystem: new ObsidianMirrorFileSystem(vault as never),
      stateStore: new MemoryMirrorStateStore(),
    });

    const blocked = await mirror.inspect();
    assert.deepEqual(blocked.actions, []);
    assert.ok(blocked.issues.some((issue) =>
      issue.code === "invalid_frontmatter" && issue.path === path && issue.blocking));
    assert.deepEqual((await mirror.status()).local_issues.map((issue) => [issue.code, issue.path]), [
      ["invalid_frontmatter", path],
    ]);
    let snapshot = await hosted.transport(replica).snapshot((await hosted.transport(replica).openSession()).snapshot_id);
    assert.deepEqual(snapshot.records, []);

    const invalidFile = vault.getAbstractFileByPath(path);
    assert.ok(invalidFile instanceof TFile);
    if (typeof invalid === "string") await vault.modify(invalidFile, "# Fixed local note");
    else {
      await vault.delete(invalidFile);
      await vault.create(path, "# Fixed local note");
    }
    await mirror.sync();
    snapshot = await hosted.transport(replica).snapshot((await hosted.transport(replica).openSession()).snapshot_id);
    assert.deepEqual(snapshot.records.map((record) => record.path).sort(), [path, "valid.md"].sort());
    await mirror.sync();
    assert.deepEqual((await mirror.status()).local_issues, []);
  }

  const hosted = new MemoryAuthority();
  const replica = hosted.registerReplica({ name: "Unreadable Obsidian writer", mode: "read_write" });
  const vault = new MemoryVault();
  await vault.create("unreadable.md", "# Cannot read this now");
  await vault.create("valid.md", "# Also fenced");
  vault.failReadPath = "unreadable.md";
  const mirror = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new MemoryMirrorStateStore(),
  });
  const blocked = await mirror.inspect();
  assert.deepEqual(blocked.actions, []);
  assert.ok(blocked.issues.some((issue) =>
    issue.code === "file_read_failed" && issue.path === "unreadable.md" && issue.blocking));
  assert.deepEqual((await mirror.status()).local_issues.map((issue) => [issue.code, issue.path]), [
    ["file_read_failed", "unreadable.md"],
  ]);

  vault.failReadPath = null;
  await mirror.sync();
  const snapshot = await hosted.transport(replica).snapshot((await hosted.transport(replica).openSession()).snapshot_id);
  assert.deepEqual(snapshot.records.map((record) => record.path).sort(), ["unreadable.md", "valid.md"]);
  await mirror.sync();
  assert.deepEqual((await mirror.status()).local_issues, []);
});

test("portable mirror materializes resources and records through Obsidian Vault APIs", async () => {
  const configuration = "spec_version: 0.3.0\n";
  const noteType = "---\nkind: mdbase.type\n---\n";
  const hosted = new MemoryAuthority({
    snapshotPageSize: 1,
    resources: {
      revision: "resources-1",
      spec_version: "0.3.0",
      types: [],
      contracts: [],
      documents: [
        { path: "mdbase.yaml", kind: "configuration", revision: sha256Revision(configuration), document: configuration },
        { path: "_types/note.md", kind: "type", revision: sha256Revision(noteType), document: noteType },
      ],
    },
  });
  hosted.seed([
    {
      record_id: "one",
      path: "notes/one.md",
      frontmatter: { type: "note", title: "One" },
      body: "First",
      types: ["note"],
    },
    {
      record_id: "two",
      path: "notes/two.md",
      frontmatter: { type: "note", title: "Two" },
      body: "Second",
      types: ["note"],
    },
  ]);
  const replica = hosted.registerReplica({ name: "Obsidian mobile", mode: "read_only" });
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  const mirror = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
    lease: new MemoryMirrorLease(),
  });
  const preview = await mirror.previewInitialization();
  assert.equal(preview.download_documents, 4);
  assert.equal(preview.collisions.length, 0);
  await mirror.sync();
  assert.match(vault.read("notes/one.md") ?? "", /title: One/);
  assert.equal(vault.read("mdbase.yaml"), "spec_version: 0.3.0\n");
  assert.match(vault.read("_types/note.md") ?? "", /mdbase\.type/);
  assert.equal((await mirror.status()).state, "up_to_date");
});

test("Obsidian binary adapter preserves exact bytes and excludes unsafe collection paths", async () => {
  const vault = new MemoryVault();
  const adapter = new ObsidianMirrorFileSystem(vault as never);
  const bytes = Uint8Array.from({ length: 1024 * 1024 + 37 }, (_, index) => index % 251);
  await adapter.writeBinary("Attachments/exact.png", (async function* () {
    yield bytes.subarray(0, 19);
    yield new Uint8Array();
    yield bytes.subarray(19);
  })());
  assert.deepEqual(vault.readBytes("Attachments/exact.png"), bytes);
  const source = await adapter.readBinary("Attachments/exact.png");
  assert.ok(source);
  assert.deepEqual(await collectBytes(source), bytes);
  assert.deepEqual(await adapter.inspectBinary("Attachments/exact.png"), {
    size: bytes.byteLength,
    content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  assert.equal(await adapter.exists("Attachments/exact.png"), true);
  assert.equal(await adapter.exists("Attachments/missing.png"), false);
  await adapter.move("Attachments/exact.png", "Archive/renamed.png");
  assert.equal(await adapter.exists("Attachments/exact.png"), false);
  assert.deepEqual(vault.readBytes("Archive/renamed.png"), bytes);
  await assert.rejects(adapter.move("Archive/renamed.png", ".obsidian/unsafe.png"), /reserved|unsafe/i);

  await vault.createBinary(".obsidian/private.png", Uint8Array.of(1).buffer);
  await vault.createBinary("Attachments/ignored.md", Uint8Array.of(2).buffer);
  assert.deepEqual(await adapter.listBinary(new Set()), ["Archive/renamed.png"]);
  await assert.rejects(adapter.writeBinary("../escape.png", (async function* () { yield bytes; })()), /safe relative|invalid|path/i);
  await assert.rejects(adapter.writeBinary("CON.png", (async function* () { yield bytes; })()), /reserved|non-portable/i);
});

test("portable mirror downloads digest-verified binary files into the vault", async () => {
  const hosted = new MemoryAuthority();
  const replica = hosted.registerReplica({ name: "Binary reader", mode: "read_only" });
  const base = hosted.transport(replica);
  const bytes = Uint8Array.from([0, 255, 17, 42, 0, 128]);
  const file = fileDescriptor("Attachments/pixel.png", bytes);
  const transport: SyncTransport = {
    ...base,
    fileSnapshot: async (snapshotId, page) => ({
      ...await base.fileSnapshot(snapshotId, page),
      files: [file],
    }),
    downloadFile: async function* () {
      yield bytes.subarray(0, 2);
      yield bytes.subarray(2);
    },
  };
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  const mirror = new DirectoryMirror(replica, transport, {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
    blobStore: new MemoryMirrorBlobStore(),
    selectiveSync: { file_classes: ["image"], excluded_folders: [] },
  });
  const preview = await mirror.previewInitialization();
  assert.equal(preview.download_files, 1);
  await mirror.sync();
  assert.deepEqual(vault.readBytes(file.path), bytes);
  assert.equal((await mirror.status()).state, "up_to_date");
  assert.equal((await state.read())?.files?.[file.file_id]?.file.content_digest, file.content_digest);
});

test("binary integrity failure leaves both the vault and mirror checkpoint untouched", async () => {
  const hosted = new MemoryAuthority();
  const replica = hosted.registerReplica({ name: "Corrupt binary", mode: "read_only" });
  const base = hosted.transport(replica);
  const expected = Uint8Array.of(1, 2, 3, 4);
  const file = fileDescriptor("Media/corrupt.png", expected);
  const transport: SyncTransport = {
    ...base,
    fileSnapshot: async (snapshotId, page) => ({
      ...await base.fileSnapshot(snapshotId, page),
      files: [file],
    }),
    downloadFile: async function* () { yield Uint8Array.of(1, 2, 3, 5); },
  };
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  const mirror = new DirectoryMirror(replica, transport, {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
    blobStore: new MemoryMirrorBlobStore(),
    selectiveSync: { file_classes: ["image"], excluded_folders: [] },
  });
  await assert.rejects(mirror.sync(), /integrity|digest|verification/i);
  assert.equal(vault.readBytes(file.path), null);
  assert.equal(await state.read(), null);
});

test("portable mirror uploads new local binary files with exact bytes", async () => {
  const hosted = new MemoryAuthority();
  const replica = hosted.registerReplica({ name: "Binary writer", mode: "read_write" });
  const base = hosted.transport(replica);
  const bytes = Uint8Array.from([3, 1, 4, 1, 5, 9, 0, 255]);
  let uploaded: Uint8Array | null = null;
  let hostedFile: CollectionFileDescriptor | null = null;
  const transport: SyncTransport = {
    ...base,
    fileSnapshot: async (snapshotId, page) => ({
      ...await base.fileSnapshot(snapshotId, page),
      files: hostedFile ? [hostedFile] : [],
    }),
    downloadFile: async function* () {
      if (!hostedFile || !uploaded) throw new Error("missing hosted file");
      yield uploaded;
    },
    uploadFile: async (request, source) => {
      uploaded = await collectBytes(source);
      hostedFile = {
        ...fileDescriptor(request.path, uploaded, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        content_digest: request.content_digest,
        size: request.size,
        ...(request.media_type ? { media_type: request.media_type } : {}),
      };
      return {
        protocol_version: 1,
        type: "file_upload_committed",
        transfer_id: request.transfer_id,
        file: hostedFile,
      };
    },
  };
  const vault = new MemoryVault();
  await vault.createFolder("Media");
  await vault.createBinary("Media/local.png", bytes.buffer);
  const mirror = new WritableDirectoryMirror(replica, transport, {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new MemoryMirrorStateStore(),
    blobStore: new MemoryMirrorBlobStore(),
    selectiveSync: { file_classes: ["image"], excluded_folders: [] },
  });
  const preview = await mirror.previewInitialization();
  assert.equal(preview.upload_files, 1);
  await mirror.sync();
  assert.deepEqual(uploaded, bytes);
  assert.equal((hostedFile as CollectionFileDescriptor | null)?.path, "Media/local.png");
});

test("Connect controller previews the exact first transfer and later local edits", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{
    record_id: "one",
    path: "notes/one.md",
    frontmatter: { type: "note", title: "One" },
    body: "First",
    types: ["note"],
  }]);
  const replicaId = hosted.registerReplica({ name: "Review ledger", mode: "read_write" });
  const session = await hosted.transport(replicaId).openSession();
  const vault = new MemoryVault();
  await vault.createFolder(".mdbase");
  await vault.create(".mdbase/connect-role.json", `${JSON.stringify({
    version: 1,
    role: "mirror",
    collection_id: session.collection_id,
  })}\n`);
  const state = new MemoryMirrorStateStore();
  const profile: import("../src/connectSync").MirrorProfile = {
    version: 1,
    syncUrl: `https://sync.example/v1/authorities/${session.collection_id}/sync`,
    controlUrl: "https://connect.example",
    collectionId: session.collection_id,
    replicaId,
    mode: "read_write",
    name: "Review ledger",
    enrollmentId: "11111111-1111-4111-8111-111111111111",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  const controller = new ConnectSyncController({
    vault,
    secretStorage: {
      setSecret: () => undefined,
      getSecret: () => "access-token",
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => profile,
    saveMirrorProfile: async () => undefined,
  }, {
    stateStoreFactory: () => state,
    blobStoreFactory: () => new MemoryMirrorBlobStore(),
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    transportFactory: () => hosted.transport(replicaId),
  });

  await controller.initialize();
  const [concurrentStatus, duplicateStatus, concurrentPreview] = await Promise.all([
    controller.status(),
    controller.status(),
    controller.preview(),
  ]);
  assert.equal(concurrentStatus?.state, "not_initialized");
  assert.equal(duplicateStatus?.state, "not_initialized");
  assert.equal(concurrentPreview.phase, "initial");

  const first = await controller.preview();
  assert.equal(first.phase, "initial");
  assert.deepEqual(first.entries.map((entry) => [entry.direction, entry.action, entry.path]), [
    ["download", "create", "notes/one.md"],
  ]);
  await controller.sync(first);
  const local = vault.getAbstractFileByPath("notes/one.md") as TFile;
  await vault.modify(local, (vault.read(local.path) ?? "").replace("First", "Edited locally"));
  const incremental = await controller.preview();
  assert.equal(incremental.phase, "incremental");
  assert.deepEqual(incremental.entries.map((entry) => [entry.direction, entry.action, entry.path]), [
    ["upload", "update", "notes/one.md"],
  ]);
});

test("disconnect removes only checkpoint-exact files and preserves local changes", async () => {
  let failProfileSave = false;
  const hosted = new MemoryAuthority();
  hosted.seed([
    { record_id: "exact", path: "notes/exact.md", frontmatter: { title: "Exact" }, body: "Hosted exact", types: [] },
    { record_id: "changed", path: "notes/changed.md", frontmatter: { title: "Changed" }, body: "Hosted original", types: [] },
  ]);
  const replicaId = hosted.registerReplica({ name: "Disposable", mode: "read_write" });
  const session = await hosted.transport(replicaId).openSession();
  const vault = new MemoryVault();
  await vault.createFolder(".mdbase");
  await vault.create(".mdbase/connect-role.json", `${JSON.stringify({
    version: 1,
    role: "mirror",
    collection_id: session.collection_id,
  })}\n`);
  const state = new MemoryMirrorStateStore();
  let profile: import("../src/connectSync").MirrorProfile | null = {
    version: 1,
    syncUrl: `https://sync.example/v1/authorities/${session.collection_id}/sync`,
    controlUrl: "https://connect.example",
    collectionId: session.collection_id,
    replicaId,
    mode: "read_write",
    name: "Disposable",
    enrollmentId: "11111111-1111-4111-8111-111111111111",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  const secrets = new Map<string, string>();
  const controller = new ConnectSyncController({
    vault,
    secretStorage: {
      setSecret: (key: string, value: string) => { secrets.set(key, value); },
      getSecret: () => "access-token",
      listSecrets: () => [],
    },
  } as never, {
    getMirrorProfile: () => profile,
    saveMirrorProfile: async (next) => {
      if (failProfileSave) throw new Error("injected profile save failure");
      profile = next;
    },
  }, {
    stateStoreFactory: () => state,
    blobStoreFactory: () => new MemoryMirrorBlobStore(),
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    transportFactory: () => hosted.transport(replicaId),
  });
  await controller.initialize();
  const initial = await controller.preview();
  await controller.sync(initial);
  failProfileSave = true;
  await assert.rejects(controller.disconnect(true), /injected profile save failure/);
  assert.ok(vault.read("notes/exact.md"));
  assert.ok(vault.read("notes/changed.md"));
  assert.ok(vault.read(".mdbase/connect-role.json"));
  assert.ok(profile);
  failProfileSave = false;
  const changed = vault.getAbstractFileByPath("notes/changed.md") as TFile;
  await vault.modify(changed, `${vault.read(changed.path)}Local edit after checkpoint\n`);

  const result = await controller.disconnect(true);

  assert.deepEqual(result.removed, ["notes/exact.md"]);
  assert.deepEqual(result.preserved, ["notes/changed.md"]);
  assert.equal(vault.read("notes/exact.md"), null);
  assert.match(vault.read("notes/changed.md") ?? "", /Local edit after checkpoint/);
  assert.equal(vault.read(".mdbase/connect-role.json"), null);
  assert.equal(profile, null);
  assert.ok([...secrets.values()].every((value) => value === ""));
});

test("conflict copy uses a collision-safe sibling without changing the original", async () => {
  const vault = new MemoryVault();
  await vault.createFolder("notes");
  await vault.create("notes/conflict.md", "local version\n");
  await vault.create("notes/conflict (local conflict copy).md", "older copy\n");
  const profile = {
    version: 1 as const,
    syncUrl: "https://sync.example/v1/authorities/collection/sync",
    controlUrl: "https://connect.example",
    collectionId: "collection",
    replicaId: "replica",
    mode: "read_write" as const,
    name: "Conflict",
    enrollmentId: "enrollment",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  const controller = new ConnectSyncController({
    vault,
    secretStorage: { setSecret: () => undefined, getSecret: () => "token", listSecrets: () => [] },
  } as never, {
    getMirrorProfile: () => profile,
    saveMirrorProfile: async () => undefined,
  }, { fileSystem: new ObsidianMirrorFileSystem(vault as never) });

  // Copying is local, but controller initialization still verifies mirror authority.
  await vault.createFolder(".mdbase");
  profile.collectionId = "22222222-2222-4222-8222-222222222222";
  await vault.create(".mdbase/connect-role.json", JSON.stringify({ version: 1, role: "mirror", collection_id: profile.collectionId }));
  await controller.initialize();
  const copied = await controller.preserveConflictCopy("notes/conflict.md");

  assert.equal(copied, "notes/conflict (local conflict copy 2).md");
  assert.equal(vault.read(copied), "local version\n");
  assert.equal(vault.read("notes/conflict.md"), "local version\n");
});

test("writable mirror uploads local edits and collision preflight makes no writes", async () => {
  const hosted = new MemoryAuthority();
  hosted.seed([{
    record_id: "one",
    path: "notes/one.md",
    frontmatter: { type: "note", title: "One" },
    body: "First",
    types: ["note"],
  }]);
  const replica = hosted.registerReplica({ name: "Obsidian", mode: "read_write" });
  const vault = new MemoryVault();
  const state = new MemoryMirrorStateStore();
  const mirror = new WritableDirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
  });
  await mirror.sync();
  const file = vault.getAbstractFileByPath("notes/one.md") as TFile;
  await vault.modify(file, (vault.read(file.path) ?? "").replace("First", "Edited locally"));
  await mirror.sync();
  await vault.createFolder("Canvas Bases");
  await vault.create("Canvas Bases/Start Here.md", "# Start here\n\nNo metadata required.\n");
  await mirror.sync();
  await mirror.sync();
  const session = await hosted.transport(replica).openSession();
  const snapshot = await hosted.transport(replica).snapshot(session.snapshot_id);
  assert.equal(snapshot.records.find((record) => record.path === "notes/one.md")?.body.trim(), "Edited locally");
  const bodyOnlyRecord = snapshot.records.find((record) => record.path === "Canvas Bases/Start Here.md");
  assert.ok(bodyOnlyRecord);
  assert.deepEqual(bodyOnlyRecord.frontmatter, {});
  assert.equal(bodyOnlyRecord.body, "# Start here\n\nNo metadata required.\n");
  assert.deepEqual(bodyOnlyRecord.types, []);
  assert.equal(vault.read("Canvas Bases/Start Here.md"), "# Start here\n\nNo metadata required.\n");

  const collisionVault = new MemoryVault();
  await collisionVault.create("notes/one.md", "unmanaged bytes");
  const collisionState = new MemoryMirrorStateStore();
  const collisionReplica = hosted.registerReplica({ name: "Collision actual", mode: "read_only" });
  const checkedMirror = new DirectoryMirror(collisionReplica, hosted.transport(collisionReplica), {
    fileSystem: new ObsidianMirrorFileSystem(collisionVault as never),
    stateStore: collisionState,
  });
  const collision = await checkedMirror.sync();
  assert.equal(collision.status, "attention");
  assert.deepEqual(collision.issues.map((issue) => [issue.code, issue.path, issue.blocking]), [
    ["local_collision", "notes/one.md", true],
  ]);
  assert.equal(collisionVault.read("notes/one.md"), "unmanaged bytes");
  assert.equal(await collisionState.read(), null);
});

test("interrupted mirror write resumes its IndexedDB checkpoint after adapter recreation", async () => {
  const hosted = new MemoryAuthority({ snapshotPageSize: 1 });
  hosted.seed([
    {
      record_id: "one",
      path: "notes/one.md",
      frontmatter: { type: "note", title: "One" },
      body: "One",
      types: ["note"],
    },
    {
      record_id: "two",
      path: "notes/two.md",
      frontmatter: { type: "note", title: "Two" },
      body: "Two",
      types: ["note"],
    },
  ]);
  const replica = hosted.registerReplica({ name: "Fault injection", mode: "read_only" });
  const vault = new MemoryVault();
  vault.failCreatePath = "notes/two.md";
  const state = new IndexedDbMirrorStateStore(replica);
  const mirror = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: state,
  });
  const interrupted = await mirror.sync();
  assert.equal(interrupted.status, "failed", JSON.stringify(interrupted));
  assert.match(interrupted.failure?.message ?? "", /injected adapter create failure/);
  const recovery = await state.read();
  assert.equal(recovery?.generation, 0);
  assert.equal(recovery?.batch?.phase, "blocked");
  assert.equal(recovery?.batch?.next_action, 1);
  vault.failCreatePath = null;
  state.close();
  const restarted = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new IndexedDbMirrorStateStore(replica),
  });
  const applied = await restarted.sync();
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal((await restarted.status()).state, "up_to_date");
  assert.equal(vault.getMarkdownFiles().length, 2);
});

test("portable mirror processes a 2,000-document mobile-shaped collection within the regression budget", async () => {
  const hosted = new MemoryAuthority({ snapshotPageSize: 200 });
  hosted.seed(Array.from({ length: 2_000 }, (_, index) => ({
    record_id: `record-${index}`,
    path: `notes/${String(index).padStart(5, "0")}.md`,
    frontmatter: { type: "note", title: `Record ${index}`, tags: ["profile"] },
    body: `Body ${index}`,
    types: ["note"],
  })));
  const replica = hosted.registerReplica({ name: "Performance", mode: "read_only" });
  const vault = new MemoryVault();
  const mirror = new DirectoryMirror(replica, hosted.transport(replica), {
    fileSystem: new ObsidianMirrorFileSystem(vault as never),
    stateStore: new MemoryMirrorStateStore(),
  });
  const started = performance.now();
  await mirror.sync();
  const elapsed = performance.now() - started;
  assert.equal(vault.getMarkdownFiles().length, 2_000);
  assert.ok(elapsed < 3_000, `2,000-document mirror took ${elapsed.toFixed(1)}ms`);
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
