import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { Notice, TFile } from "obsidian";
import { loadMdbaseConfig } from "../src/collectionConfig";
import { createLinkedNote } from "../src/createTypedNoteModal";
import { linkField, linkRows, linkTargets, missingLinkNote, wikilink, type LinkRow } from "../src/links";
import { linkTrigger, TypedLinkSuggest } from "../src/linkSuggest";
import { parseFrontmatter, type CollectionRecord, type MdbaseConfig, type MdbaseIssue, type MdbaseTypeDef } from "../src/mdbaseCore";
import { NoteLinks } from "../src/noteLinks";
import { createNoteFromType, fileNameFrom } from "../src/noteCreation";
import { loadTypeDefinitions } from "../src/typeDefinitions";
import { validateFile } from "../src/validation";
import { MemoryVault } from "./memoryVault";

const ROOT = join(process.cwd(), "mdbase-test-vault");

/** The committed test vault: books that link to people. */
async function library() {
  const vault = new MemoryVault();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await vault.createFolder(relative(ROOT, full));
        await walk(full);
      } else await vault.create(relative(ROOT, full), readFileSync(full, "utf8"));
    }
  };
  await walk(ROOT);
  const config = await loadMdbaseConfig(vault as never) as MdbaseConfig;
  const types = await loadTypeDefinitions(vault as never, config);
  const records = (): CollectionRecord[] => [...vault.files.values()]
    .filter(({ file }) => file.extension === "md" && !file.path.startsWith("_types/"))
    .map(({ file, content }) => ({ path: file.path, frontmatter: parseFrontmatter(content).frontmatter }));
  const host = {
    app: { vault } as never,
    createTypedNote: (path: string, frontmatter: Record<string, unknown>) => createNoteFromType(vault as never, path, frontmatter),
  };
  return { vault, config, types, records, host };
}

const describe = (rows: LinkRow[]): string[] => rows.map((row) =>
  row.kind === "note" ? row.target.path : row.kind === "create" ? `+${row.type.name}:${row.name}` : `+…:${row.name}`);

test("notes are suggested by the name their type gives them, then a note of each type can be created", async () => {
  const { config, types, records } = await library();
  const targets = linkTargets(records(), config, types);
  const ursula = targets.find((target) => target.path === "People/Ursula K. Le Guin.md");
  assert.deepEqual(ursula, { path: "People/Ursula K. Le Guin.md", name: "Ursula K. Le Guin", types: ["person"] });
  // Typed only by its path, and named by its file: it has no title.
  assert.deepEqual(targets.find((target) => target.path === "Library/Untyped draft.md")?.types, ["book"]);

  // A word inside the name matches; the most used type is offered first.
  assert.deepEqual(describe(linkRows(targets, "guin", types)),
    ["People/Ursula K. Le Guin.md", "+book:guin", "+note:guin", "+person:guin"]);
  assert.deepEqual(describe(linkRows(targets, "", types)).length, 8, "nothing typed lists notes only");
  assert.ok(linkRows(targets, "", types).every((row) => row.kind === "note"));
});

test("a link field's suggestions keep to the type it points at", async () => {
  const { config, types, records } = await library();
  const targets = linkTargets(records(), config, types);
  assert.deepEqual(linkField(types.get("book") as MdbaseTypeDef, "author"), { type: "person" });
  assert.equal(linkField(types.get("book") as MdbaseTypeDef, "title"), null);
  assert.deepEqual(describe(linkRows(targets, "", types, "person")),
    ["People/Ted Chiang.md", "People/Ursula K. Le Guin.md"]);
  assert.deepEqual(describe(linkRows(targets, "Octavia Butler", types, "person")), ["+person:Octavia Butler"]);
  // Someone of that name is already there: nothing to create.
  assert.deepEqual(describe(linkRows(targets, "ted chiang", types, "person")), ["People/Ted Chiang.md"]);
});

test("a collection with many types offers the most used and one row for the rest", () => {
  const types = new Map(["a", "b", "c", "d", "e", "f", "g"].map((name) =>
    [name, { name, fields: {}, filePath: `_types/${name}.md` } as MdbaseTypeDef]));
  const targets = [{ path: "x.md", name: "x", types: ["f"] }, { path: "y.md", name: "y", types: ["f"] }, { path: "z.md", name: "z", types: ["c"] }];
  assert.deepEqual(describe(linkRows(targets, "New", types)), ["+f:New", "+c:New", "+a:New", "+b:New", "+…:New"]);
});

test("a frontmatter link names the note when its file is called something else", () => {
  assert.equal(wikilink({ path: "People/Ted Chiang.md", name: "Ted Chiang" }), "[[People/Ted Chiang]]");
  assert.equal(wikilink({ path: "People/ted-chiang.md", name: "Ted Chiang" }), "[[People/ted-chiang|Ted Chiang]]");
});

