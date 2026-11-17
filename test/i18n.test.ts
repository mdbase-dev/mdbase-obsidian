import * as assert from "node:assert/strict";
import { test } from "node:test";
import { activateLanguage, formatNumber, i18n, localeTag } from "../src/i18n/runtime";
import { ValidationState } from "../src/validationState";

test("follows Obsidian's language, by base language, falling back to English", (t) => {
  t.after(() => activateLanguage("en"));
  assert.equal(activateLanguage("fr"), "fr");
  assert.equal(i18n.locale, "fr");
  assert.equal(activateLanguage("pt-BR"), "pt");
  assert.equal(localeTag(), "pt-BR");
  assert.equal(activateLanguage("zh-TW"), "zh");
  assert.equal(localeTag(), "zh-CN");
  assert.equal(activateLanguage("uk"), "en");
  assert.equal(localeTag(), "en");
});

test("formats numbers for the active language", (t) => {
  t.after(() => activateLanguage("en"));
  assert.equal(formatNumber(1234567), "1,234,567");
  activateLanguage("de");
  assert.equal(formatNumber(1234567), "1.234.567");
});

test("renders English messages with plurals", () => {
  const state = new ValidationState();
  assert.equal(state.summary(["a.md"]), "Not checked yet");
  state.markChecked("a.md");
  assert.equal(state.summary(["a.md"]), "Checked 1 of 1 note · duplicate values not checked yet");
  assert.equal(state.summary(["a.md", "b.md"]), "Checked 1 of 2 notes · duplicate values not checked yet");
});

test("shows backslashes in user values literally", () => {
  const path = String.raw`C:\x41\u0042`;
  assert.equal(i18n._({ id: "test.literal", message: "Open {path}", values: { path } }), `Open ${path}`);
});
