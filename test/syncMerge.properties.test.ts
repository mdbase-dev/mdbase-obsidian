import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { parse } from "yaml";
import { mergeDocuments } from "../src/syncMerge";

const validYaml = (yaml: string) => {
  try {
    const value: unknown = parse(yaml);
    return value === null || (typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
};
const merge = (base: string, local: string, remote: string) => mergeDocuments(base, local, remote, validYaml);

// Stable Mulberry32: a failure identifies its seed and iteration for replay.
function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const field = (key: string, value: string, style: number) => [
  `${key}: "${value}" # inline comment`,
  `${key}: |\n  ${value}\n  literal --- and emoji 🥒`,
  `${key}: >-\n  ${value}\n  continuation`,
  `${key}: {nested: "${value}", list: [a, b]}`,
  `${key}:\n  nested:\n    value: "${value}"\n  list:\n    - α\n    - 🥒`,
  `${key}: ["${value}", "emoji 🥒"]`,
][style]!;

for (const seed of [1, 0xC0FFEE, 0xDEADBEEF]) {
  test(`seed ${seed}: disjoint field/body edits are verbatim, valid and never invented`, () => {
    const next = random(seed);
    for (let iteration = 0; iteration < 200; iteration++) {
      const styleA = Math.floor(next() * 6);
      const styleB = Math.floor(next() * 6);
      const eol = next() < 0.5 ? "\n" : "\r\n";
      const bom = next() < 0.5 ? "" : "\uFEFF";
      const trailing = next() < 0.5 ? "" : "\n";
      const preamble = next() < 0.5 ? "# header comment\n" : "\n";
      const a = `local-${seed}-${iteration}-α🥒`;
      const b = `hosted-${seed}-${iteration}-β🌈`;
      const render = (left: string, right: string, first: string, last: string) =>
        `${bom}---\n${preamble}${field("left", left, styleA)}\n${field("right", right, styleB)}\n---\n${first}\n\n---\n\n${last}${trailing}`.split("\n").join(eol);
      const base = render("base-left", "base-right", "first", "last");
      const local = render(a, "base-right", `first-${a}`, "last");
      const remote = render("base-left", b, "first", `last-${b}`);
      const expected = render(a, b, `first-${a}`, `last-${b}`);
      const result = merge(base, local, remote);
      assert.deepEqual(result, { clean: true, text: expected }, `iteration ${iteration}`);
      if (!result.clean) continue;
      const sourceLines = new Set([base, local, remote].flatMap((text) => text.split("\n")));
      for (const line of result.text.split("\n")) assert.ok(sourceLines.has(line), `invented ${line}`);
      assert.equal(validYaml(result.text.split(eol).slice(1, result.text.split(eol).indexOf("---", 1)).join(eol) + eol), true);
    }
  });
}

test("overlapping generated fields keep both, including block scalars and nested maps", () => {
  for (let style = 0; style < 6; style++) {
    const render = (value: string) => `---\n${field("value", value, style)}\n---\nBody`;
    assert.equal(merge(render("base"), render("local α"), render("hosted 🥒")).clean, false);
  }
});

test("field additions and deletions preserve every independent change", () => {
  const base = "---\n# header\na: 1\nb: 2\nc: 3\n---\nBody";
  const local = base.replace("b: 2\n", "");
  const remote = base.replace("c: 3", "c: 4\nd: [α, 🥒]");
  assert.deepEqual(merge(base, local, remote), { clean: true, text: local.replace("c: 3", "c: 4\nd: [α, 🥒]") });
});

test("duplicate keys are not emitted by a combined merge", () => {
  const base = "---\na: 1\na: 2\nb: 1\n---\nBody";
  assert.equal(merge(base, base.replace("a: 1", "a: 3"), base.replace("b: 1", "b: 4")).clean, false);
});

test("added or removed frontmatter with another body edit keeps both", () => {
  const plain = "Body\n\n---\ninside body";
  const frontmatter = `---\n\n---\n${plain}`;
  assert.equal(merge(plain, frontmatter, plain.replace("Body", "Edited")).clean, false);
  assert.equal(merge(frontmatter, plain, frontmatter.replace("Body", "Edited")).clean, false);
});

// Isolate performance cases so a regression cannot hang the entire test runner.
async function largeMerge(scenario: string, mustMerge = false): Promise<void> {
  const moduleUrl = new URL("../src/syncMerge.js", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    import(${JSON.stringify(moduleUrl)}).then(({ mergeDocuments }) => {
      const body = "a\\n".repeat(512 * 1024);
      let base = "---\\nstatus: open\\n---\\n" + body;
      ${scenario}
      parentPort.postMessage(mergeDocuments(base, local, remote, () => true));
    });
  `, { eval: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("1 MB merge exceeded 3 seconds")), 3000);
      worker.once("error", (error) => { clearTimeout(timer); reject(error); });
      worker.once("message", (result: { clean: boolean; text?: string }) => {
        clearTimeout(timer);
        try {
          if (mustMerge) assert.equal(result.clean, true, "unchanged bulk must not prevent a small clean merge");
          // Keeping both is acceptable for pathological diffs; a clean merge
          // must retain both edits, not return a partial result.
          if (result.clean) {
            assert.ok(result.text?.includes("local edit"));
            assert.ok(result.text?.includes("hosted edit"));
          }
          resolve();
        } catch (error) { reject(error); }
      });
    });
  } finally {
    await worker.terminate();
  }
}

test("1 MB repeated-line body with independent frontmatter edit stays responsive", async () => {
  await largeMerge(`const local = base.replace("status: open", "status: local edit");
    const remote = base + "hosted edit\\n";`);
});

test("1 MB unchanged prefix does not force conflict copies for small disjoint edits", async () => {
  await largeMerge(`base += "alpha\\n\\nbeta\\n\\ngamma\\n";
    const local = base.replace("alpha", "local edit");
    const remote = base.replace("gamma", "hosted edit");`, true);
});

test("1 MB repeated-line body edited on both sides stays responsive", async () => {
  await largeMerge(`const local = base.replace("---\\na", "---\\nlocal edit");
    const remote = base + "hosted edit\\n";`);
});
