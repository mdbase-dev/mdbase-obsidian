import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidationState } from "../src/validationState";
import type { MdbaseConfig } from "../src/mdbaseCore";
import { coerceFieldInput } from "../src/noteCreation";
import { validateCollection } from "../src/validation";
import { safeNotePath } from "../src/createTypedNoteModal";
import { safePackPath, planPack, applyPack, recoverPackInstall, sha256, plainCaution, installedPackVersions, installedStatus, type CatalogPack } from "../src/contractCatalog";
import { TFile } from "obsidian";

test("validation starts unchecked, records coverage, and invalidates schema and changed notes", () => {
  const state = new ValidationState();
  assert.equal(state.summary(["a", "b"]), "Not checked yet");
  state.markChecked("a");
  assert.match(state.summary(["a", "b"]), /1 of 2.*duplicate values not checked yet/);
  state.lastCompletedAt = new Date().toISOString(); state.completedRevision = state.revision;
  assert.match(state.summary(["a", "b"]), /Checked 2 notes at/);
  state.changed("a");
  assert.equal(state.isChecked("a"), false);
  assert.match(state.summary(["a", "b"]), /Changed since/);
  state.changed(); assert.equal(state.isChecked("b"), false);
  state.cancelled = true;
  assert.match(state.summary(["a", "b"]), /results incomplete/);
});

test("numeric creation inputs reject truncation, infinity, unsafe integers and blank values", () => {
  for (const value of ["12abc", "1.5", "", "Infinity", "9007199254740993"]) assert.throws(() => coerceFieldInput(value, { type: "integer" }));
  for (const value of ["12abc", "", "Infinity", "0x20", "1e999"]) assert.throws(() => coerceFieldInput(value, { type: "number" }));
  assert.equal(coerceFieldInput("-12", { type: "integer" }), -12);
  assert.equal(coerceFieldInput("1.2e3", { type: "number" }), 1200);
});

test("creation accepts structured lists without splitting commas inside values", () => {
  assert.deepEqual(coerceFieldInput('["Smith, Jane", "Ada"]', { type: "list", items: { type: "string" } }), ["Smith, Jane", "Ada"]);
  assert.deepEqual(coerceFieldInput('[{"name":"Ada","active":false}]', { type: "list", items: { type: "object" } }), [{ name: "Ada", active: false }]);
  assert.deepEqual(coerceFieldInput("2, 3", { type: "list", items: { type: "integer" } }), [2, 3]);
});

test("datetime creation inputs coerce datetime-local strings to RFC 3339 without altering valid offsets or invalid dates", () => {
  const localMinute = new Date(0);
  localMinute.setFullYear(2026, 10, 23);
  localMinute.setHours(19, 24, 0, 0);
  assert.equal(coerceFieldInput("2026-11-23T19:24", { type: "datetime" }), localMinute.toISOString());

  const localFraction = new Date(0);
  localFraction.setFullYear(2026, 10, 23);
  localFraction.setHours(19, 24, 35, 500);
  assert.equal(coerceFieldInput("2026-11-23T19:24:35.5", { type: "datetime" }), localFraction.toISOString());

  assert.equal(coerceFieldInput("2026-11-23T19:24:00+11:00", { type: "datetime" }), "2026-11-23T19:24:00+11:00");
  assert.equal(coerceFieldInput("2026-11-23T08:24:00Z", { type: "datetime" }), "2026-11-23T08:24:00Z");
  assert.equal(coerceFieldInput("2026-02-31T19:24", { type: "datetime" }), "2026-02-31T19:24");
  assert.equal(coerceFieldInput("not-a-date", { type: "datetime" }), "not-a-date");
});

test("creation and pack paths reject traversal, hidden paths, absolute paths and controls", () => {
  for (const value of ["/absolute", "../escape", "a/../escape", ".obsidian/settings", "a\\b", "a\0b", "a//b"]) {
    assert.throws(() => safeNotePath(value)); assert.throws(() => safePackPath(value));
  }
  assert.equal(safeNotePath("Notes/Hello"), "Notes/Hello.md");
  assert.equal(safePackPath("_contracts/task.md"), "_contracts/task.md");
});

test("collection validation reports progress and cancellation prevents a completed result", async () => {
  const abort = new AbortController();
  const files = [Object.assign(new TFile(), { path: "a.md", extension: "md" }), Object.assign(new TFile(), { path: "b.md", extension: "md" })];
  const vault = { getMarkdownFiles: () => files, cachedRead: async () => "---\ntitle: A\n---\n" };
  const seen: string[] = [];
  await assert.rejects(validateCollection(vault as never, { spec_version: "0.3.0", settings: { exclude: [], explicit_type_keys: ["type"], types_folder: "_types" } } as unknown as MdbaseConfig, new Map(), {
    signal: abort.signal,
    onFile: file => { seen.push(file.path); abort.abort(); },
  }), { name: "AbortError" });
  assert.deepEqual(seen, ["a.md"]);
});

