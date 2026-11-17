import { t } from "@lingui/core/macro";
// The pick-one lists sync opens: a collection to sync with, a rejected write to discard.
import { SuggestModal, type App } from "obsidian";

/** A collection in a chooser. Private ones say so: they ask for the encryption password. */
function renderCollectionChoice(c: { name: string; private?: boolean }, el: HTMLElement) {
  el.createSpan({ text: c.name });
  if (c.private) el.createSpan({ cls: "mdbase-choice-tag", text: t({ message: "Private", context: "collection mode" }) });
}
/** Open a list of collections, filtered by name as the person types. */
export function chooseCollection<T extends { name: string; private?: boolean }>(app: App, items: T[], chosen: (c: T) => void) {
  new (class extends SuggestModal<T> {
    getSuggestions(q: string) { return items.filter(c => c.name.toLowerCase().includes(q.toLowerCase())); }
    renderSuggestion(c: T, el: HTMLElement) { renderCollectionChoice(c, el); }
    onChooseSuggestion(c: T) { chosen(c); }
  })(app).open();
}

/** Open a list of rejected writes; the person picks the one to discard. */
export function chooseRejectedWrite<T>(app: App, entries: T[], label: (e: T) => string, discard: (e: T) => void) {
  new (class extends SuggestModal<T> {
    getSuggestions(q: string) { return entries.filter(e => label(e).toLowerCase().includes(q.toLowerCase())); }
    renderSuggestion(e: T, el: HTMLElement) { const name = label(e); el.setText(t`Discard: ${name}`); }
    onChooseSuggestion(e: T) { discard(e); }
  })(app).open();
}
