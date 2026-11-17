import { plural, t } from "@lingui/core/macro";
import { formatNumber } from "../../i18n/runtime";
import { setIcon } from "obsidian";
import type { MdbaseTypeDef } from "../../mdbaseCore";
import type { TypeStats } from "../../typeImpact";
import type { WorkspaceContext } from "../shared";

/** What the type list reads from the Types pane. */
export interface TypeListEnv {
  ctx: WorkspaceContext;
  /** The type search text. */
  query: string;
  setQuery(query: string): void;
  typeEntries(): MdbaseTypeDef[];
  selectedPath: string | null;
  /** Whether the selected type has unsaved changes. */
  dirty: boolean;
  currentStats(): { stats: Map<string, TypeStats> };
  createType(): Promise<void>;
  selectType(path: string): Promise<void>;
}

/** The left column of the Types pane: the catalog and create buttons, type search, and one row per type. */
export function renderTypeList(container: HTMLElement, env: TypeListEnv): void {
  const { ctx } = env;
  const pane = container.createDiv({ cls: "mdbase-type-list-pane" });
  const header = pane.createDiv({ cls: "mdbase-pane-header" });
  header.createEl("h2", { text: t`Types` });
  const createBlocked = (ctx.schema?.config.spec_version.startsWith("0.2.") ?? true)
    ? t`Migrate to v0.3 to create types`
    : "";
  const add = ctx.iconButton(header, "plus", createBlocked ? t`Create type · ${createBlocked}` : t`Create type`, "create-type");
  add.disabled = Boolean(createBlocked);
  add.onclick = () => void env.createType();

  // Obsidian's own search field markup, so it gets the magnifier and clear button.
  const searchBox = pane.createDiv({ cls: "search-input-container mdbase-type-search-box" });
  const search = searchBox.createEl("input", { type: "search" });
  search.addClass("mdbase-type-search");
  search.placeholder = t`Search types`;
  search.spellcheck = false;
  search.setAttr("aria-label", t`Search types`);
  search.setAttr("data-focus-key", "type-search");
  search.value = env.query;
  search.oninput = () => {
    env.setQuery(search.value);
    ctx.render();
    const next = ctx.containerEl.querySelector<HTMLInputElement>(".mdbase-type-search");
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  };
  const clear = searchBox.createDiv({ cls: "search-input-clear-button" });
  clear.setAttr("aria-label", t`Clear search`);
  clear.onclick = () => {
    search.value = "";
    search.dispatchEvent(new Event("input"));
  };

  const list = pane.createDiv({ cls: "mdbase-type-list" });
  list.setAttr("data-scroll-key", "type-list");
  // A labelled action below the list, outside its scroll, so it is always in reach.
  const footer = pane.createDiv({ cls: "mdbase-type-list-footer" });
  const catalog = footer.createEl("button", { cls: "mdbase-type-catalog-button" });
  setIcon(catalog.createSpan({ cls: "mdbase-type-catalog-icon" }), "library");
  catalog.createSpan({ text: t`Browse ready-made types` });
  catalog.setAttr("data-focus-key", "type-catalog");
  catalog.disabled = ctx.busy || ctx.schema?.config.spec_version.startsWith("0.2.") === true;
  catalog.onclick = () => void ctx.perform(() => ctx.host.openContractCatalog());
  const query = env.query.trim().toLowerCase();
  const entries = env.typeEntries().filter((entry) =>
    `${entry.name} ${entry.description ?? ""} ${entry.filePath}`.toLowerCase().includes(query));
  if (!entries.length) {
    list.createDiv({ cls: "mdbase-empty-list", text: query ? t`No matching types.` : t`No type definitions.` });
    return;
  }
  const { stats } = env.currentStats();
  for (const type of entries) {
    // The file explorer's row markup (tree-item-self, tree-item-inner, tree-item-flair),
    // so rows take the theme's nav-item padding, hover and selection.
    const item = list.createDiv({ cls: "tree-item mdbase-type-item" });
    const row = item.createDiv({ cls: "tree-item-self is-clickable mdbase-type-row" });
    const active = type.filePath === env.selectedPath;
    row.toggleClass("is-active", active);
    row.setAttr("role", "button");
    row.tabIndex = 0;
    row.setAttr("aria-current", active ? "true" : "false");
    row.setAttr("data-focus-key", `type-${type.filePath}`);
    const inner = row.createDiv({ cls: "tree-item-inner mdbase-type-name-line" });
    inner.createSpan({ cls: "mdbase-type-name", text: type.name });
    const unsaved = active ? env.dirty : ctx.host.loadTypeDraft(type.filePath) !== null;
    if (unsaved) {
      const dot = inner.createSpan({ cls: "mdbase-unsaved-dot" });
      dot.setAttr("aria-label", t`Unsaved changes`);
      dot.setAttr("title", t`Unsaved changes`);
    }
    const typeStat = stats.get(type.name);
    if (ctx.records) {
      const flairs = row.createDiv({ cls: "tree-item-flair-outer mdbase-type-meta" });
      const notes = typeStat?.notes ?? 0;
      const notesLabel = plural(notes, { one: "# note", other: "# notes" });
      if (typeStat?.issues) {
        // Coloured like the Issues tab: errors in the error colour, otherwise the warning colour.
        const errors = typeStat.errors;
        const warnings = typeStat.issues - errors;
        const parts = [
          errors ? plural(errors, { one: "# error", other: "# errors" }) : "",
          warnings ? plural(warnings, { one: "# warning", other: "# warnings" }) : "",
        ].filter(Boolean);
        const issuesLabel = parts.join(", ");
        const issues = flairs.createSpan({ cls: "tree-item-flair mdbase-type-issues" });
        issues.setAttr("data-severity", errors ? "error" : "warn");
        setIcon(issues.createSpan({ cls: "mdbase-type-issues-icon" }), errors ? "alert-circle" : "alert-triangle");
        issues.createSpan({ text: formatNumber(typeStat.issues) });
        issues.setAttr("aria-label", issuesLabel);
        issues.setAttr("title", issuesLabel);
      }
      const count = flairs.createSpan({ cls: "tree-item-flair mdbase-type-count", text: notesLabel });
      count.setAttr("aria-label", notesLabel);
      count.setAttr("title", notesLabel);
    }
    row.onclick = () => void env.selectType(type.filePath);
    row.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void env.selectType(type.filePath);
    };
  }
}
