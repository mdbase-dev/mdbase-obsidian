import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const result = await build({ entryPoints: ["src/sync/native/classify.ts"], bundle: true, format: "esm", write: false });
const { classifyPath, layoutFromConfig, globMatches, DEFAULT_LAYOUT } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);

test("paths classify the way Connect does", () => {
  const cases = [
    ["mdbase.yaml", "resource"], ["mdbase.lock.yaml", "resource"], ["mdbase.provisions.yaml", "resource"],
    ["_types/book.md", "resource"], ["_types/nested/x.md", "resource"], ["_contracts/c.yaml", "resource"],
    ["_types", "file"], ["Notes/a.md", "record"], ["Notes/A.MD", "record"], ["image.png", "file"], ["README", "file"],
    [".gitignore", "excluded"], ["notes/.draft.md", "excluded"], ["node_modules/a.md", "excluded"], ["a/node_modules/b.png", "excluded"],
  ];
  for (const [p, kind] of cases) assert.equal(classifyPath(p, DEFAULT_LAYOUT), kind, p);
});
test("layout follows mdbase.yaml settings and ignores malformed ones", () => {
  const layout = layoutFromConfig({ settings: { types_folder: "schemas/", contracts_folder: "./c", record_extensions: [".MD", "txt"], exclude: ["drafts/**"] } });
  assert.equal(classifyPath("schemas/book.md", layout), "resource");
  assert.equal(classifyPath("_types/book.md", layout), "record");
  assert.equal(classifyPath("c/x.yaml", layout), "resource");
  assert.equal(classifyPath("a.txt", layout), "record");
  assert.equal(classifyPath("drafts/a/b.md", layout), "excluded");
  assert.deepEqual(layoutFromConfig({ settings: { types_folder: 3, record_extensions: "md", exclude: [1] } }), DEFAULT_LAYOUT);
  assert.deepEqual(layoutFromConfig(null), DEFAULT_LAYOUT);
});
test("exclude globs match whole paths with spec 02 semantics", () => {
  const yes = [["*.tmp", "a.tmp"], ["drafts/**", "drafts/a/b.md"], ["**/x.md", "x.md"], ["**/x.md", "a/b/x.md"], ["a/?.md", "a/b.md"], ["[a-c]*.md", "b1.md"], ["[!a]*.md", "b.md"], ["_types", "_types"]];
  const no = [["*.tmp", "a/b.tmp"], ["drafts/**", "draftsx/a.md"], ["a/?.md", "a/bc.md"], ["[!a]*.md", "a.md"], ["_types", "_types/book.md"], ["a**/b", "a/b"], ["{a,b}.md", "a.md"], ["/a.md", "a.md"]];
  for (const [g, p] of yes) assert.equal(globMatches(g, p), true, `${g} ~ ${p}`);
  for (const [g, p] of no) assert.equal(globMatches(g, p), false, `${g} !~ ${p}`);
});
