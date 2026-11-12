// SPIKE ONLY. node spike/mobile-engine/build.mjs <absolute LAB sdk package dir>
import esbuild from "esbuild";
import { engineAssets } from "./assets.mjs";
const sdk = process.argv[2];
if (!sdk) throw new Error("usage: build.mjs <sdk package dir>");
const assets = await engineAssets(sdk);
await esbuild.build({
  entryPoints: ["spike/mobile-engine/main.ts"], bundle: true, format: "cjs", target: "es2022", external: ["obsidian"], outfile: "spike/mobile-engine/dist/main.js", logLevel: "info",
  plugins: [{ name: "assets", setup(b) {
    b.onResolve({ filter: /^embedded:engine$/ }, () => ({ path: "engine", namespace: "e" }));
    b.onLoad({ filter: /.*/, namespace: "e" }, () => ({ contents: `export default ${JSON.stringify(assets)};`, loader: "js" }));
  } }],
});
console.log(Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, { bytes: v.bytes, gzB64: v.gz.length }])));
