import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import { MAX_BINARY_FILE_BYTES, ObsidianMirrorFileSystem } from "../src/connectSync";

test("oversized local binaries are rejected before the Vault allocates their contents", async () => {
  const file = new (TFile as unknown as { new(path: string): TFile })("large.mp4");
  file.stat.size = MAX_BINARY_FILE_BYTES + 1;
  let reads = 0;
  const adapter = new ObsidianMirrorFileSystem({
    getAbstractFileByPath: () => file,
    readBinary: () => { reads++; throw new Error("must not read"); },
  } as never);
  await assert.rejects(adapter.readBinary("large.mp4"), /32 MiB/);
  await assert.rejects(adapter.inspectBinary("large.mp4"), /32 MiB/);
  assert.equal(reads, 0);
});

test("oversized incoming streams never reach a Vault write", async () => {
  const adapter = new ObsidianMirrorFileSystem({} as never);
  await assert.rejects(adapter.writeBinary("large.mp4", (async function* () {
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 33; i++) yield chunk;
  })()), /32 MiB/);
});

test("unload during download prevents materialization after the stream completes", async () => {
  let disposed = false;
  let writes = 0;
  const adapter = new ObsidianMirrorFileSystem({
    getAbstractFileByPath: () => null,
    createBinary: () => { writes++; },
  } as never, undefined, () => { if (disposed) throw new Error("unloaded"); });
  await assert.rejects(adapter.writeBinary("image.png", (async function* () {
    yield Uint8Array.of(1, 2, 3);
    disposed = true;
  })()), /unloaded/);
  assert.equal(writes, 0);
});
