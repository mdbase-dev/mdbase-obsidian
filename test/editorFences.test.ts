import test from "node:test";
import assert from "node:assert/strict";
import { ObsidianMirrorFileSystem, prepareMirrorEditorChange } from "../src/connectSync";
import { MemoryVault } from "./memoryVault";
import type { TFile } from "obsidian";

function editor(path: string, saved: string, value = saved, mode = "source") {
  const view = {
    file: { path }, data: saved, value,
    getMode: () => mode,
    editor: { getValue: () => view.value },
    setViewData: (next: string, clear: boolean) => {
      assert.equal(clear, false, "keep editor history when applying a download");
      view.value = next.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    },
  };
  const leaf = { view, detached: false, detach: () => { leaf.detached = true; } };
  return leaf;
}

function fence(leaves: ReturnType<typeof editor>[]) {
  const app = { workspace: { getLeavesOfType: () => leaves } };
  return (path: string, before: string | undefined, after: string | null) => prepareMirrorEditorChange(app as never, path, before, after);
}

const stale = (error: unknown) => (error as { code?: string }).code === "sync_plan_stale";

test("a download cannot overwrite an unsaved editor buffer that is not in Vault.process's disk snapshot", async () => {
  const vault = new MemoryVault();
  await vault.create("a.md", "base\n");
  const leaf = editor("a.md", "base\n", "unsaved user edit\n");
  let echoes = 0;
  const fs = new ObsidianMirrorFileSystem(vault as never, undefined, undefined, () => { echoes++; }, fence([leaf]));
  await assert.rejects(fs.write("a.md", "remote\n", "base\n"), stale);
  assert.equal(vault.read("a.md"), "base\n");
  assert.equal(leaf.view.value, "unsaved user edit\n");
  assert.equal(echoes, 0);
});

test("a hosted deletion cannot trash an unsaved editor buffer", async () => {
  const vault = new MemoryVault();
  await vault.create("a.md", "base\n");
  const leaf = editor("a.md", "base\n", "unsaved user edit\n");
  const fs = new ObsidianMirrorFileSystem(vault as never, undefined, undefined, undefined, fence([leaf]));
  await assert.rejects(fs.remove("a.md", "base\n"), stale);
  assert.equal(vault.read("a.md"), "base\n");
  assert.equal(leaf.detached, false);
});

test("advancing clean editor data before IO protects typing made before the disk modification notification", async () => {
  const leaf = editor("a.md", "base\n");
  class DelayedVault extends MemoryVault {
    override async process(file: TFile, transform: (current: string) => string): Promise<string> {
      const current = this.read(file.path);
      if (current === null) throw new Error("fixture file missing");
      const next = transform(current);
      assert.equal(leaf.view.data, "remote\n", "the view's saved baseline advances atomically with the conditional transform");
      leaf.view.value = "typed during IO\n";
      await this.modify(file, next);
      // TextFileView ignores a notification equal to its current data; otherwise
      // reloading that snapshot destroys its still-unsaved buffer.
      if (leaf.view.data !== next) {
        leaf.view.setViewData(next, false);
        leaf.view.data = next;
      }
      return next;
    }
  }
  const vault = new DelayedVault();
  const file = await vault.create("a.md", "base\n");
  const fs = new ObsidianMirrorFileSystem(vault as never, undefined, undefined, undefined, fence([leaf]));
  await fs.write("a.md", "remote\n", "base\n");
  assert.equal(leaf.view.value, "typed during IO\n");
  await vault.modify(file, leaf.view.value);
  assert.equal(vault.read("a.md"), "typed during IO\n");
});

test("editor comparison tolerates BOM and CRLF without changing the downloaded bytes", async () => {
  const vault = new MemoryVault();
  await vault.create("a.md", "\uFEFFbase\r\n");
  const leaf = editor("a.md", "\uFEFFbase\r\n", "base\n");
  const fs = new ObsidianMirrorFileSystem(vault as never, undefined, undefined, undefined, fence([leaf]));
  await fs.write("a.md", "\uFEFFremote\r\n", "\uFEFFbase\r\n");
  assert.equal(vault.read("a.md"), "\uFEFFremote\r\n");
  assert.equal(leaf.view.data, "\uFEFFremote\r\n");
});

test("a dirty popout fences all views before any clean view is advanced", () => {
  const clean = editor("a.md", "base\n");
  const dirty = editor("a.md", "base\n", "popout edit\n");
  assert.throws(() => fence([clean, dirty])("a.md", "base\n", "remote\n"), stale);
  assert.equal(clean.view.value, "base\n");
  assert.equal(clean.view.data, "base\n");
});

test("clean source and preview leaves close before asynchronous trash can accept more typing", async () => {
  const vault = new MemoryVault();
  const file = await vault.create("a.md", "base\n");
  const source = editor("a.md", "base\n");
  const preview = editor("a.md", "base\n", "old preview buffer", "preview");
  const fs = new ObsidianMirrorFileSystem(vault as never, async target => {
    assert.equal(source.detached, true);
    assert.equal(preview.detached, true);
    await vault.delete(target);
  }, undefined, undefined, fence([source, preview]));
  await fs.remove(file.path, "base\n");
  assert.equal(vault.read("a.md"), null);
});
