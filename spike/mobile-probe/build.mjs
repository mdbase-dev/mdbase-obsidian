// SPIKE ONLY. node spike/mobile-probe/build.mjs (from the repo root)
import esbuild from "esbuild";
await esbuild.build({ entryPoints: ["spike/mobile-probe/main.ts"], bundle: true, format: "cjs", target: "es2022", external: ["obsidian"], outfile: "spike/mobile-probe/dist/main.js", logLevel: "info" });
