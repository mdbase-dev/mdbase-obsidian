import assert from "node:assert/strict";
import test from "node:test";
import MdbasePlugin from "../main";
import { MemoryVault } from "./memoryVault";
import type { MdbaseConfig } from "../src/mdbaseCore";

type Schema = { config: MdbaseConfig };
function fixture(vault: MemoryVault) {
  const plugin = new MdbasePlugin({ vault } as never, {} as never);
  return plugin as unknown as {
    getConfigAndTypes(): Promise<Schema | null>;
    invalidateSchemaCache(): void;
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("invalidated schema loads and their coalesced callers cannot replace newer rules", async () => {
  const vault = new MemoryVault();
  const file = await vault.create("mdbase.yaml", "spec_version: 0.3.0\nname: old\n");
  const cache = fixture(vault);
  const entered = deferred();
  const release = deferred();
  const read = vault.cachedRead.bind(vault);
  let first = true;
  vault.cachedRead = async (target) => {
    const document = await read(target);
    if (target.path === file.path && first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return document;
  };
  const old = cache.getConfigAndTypes();
  await entered.promise;
  const coalesced = cache.getConfigAndTypes();
  await vault.modify(file, "spec_version: 0.3.0\nname: new\n");
  cache.invalidateSchemaCache();
  const current = await cache.getConfigAndTypes();
  release.resolve();
  assert.equal(current?.config.name, "new");
  assert.equal(await old, current, "older waiter must receive current rules, not republish its stale load");
  assert.equal(await coalesced, current, "coalesced waiters need the same invalidation fence");
  assert.equal(await cache.getConfigAndTypes(), current);
});

test("errors from an invalidated type read cannot replace a newer successful load", async () => {
  const vault = new MemoryVault();
  await vault.create("mdbase.yaml", "spec_version: 0.3.0\nname: rules\n");
  const file = await vault.create("_types/task.md", "---\nkind: mdbase.type\nname: task\nschema:\n  value:\n    type: object\n    properties:\n      title:\n        type: string\n---\n");
  const cache = fixture(vault);
  const entered = deferred();
  const release = deferred();
  const read = vault.cachedRead.bind(vault);
  let first = true;
  vault.cachedRead = async (target) => {
    if (target.path === file.path && first) {
      first = false;
      entered.resolve();
      await release.promise;
      throw new Error("the old type read was invalidated");
    }
    return read(target);
  };
  const old = cache.getConfigAndTypes();
  await entered.promise;
  cache.invalidateSchemaCache();
  const current = await cache.getConfigAndTypes();
  release.resolve();
  assert.ok(current);
  assert.equal(await old, current);
  assert.equal(await cache.getConfigAndTypes(), current);
});

test("an invalidated no-config result cannot conceal a newly created collection", async () => {
  const vault = new MemoryVault();
  const cache = fixture(vault);
  const old = cache.getConfigAndTypes();
  cache.invalidateSchemaCache();
  await vault.create("mdbase.yaml", "spec_version: 0.3.0\nname: created\n");
  const current = await cache.getConfigAndTypes();
  assert.equal(current?.config.name, "created");
  assert.equal(await old, current);
});
