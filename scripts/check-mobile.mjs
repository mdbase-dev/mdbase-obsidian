import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const bundle = await readFile(new URL("../main.js", import.meta.url));
const source = bundle.toString("utf8");
const gzipBytes = gzipSync(bundle).byteLength;
// Sync talks to the mdbase desktop app: the SDK's thin client and Node modules
// (through Obsidian's `window.require`) load only when sync is used, so nothing
// here may import Node built-ins at module level. The product budget is 5 MB
// (raw and gzip); this check guards against Node-only imports and runaway growth.
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
