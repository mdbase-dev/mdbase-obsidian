import assert from "node:assert/strict";
import test from "node:test";
import MdbasePlugin from "../main";
import { MemoryVault } from "./memoryVault";
import type { CollectionRecord } from "../src/mdbaseCore";

const config = {
  spec_version: "0.3.0",
  settings: { types_folder: "_types", explicit_type_keys: ["type"], exclude: [] },
};

function fixture(vault: MemoryVault) {
  const plugin = new MdbasePlugin({ vault } as never, {} as never);
  const cache = plugin as unknown as {
    getConfigAndTypes(): Promise<unknown>;
    markRecordChanged(path: string): void;
    loadCollectionRecords(): Promise<CollectionRecord[]>;
  };
  cache.getConfigAndTypes = async () => ({ config, types: new Map(), contracts: new Map() });
  return cache;
}

test("initial record-cache loading reconciles edits and creations that arrive while reads yield", async () => {
  const vault = new MemoryVault();
  await vault.create("a.md", "---\ntype: old\n---\n");
  await vault.create("b.md", "---\ntype: deleted\n---\n");
  await vault.create("c.md", "---\ntype: moved\n---\n");
  await vault.create("z.md", "---\ntype: unchanged\n---\n");
  const cache = fixture(vault);
  const read = vault.cachedRead.bind(vault);
  let changed = false;
  vault.cachedRead = async (file) => {
    if (file.path === "z.md" && !changed) {
      changed = true;
      await vault.modify(vault.getAbstractFileByPath("a.md") as never, "---\ntype: new\n---\n");
      cache.markRecordChanged("a.md");
      await vault.delete(vault.getAbstractFileByPath("b.md") as never);
      cache.markRecordChanged("b.md");
      await vault.rename(vault.getAbstractFileByPath("c.md") as never, "renamed.md");
      cache.markRecordChanged("c.md");
      cache.markRecordChanged("renamed.md");
      await vault.create("new.md", "---\ntype: added\n---\n");
      cache.markRecordChanged("new.md");
    }
    return read(file);
  };
  const records = await cache.loadCollectionRecords();
  assert.deepEqual(records.map(({ path, frontmatter }) => [path, frontmatter.type]), [
    ["a.md", "new"], ["new.md", "added"], ["renamed.md", "moved"], ["z.md", "unchanged"],
  ]);
  assert.deepEqual(await cache.loadCollectionRecords(), records, "cached lists must remain reconciled");
});
