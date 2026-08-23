import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TFile, normalizePath } from "obsidian";
import {
  MdbaseConfig,
  MdbaseIssue,
  MdbasePathError,
  MdbaseTypeDef,
  applyReadDefaults,
  buildUniqueNotePath,
  ensureCollectionInitialized,
  fieldsFromV03Schema,
  formatMarkdown,
  getTypesForFile,
  loadMdbaseConfig,
  loadTypeDefinitions,
  normalizeSafeRelativePath,
  parseFrontmatter,
  schemaFromV03Fields,
  validateCollection,
  validateFile,
} from "../src/mdbaseCore";

interface StoredFile {
  file: TFile;
  content: string;
}

const TestFileCtor = TFile as unknown as { new (path: string): TFile };

class MockVault {
  private files = new Map<string, StoredFile>();
  private folders = new Set<string>();

  adapter = {
    exists: async (path: string): Promise<boolean> => {
      const normalized = normalizePath(path);
      return this.files.has(normalized) || this.folders.has(normalized);
    },
  };

  getAbstractFileByPath(path: string): TFile | null {
    const normalized = normalizePath(path);
    return this.files.get(normalized)?.file ?? null;
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this.files.values())
      .map((entry) => entry.file)
      .filter((file) => file.extension === "md");
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content ?? "";
  }

  async create(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    const file = new TestFileCtor(normalized);
    this.files.set(normalized, { file, content });
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.files.set(file.path, { file, content });
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }

  async writeNote(path: string, frontmatter: Record<string, unknown>, body = ""): Promise<TFile> {
    const content = `---\n${JSON.stringify(frontmatter)}\n---\n\n${body}`;
    return this.create(path, content);
  }
}

function createConfig(overrides?: Partial<MdbaseConfig["settings"]>): MdbaseConfig {
  return {
    spec_version: "0.2.1",
    settings: {
      types_folder: "_types",
      explicit_type_keys: ["type", "types"],
      default_strict: false,
      include_subfolders: true,
      exclude: ["_types", ".obsidian", ".git"],
      ...overrides,
    },
  };
}

function createV03Config(overrides?: Partial<MdbaseConfig["settings"]>): MdbaseConfig {
  return {
    ...createConfig(overrides),
    spec_version: "0.3.0",
  };
}

function v03TaskType(): Record<string, unknown> {
  return {
    kind: "mdbase.type",
    name: "task",
    version: 1,
    match: { path_glob: "tasks/**/*.md" },
    schema: {
      dialect: "json-schema-2020-12",
      value: {
        type: "object",
        required: ["type", "id", "title"],
        additionalProperties: false,
        properties: {
          type: { const: "task" },
          id: { type: "string" },
          title: { type: "string", minLength: 1 },
          status: { enum: ["open", "done"] },
          due: { type: "string", format: "date" },
          parent: { type: "string" },
        },
      },
    },
    collection: {
      display: { name_field: "title" },
      read_defaults: { status: "open" },
      unique: [{ field: "id", scope: "type" }],
      links: { parent: { target_type: "task", validate_exists: true } },
      path: { pattern: "tasks/{id}.md" },
    },
  };
}

function getIssueCodes(issues: MdbaseIssue[]): string[] {
  return issues.map((issue) => issue.code).sort();
}

test("getTypesForFile prefers explicit type key and supports matcher rules", () => {
  const config = createConfig();
  const types = new Map<string, MdbaseTypeDef>([
    [
      "task",
      {
        name: "task",
        strict: false,
        fields: { title: { type: "string" } },
        match: { path_glob: "tasks/**/*.md" },
        filePath: "_types/task.md",
      },
    ],
    [
      "note",
      {
        name: "note",
        strict: false,
        fields: { title: { type: "string" } },
        match: { fields_present: ["title"], where: { status: "active" } },
        filePath: "_types/note.md",
      },
    ],
  ]);

  const explicit = getTypesForFile(
    "misc/one.md",
    { type: "task", title: "Explicit wins", status: "inactive" },
    config,
    types,
  );
  assert.deepEqual(explicit, ["task"]);

  const matched = getTypesForFile(
    "tasks/todo.md",
    { title: "By matcher", status: "active" },
    config,
    types,
  );
  assert.deepEqual(matched.sort(), ["note", "task"]);
});

