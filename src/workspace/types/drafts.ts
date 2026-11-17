import { t } from "@lingui/core/macro";
import { formatDate } from "../../i18n/runtime";
import { Modal, setIcon } from "obsidian";
import { formatMarkdown } from "../../mdbaseCore";
import type { TypeEditorModel } from "../../typeEditorTypes";
import { frontmatterFromTypeModel } from "../../typeModel";
import { clone, type WorkspaceContext } from "../shared";

/**
 * Recovery rows for drafts of the open type that were kept because its source
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
    const row = container.createDiv({ cls: "mdbase-draft-recovery" });
    const message = row.createDiv({ cls: "mdbase-draft-recovery-message" });
    setIcon(message.createSpan({ cls: "mdbase-draft-recovery-icon", attr: { "aria-hidden": "true" } }), "history");
    const updatedAt = formatDate(new Date(draft.updatedAt), { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
    message.createSpan({
      text: t`Older unsaved changes from ${updatedAt}. The file has changed since, so they weren't applied.`,
    });
    const actions = row.createDiv({ cls: "mdbase-draft-recovery-actions" });
    const compare = actions.createEl("button", { text: t`Compare draft` });
    compare.onclick = () => {
      const modal = new Modal(ctx.app);
      modal.titleEl.setText(t`Current source and recovered draft`);
      let draftText = draft.yamlDraft;
      if (draftText === undefined) {
        try { draftText = formatMarkdown(frontmatterFromReadableModel(draft.model), draft.model.body); }
        catch { draftText = JSON.stringify(draft.model, null, 2); }
      }
      modal.contentEl.createEl("h3", { text: t`Current source` });
      const saved = current.originalModel();
      modal.contentEl.createEl("pre", { text: saved ? formatMarkdown(frontmatterFromReadableModel(saved), saved.body) : current.yamlDraft() });
      modal.contentEl.createEl("h3", { text: t`Recovered draft (read-only)` });
      modal.contentEl.createEl("pre", { text: draftText });
      modal.contentEl.createEl("p", { text: t`Copy the parts you want into the current definition, then review before saving.` });
      modal.open();
    };
    const exportDraft = actions.createEl("button", { text: t`Export draft` });
    exportDraft.onclick = () => void ctx.perform(async () => {
      const folder = "mdbase-draft-recovery";
      if (!ctx.app.vault.getAbstractFileByPath(folder)) await ctx.app.vault.createFolder(folder);
      const file = await ctx.app.vault.create(`${folder}/draft-${crypto.randomUUID()}.txt`, draft.yamlDraft ?? JSON.stringify(draft.model, null, 2));
      const path = file.path;
      ctx.message = t`Exported recovery draft to ${path}. The original draft is still retained.`;
    });
    const discard = actions.createEl("button", { text: t`Discard old draft` });
    discard.onclick = () => {
      const modal = new Modal(ctx.app);
      modal.titleEl.setText(t`Discard this recovered draft?`);
      modal.contentEl.createEl("p", { text: t`This removes the saved recovery copy, not the current source or your current edits. Export it first if you might need it.` });
      const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
      buttons.createEl("button", { text: t`Cancel` }).onclick = () => modal.close();
      buttons.createEl("button", { text: t`Discard old draft`, cls: "mod-warning" }).onclick = () => {
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