test("a new note's file is called what the note is, less what a file name or link can't hold", () => {
  assert.equal(fileNameFrom("Ursula K. Le Guin"), "Ursula K. Le Guin");
  assert.equal(fileNameFrom("東京の夜"), "東京の夜");
  assert.equal(fileNameFrom("  What is 1/2 of [x]?  #draft "), "What is 1 2 of x draft");
  assert.equal(fileNameFrom("..hidden. "), "hidden");
  assert.equal(fileNameFrom("?:*"), "note");
  assert.equal(fileNameFrom("a".repeat(200)).length, 80);
});

test("@ starts a link only where a mention would be written", () => {
  assert.deepEqual(linkTrigger("@"), { query: "", from: 0 });
  assert.deepEqual(linkTrigger("Read with @Ursula K"), { query: "Ursula K", from: 10 });
  assert.deepEqual(linkTrigger("(@ted"), { query: "ted", from: 1 });
  assert.equal(linkTrigger("write to name@example.com"), null);
  assert.equal(linkTrigger("at @ noon"), null, "a lone @ followed by a space is not a mention");
  assert.equal(linkTrigger("use `@decorator"), null, "inline code");
  assert.equal(linkTrigger("@one two three four five six"), null, "prose that happens to follow an @");
  assert.equal(linkTrigger("@ted  "), null);
});

test("a missing link can be settled by creating the note it points at", async () => {
  const { vault, config, types, host } = await library();
  const broken = vault.getAbstractFileByPath("Library/Broken record.md") as TFile;
  const missing = (await validateFile(vault as never, broken, config, types)).find((issue) => issue.code === "link_not_found");
  assert.ok(missing, "the broken record links to nobody");
  const note = missingLinkNote(missing, config, types);
  assert.deepEqual(note && { type: note.type.name, name: note.name, path: note.path },
    { type: "person", name: "Nobody", path: "People/Nobody.md" });

  const created = await createLinkedNote(host, note!.type, note!.name, config, types, { path: note!.path });
  assert.deepEqual(created, { path: "People/Nobody.md", name: "Nobody", types: ["person"] });
  assert.deepEqual(parseFrontmatter(vault.read("People/Nobody.md")!).frontmatter, { type: "person", name: "Nobody" });
  const after = await validateFile(vault as never, broken, config, types);
  assert.ok(!after.some((issue) => issue.field === "author"), `the link resolves now: ${JSON.stringify(after)}`);
});

test("a missing link is only settled where the note's type and place are certain", async () => {
  const { config, types } = await library();
  const issue = (link: unknown, target: unknown, code = "link_not_found"): MdbaseIssue =>
    ({ path: "Library/a.md", code, message: "", severity: "error", field: "author", details: { link, target_type: target } });
  // A bare name goes where people go; a link with a folder is created where it says.
  assert.equal(missingLinkNote(issue("[[Octavia Butler|Butler]]", "person"), config, types)?.path, "People/Octavia Butler.md");
  assert.equal(missingLinkNote(issue("Authors/Octavia Butler.md", "person"), config, types)?.path, "Authors/Octavia Butler.md");
  assert.equal(missingLinkNote(issue("[[Octavia Butler]]", "person", "missing_link_target"), config, types)?.name, "Octavia Butler");
  for (const [link, target, why] of [
    ["[[Octavia Butler]]", undefined, "the field takes any note"],
    ["[[Octavia Butler]]", "any", "the field takes any note"],
    ["[[Octavia Butler]]", "publisher", "the type isn't defined"],
    ["https://example.com/butler", "person", "a web address"],
    ["[[../Octavia Butler]]", "person", "outside the vault"],
    ["[[_types/Octavia Butler]]", "person", "not part of the collection"],
    ["[[.hidden/Octavia Butler]]", "person", "a hidden folder"],
    ["[[#heading]]", "person", "no note named"],
  ] as const) assert.equal(missingLinkNote(issue(link, target), config, types), null, why);
  assert.equal(missingLinkNote(issue("[[Octavia Butler]]", "person", "link_wrong_type"), config, types), null);
});

test("a type that asks only for a name gets its note without a form", async () => {
  const { vault, config, types, host } = await library();
  const created = await createLinkedNote(host, types.get("person") as MdbaseTypeDef, "Octavia Butler", config, types);
  // The file is called what the person is: the link reads the same as the name.
  assert.deepEqual(created, { path: "People/Octavia Butler.md", name: "Octavia Butler", types: ["person"] });
  assert.equal(wikilink(created!), "[[People/Octavia Butler]]");
  assert.deepEqual(parseFrontmatter(vault.read("People/Octavia Butler.md")!).frontmatter, { type: "person", name: "Octavia Butler" });
});

