import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { loadMdbaseConfig, loadTypeDefinitions, validateCollection } from "../src/mdbaseCore";
import { MemoryVault } from "./memoryVault";

// mdbase-test-vault/ is the committed vault for trying the plugin in a real Obsidian.
// Keep it meaning what its notes say: valid records stay valid, the broken one stays broken.
const ROOT = join(process.cwd(), "mdbase-test-vault");

async function loadTestVault(): Promise<MemoryVault> {
  const vault = new MemoryVault();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".obsidian") continue;
        await vault.createFolder(relative(ROOT, full));
        await walk(full);
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".yaml")) {
        await vault.create(relative(ROOT, full), readFileSync(full, "utf8"));
      }
    }
  };
  await walk(ROOT);
  return vault;
}

test("the test vault's records validate as its notes describe", async () => {
  const vault = await loadTestVault();
  const config = await loadMdbaseConfig(vault as never);
  assert.ok(config, "mdbase.yaml loads");
  const types = await loadTypeDefinitions(vault as never, config);
  assert.deepEqual([...types.keys()].sort(), ["book", "note", "person"]);
  const issues = await validateCollection(vault as never, config, types);
  const byPath = new Map<string, string[]>();
  for (const issue of issues) byPath.set(issue.path, [...(byPath.get(issue.path) ?? []), issue.field ?? issue.code]);
  assert.deepEqual([...byPath.keys()], ["Library/Broken record.md"],
    `only the broken record has issues: ${JSON.stringify(issues, null, 1)}`);
  const fields = new Set(byPath.get("Library/Broken record.md"));
  for (const field of ["title", "author", "published", "year", "status", "rating"]) {
    assert.ok(fields.has(field), `Broken record.md reports ${field}: ${JSON.stringify([...fields])}`);
  }
});