test("validateFile enforces strict mode severity semantics", async () => {
  const vault = new MockVault();
  const file = await vault.writeNote("task.md", { type: "task", title: "x", extra: "field" });

  const typeTemplate: Omit<MdbaseTypeDef, "strict"> = {
    name: "task",
    fields: {
      title: { type: "string", required: true },
    },
    filePath: "_types/task.md",
  };

  const strictErrorMap = new Map<string, MdbaseTypeDef>([
    ["task", { ...typeTemplate, strict: true }],
  ]);
  const strictWarnMap = new Map<string, MdbaseTypeDef>([
    ["task", { ...typeTemplate, strict: "warn" }],
  ]);
  const strictFalseMap = new Map<string, MdbaseTypeDef>([
    ["task", { ...typeTemplate, strict: false }],
  ]);
  const strictUndefinedMap = new Map<string, MdbaseTypeDef>([
    ["task", { ...typeTemplate }],
  ]);

  const errorIssues = await validateFile(vault as unknown as any, file, createConfig(), strictErrorMap);
  assert.equal(errorIssues.find((issue) => issue.code === "unknown_field")?.severity, "error");

  const warnIssues = await validateFile(vault as unknown as any, file, createConfig(), strictWarnMap);
  assert.equal(warnIssues.find((issue) => issue.code === "unknown_field")?.severity, "warn");

  const overrideOffIssues = await validateFile(
    vault as unknown as any,
    file,
    createConfig({ default_strict: true }),
    strictFalseMap,
  );
  assert.equal(overrideOffIssues.some((issue) => issue.code === "unknown_field"), false);

  const defaultWarnIssues = await validateFile(
    vault as unknown as any,
    file,
    createConfig({ default_strict: true }),
    strictUndefinedMap,
  );
  assert.equal(defaultWarnIssues.find((issue) => issue.code === "unknown_field")?.severity, "warn");
});

test("validateFile reports unknown explicit types without skipping known type validation", async () => {
  const vault = new MockVault();
  const file = await vault.writeNote("task.md", { types: ["task", "missing"] });
  const types = new Map<string, MdbaseTypeDef>([
    ["task", {
      name: "task",
      fields: { title: { type: "string", required: true } },
      filePath: "_types/task.md",
    }],
  ]);

  const issues = await validateFile(vault as unknown as any, file, createConfig(), types);
  assert.ok(issues.some((issue) => issue.code === "unknown_type" && issue.message.includes("missing")));
  assert.ok(issues.some((issue) => issue.code === "missing_required" && issue.field === "title"));
});

test("validateFile enforces field constraints including nested required and link existence", async () => {
  const vault = new MockVault();
  await vault.writeNote("targets/existing.md", { type: "note", title: "Existing" });
  const file = await vault.writeNote("tasks/item.md", {
    type: "task",
    title: "AB12",
    score: 0,
    link: "[[missing-target]]",
    meta: {},
  });

  const types = new Map<string, MdbaseTypeDef>([
    [
      "task",
      {
        name: "task",
        strict: false,
        fields: {
          title: {
            type: "string",
            min_length: 5,
            max_length: 8,
            pattern: "^[a-z]+$",
          },
          score: { type: "number", min: 1, max: 5 },
          link: { type: "link", validate_exists: true },
          meta: {
            type: "object",
            fields: {
              owner: { type: "string", required: true },
            },
          },
        },
        filePath: "_types/task.md",
      },
    ],
  ]);

  const issues = await validateFile(vault as unknown as any, file, createConfig(), types);
  const codes = getIssueCodes(issues);

  assert.ok(codes.includes("pattern_mismatch"));
  assert.ok(codes.includes("below_min"));
  assert.ok(codes.includes("missing_link_target"));
  assert.ok(codes.includes("missing_required"));
});