function linksFixture(vault: MemoryVault, config: MdbaseConfig, types: Map<string, MdbaseTypeDef>, records: () => CollectionRecord[]) {
  let list = records();
  const plugin = {
    app: {
      vault,
      metadataCache: { getFileCache: () => ({ frontmatterPosition: { end: { line: 2 } }, sections: [{ type: "code", position: { start: { line: 6 }, end: { line: 8 } } }] }) },
      fileManager: {
        generateMarkdownLink: (file: TFile, _source: string, _subpath: string, alias: string) =>
          alias ? `[[${file.basename}|${alias}]]` : `[[${file.basename}]]`,
      },
    },
    settings: { linkSuggestions: true },
    loadWorkspaceSchema: async () => ({ config, types }),
    loadCollectionRecords: async () => list,
    createTypedNote: (path: string, frontmatter: Record<string, unknown>) => createNoteFromType(vault as never, path, frontmatter),
  };
  return { plugin, links: new NoteLinks(plugin as never), changed: () => { list = records(); } };
}

test("link targets are worked out once per change to the collection", async () => {
  const { vault, config, types, records } = await library();
  const { links, changed } = linksFixture(vault, config, types, records);
  const first = await links.targets();
  assert.equal(await links.targets(), first);
  await vault.create("People/Octavia Butler.md", "---\ntype: person\nname: Octavia Butler\n---\n");
  changed();
  assert.ok((await links.targets()).some((target) => target.name === "Octavia Butler"));
  assert.equal(await links.linkTypes("_types/book.md"), null, "a type definition is not a note to link from");
  assert.ok(await links.linkTypes("Notes/Reading list.md"));
});

test("choosing a suggestion replaces the @ with a link, creating the note first when asked", async () => {
  const { vault, config, types, records } = await library();
  const { plugin, links } = linksFixture(vault, config, types, records);
  const suggest = new TypedLinkSuggest(links);
  const file = vault.getAbstractFileByPath("Notes/Reading list.md") as TFile;
  let line = "Next: @octavia";
  const editor = {
    getLine: () => line,
    getRange: (from: { ch: number }, to: { ch: number }) => line.slice(from.ch, to.ch),
    replaceRange: (text: string, from: { ch: number }, to: { ch: number }) => { line = line.slice(0, from.ch) + text + line.slice(to.ch); },
    setCursor: () => undefined,
    replaceSelection: (text: string) => { line += text; },
  };
  const cursor = { line: 4, ch: line.length };
  const trigger = suggest.onTrigger(cursor, editor as never, file);
  assert.deepEqual(trigger, { start: { line: 4, ch: 6 }, end: cursor, query: "octavia" });
  assert.equal(suggest.onTrigger({ line: 1, ch: line.length }, editor as never, file), null, "properties");
  assert.equal(suggest.onTrigger({ line: 7, ch: line.length }, editor as never, file), null, "a code block");
  plugin.settings.linkSuggestions = false;
  assert.equal(suggest.onTrigger(cursor, editor as never, file), null, "turned off");
  plugin.settings.linkSuggestions = true;

  const context = { ...trigger!, editor, file } as never;
  const rows = await suggest.getSuggestions(context);
  assert.deepEqual(describe(rows), ["+book:octavia", "+note:octavia", "+person:octavia"]);
  suggest.context = context;
  suggest.selectSuggestion(rows[2]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(line, "Next: [[octavia]]");
  assert.ok(vault.getAbstractFileByPath("People/octavia.md"));
  assert.ok((Notice as unknown as { messages: string[] }).messages.includes("Created People/octavia.md"));

  // An existing note is linked by its name.
  line = "By @ted";
  const again = { start: { line: 4, ch: 3 }, end: { line: 4, ch: 7 }, query: "ted", editor, file } as never;
  suggest.context = again;
  const [ted] = await suggest.getSuggestions(again);
  suggest.selectSuggestion(ted);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(line, "By [[Ted Chiang]]");
});

test("a missing link whose note has since appeared needs nothing created", async () => {
  const { vault, config, types, records } = await library();
  const { links } = linksFixture(vault, config, types, records);
  const issue: MdbaseIssue = { path: "Library/Broken record.md", code: "link_not_found", message: "", severity: "error", field: "author",
    details: { link: "[[People/Nobody]]", target_type: "person" } };
  assert.equal(links.missingLinkLabel(issue, { config, types }), "Create person “Nobody”");
  assert.equal(links.missingLinkLabel(issue, null), null);
  assert.equal(await links.createMissingLink(issue), true);
  const created = vault.read("People/Nobody.md");
  assert.equal(await links.createMissingLink(issue), true);
  assert.equal(vault.read("People/Nobody.md"), created);
  assert.equal(await links.createMissingLink({ ...issue, details: {} }), false);
});
