import { transformAsync } from "@babel/core";
import { readFile } from "node:fs/promises";
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