test("buildUniqueNotePath applies filename_pattern and resolves duplicates", async () => {
  const vault = new MockVault();
  await vault.create("tasks/open/2026-03-03-my-task.md", "seed");
  await vault.create("journals/2026-03-03.md", "seed");

  const templatedType: MdbaseTypeDef = {
    name: "task",
    path_pattern: "tasks/{status}",
    filename_pattern: "{date}-{title}",
    fields: {},
    filePath: "_types/task.md",
  };

  const templatedPath = await buildUniqueNotePath(vault as unknown as any, templatedType, {
    status: "open",
    date: "2026-03-03",
    title: "My Task",
  });
  assert.equal(templatedPath, "tasks/open/2026-03-03-my-task-2.md");

  const explicitPathType: MdbaseTypeDef = {
    name: "journal",
    path_pattern: "journals/{date}.md",
    filename_pattern: "{title}",
    fields: {},
    filePath: "_types/journal.md",
  };

  const explicitPath = await buildUniqueNotePath(vault as unknown as any, explicitPathType, {
    date: "2026-03-03",
    title: "Ignored By Explicit Path",
  });
  assert.equal(explicitPath, "journals/2026-03-03-2.md");
});

test("validateCollection reports duplicate unique values and respects include_subfolders", async () => {
  const vault = new MockVault();
  await vault.writeNote("a.md", { type: "task", slug: "same" });
  await vault.writeNote("nested/b.md", { type: "task", slug: "same" });

  const types = new Map<string, MdbaseTypeDef>([
    [
      "task",
      {
        name: "task",
        strict: false,
        fields: {
          slug: { type: "string", unique: true },
        },
        filePath: "_types/task.md",
      },
    ],
  ]);

  const withSubfolders = await validateCollection(vault as unknown as any, createConfig(), types);
  const duplicateIssues = withSubfolders.filter((issue) => issue.code === "duplicate_unique");
  assert.equal(duplicateIssues.length, 2);

  const withoutSubfolders = await validateCollection(
    vault as unknown as any,
    createConfig({ include_subfolders: false }),
    types,
  );
  const duplicateWithoutSubfolders = withoutSubfolders.filter((issue) => issue.code === "duplicate_unique");
  assert.equal(duplicateWithoutSubfolders.length, 0);
});

test("loads v0.3 type wrappers and projects collection metadata for the Vault adapter", async () => {
  const vault = new MockVault();
  await vault.writeNote("_types/task.md", v03TaskType());
  const types = await loadTypeDefinitions(vault as unknown as any, createV03Config());
  const task = types.get("task");
  assert.ok(task);
  assert.equal(task.specProfile, "v0.3");
  assert.equal(task.display_name_key, "title");
  assert.equal(task.path_pattern, "tasks/{id}.md");
  assert.equal(task.fields.title.required, true);
  assert.equal(task.fields.due.type, "date");
  assert.equal(task.fields.id.unique, true);
  assert.equal(task.fields.id.unique_scope, "type");
  assert.equal(task.fields.parent.validate_exists, true);

  assert.deepEqual(applyReadDefaults({ type: "task", id: "a", title: "A" }, [task]), {
    type: "task",
    id: "a",
    title: "A",
    status: "open",
  });
  assert.equal(applyReadDefaults({ status: null }, [task]).status, null);
});

