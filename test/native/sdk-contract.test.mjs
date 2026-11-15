import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { checkNativeSdk } from "../../scripts/native-sdk-contract.mjs";
import { nativeAssets } from "../../scripts/native-assets.mjs";

const sdk = resolve("node_modules/@mdbase-dev/sdk");

test("native page typechecks against the actual packaged SDK", () => {
  assert.doesNotThrow(() => checkNativeSdk(sdk));
});

test("native build refuses the pre-options-bag watch API before bundling", async t => {
  const directory = mkdtempSync(join(tmpdir(), "obsidian-sdk-contract-"));
  const previous = process.argv;
  process.argv = [...previous, "--native-sdk", directory];
  t.after(() => { process.argv = previous; });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  writeFileSync(join(directory, "dist/index.d.ts"), `
    export * from ${JSON.stringify(resolve(sdk, "dist/index.js"))};
    import type { MdbaseClient as Current, ChangesResult, ChangesWatch } from ${JSON.stringify(resolve(sdk, "dist/index.js"))};
    export interface MdbaseClient extends Omit<Current, "watchChanges"> {
      watchChanges(cursor: string | undefined, onChanges: (batch: ChangesResult) => void): ChangesWatch;
    }
  `);
  await assert.rejects(nativeAssets(), error => {
    assert.match(error.message, /Native SDK API mismatch/);
    assert.match(error.message, /page\.ts\(\d+,\d+\).*TS2345/);
    assert.match(error.message, /not assignable to parameter of type 'string'/);
    return true;
  });
});

test("a package without declarations cannot fall back to installed SDK types", t => {
  const directory = mkdtempSync(join(tmpdir(), "obsidian-sdk-no-types-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => checkNativeSdk(directory), /Native SDK API mismatch.*package declarations are missing/);
});
