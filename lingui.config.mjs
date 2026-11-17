import { i18nConfig } from "@mdbase-dev/i18n/config";

export default i18nConfig({
  include: ["<rootDir>/src", "<rootDir>/main.ts"],
  exclude: ["**/*.test.*", "**/*.d.ts", "**/i18n/locales/**"],
  path: "<rootDir>/src/i18n/locales/{locale}/messages",
});