test("v0.3 validation uses canonical JSON Schema diagnostics on raw frontmatter", async () => {
  const vault = new MockVault();
  await vault.writeNote("_types/task.md", v03TaskType());
  const missing = await vault.writeNote("tasks/missing.md", { type: "task", id: "missing" });
  const invalid = await vault.writeNote("tasks/invalid.md", {
    type: "task",
    id: "invalid",
    title: "Invalid",
    due: "16/07/2026",
    extra: true,
  });
  const bodyOnly = await vault.create("tasks/body-only.md", "# Body-only task\n");
  const config = createV03Config();
  const types = await loadTypeDefinitions(vault as unknown as any, config);

  const missingIssues = await validateFile(vault as unknown as any, missing, config, types);
  assert.ok(missingIssues.some((issue) => issue.code === "schema_required" && issue.field === "title"));
  assert.ok(missingIssues.some((issue) => issue.schema_location?.startsWith("embedded://type/schema#")));

  const invalidIssues = await validateFile(vault as unknown as any, invalid, config, types);
  assert.ok(invalidIssues.some((issue) => issue.code === "format_invalid" && issue.field === "due"));
  assert.ok(invalidIssues.some((issue) => issue.code === "schema_additional_properties" && issue.field === "extra"));

  const bodyOnlyIssues = await validateFile(vault as unknown as any, bodyOnly, config, types);
  assert.ok(bodyOnlyIssues.some((issue) => issue.code === "schema_required" && issue.field === "type"));
  assert.ok(!bodyOnlyIssues.some((issue) => issue.code === "missing_frontmatter"));
  assert.ok(!bodyOnlyIssues.some((issue) => issue.code === "no_matching_type"));
  assert.deepEqual(parseFrontmatter(await vault.cachedRead(bodyOnly)), {
    hasFrontmatter: false,
    frontmatter: {},
    body: "# Body-only task\n",
  });
  assert.deepEqual(parseFrontmatter("---\n---\nExplicitly empty\n"), {
    hasFrontmatter: true,
    frontmatter: {},
    body: "Explicitly empty\n",
  });
  assert.equal(
    parseFrontmatter("---\nnull\n---\nNot an object\n").error,
    "Frontmatter must be a YAML object",
  );
  assert.deepEqual(parseFrontmatter("Introduction\n---\n{\"type\":\"task\"}\n---\n"), {
    hasFrontmatter: false,
    frontmatter: {},
    body: "Introduction\n---\n{\"type\":\"task\"}\n---\n",
  });
  assert.equal(formatMarkdown({}, "# Body-only task\n"), "# Body-only task\n");
});

test("loads custom contract folders from mdbase configuration", async () => {
  const vault = new MockVault();
  await vault.create("mdbase.yaml", JSON.stringify({
    spec_version: "0.3.0",
    settings: { contracts_folder: "schemas/contracts" },
  }));

  const config = await loadMdbaseConfig(vault as unknown as any);
  assert.equal(config?.settings.contracts_folder, "schemas/contracts");
});

