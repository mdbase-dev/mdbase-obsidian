// Development only: compiles catalogues with English fallback for untranslated
// messages, so work in progress builds. Releases use `mdbase-i18n check`, which
// rejects missing translations before compiling strictly.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const kit = createRequire(createRequire(import.meta.url).resolve("@mdbase-dev/i18n/config"));
const lingui = join(dirname(kit.resolve("@lingui/cli")), "lingui.js");
console.warn("DEVELOPMENT ONLY: missing translations fall back to English.");
execFileSync(process.execPath, [lingui, "compile", "--workers", "1"], { stdio: "inherit" });
