import * as assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePath, parseYaml, TFile, TFolder } from "obsidian";
import { MemoryVault, TestFile, TestFolder } from "./memoryVault";
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
  validateFile,
} from "../src/mdbaseCore";

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

test("migration translates v0.2 discovery and default settings into v0.3 configuration", async () => {
  const vault = new MemoryVault();
  await collectionVault(taskType(), vault);
  await vault.modify(vault.getAbstractFileByPath("mdbase.yaml") as never, `${JSON.stringify({
    spec_version: "0.2.0",
    settings: {
      types_folder: "_types",
      include_subfolders: false,
      default_strict: true,
      exclude: [".git", "node_modules", "_types", "archive", "*.draft.md", "drafts/**", "{a,b}/x"],
    },
  }, null, 2)}\n`);

  const plan = await analyzeV02Migration(vault as never);

  const config = parseYaml(plan.operations[0].target) as Record<string, Record<string, unknown>>;
  assert.deepEqual(config.settings.exclude, ["archive/**", "**/*.draft.md", "drafts/**", "{a,b}/x", "*/**"]);
  assert.equal(config.settings.validation, "warn");
  assert.equal(config.settings.id_field, "id");
  assert.equal("include_subfolders" in config.settings, false);
  assert.deepEqual(config["x-legacy-v0.2"], { settings: { default_strict: true } });
  assert.ok(plan.diagnostics.some((entry) => entry.code === "non_portable_exclude"));
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

test("migration tolerates Obsidian folder metadata cache lag", async () => {
  const vault = await collectionVault(taskType(), new LaggyFolderMetadataVault());
  const plan = await analyzeV02Migration(vault as never);
  const result = await applyV02Migration(vault as never, plan);
  assert.equal(result.applied, true);
  assert.equal(JSON.parse(vault.read(result.manifestPath) ?? "{}").status, "applied");
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
