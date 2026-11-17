import { plural, t } from "@lingui/core/macro";
import { BulkFixConfirmationModal } from "../modals";
import { formatNumber } from "../i18n/runtime";
import { setIcon } from "obsidian";
import type { MdbaseIssue } from "../mdbaseCore";
import { groupIssuesByRule, issueRuleLabel } from "../issuePresentation";
import { issueTypeNames } from "../typeImpact";
import type { WorkspaceContext } from "./shared";

export class IssuesPane {
  private issueQuery = "";
  private issueSeverity: "all" | "error" | "warn" = "all";
  private issueLimit = 250;
  private issueGroupBy: "file" | "rule" = "file";
  constructor(private readonly ctx: WorkspaceContext) {}

  getState(): Record<string, unknown> {
    return { issueQuery: this.issueQuery, issueSeverity: this.issueSeverity, issueGroupBy: this.issueGroupBy };
  }

  setState(state: Record<string, unknown>): void {
    if (typeof state.issueQuery === "string") this.issueQuery = state.issueQuery.slice(0, 2000);
    if (["all", "error", "warn"].includes(String(state.issueSeverity))) this.issueSeverity = state.issueSeverity as typeof this.issueSeverity;
    if (state.issueGroupBy === "rule" || state.issueGroupBy === "file") this.issueGroupBy = state.issueGroupBy;
  }

  updateValidationProgress(): void {
    const summary = this.ctx.containerEl.querySelector<HTMLElement>("[data-validation-summary]");
    if (summary) summary.textContent = this.ctx.host.getValidationSummary();
  }

  /** Narrow the list to one note. */
  filterToPath(path: string): void {
    this.issueQuery = path;
    this.issueLimit = 250;
  }

