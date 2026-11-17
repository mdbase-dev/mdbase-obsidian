import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformLinguiMacros } from "../scripts/lingui-macros.mjs";

const testDist = fileURLToPath(new URL("../.test-dist/", import.meta.url));
const i18nRuntime = `${testDist}src/i18n/runtime.js`;

const mockUrl = pathToFileURL(new URL("./obsidian-mock.cjs", import.meta.url).pathname).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "obsidian") {
    return {
      url: mockUrl,
      shortCircuit: true,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.match(/\.[a-z0-9]+$/i)) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}

// tsc leaves Lingui macros in place; compile them like the esbuild build does,
// keeping English source text so tests read real messages.
export async function load(url, context, nextLoad) {
  // tsc keeps `import x from "./messages.json"` without an import attribute,
  // which Node rejects; serve compiled catalogues as plain modules instead.
  if (url.startsWith("file:") && url.endsWith("/messages.json") && fileURLToPath(url).startsWith(testDist)) {
    return { format: "module", source: `export default ${await readFile(fileURLToPath(url), "utf8")};`, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".js")) {
    const filename = fileURLToPath(url);
    if (filename.startsWith(testDist) && !filename.includes("/node_modules/")) {
      const source = await readFile(filename, "utf8");
      const code = await transformLinguiMacros(source, filename, { runtime: i18nRuntime, descriptorFields: "all" });
      if (code !== null) return { format: "module", source: code, shortCircuit: true };
    }
  }
  return nextLoad(url, context);
}
