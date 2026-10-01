import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bundle = await readFile(new URL("../main.js", import.meta.url));
const source = bundle.toString("utf8");
const gzipBytes = gzipSync(bundle).byteLength;
// The type-workbench baseline adds record impact previews, constraint editing,
// the YAML source editor (CodeMirror itself is supplied by Obsidian, not bundled),
// rule-grouped issues, and adoption recovery on top of the sync-polish work.
// The UX acceptance baseline also includes digest-verified contract installation,
// draft recovery, typed creation, validation freshness and complete transfer browsing.
// Reviewed growth: about 27 KiB raw / 8 KiB gzip; no new runtime dependencies.
// Keep a narrow margin so unintentional dependency growth remains visible.
const rawBudget = 760 * 1024;
const gzipBudget = 220 * 1024;
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
