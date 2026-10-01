import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bundle = await readFile(new URL("../main.js", import.meta.url));
const source = bundle.toString("utf8");
const gzipBytes = gzipSync(bundle).byteLength;
// The type-workbench baseline adds record impact previews, constraint editing,
// the YAML source editor (CodeMirror itself is supplied by Obsidian, not bundled),
// rule-grouped issues, and adoption recovery on top of the sync-polish work.
// connect-sync beta.120 adds ~1.3 KB (lossless malformed-frontmatter handling
// and Obsidian Bases as YAML document records). The sync session (one-step
// sync with a safety check for routine plans, automatic sync and a unified
// history log) and the sync settings tab add ~3.3 KB.
// Keep a narrow margin over that reviewed production bundle so unintentional
// dependency growth is visible.
// Reviewed UX and partial-sync additions on the beta.120 workspace baseline.
// Sync reliability adds ~25 KB raw / ~8 KB gzip: request deadlines and retry,
// the sync scheduler, automatic conflict settling with a three-way merge
// (node-diff3 is ~5 KB of that), device ownership and diagnostics.
// The product budget is 5 MB (raw and gzip); this check still guards against
// Node-only imports and runaway growth.
const rawBudget = 5 * 1024 * 1024;
const gzipBudget = 5 * 1024 * 1024;
const forbidden = [
  /require\((["'])node:(?:fs|path|crypto|os|worker_threads|child_process)\1\)/,
  /require\((["'])(?:fs|path|crypto|os|worker_threads|child_process)\1\)/,
  /from (["'])node:(?:fs|path|crypto|os|worker_threads|child_process)\1/,
];

const violations = forbidden.filter((pattern) => pattern.test(source));
if (violations.length) {
  throw new Error("Mobile bundle contains a Node-only runtime import.");
}
if (bundle.byteLength > rawBudget) {
  throw new Error(`Mobile bundle is ${bundle.byteLength} bytes; budget is ${rawBudget}.`);
}
if (gzipBytes > gzipBudget) {
  throw new Error(`Gzipped mobile bundle is ${gzipBytes} bytes; budget is ${gzipBudget}.`);
}

console.log(JSON.stringify({
  mobile_safe: true,
  raw_bytes: bundle.byteLength,
  gzip_bytes: gzipBytes,
  raw_budget: rawBudget,
  gzip_budget: gzipBudget,
}));