test("v0.3 view query scope stays nested and the view validates as an ordinary record", async () => {
  const vault = new MockVault();
  await vault.writeNote("_types/view.md", {
    kind: "mdbase.type",
    name: "view",
    version: 1,
    schema: {
      dialect: "json-schema-2020-12",
      value: {
        type: "object",
        required: ["type", "id", "version", "name", "views"],
        additionalProperties: false,
        properties: {
          type: { const: "view" },
          id: { type: "string" },
          version: { type: "integer", minimum: 1 },
          name: { type: "string" },
          query: {
            type: "object",
            properties: { types: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
          views: { type: "array", minItems: 1, items: { type: "object" } },
        },
      },
    },
  });
  const file = await vault.writeNote("views/tasks.md", {
    type: "view",
    id: "tasks.views",
    version: 1,
    name: "Task views",
    query: { types: ["task"] },
    views: [{ id: "all", name: "All tasks" }],
  });
  const config = createV03Config();
  const types = await loadTypeDefinitions(vault as unknown as any, config);
  const parsed = parseFrontmatter(await vault.cachedRead(file));

  assert.deepEqual(getTypesForFile(file.path, parsed.frontmatter, config, types), ["view"]);
  assert.deepEqual(await validateFile(vault as unknown as any, file, config, types), []);
});

test("v0.3 collection validation enforces links and unique rules", async () => {
  const vault = new MockVault();
  await vault.writeNote("_types/task.md", v03TaskType());
  await vault.writeNote("tasks/a.md", { type: "task", id: "duplicate", title: "A" });
  const second = await vault.writeNote("tasks/b.md", {
    type: "task",
    id: "duplicate",
    title: "B",
    parent: "[[missing]]",
  });
  const config = createV03Config();
  const types = await loadTypeDefinitions(vault as unknown as any, config);

  const fileIssues = await validateFile(vault as unknown as any, second, config, types);
  assert.ok(fileIssues.some((issue) => issue.code === "link_not_found" && issue.field === "parent"));
  const collectionIssues = await validateCollection(vault as unknown as any, config, types);
  assert.equal(collectionIssues.filter((issue) => issue.code === "duplicate_value").length, 2);
});

test("v0.3 collection-scoped uniqueness compares values across declaring types", async () => {
  const vault = new MockVault();
  await vault.writeNote("a.md", { type: "alpha", id: "shared" });
  await vault.writeNote("b.md", { type: "beta", id: "shared" });
  const uniqueField = { type: "string", unique: true, unique_scope: "collection" };
  const types = new Map<string, MdbaseTypeDef>([
    ["alpha", {
      name: "alpha",
      fields: { id: { ...uniqueField } },
      filePath: "_types/alpha.md",
      specProfile: "v0.3",
    }],
    ["beta", {
      name: "beta",
      fields: { id: { ...uniqueField } },
      filePath: "_types/beta.md",
      specProfile: "v0.3",
    }],
  ]);

  const issues = await validateCollection(vault as unknown as any, createV03Config(), types);
  assert.equal(issues.filter((issue) => issue.code === "duplicate_value").length, 2);
  assert.ok(issues.every((issue) => issue.message.includes("across the collection")));
});

test("initializes new collections and their default type as v0.3", async () => {
  const vault = new MockVault();
  const result = await ensureCollectionInitialized(vault as unknown as any);
  assert.deepEqual(result.created, ["mdbase.yaml", "_types", "_types/note.md"]);
  const config = await loadMdbaseConfig(vault as unknown as any);
  assert.equal(config?.spec_version, "0.3.0");
  const typeFile = vault.getAbstractFileByPath("_types/note.md");
  assert.ok(typeFile instanceof TFile);
  const parsed = parseFrontmatter(await vault.cachedRead(typeFile));
  assert.equal(parsed.frontmatter.kind, "mdbase.type");
  assert.equal((parsed.frontmatter.schema as Record<string, unknown>).dialect, "json-schema-2020-12");
});

test("v0.3 schema projection preserves unedited JSON Schema structure", () => {
  const schema = {
    type: "object",
    required: ["title"],
    oneOf: [{ required: ["title"] }],
    properties: {
      title: { type: "string", minLength: 2, "x-editor": "keep" },
      status: { enum: ["open", "done"] },
    },
  };
  const fields = fieldsFromV03Schema(schema);
  fields.title.max_length = 30;
  const rebuilt = schemaFromV03Fields(fields, schema, true);
  assert.deepEqual(rebuilt.oneOf, schema.oneOf);
  assert.equal((rebuilt.properties as any).title["x-editor"], "keep");
  assert.equal((rebuilt.properties as any).title.minLength, 2);
  assert.equal((rebuilt.properties as any).title.maxLength, 30);
  assert.deepEqual(rebuilt.required, ["title"]);
  assert.equal(rebuilt.additionalProperties, false);
});

test("loads local v0.3 schema.ref fragments through the Vault API", async () => {
  const vault = new MockVault();
  await vault.create("_types/task.schema.json", JSON.stringify({
    $defs: {
      task: {
        type: "object",
        required: ["type", "title"],
        properties: {
          type: { const: "task" },
          title: { type: "string", minLength: 2 },
        },
      },
    },
  }));
  await vault.writeNote("_types/task.md", {
    kind: "mdbase.type",
    name: "task",
    version: 1,
    schema: {
      dialect: "json-schema-2020-12",
      ref: "./task.schema.json#/$defs/task",
    },
  });
  const file = await vault.writeNote("tasks/a.md", { type: "task", title: "A" });
  const config = createV03Config();
  const types = await loadTypeDefinitions(vault as unknown as any, config);
  assert.equal(types.get("task")?.fields.title.required, true);
  const issues = await validateFile(vault as unknown as any, file, config, types);
  assert.ok(issues.some((issue) => issue.code === "schema_min_length" && issue.field === "title"));
});

test("rejects explicit and policy-generated path traversal", async () => {
  assert.throws(
    () => normalizeSafeRelativePath("../escape.md"),
    (error: unknown) => error instanceof MdbasePathError && error.code === "path_traversal",
  );
  const vault = new MockVault();
  const typeDef: MdbaseTypeDef = {
    name: "task",
    path_pattern: "../{id}.md",
    fields: {},
    filePath: "_types/task.md",
    specProfile: "v0.3",
  };
  await assert.rejects(
    buildUniqueNotePath(vault as unknown as any, typeDef, { id: "escape" }),
    (error: unknown) => error instanceof MdbasePathError && error.code === "path_traversal",
  );
});
