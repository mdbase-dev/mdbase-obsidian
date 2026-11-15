import { Modal } from "obsidian";
import { formatMarkdown } from "../../mdbaseCore";
import type { TypeEditorModel } from "../../typeEditorTypes";
import { frontmatterFromTypeModel } from "../../typeModel";
import { clone, type WorkspaceContext } from "../shared";

/**
 * Recovery cards for drafts of the open type that were kept because its source
 * changed underneath them: compare, export or discard each one.
 */
export function renderStaleDrafts(
  ctx: WorkspaceContext,
  container: HTMLElement,
  path: string | null,
  current: { originalModel(): TypeEditorModel | null; yamlDraft(): string },
): void {
  const originalModel = current.originalModel();
  if (!path || !originalModel) return;
  const active = ctx.host.loadTypeDraft(path);
  const drafts = [...ctx.host.getArchivedTypeDrafts(path),
    ...(active && active.sourceRevision !== (originalModel.sourceRevision ?? null) ? [active] : [])];
  for (const draft of drafts) {
    const row = container.createDiv({ cls: "mdbase-recovery-card" });
    row.createDiv({ text: `An older draft from ${new Date(draft.updatedAt).toLocaleString()} is available. The source changed; it will not be applied automatically.` });
    const compare = row.createEl("button", { text: "Compare draft" });
    compare.onclick = () => {
      const modal = new Modal(ctx.app);
      modal.titleEl.setText("Current source and recovered draft");
      let draftText = draft.yamlDraft;
      if (draftText === undefined) {
        try { draftText = formatMarkdown(frontmatterFromReadableModel(draft.model), draft.model.body); }
        catch { draftText = JSON.stringify(draft.model, null, 2); }
      }
      modal.contentEl.createEl("h3", { text: "Current source" });
      const saved = current.originalModel();
      modal.contentEl.createEl("pre", { text: saved ? formatMarkdown(frontmatterFromReadableModel(saved), saved.body) : current.yamlDraft() });
      modal.contentEl.createEl("h3", { text: "Recovered draft (read-only)" });
      modal.contentEl.createEl("pre", { text: draftText });
      modal.contentEl.createEl("p", { text: "Copy the parts you want into the current definition, then review before saving." });
      modal.open();
    };
    const exportDraft = row.createEl("button", { text: "Export draft" });
    exportDraft.onclick = () => void ctx.perform(async () => {
      const folder = "mdbase-draft-recovery";
      if (!ctx.app.vault.getAbstractFileByPath(folder)) await ctx.app.vault.createFolder(folder);
      const file = await ctx.app.vault.create(`${folder}/draft-${crypto.randomUUID()}.txt`, draft.yamlDraft ?? JSON.stringify(draft.model, null, 2));
      ctx.message = `Exported recovery draft to ${file.path}. The original draft is still retained.`;
    });
    const discard = row.createEl("button", { text: "Discard old draft" });
    discard.onclick = () => {
      const modal = new Modal(ctx.app);
      modal.titleEl.setText("Discard this recovered draft?");
      modal.contentEl.createEl("p", { text: "This removes the saved recovery copy, not the current source or your current edits. Export it first if you might need it." });
      modal.contentEl.createEl("button", { text: "Cancel" }).onclick = () => modal.close();
      modal.contentEl.createEl("button", { text: "Discard old draft", cls: "mod-warning" }).onclick = () => {
        modal.close();
        void ctx.perform(async () => {
          if (draft === active) await ctx.host.clearTypeDraft(path);
          else await ctx.host.discardArchivedTypeDraft(draft);
        });
      };
      modal.open();
    };
  }
}

/** A type's frontmatter as saved: canonical for an editable v0.3 type, otherwise as read from its file. */
export function frontmatterFromReadableModel(model: TypeEditorModel): Record<string, unknown> {
  if (model.specProfile === "v0.3" && !model.readOnlyReason) return frontmatterFromTypeModel(model);
  return clone(model.originalFrontmatter ?? {
    name: model.name,
    fields: Object.fromEntries(model.fields.map((field) => [field.name, field.definition])),
  });
}
