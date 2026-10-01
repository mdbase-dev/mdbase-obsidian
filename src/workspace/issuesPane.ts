import { BulkFixConfirmationModal } from "../modals";
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
    const header = document.createDiv({ cls: "mdbase-document-header" });
    const heading = header.createDiv();
    const validationSummary = this.ctx.host.getValidationSummary();
    heading.createEl("h2", { text: allIssues.length
      ? `${allIssues.length.toLocaleString()} ${allIssues.length === 1 ? "issue" : "issues"} · ${allFiles.toLocaleString()} ${allFiles === 1 ? "file" : "files"}`
      : validationSummary === "Not checked yet" ? "Validation" : "No known issues",
    });
    const freshness = heading.createDiv({ cls: "mdbase-muted", text: validationSummary });
    freshness.setAttr("role", "status");
    freshness.setAttr("data-validation-summary", "true");
    if (this.ctx.host.isValidating()) {
      const cancel = header.createEl("button", { text: "Stop validation" });
      cancel.onclick = () => this.ctx.host.cancelValidation();
    }
    const refresh = header.createEl("button", { text: "Validate" });
    refresh.disabled = this.ctx.busy || this.ctx.host.isValidating();
    refresh.onclick = () => void this.ctx.perform(async () => {
      await this.ctx.host.validateCollection();
      this.ctx.render();
    });
    if (!allIssues.length) return;
    const controls = document.createDiv({ cls: "mdbase-issue-controls" });
    const severity = controls.createEl("select");
    severity.setAttr("aria-label", "Issue severity");
    severity.createEl("option", { value: "all", text: "All severities" });
    severity.createEl("option", { value: "error", text: "Errors" });
    severity.createEl("option", { value: "warn", text: "Warnings" });
    severity.value = this.issueSeverity;
    severity.onchange = () => {
      this.issueSeverity = severity.value === "error" || severity.value === "warn" ? severity.value : "all";
      this.issueLimit = 250;
      this.ctx.render();
    };
    const groupBy = controls.createEl("select");
    groupBy.setAttr("aria-label", "Group issues");
    groupBy.createEl("option", { value: "file", text: "By file" });
    groupBy.createEl("option", { value: "rule", text: "By rule" });
    groupBy.value = this.issueGroupBy;
    groupBy.onchange = () => {
      this.issueGroupBy = groupBy.value === "rule" ? "rule" : "file";
      this.ctx.render();
    };
    const query = controls.createEl("input", { type: "search" });
    query.setAttr("aria-label", "Filter issues");
    query.setAttr("data-focus-key", "issue-search");
    query.placeholder = "Filter issues";
    query.value = this.issueQuery;
    query.oninput = () => {
      this.issueQuery = query.value;
      this.issueLimit = 250;
      this.ctx.render();
      const next = this.ctx.containerEl.querySelector<HTMLInputElement>(".mdbase-issue-controls input[type='search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    };
    const normalizedQuery = this.issueQuery.trim().toLowerCase();
    const filtered = allIssues.filter((issue) => {
      if (this.issueSeverity !== "all" && issue.severity !== this.issueSeverity) return false;
      if (!normalizedQuery) return true;
      return `${issue.path} ${issue.code} ${issue.type ?? ""} ${issue.field ?? ""} ${issue.message}`.toLowerCase().includes(normalizedQuery);
    });
    const filteredFiles = new Set(filtered.map((issue) => issue.path)).size;
    if (filtered.length !== allIssues.length || filtered.length > this.issueLimit) {
      document.createDiv({ cls: "mdbase-issues-summary", text:
        `${Math.min(filtered.length, this.issueLimit).toLocaleString()} of ${filtered.length.toLocaleString()} issues · ${filteredFiles.toLocaleString()} files`,
      });
    }
    if (!filtered.length) {
      document.createDiv({ cls: "mdbase-empty-state", text: "No issues match these filters." });
      return;
    }
    const issues = filtered.slice(0, this.issueLimit);
    if (this.issueGroupBy === "rule") this.renderIssuesByRule(document, issues);
    else this.renderIssuesByFile(document, issues);
    if (filtered.length > issues.length) {
      const load = document.createEl("button", {
        cls: "mdbase-load-more",
        text: `Load ${Math.min(250, filtered.length - issues.length)} more`,
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
      const group = document.createEl("section", { cls: "mdbase-issue-group" });
      const groupHeader = group.createDiv({ cls: "mdbase-issue-group-header" });
      const fileButton = groupHeader.createEl("button", { cls: "mdbase-issue-file-button" });
      setIcon(fileButton.createSpan({ cls: "mdbase-issue-file-icon" }), "file-text");
      fileButton.createSpan({ cls: "mdbase-issue-file-path", text: path });
      fileButton.setAttr("title", `Open ${path}`);
      fileButton.onclick = () => void this.ctx.host.openFileByPath(path);
      groupHeader.createSpan({
        cls: "mdbase-issue-file-count",
        text: `${fileIssues.length} ${fileIssues.length === 1 ? "issue" : "issues"}`,
      });
      for (const issue of fileIssues) {
        const row = group.createDiv({ cls: "mdbase-issue-row" });
        this.fillIssueRow(row, issue, `${issue.severity === "warn" ? "Warning" : "Error"}${issue.field ? ` · ${issue.field}` : ""}`);
      }
    }
  }

  /** Issues from the same rule together, so one schema decision or bulk fix covers them all. */
  private renderIssuesByRule(document: HTMLElement, issues: MdbaseIssue[]): void {
    for (const rule of groupIssuesByRule(issues)) {
      const first = rule.issues[0];
      const group = document.createEl("section", { cls: "mdbase-issue-group" });
      const groupHeader = group.createDiv({ cls: "mdbase-issue-group-header" });
      const title = groupHeader.createDiv({ cls: "mdbase-issue-rule-title" });
      title.createSpan({ cls: "mdbase-issue-indicator", attr: { "data-severity": first.severity, "aria-hidden": "true" } });
      title.createSpan({ cls: "mdbase-issue-file-path", text: issueRuleLabel(first) });
      const files = new Set(rule.issues.map((issue) => issue.path)).size;
      groupHeader.createSpan({
        cls: "mdbase-issue-file-count",
        text: `${files.toLocaleString()} ${files === 1 ? "note" : "notes"}`,
      });
      const actions = groupHeader.createDiv({ cls: "mdbase-issue-row-actions" });
      this.renderEditRuleButton(actions, first);
      const fixLabel = this.ctx.host.getQuickFixLabel(first);
      const fixable = fixLabel ? rule.issues.filter((issue) => this.ctx.host.getQuickFixLabel(issue) === fixLabel) : [];
      const fixableNotes = new Set(fixable.map((issue) => issue.path)).size;
      if (fixLabel && fixableNotes > 1) {
        const bulk = actions.createEl("button", { text: `${fixLabel} · ${fixableNotes} notes` });
        bulk.disabled = this.ctx.busy;
        bulk.onclick = () => void this.applyBulkQuickFix(fixLabel, fixable);
      }
      for (const issue of rule.issues) {
        const row = group.createDiv({ cls: "mdbase-issue-row" });
        this.fillIssueRow(row, issue, issue.path, true);
      }
    }
  }

  private fillIssueRow(row: HTMLElement, issue: MdbaseIssue, context: string, contextOpensFile = false): void {
    row.setAttr("data-severity", issue.severity);
    row.createSpan({ cls: "mdbase-issue-indicator" }).setAttr("aria-hidden", "true");
    const technical = typeof issue.details?.technical_message === "string" ? issue.details.technical_message : "";
    row.setAttr("title", technical ? `${issue.code}: ${technical}` : issue.code);
    const metadata = row.createDiv({ cls: "mdbase-issue-metadata" });
    if (contextOpensFile) {
      const open = metadata.createEl("button", { cls: "mdbase-link-button mdbase-issue-context", text: context });
      open.setAttr("title", `Open ${issue.path}${issue.field ? ` at ${issue.field}` : ""}`);
      open.onclick = () => void this.ctx.host.openFileByPath(issue.path, issue.field);
    } else {
      metadata.createDiv({ cls: "mdbase-issue-context", text: context });
    }
    row.createDiv({ cls: "mdbase-issue-row-message", text: issue.message });
    const actions = row.createDiv({ cls: "mdbase-issue-row-actions" });
    // The file header already opens the note; a row action is only useful when it lands on the field.
    if (!contextOpensFile && issue.field) {
      const open = this.ctx.iconButton(actions, "arrow-up-right", `Open ${issue.path} at ${issue.field}`);
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
    const edit = this.ctx.iconButton(
      container,
      "pencil",
      issue.field ? `Edit ${issue.field} in ${typeDef.name}` : `Edit type ${typeDef.name}`,
    );
    edit.onclick = () => void this.ctx.openTypeField(typeDef.filePath, issue.field);
  }

  private async applyBulkQuickFix(label: string, issues: MdbaseIssue[]): Promise<void> {
    const notes = new Set(issues.map((issue) => issue.path)).size;
    const confirmed = await new BulkFixConfirmationModal(this.ctx.app).confirm(label, issues);
    if (!confirmed) return;
    await this.ctx.perform(async () => {
      const result = await this.ctx.host.applyQuickFixes(issues);
      this.ctx.message = result.skipped
        ? `${label}: updated ${result.changed} of ${notes} ${notes === 1 ? "note" : "notes"}. ${result.skipped} changed since validation and were left as they are.`
        : `${label}: updated ${result.changed} ${result.changed === 1 ? "note" : "notes"}.`;
    });
  }

}