  render(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-issues-document" });
    const allIssues = this.ctx.host.getIssues();
    const allFiles = new Set(allIssues.map((issue) => issue.path)).size;
    const issueCount = allIssues.length;
    const header = document.createDiv({ cls: "mdbase-document-header" });
    const heading = header.createDiv();
    const validationSummary = this.ctx.host.getValidationSummary();
    heading.createEl("h2", { text: allIssues.length
      ? t`${plural(issueCount, { one: "# issue", other: "# issues" })} · ${plural(allFiles, { one: "# file", other: "# files" })}`
      : this.ctx.host.isValidationUntouched() ? t`Validation` : t`No known issues`,
    });
    const freshness = heading.createDiv({ cls: "mdbase-muted", text: validationSummary });
    freshness.setAttr("role", "status");
    freshness.setAttr("data-validation-summary", "true");
    if (this.ctx.host.isValidating()) {
      const cancel = header.createEl("button", { text: t`Stop validation` });
      cancel.onclick = () => this.ctx.host.cancelValidation();
    }
    const refresh = header.createEl("button", { text: t`Validate` });
    refresh.disabled = this.ctx.busy || this.ctx.host.isValidating();
    refresh.onclick = () => void this.ctx.perform(async () => {
      await this.ctx.host.validateCollection();
      this.ctx.render();
    });
    if (!allIssues.length) return;
    const controls = document.createDiv({ cls: "mdbase-issue-controls" });
    const severity = controls.createEl("select", { cls: "dropdown" });
    severity.setAttr("aria-label", t`Issue severity`);
    severity.createEl("option", { value: "all", text: t`All severities` });
    severity.createEl("option", { value: "error", text: t`Errors` });
    severity.createEl("option", { value: "warn", text: t`Warnings` });
    severity.value = this.issueSeverity;
    severity.onchange = () => {
      this.issueSeverity = severity.value === "error" || severity.value === "warn" ? severity.value : "all";
      this.issueLimit = 250;
      this.ctx.render();
    };
    const groupBy = controls.createEl("select", { cls: "dropdown" });
    groupBy.setAttr("aria-label", t`Group issues`);
    groupBy.createEl("option", { value: "file", text: t`By file` });
    groupBy.createEl("option", { value: "rule", text: t`By rule` });
    groupBy.value = this.issueGroupBy;
    groupBy.onchange = () => {
      this.issueGroupBy = groupBy.value === "rule" ? "rule" : "file";
      this.ctx.render();
    };
    // Obsidian's own search field markup, so it gets the magnifier and clear button.
    const searchBox = controls.createDiv({ cls: "search-input-container mdbase-issue-search" });
    const query = searchBox.createEl("input", { type: "search" });
    query.setAttr("aria-label", t`Filter issues`);
    query.setAttr("data-focus-key", "issue-search");
    query.placeholder = t`Filter issues`;
    query.value = this.issueQuery;
    query.oninput = () => {
      this.issueQuery = query.value;
      this.issueLimit = 250;
      this.ctx.render();
      const next = this.ctx.containerEl.querySelector<HTMLInputElement>(".mdbase-issue-controls input[type='search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    };
    const clear = searchBox.createDiv({ cls: "search-input-clear-button" });
    clear.setAttr("aria-label", t`Clear filter`);
    clear.onclick = () => {
      query.value = "";
      query.dispatchEvent(new Event("input"));
    };
    const normalizedQuery = this.issueQuery.trim().toLowerCase();
    const filtered = allIssues.filter((issue) => {
      if (this.issueSeverity !== "all" && issue.severity !== this.issueSeverity) return false;
      if (!normalizedQuery) return true;
      return `${issue.path} ${issue.code} ${issue.type ?? ""} ${issue.field ?? ""} ${issue.message}`.toLowerCase().includes(normalizedQuery);
    });
    const filteredFiles = new Set(filtered.map((issue) => issue.path)).size;
    if (filtered.length !== allIssues.length || filtered.length > this.issueLimit) {
      const shown = formatNumber(Math.min(filtered.length, this.issueLimit));
      const filteredCount = filtered.length;
      document.createDiv({ cls: "search-results-info mdbase-issues-summary", text:
        t`${shown} of ${plural(filteredCount, { one: "# issue", other: "# issues" })} · ${plural(filteredFiles, { one: "# file", other: "# files" })}`,
      });
    }
    if (!filtered.length) {
      document.createDiv({ cls: "mdbase-empty-state", text: t`No issues match these filters.` });
      return;
    }
    const issues = filtered.slice(0, this.issueLimit);
    if (this.issueGroupBy === "rule") this.renderIssuesByRule(document, issues);
    else this.renderIssuesByFile(document, issues);
    if (filtered.length > issues.length) {
      const remaining = Math.min(250, filtered.length - issues.length);
      const load = document.createEl("button", {
        cls: "mdbase-load-more",
        text: t`Load ${remaining} more`,
      });
      load.onclick = () => {
        this.issueLimit += 250;
        this.ctx.render();
      };
    }
  }

  private renderIssuesByFile(document: HTMLElement, issues: MdbaseIssue[]): void {
    const groups = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) groups.set(issue.path, [...(groups.get(issue.path) ?? []), issue]);
    for (const [path, fileIssues] of groups) {
      const { group, header, name, flair } = this.resultGroup(document);
      header.addClass("is-clickable");
      header.setAttr("role", "button");
      header.tabIndex = 0;
      header.setAttr("title", t`Open ${path}`);
      setIcon(name.createSpan({ cls: "mdbase-issue-file-icon" }), "file-text");
      name.createSpan({ cls: "mdbase-issue-file-path", text: path });
      const open = () => void this.ctx.host.openFileByPath(path);
      header.onclick = open;
      header.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } };
      const issueCount = fileIssues.length;
      flair.createSpan({ cls: "tree-item-flair mdbase-issue-file-count", text: formatNumber(issueCount) })
        .setAttr("aria-label", plural(issueCount, { one: "# issue", other: "# issues" }));
      const matches = group.createDiv({ cls: "search-result-file-matches" });
      for (const issue of fileIssues) {
        const row = matches.createDiv({ cls: "search-result-file-match mdbase-issue-row" });
        const severityLabel = issue.severity === "warn" ? t`Warning` : t`Error`;
        const field = issue.field;
        this.fillIssueRow(row, issue, field ? t`${severityLabel} · ${field}` : severityLabel);
      }
    }
  }

  /** Issues from the same rule together, so one schema decision or bulk fix covers them all. */
  private renderIssuesByRule(document: HTMLElement, issues: MdbaseIssue[]): void {
    for (const rule of groupIssuesByRule(issues)) {
      const first = rule.issues[0];
      const { group, name: title, flair } = this.resultGroup(document);
      title.addClass("mdbase-issue-rule-title");
      title.createSpan({ cls: "mdbase-issue-indicator", attr: { "data-severity": first.severity, "aria-hidden": "true" } });
      title.createSpan({ cls: "mdbase-issue-file-path", text: issueRuleLabel(first) });
      const files = new Set(rule.issues.map((issue) => issue.path)).size;
      const actions = flair.createDiv({ cls: "mdbase-issue-row-actions" });
      flair.createSpan({ cls: "tree-item-flair mdbase-issue-file-count", text: formatNumber(files) })
        .setAttr("aria-label", plural(files, { one: "# note", other: "# notes" }));
      this.renderEditRuleButton(actions, first);
      const fixLabel = this.ctx.host.getQuickFixLabel(first);
      const fixable = fixLabel ? rule.issues.filter((issue) => issue.code === first.code && this.ctx.host.getQuickFixLabel(issue) !== null) : [];
      const fixableNotes = new Set(fixable.map((issue) => issue.path)).size;
      if (fixLabel && fixableNotes > 1) {
        const bulk = actions.createEl("button", { text: t`${fixLabel} · ${plural(fixableNotes, { one: "# note", other: "# notes" })}` });
        bulk.disabled = this.ctx.busy;
        bulk.onclick = () => void this.applyBulkQuickFix(fixLabel, fixable);
      }
      const matches = group.createDiv({ cls: "search-result-file-matches" });
      for (const issue of rule.issues) {
        const row = matches.createDiv({ cls: "search-result-file-match mdbase-issue-row" });
        this.fillIssueRow(row, issue, issue.path, true);
      }
    }
  }

  /** One group, as Obsidian's search shows a file and its matches. */
  private resultGroup(document: HTMLElement): { group: HTMLElement; header: HTMLElement; name: HTMLElement; flair: HTMLElement } {
    const group = document.createDiv({ cls: "tree-item search-result mdbase-issue-group" });
    const header = group.createDiv({ cls: "tree-item-self search-result-file-title mdbase-issue-group-header" });
    const name = header.createDiv({ cls: "tree-item-inner" });
    const flair = header.createDiv({ cls: "tree-item-flair-outer" });
    return { group, header, name, flair };
  }

  private fillIssueRow(row: HTMLElement, issue: MdbaseIssue, context: string, contextOpensFile = false): void {
    row.setAttr("data-severity", issue.severity);
    row.createSpan({ cls: "mdbase-issue-indicator" }).setAttr("aria-hidden", "true");
    const { path, field } = issue;
    const technical = typeof issue.details?.technical_message === "string" ? issue.details.technical_message : "";
    row.setAttr("title", technical ? `${issue.code}: ${technical}` : issue.code);
    const metadata = row.createDiv({ cls: "mdbase-issue-metadata" });
    if (contextOpensFile) {
      const open = metadata.createEl("button", { cls: "mdbase-link-button mdbase-issue-context", text: context });
      open.setAttr("title", field ? t`Open ${path} at ${field}` : t`Open ${path}`);
      open.onclick = () => void this.ctx.host.openFileByPath(issue.path, issue.field);
    } else {
      metadata.createDiv({ cls: "mdbase-issue-context", text: context });
    }
    row.createDiv({ cls: "mdbase-issue-row-message", text: issue.message });
    const actions = row.createDiv({ cls: "mdbase-issue-row-actions" });
    // The file header already opens the note; a row action is only useful when it lands on the field.
    if (!contextOpensFile && field) {
      const open = this.ctx.iconButton(actions, "arrow-up-right", t`Open ${path} at ${field}`);
      open.onclick = () => void this.ctx.host.openFileByPath(issue.path, issue.field);
    }
    if (!contextOpensFile) this.renderEditRuleButton(actions, issue);
    const quickFixLabel = this.ctx.host.getQuickFixLabel(issue);
    if (quickFixLabel) {
      const fix = actions.createEl("button", { text: quickFixLabel });
      fix.disabled = this.ctx.busy;
      fix.onclick = () => void this.ctx.perform(async () => {
        await this.ctx.host.applyQuickFix(issue);
      });
    }
  }

  /** Jump from an issue to the type field whose rule produced it. */
  private renderEditRuleButton(container: HTMLElement, issue: MdbaseIssue): void {
    const typeName = issueTypeNames(issue, this.ctx.recordTypes())[0];
    const typeDef = typeName ? this.ctx.schema?.types.get(typeName) : undefined;
    if (!typeDef) return;
    const { field } = issue;
    const typeNameLabel = typeDef.name;
    const edit = this.ctx.iconButton(
      container,
      "pencil",
      field ? t`Edit ${field} in ${typeNameLabel}` : t`Edit type ${typeNameLabel}`,
    );
    edit.onclick = () => void this.ctx.openTypeField(typeDef.filePath, issue.field);
  }

  private async applyBulkQuickFix(label: string, issues: MdbaseIssue[]): Promise<void> {
    const notes = new Set(issues.map((issue) => issue.path)).size;
    const confirmed = await new BulkFixConfirmationModal(this.ctx.app).confirm(label, issues);
    if (!confirmed) return;
    await this.ctx.perform(async () => {
      const result = await this.ctx.host.applyQuickFixes(issues);
      const { changed, skipped } = result;
      this.ctx.message = skipped
        ? t`${label}: updated ${changed} of ${plural(notes, { one: "# note", other: "# notes" })}. ${plural(skipped, { one: "# note changed since validation and was left as it is.", other: "# notes changed since validation and were left as they are." })}`
        : t`${label}: updated ${plural(changed, { one: "# note", other: "# notes" })}.`;
    });
  }

}

