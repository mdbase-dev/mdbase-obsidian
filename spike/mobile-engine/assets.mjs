// SPIKE ONLY. Same checks as scripts/native-assets.mjs, but gzip (the phone's
// DecompressionStream has no brotli) and the spike page entry.
import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export async function engineAssets(sdkDir) {
  const sdk = resolve(sdkDir);
  const environment = "lab";
  const trust = readFileSync(resolve(sdk, "dist/application/packaged-trust.js"), "utf8");
  if (!trust.includes(`"environment":"${environment}"`)) throw new Error("SDK must be packaged for lab");
  if (!existsSync(resolve(sdk, "dist/application/storage-scope.js"))) throw new Error("vault-isolated SDK required");
  const pins = JSON.parse(readFileSync(resolve(sdk, "dist/application/asset-pins.json")));
  const assets = {};
  for (const [name, pin] of [["runtime.wasm", pins.runtime], ["sqlite3.wasm", pins.sqlite], ["sqlite3.js", pins.sqlite.initializer]]) {
    const bytes = readFileSync(resolve(sdk, "dist/native", name));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error(`SDK integrity mismatch: ${name}`);
    assets[`sdk/native/${name}`] = bytes;
  }
  for (const [url, entry, bundle] of [["sdk/application/sdk.js", "dist/index.js", true], ["sdk/application/worker.js", "dist/application/worker.js", false]]) {
    const result = await build({ entryPoints: [resolve(sdk, entry)], absWorkingDir: sdk, bundle, platform: "browser", format: "esm", target: "es2022", minify: true, write: false });
    assets[url] = Buffer.from(result.outputFiles[0].contents);
  }
  const page = await build({
    entryPoints: ["spike/mobile-engine/page.ts"], bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, write: false,
    define: { __MDBASE_ENVIRONMENT__: JSON.stringify(environment) },
    plugins: [{ name: "native-sdk", setup(b) { b.onResolve({ filter: /^@mdbase-dev\/sdk$/ }, () => ({ path: "./sdk/application/sdk.js", external: true })); } }],
  });
  assets["app.js"] = Buffer.from(page.outputFiles[0].contents);
  const out = {};
  for (const [k, v] of Object.entries(assets)) out[k] = { gz: gzipSync(v, { level: 9 }).toString("base64"), bytes: v.length, sha256: createHash("sha256").update(v).digest("hex") };
  return out;
}
