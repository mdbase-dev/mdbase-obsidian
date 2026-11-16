import { setIcon } from "obsidian";
import type { WorkspaceContext } from "../shared";

/**
 * Give a `<details>` summary the chevron field rows use, in place of the
 * browser's ▶ marker, so every collapsible part of the workspace looks the same.
 * Returns the span that holds the summary's label.
 */
export function addChevron(summary: HTMLElement): HTMLElement {
  summary.addClass("mdbase-chevron-summary");
  const label = summary.ownerDocument.createElement("span");
  label.className = "mdbase-chevron-summary-label";
  while (summary.firstChild) label.appendChild(summary.firstChild);
  const chevron = summary.createSpan({ cls: "mdbase-field-chevron" });
  chevron.setAttr("aria-hidden", "true");
  setIcon(chevron, "chevron-right");
  summary.appendChild(label);
  return label;
}

/** A workspace disclosure (open state kept across renders); every one has the chevron. */
export function typesDisclosure(
  ctx: WorkspaceContext,
  container: HTMLElement,
  key: string,
  label: string,
  initiallyOpen = false,
): HTMLDivElement {
  return ctx.disclosure(container, key, label, initiallyOpen);
}
