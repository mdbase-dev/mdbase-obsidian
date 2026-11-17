// Reports every problem in one or more locales' PO files at once, for
// translators: missing or fuzzy translations, English left in place, and ICU
// contract errors (placeholders, plural categories). `npm run i18n:check` is
// still the release gate; it stops at the first problem.
//
//   node scripts/i18n-locale-check.mjs fr de
import { readFile } from "node:fs/promises";
import { formatter } from "@lingui/format-po";
import { assertMessageContract } from "@mdbase-dev/i18n/checks";

const locales = process.argv.slice(2);
if (!locales.length) throw new Error("Usage: node scripts/i18n-locale-check.mjs <locale> [...]");
const policy = JSON.parse(await readFile("i18n-policy.json", "utf8"));
const load = async (locale) => formatter({}).parse(await readFile(`src/i18n/locales/${locale}/messages.po`, "utf8"), { locale });
const active = (entries) => Object.entries(entries).filter(([, entry]) => !entry.obsolete);
const english = Object.fromEntries(active(await load("en")));
const normalized = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();

let failed = false;
for (const locale of locales) {
  const allowed = policy.allowIdentical?.[locale] ?? [];
  const target = Object.fromEntries(active(await load(locale)));
  const problems = [];
  for (const [id, source] of Object.entries(english)) {
    const entry = target[id];
    const translation = entry?.translation?.trim();
    if (!translation) { problems.push(`missing      ${id}  ${JSON.stringify(source.message)}`); continue; }
    if (entry.extra?.flags?.includes("fuzzy")) problems.push(`fuzzy        ${id}`);
    if (locale !== "en" && normalized(translation) === normalized(source.message) && !allowed.includes(id))
      problems.push(`same as en   ${id}  ${JSON.stringify(source.message)} (translate it, or add the ID to i18n-policy.json allowIdentical.${locale} if it is a name or a term that is correct unchanged)`);
    try {
      assertMessageContract(source.message, entry.translation, locale, (warning) => {
        if (!allowed.includes(id)) problems.push(`warning      ${id}  ${warning}`);
      }, () => {});
    } catch (error) {
      problems.push(`ICU error    ${id}  ${error.message}`);
    }
  }
  const extra = Object.keys(target).filter((id) => !english[id]);
  for (const id of extra) problems.push(`not in en    ${id} (run npm run i18n:extract)`);
  console.log(`${locale}: ${Object.keys(english).length} messages, ${problems.length} problems`);
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length) failed = true;
}
process.exitCode = failed ? 1 : 0;