function packFixture() {
  const contents = new Map<string, string>(); const files = new Map<string, TFile>();
  // Folders on disk. Like Obsidian, the index (getAbstractFileByPath) never sees hidden ones.
  const folders = new Set<string>();
  let failPath = "";
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    read: async (file: TFile) => contents.get(file.path)!,
    createFolder: async (path: string) => { if (folders.has(path)) throw new Error("Folder already exists."); folders.add(path); },
    create: async (path: string, value: string) => {
      if (path === failPath) throw new Error("injected write failure");
      if (files.has(path)) throw new Error("exists");
      const file = Object.assign(new TFile(), { path }); files.set(path, file); contents.set(path, value); return file;
    },
    process: async (file: TFile, fn: (value: string) => string) => contents.set(file.path, fn(contents.get(file.path)!)),
    adapter: { exists: async (path: string) => contents.has(path) || folders.has(path), read: async (path: string) => contents.get(path)!,
      write: async (path: string, value: string) => { contents.set(path, value); }, remove: async (path: string) => { contents.delete(path); } },
  }, fileManager: { trashFile: async (file: TFile) => { files.delete(file.path); contents.delete(file.path); } } };
  const pack: CatalogPack = { id: "example", version: "1.0.0", digest: `sha256:${"0".repeat(64)}`, provision: "https://mdbase.dev/contracts/example.json", resource_count: 2,
    display: { name: "Example", summary: "Example" }, installation: { visibility: "default", recommendation: "user", primary_type: "example" } };
  const provision = async () => ({ manifest: { kind: "mdbase.type-pack", id: pack.id, version: pack.version, resources: [
    { kind: "contract", mode: "managed", source: "contract.md", target: "_contracts/example.md", digest: await sha256("contract") },
    { kind: "type", mode: "seed", source: "type.md", target: "_types/example.md", digest: await sha256("type") },
  ] }, resources: [{ source: "contract.md", document: "contract" }, { source: "type.md", document: "type" }] });
  return { app, contents, files, folders, pack, provision, fail: (path: string) => { failPath = path; } };
}

test("pack installs work when hidden and existing folders are already on disk", async () => {
  const f = packFixture();
  // Another mdbase app made .mdbase; Obsidian does not index hidden folders.
  f.folders.add(".mdbase"); f.folders.add("_types");
  await applyPack(f.app as never, await planPack(f.app as never, f.pack, await f.provision()), () => undefined);
  assert.equal(f.contents.get("_types/example.md"), "type");
  assert.equal(f.contents.has(".mdbase/obsidian-pack-install.json"), false);
});

test("the catalog says when a pack is installed and only offers same-version repair", async () => {
  const f = packFixture();
  assert.equal((await installedPackVersions(f.app as never)).size, 0);
  await applyPack(f.app as never, await planPack(f.app as never, f.pack, await f.provision()), () => undefined);
  const installed = await installedPackVersions(f.app as never);
  assert.equal(installed.get("example"), "1.0.0");
  assert.equal(installedStatus(f.pack, undefined), null);
  assert.deepEqual(installedStatus(f.pack, installed.get("example")), { text: "Installed.", reviewable: true });
  const newer = installedStatus({ ...f.pack, version: "1.1.0" }, installed.get("example"));
  assert.equal(newer?.reviewable, false); assert.match(newer!.text, /Version 1\.0\.0 is installed/);
});

test("catalog pack installation records a portable lock and preserves edited seeded types on reinstall", async () => {
  const f = packFixture();
  await applyPack(f.app as never, await planPack(f.app as never, f.pack, await f.provision()), () => undefined);
  const lock = JSON.parse(f.contents.get("mdbase.lock.yaml")!);
  assert.equal(lock.kind, "mdbase.type-pack-lock"); assert.equal(lock.packs[0].installed_by, "mdbase-obsidian");
  f.contents.set("_types/example.md", "my edited type");
  const next = await planPack(f.app as never, f.pack, await f.provision());
  assert.equal(next.files.find(file => file.path === "_types/example.md")?.action, "preserve");
  await applyPack(f.app as never, next, () => undefined);
  assert.equal(f.contents.get("_types/example.md"), "my edited type");
});

test("pack installs reject corrupt bytes, duplicate targets and changed review state", async () => {
  const f = packFixture(); const value = await f.provision();
  value.resources[0].document = "corrupt";
  await assert.rejects(planPack(f.app as never, f.pack, value), /digest mismatch/);
  const good = await f.provision(); good.manifest.resources[1].target = good.manifest.resources[0].target;
  await assert.rejects(planPack(f.app as never, f.pack, good), /duplicate target/);
  const plan = await planPack(f.app as never, f.pack, await f.provision());
  await f.app.vault.create("_types/example.md", "local work");
  await assert.rejects(applyPack(f.app as never, plan, () => undefined), /changed/);
  assert.equal(f.contents.get("_types/example.md"), "local work");
});

test("failed pack writes roll back exact new resources, leaving no partial lock", async () => {
  const f = packFixture(); const plan = await planPack(f.app as never, f.pack, await f.provision());
  f.fail("_types/example.md");
  await assert.rejects(applyPack(f.app as never, plan, () => undefined), /write failure/);
  assert.equal(f.files.size, 0); assert.equal(f.contents.size, 0);
});

test("restart recovery preserves competing edits and retains evidence", async () => {
  const f = packFixture();
  await f.app.vault.create("_types/example.md", "edited after crash");
  f.contents.set(".mdbase/obsidian-pack-install.json", JSON.stringify({ lockAfter: "not committed", created: [{ path: "_types/example.md", digest: await sha256("type") }] }));
  await assert.rejects(recoverPackInstall(f.app as never), /changed/);
  assert.equal(f.contents.get("_types/example.md"), "edited after crash");
  assert.ok(f.contents.has(".mdbase/obsidian-pack-install.json"));
});

test("pack cautions about engine versions read as plain advice; others are shown as written", () => {
  const engine = "Requires an mdbase engine with path-stored fields (mdbase 0.3.0-rc.6). Older engines reject the Daily note type.";
  assert.doesNotMatch(plainCaution(engine), /engine|path-stored|0\.3\.0|rc/);
  assert.match(plainCaution(engine), /recent version of mdbase/);
  const other = "Most collections do not need this pack.";
  assert.equal(plainCaution(other), other);
});
