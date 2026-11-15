import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

export function checkNativeSdk(sdk) {
  const entry = resolve(sdk, "dist/index.d.ts");
  if (!existsSync(entry)) throw new Error(`Native SDK API mismatch (${sdk}); package declarations are missing`);
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([resolve(root, "src/sync/native/page.ts")], {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    paths: { "@mdbase-dev/sdk": [entry] },
  });
  const diagnostics = [config.error, ...parsed.errors, ...ts.getPreEmitDiagnostics(program)].filter(Boolean);
  if (diagnostics.length) {
    const details = ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    });
    throw new Error(`Native SDK API mismatch (${sdk}); use a package matching the plugin's SDK API.\n${details}`);
  }
}
