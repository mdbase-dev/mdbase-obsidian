import { TFolder, type App } from "obsidian";

export const ATTACHMENT_SCOPE_DESCRIPTION = "Attachments are limited to 32 MiB per file on desktop and mobile. Exclusions apply to both notes and attachments. Previously synced files remain in this vault; excluded paths no longer transfer. Excluding a folder does not delete hosted copies.";

/** Folder names are separate values, never parsed as comma-separated text. */
export function renderFolderExclusions(app: App, container: HTMLElement, initial: string[], changed: (folders: string[]) => void): void {
  const folders = [...initial];
  const root = container.createDiv({ cls: "mdbase-folder-exclusions" });
  const chips = root.createDiv({ cls: "mdbase-folder-chips" });
  const input = root.createEl("input", { type: "text", placeholder: "Choose or enter a folder" });
  input.id = "mdbase-excluded-folder";
  input.setAttr("aria-label", "Excluded folder");
  input.setAttr("data-focus-key", "excluded-folder-input");
  const suggestions = root.createEl("datalist");
  suggestions.id = "mdbase-folder-options";
  input.setAttr("list", suggestions.id);
  for (const file of app.vault.getAllLoadedFiles()) if (file instanceof TFolder && file.path && file.path !== "/") suggestions.createEl("option", { value: file.path });
  const error = root.createDiv({ cls: "mdbase-inline-error", attr: { role: "alert" } });
  const render = () => {
    chips.empty();
    for (const folder of folders) {
      const chip = chips.createEl("button", { text: `${folder} ×` });
      chip.setAttr("aria-label", `Remove exclusion ${folder}`);
      chip.onclick = () => { folders.splice(folders.indexOf(folder), 1); changed([...folders]); render(); };
    }
  };
  const add = () => {
    const folder = input.value.trim().replace(/\/+$/, "");
    if (!folder || folder.startsWith("/") || folder.includes("\\") || folder.split("/").some(part => !part || part === "." || part === "..")) {
      error.textContent = "Choose a vault-relative folder without parent traversal or empty segments.";
      return;
    }
    error.textContent = "";
    if (!folders.includes(folder)) { folders.push(folder); changed([...folders]); render(); }
    input.value = "";
    input.focus();
  };
  root.createEl("button", { text: "Exclude folder" }).onclick = add;
  input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); add(); } };
  render();
}
