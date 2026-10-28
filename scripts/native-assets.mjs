// URL-addressed SDK tree, embedded lazily in the desktop-only host.
import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { createHash } from "node:crypto";

export async function nativeAssets() {
  const index = process.argv.indexOf("--native-sdk");
  const sdk = resolve(index < 0 ? "node_modules/@mdbase-dev/sdk" : process.argv[index + 1]);
  const environment = process.argv.includes("--lab") ? "lab" : "production";
  const trust = readFileSync(resolve(sdk, "dist/application/packaged-trust.js"), "utf8");
  if (!trust.includes(`"environment":"${environment}"`)) throw new Error(`Native SDK must be authentically packaged for ${environment}; no environment retargeting`);
  const declaration = readFileSync(resolve(sdk, "dist/application/declaration.js"), "utf8");
  if (!declaration.includes("native")) throw new Error("A native-platform SDK with vault namespace isolation is required");
  const namespacePath = resolve(sdk, "dist/application/storage-scope.js");
  if (!existsSync(namespacePath)) throw new Error("Native sync build blocked: replace the pinned SDK with an authenticated production bundle containing native-platform and vault-isolation support");
  const namespace = readFileSync(namespacePath, "utf8");
  if (!namespace.includes("bundle-storage:")) throw new Error("A vault-isolated native SDK is required");
  const pins = JSON.parse(readFileSync(resolve(sdk, "dist/application/asset-pins.json")));
  const assets = {
    "/index.html": Buffer.from('<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/app.js"></script></body></html>'),
  };
  for (const [name, pin] of [["runtime.wasm", pins.runtime], ["sqlite3.wasm", pins.sqlite], ["sqlite3.js", pins.sqlite.initializer]]) {
    const bytes = readFileSync(resolve(sdk, "dist/native", name));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error(`SDK integrity mismatch: ${name}`);
    assets[`/sdk/native/${name}`] = bytes;
  }
  // Newer SDKs may package the official OPFS async proxy too.
  if (pins.sqlite.asyncProxy) {
    const bytes = readFileSync(resolve(sdk, "dist/native/sqlite3-opfs-async-proxy.js"));
    if (bytes.length !== pins.sqlite.asyncProxy.bytes || createHash("sha256").update(bytes).digest("hex") !== pins.sqlite.asyncProxy.sha256) throw new Error("SDK proxy integrity mismatch");
    assets["/sdk/native/sqlite3-opfs-async-proxy.js"] = bytes;
  }
  for (const [url, entry, bundle] of [
    ["/sdk/application/sdk.js", "dist/index.js", true],
    ["/sdk/application/worker.js", "dist/application/worker.js", false],
  ]) {
    const result = await build({ entryPoints: [resolve(sdk, entry)], absWorkingDir: sdk, bundle, platform: "browser", format: "esm", target: "es2022", minify: true, write: false });
    assets[url] = Buffer.from(result.outputFiles[0].contents);
  }
  const page = await build({
    entryPoints: ["src/sync/native/page.ts"], bundle: true, platform: "browser", format: "esm", target: "es2022", minify: true, write: false,
    define: { __MDBASE_ENVIRONMENT__: JSON.stringify(environment) },
    plugins: [{ name: "native-sdk", setup(b) {
      b.onResolve({ filter: /^@mdbase-dev\/sdk$/ }, () => ({ path: "./sdk/application/sdk.js", external: true }));
    } }],
  });
  assets["/app.js"] = Buffer.from(page.outputFiles[0].contents);
  return Object.fromEntries(Object.entries(assets).map(([url, bytes]) => [url, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).toString("base64")]));
}
