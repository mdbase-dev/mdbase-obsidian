import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TFile, type TAbstractFile } from "obsidian";
import { ObsidianMirrorFileSystem } from "../src/connectSync";
import { portablePathKey } from "../src/adoptionPaths";
import { MemoryVault } from "./memoryVault";

/** Exact Obsidian cache spellings, with an APFS-like aliasing disk adapter. */
class AliasingVault extends MemoryVault {
  configDir = ".obsidian";
  constructor() {
    super();
    const disk = this.adapter;
    const actual = (path: string) => [...this.files.keys(), ...this.binaryFiles.keys(), ...this.folders.keys()]
      .find((candidate) => portablePathKey(candidate) === portablePathKey(path)) ?? path;
    const adapter = { ...disk,
      exists: async (path: string) => disk.exists(actual(path)),
      stat: async (path: string) => disk.stat(actual(path)),
      readBinary: async (path: string) => disk.readBinary(actual(path)),
      list: async (folder: string) => {
        const immediate = (path: string) => portablePathKey(path.slice(0, Math.max(0, path.lastIndexOf("/")))) === portablePathKey(folder);
        return { files: [...this.files.keys(), ...this.binaryFiles.keys()].filter(immediate), folders: [...this.folders.keys()].filter(immediate) };
      },
    };
    this.adapter = adapter;
  }
  getAllLoadedFiles(): TAbstractFile[] { return [...this.getFiles(), ...this.folders.values()]; }
}

test("reserved folder protection includes case and canonical-Unicode aliases", async () => {
  const vault = new AliasingVault();
  const fs = new ObsidianMirrorFileSystem(vault as never);
  for (const path of [".OBSIDIAN/settings.json", ".MDBASE/connect-role.json", ".GIT/config", ".TRASH/note.md"]) {
    await assert.rejects(fs.write(path, "must not write", null), /reserved/);
  }
  vault.configDir = "Café Config";
  for (const path of ["CAFÉ CONFIG/settings.json", "Cafe\u0301 Config/settings.json"]) {
    await assert.rejects(fs.write(path, "must not write", null), /reserved/);
  }
  assert.equal(vault.getFiles().length, 0);
  await vault.create("CAFÉ CONFIG/private.md", "private config");
  await vault.createBinary("Cafe\u0301 Config/icon.png", new Uint8Array([1]).buffer);
  assert.deepEqual(await fs.listMarkdown(new Set()), []);
  assert.deepEqual(await fs.listBinary(new Set()), []);
  await assert.rejects(fs.inspectBinary("CAFÉ CONFIG/icon.png"), /reserved/);
  await assert.rejects(fs.writeBinary("Cafe\u0301 Config/icon.png", (async function* () { yield new Uint8Array([2]); })()), /reserved/);
});

for (const [source, target] of [["note.md", "Note.md"], ["cafe\u0301.md", "café.md"]]) {
  test(`a same-file physical rename ${source} → ${target} is not mistaken for a collision`, async () => {
    const vault = new AliasingVault();
    await vault.create(source!, "exact bytes 🥒\n");
    const fs = new ObsidianMirrorFileSystem(vault as never);
    await fs.move(source!, target!);
    assert.equal(vault.read(target!), "exact bytes 🥒\n");
    assert.deepEqual(vault.getFiles().map((file) => file.path), [target]);
  });
}

test("a distinct case-sensitive destination is never accepted as the source alias", async () => {
  const vault = new AliasingVault();
  await vault.create("note.md", "source\n");
  await vault.create("Note.md", "unrelated destination\n");
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await assert.rejects(fs.move("note.md", "Note.md"), /blocks|collision/);
  assert.equal(vault.read("note.md"), "source\n");
  assert.equal(vault.read("Note.md"), "unrelated destination\n");
});

test("an uncached distinct case-sensitive destination is not mistaken for the source", async () => {
  const vault = new AliasingVault();
  await vault.create("note.md", "source\n");
  await vault.create("Note.md", "uncached destination\n");
  const lookup = vault.getAbstractFileByPath.bind(vault);
  vault.getAbstractFileByPath = (path) => path === "Note.md" ? null : lookup(path);
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await assert.rejects(fs.move("note.md", "Note.md"), /blocks/);
  assert.equal(vault.read("note.md"), "source\n");
  assert.equal(vault.read("Note.md"), "uncached destination\n");
});

test("a hosted spelling can conditionally update and remove an aliased cached TFile", async () => {
  const vault = new AliasingVault();
  await vault.create("cafe\u0301.md", "before\n");
  const fs = new ObsidianMirrorFileSystem(vault as never);
  assert.equal(await fs.read("café.md"), "before\n");
  await fs.write("café.md", "after\n", "before\n");
  assert.equal(vault.read("cafe\u0301.md"), "after\n");
  await fs.remove("CAFÉ.md");
  assert.equal(vault.getFiles().length, 0);
});

test("a user rename during destination checks is not silently replaced by a hosted rename", async () => {
  const vault = new AliasingVault();
  const file = await vault.create("note.md", "exact user bytes\n");
  const exists = vault.adapter.exists.bind(vault.adapter);
  let raced = false;
  vault.adapter.exists = async (path) => {
    if (path === "hosted.md" && !raced) {
      raced = true;
      // Obsidian mutates a TFile's path in place when it is renamed.
      const entry = vault.files.get("note.md")!;
      vault.files.delete("note.md");
      file.path = "saved-by-user.md";
      vault.files.set(file.path, entry);
    }
    return exists(path);
  };
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await assert.rejects(fs.move("note.md", "hosted.md"), (error: unknown) => (error as { code?: string }).code === "sync_plan_stale");
  assert.equal(vault.read("saved-by-user.md"), "exact user bytes\n");
  assert.equal(vault.read("hosted.md"), null);
});

test("a TFile renamed before an async cache lookup completes is not deleted at its new path", async () => {
  const vault = new AliasingVault();
  const file = await vault.create("note.md", "keep this rename\n");
  const lookup = vault.getAbstractFileByPath.bind(vault);
  let raced = false;
  vault.getAbstractFileByPath = (path) => {
    const result = lookup(path);
    if (path === "note.md" && !raced) {
      raced = true;
      queueMicrotask(() => {
        const entry = vault.files.get("note.md")!;
        vault.files.delete("note.md");
        file.path = "saved-by-user.md";
        vault.files.set(file.path, entry);
      });
    }
    return result;
  };
  const fs = new ObsidianMirrorFileSystem(vault as never);
  await assert.rejects(fs.remove("note.md"), (error: unknown) => (error as { code?: string }).code === "sync_plan_stale");
  assert.equal(vault.read("saved-by-user.md"), "keep this rename\n");
});

test("binary inspection and writes use the aliased TFile rather than declaring it absent", async () => {
  const vault = new AliasingVault();
  await vault.createBinary("cafe\u0301.png", new Uint8Array([0, 255, 128]).buffer);
  const fs = new ObsidianMirrorFileSystem(vault as never);
  assert.equal((await fs.inspectBinary("café.png"))?.size, 3);
  await fs.writeBinary("café.png", (async function* () { yield new Uint8Array([1, 254]); })());
  assert.deepEqual(vault.readBytes("cafe\u0301.png"), new Uint8Array([1, 254]));
  assert.ok(vault.getAbstractFileByPath("cafe\u0301.png") instanceof TFile);
});
