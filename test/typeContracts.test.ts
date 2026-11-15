import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  addImplementation,
  assessMapping,
  contractFields,
  schemaInitialValue,
  setBinding,
  setFieldMapping,
  typeFieldsForModel,
} from "../src/typeContracts";
import { createDefaultTypeModel, frontmatterFromTypeModel, typeModelFromDocument } from "../src/typeModel";
import { loadContractDefinitions } from "../src/typeDefinitions";

const contract = {
  contract_type: "record" as const,
  id: "example.task",
  version: "1.0.0",
  digest: "",
  schema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1 },
      priority: { type: "integer" },
    },
  },
  binding_schema: {
    type: "object",
    required: ["completed_values"],
    properties: {
      completed_values: { type: "array", minItems: 1, items: { type: "string" } },
    },
  },
  implementations: [],
};

test("type contract setup adds mappings, settings, and round-trips through YAML", () => {
  const model = createDefaultTypeModel();
  model.name = "task";
  model.fields = [
    { name: "title", definition: { type: "string", required: true } },
    { name: "priority", definition: { type: "integer" } },
  ];
  addImplementation(model, contract);
  const implementation = model.implementations[0];
  assert.deepEqual(implementation.fields, { title: "title", priority: "priority" });
  assert.equal(assessMapping(contractFields(contract)[0], typeFieldsForModel(model)[0]).level, "valid");

  setFieldMapping(implementation, "priority");
  assert.equal(implementation.fields.priority, undefined);
  const binding = schemaInitialValue(contract.binding_schema);
  assert.deepEqual(binding, { completed_values: [] });
  setBinding(implementation, { completed_values: ["done"] });

  const frontmatter = frontmatterFromTypeModel(model);
  assert.deepEqual(frontmatter.implements, [{
    contract: "example.task",
    version: "1.0.0",
    fields: { title: "title" },
    binding: { completed_values: ["done"] },
  }]);
  const restored = typeModelFromDocument(frontmatter, "# Task", "task");
  assert.deepEqual(restored.implementations, model.implementations);
});

test("local contract discovery loads record schemas from the configured folder", async () => {
  const file = { path: "contracts/example.md", extension: "md" };
  const vault = {
    getMarkdownFiles: () => [file],
    cachedRead: async () => `---
${JSON.stringify({
  kind: "mdbase.contract",
  contract_type: "record",
  id: "example.task",
  version: "1.0.0",
  record_schema: { dialect: "json-schema-2020-12", value: { type: "object", properties: { title: { type: "string" } } } },
})}
---
# Example
`,
  };
  const contracts = await loadContractDefinitions(vault as never, {
    spec_version: "0.3.0",
    settings: {
      types_folder: "_types",
      contracts_folder: "contracts",
      explicit_type_keys: ["type"],
      default_strict: false,
      include_subfolders: true,
      exclude: [],
    },
  });
  const properties = contracts.get("example.task@1.0.0")?.schema.properties as Record<string, { type?: string }> | undefined;
  assert.equal(properties?.title?.type, "string");
});
