import { setupI18n, type Messages } from "@lingui/core";
import { formatters, locales, negotiateLocale, type Locale } from "@mdbase-dev/i18n";
import en from "./locales/en/messages.json";
import fr from "./locales/fr/messages.json";
import de from "./locales/de/messages.json";
import es from "./locales/es/messages.json";
import ja from "./locales/ja/messages.json";
import ko from "./locales/ko/messages.json";
import pt from "./locales/pt/messages.json";
import ru from "./locales/ru/messages.json";
import zh from "./locales/zh/messages.json";
import it from "./locales/it/messages.json";

/**
 * The plugin's own Lingui instance. Every `t`/`plural`/`msg` macro in the
 * plugin compiles to a call on this object (see scripts/lingui-macros.mjs), so
 * English is active from the moment any translated module loads.
 */
export const i18n = setupI18n();

// Lingui decodes \uXXXX and \xXX escapes after interpolation, so a path such as
// `C:\x41` would render as `C:A`. Encode backslashes in values so user data
// (file names, paths, YAML) is shown exactly as written.
const literal = (values?: Record<string, unknown>) => values && Object.fromEntries(Object.entries(values)
  .map(([key, value]) => [key, typeof value === "string" ? value.replace(/\\/g, "\\u005c") : value]));
const render = i18n._.bind(i18n) as (id: unknown, values?: Record<string, unknown>, options?: unknown) => string;
const translate = ((id: unknown, values?: Record<string, unknown>, options?: unknown) =>
  typeof id === "object" && id !== null
    ? render({ ...id, values: literal((id as { values?: Record<string, unknown> }).values) }, literal(values), options)
    : render(id, literal(values), options)) as typeof i18n._;
i18n._ = translate;
i18n.t = translate;

const catalogues: Record<Locale, { messages: unknown }> = { en, fr, de, es, ja, ko, pt, ru, zh, it };
i18n.load("en", en.messages as unknown as Messages);
i18n.activate("en");

export { locales, type Locale };

/**
 * Activates the catalogue for Obsidian's display language (`getLanguage()`),
 * falling back to English. Obsidian restarts when its language changes, so
 * this runs once, before the plugin builds any UI.
 */
export function activateLanguage(language: string): Locale {
  const locale = negotiateLocale([language]);
  if (locale !== i18n.locale) {
    if (locale !== "en") i18n.load(locale, catalogues[locale].messages as Messages);
    i18n.activate(locale);
  }
  return locale;
}

/** BCP 47 tag for `Intl` APIs: Portuguese is Brazilian, Chinese is Simplified. */
export function localeTag(): string {
  return i18n.locale === "pt" ? "pt-BR" : i18n.locale === "zh" ? "zh-CN" : i18n.locale;
}

/** Display-only formatting in the active language. Never use for stored values. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatters(i18n.locale).number(value, options);
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return formatters(i18n.locale).date(value, options);
}
