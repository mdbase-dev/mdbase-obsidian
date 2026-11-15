import type { V02MigrationPlan } from "../../migration";
import { renderStatus, type WorkspaceContext } from "../shared";

/**
 * First run: the one decision is where the collection lives. Starting one
 * here makes this vault its source; copying one from Connect makes this vault
 * a synced mirror. Adoption (moving a local collection to Connect) is offered
 * later, from Sync, once a local collection exists.
 */
export function renderSetup(container: HTMLElement, ctx: WorkspaceContext): void {
  const empty = container.createDiv({ cls: "mdbase-empty-state mdbase-setup" });
  empty.createEl("h2", { text: "Set up mdbase" });
  const choices = empty.createDiv({ cls: "mdbase-setup-choices" });
  const choice = (label: string, detail: string, cta: boolean, onClick: () => void) => {
    const row = choices.createDiv({ cls: "mdbase-setup-choice" });
    const text = row.createDiv();
    text.createEl("strong", { text: label });
    text.createDiv({ cls: "mdbase-muted", text: detail });
    const button = row.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
    button.disabled = ctx.busy;
    button.onclick = onClick;
  };
  choice("Start a collection", "Describe your notes with types in this vault. You can sync it later.", true, () => {
    void ctx.perform(async () => {
      await ctx.host.initializeCollection();
      await ctx.refresh(true);
    });
  });
  choice("Sync from another device", "Bring a collection you already use elsewhere into this vault.", false, () => {
    ctx.showDestination("sync");
  });
}

/** Migrating a read-only v0.2 collection to v0.3: the banner, the review of the plan, and applying it. */
export class MigrationReview {
  private plan: V02MigrationPlan | null = null;
  private allowLossy = false;

  constructor(
    private readonly ctx: WorkspaceContext,
    /** Runs once the migration is applied, before the collection reloads. */
    private readonly onApplied: () => void,
  ) {}

  /** The read-only notice on a v0.2 collection, and its migration review once requested. */
  renderBanner(container: HTMLElement): void {
    const banner = container.createDiv({ cls: "mdbase-legacy-banner" });
    const text = banner.createDiv();
    text.createEl("strong", { text: "Read-only · v0.2 collection" });
    text.createEl("p", { text: "Migrate to edit types." });
    if (!this.plan) {
      const button = banner.createEl("button", { text: "Review migration" });
      button.disabled = this.ctx.busy;
      button.onclick = () => void this.ctx.perform(async () => {
        this.plan = await this.ctx.host.analyzeMigration();
        this.ctx.render();
      });
    }
    if (this.plan) this.renderReview(container, this.plan);
  }

  private renderReview(container: HTMLElement, plan: V02MigrationPlan): void {
    const review = container.createDiv({ cls: "mdbase-migration-review" });
    const header = review.createDiv({ cls: "mdbase-section-header" });
    header.createEl("h3", { text: "Migration review" });
    header.createSpan({ cls: "mdbase-spec-badge", text: `${plan.sourceVersion} → ${plan.targetVersion}` });
    const summary = review.createDiv({ cls: "mdbase-status-list" });
    renderStatus(summary, "Files replaced", String(plan.operations.length));
    renderStatus(summary, "Type definitions", String(plan.typeSummaries.length));
    renderStatus(summary, "Record reads verified", String(plan.recordsVerified));
    if (plan.recordsSkipped) renderStatus(summary, "Records skipped", String(plan.recordsSkipped));
    renderStatus(summary, "Record files rewritten", "0");
    renderStatus(summary, "Recovery backup", plan.backupLocation);
    const warnings = review.createDiv({ cls: "mdbase-review-list" });
    if (!plan.diagnostics.length) {
      warnings.createDiv({ cls: "mdbase-review-ok", text: "No migration diagnostics." });
    }
    for (const diagnostic of plan.diagnostics.slice(0, 250)) {
      const item = warnings.createDiv({ cls: "mdbase-review-item" });
      item.setAttr("data-severity", diagnostic.severity);
      item.createDiv({ cls: "mdbase-review-code", text: `${diagnostic.severity} · ${diagnostic.path}` });
      item.createDiv({ text: diagnostic.message });
    }
    if (plan.diagnostics.length > 250) {
      warnings.createDiv({
        cls: "mdbase-form-description",
        text: `Showing 250 of ${plan.diagnostics.length} diagnostics.`,
      });
    }
    if (!plan.applicable) {
      const consent = review.createEl("label", { cls: "mdbase-consent" });
      const checkbox = consent.createEl("input", { type: "checkbox" });
      checkbox.checked = this.allowLossy;
      checkbox.onchange = () => {
        this.allowLossy = checkbox.checked;
        this.ctx.render();
      };
      consent.createSpan({ text: "I reviewed the lossy diagnostics and want to apply this migration." });
    }
    const actions = review.createDiv({ cls: "mdbase-actions" });
    const apply = actions.createEl("button", { text: "Apply migration" });
    apply.addClass("mod-warning");
    apply.disabled = this.ctx.busy || (!plan.applicable && !this.allowLossy);
    apply.onclick = () => void this.ctx.perform(async () => {
      await this.ctx.host.applyMigration(plan, this.allowLossy);
      this.plan = null;
      this.allowLossy = false;
      this.onApplied();
      await this.ctx.refresh(true);
    });
    const dismiss = actions.createEl("button", { text: "Close review" });
    dismiss.onclick = () => {
      this.plan = null;
      this.ctx.render();
    };
  }
}
