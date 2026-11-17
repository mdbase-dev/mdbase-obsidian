import { transformAsync } from "@babel/core";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Imported, not require()d: these are ES modules, and the test loader's hook
// thread cannot require ES modules.
import macroPlugin from "@lingui/babel-plugin-lingui-macro";
import { getConfig } from "@lingui/conf";

const root = fileURLToPath(new URL("../", import.meta.url));
let linguiConfig;

const specifier = (from, to) => {
  const path = relative(dirname(from), to).replace(/\\/g, "/").replace(/\.[cm]?[jt]s$/, "");
  return path.startsWith(".") ? path : `./${path}`;
};

/**
 * Compiles Lingui core macros in one source file. Macros bind to the plugin's
 * own runtime module, which activates English as soon as it loads, so a string
 * can never be looked up before a catalogue exists.
 */
export async function transformLinguiMacros(source, filename, { runtime, descriptorFields }) {
  if (!source.includes("@lingui/core/macro")) return null;
  linguiConfig ??= getConfig({ cwd: root });
  const result = await transformAsync(source, {
    filename, cwd: root, babelrc: false, configFile: false, sourceMaps: false,
    parserOpts: { plugins: ["typescript"] },
    plugins: [[macroPlugin, {
      descriptorFields,
      linguiConfig: { ...linguiConfig, runtimeConfigModule: { ...linguiConfig.runtimeConfigModule, i18n: [specifier(filename, runtime), "i18n"] } },
    }]],
  });
  return result.code;
}

/** esbuild plugin: production bundles keep only message IDs. */
export function linguiMacros({ production }) {
  const runtime = resolve(root, "src/i18n/runtime.ts");
  return {
    name: "lingui-core-macros",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        if (path.includes("/node_modules/")) return undefined;
        const contents = await transformLinguiMacros(await readFile(path, "utf8"), path, {
          runtime, descriptorFields: production ? "id-only" : "all",
        });
        return contents === null ? undefined : { contents, loader: "ts" };
      });
    },
  };
}

/**
 * esbuild plugin for release bundles: stores each non-English compiled
 * catalogue deflated, and inflates it (synchronously, with no Node APIs) only
 * when that language is activated. English stays plain, ready at startup.
 */
export function compressedCatalogues() {
  return {
    name: "compressed-catalogues",
    setup(build) {
      build.onLoad({ filter: /\/src\/i18n\/locales\/[a-z]+\/messages\.json$/ }, async ({ path }) => {
        if (path.endsWith("/en/messages.json")) return undefined;
        const { messages } = JSON.parse(await readFile(path, "utf8"));
        const packed = deflateSync(Buffer.from(JSON.stringify(messages)), { level: 9 }).toString("base64");
        return {
          contents: `import { strFromU8, unzlibSync } from "fflate";
let messages;
export default { get messages() {
  return messages ??= JSON.parse(strFromU8(unzlibSync(Uint8Array.from(atob(${JSON.stringify(packed)}), (char) => char.charCodeAt(0)))));
} };`,
          loader: "js", resolveDir: root, watchFiles: [path],
        };
      });
    },
  };
}
