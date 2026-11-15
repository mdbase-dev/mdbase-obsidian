import type { CollectionRecord, MdbaseIssue, MdbaseTypeDef } from "../../mdbaseCore";
import type { TypeEditorModel } from "../../typeEditorTypes";
import {
  analyzeTypeImpact,
  indexRecordTypes,
  typeStats,
  type TypeImpactResult,
  type TypeStats,
} from "../../typeImpact";
import type { WorkspaceContext } from "../shared";

/**
 * What the open type matches and what saving it would do to existing notes:
 * per-type note and issue counts, the debounced draft/record comparison, and
 * the regions of the design form that show its result.
 */
export class TypeImpact {
  /** The latest comparison of the draft against the collection's notes. */
  result: TypeImpactResult | null = null;
  private version = 0;
  private timer: number | null = null;
  private showAllMatches = false;
  private statsCache: {
    records: CollectionRecord[] | null;
    types: Map<string, MdbaseTypeDef> | null;
    issues: MdbaseIssue[];
    recordTypes: Map<string, string[]>;
    stats: Map<string, TypeStats>;
  } | null = null;

  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly deps: {
      /** The draft to compare: the parsed YAML in YAML mode, otherwise the design model. */
      draft(): { model: TypeEditorModel | null } | { error: string };
      selectedPath(): string | null;
      dirty(): boolean;
      /** Runs after a new result has been shown. */
      onUpdated(): void;
    },
  ) {}

  /** Forget the result when another type is opened. */
  reset(): void {
    this.result = null;
    this.showAllMatches = false;
  }

  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.version++;
  }

  currentStats(): { recordTypes: Map<string, string[]>; stats: Map<string, TypeStats> } {
    const issues = this.ctx.host.getIssues();
    const types = this.ctx.schema?.types ?? null;
    const cached = this.statsCache;
    if (cached && cached.records === this.ctx.records && cached.types === types && cached.issues === issues) return cached;
    const recordTypes = this.ctx.records && this.ctx.schema
      ? indexRecordTypes(this.ctx.records, this.ctx.schema.config, this.ctx.schema.types)
      : new Map<string, string[]>();
    this.statsCache = { records: this.ctx.records, types, issues, recordTypes, stats: typeStats(recordTypes, issues) };
    return this.statsCache;
  }

  /** Re-run the draft/record comparison after a pause in editing. */
  schedule(delay = 400): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.compute().then((result) => {
        if (result === undefined) return;
        this.result = result;
        this.updateRegions();
      });
    }, delay);
  }

  /** undefined when superseded; null when there is nothing to analyze. */
  async compute(): Promise<TypeImpactResult | null | undefined> {
    const version = ++this.version;
    const draft = this.deps.draft();
    if ("error" in draft) return { error: draft.error };
    const model = draft.model;
    const selectedPath = this.deps.selectedPath();
    if (!model || !this.ctx.schema || !this.ctx.records || model.specProfile !== "v0.3" || model.readOnlyReason) return null;
    const savedName = selectedPath
      ? [...this.ctx.schema.types.values()].find((type) => type.filePath === selectedPath)?.name ?? null
      : null;
    const result = await analyzeTypeImpact({
      records: this.ctx.records,
      config: this.ctx.schema.config,
      types: this.ctx.schema.types,
      draft: model,
      savedName,
      filePath: selectedPath,
      isCurrent: () => version === this.version,
    });
    return version === this.version && result !== null ? result : undefined;
  }

  /** Refresh only the regions that show record impact, leaving inputs untouched. */
  private updateRegions(): void {
    const preview = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-match-preview");
    if (preview) {
      preview.empty();
      this.fillMatchPreview(preview);
    }
    const summary = this.ctx.containerEl.querySelector<HTMLElement>("[data-disclosure='type-matching'] > summary");
    if (summary) summary.textContent = this.matchingLabel();
    const effect = this.ctx.containerEl.querySelector<HTMLElement>(".mdbase-impact");
    if (effect) {
      effect.empty();
      this.fillImpact(effect);
    }
    this.deps.onUpdated();
  }

  /** Notes that pass with the saved type but would fail with the draft. */
  newlyFailing(): number {
    if (!this.deps.dirty() || !this.result || "error" in this.result) return 0;
    return this.result.impact.failing.filter((record) => record.isNew).length;
  }

  matchingLabel(): string {
    const count = this.result && !("error" in this.result)
      ? this.result.impact.matched.length
      : this.savedTypeName() ? this.currentStats().stats.get(this.savedTypeName() ?? "")?.notes : undefined;
    return count === undefined || !this.ctx.records
      ? "Matching"
      : `Matching · ${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;
  }

  private savedTypeName(): string | null {
    const selectedPath = this.deps.selectedPath();
    if (!selectedPath || !this.ctx.schema) return null;
    return [...this.ctx.schema.types.values()].find((type) => type.filePath === selectedPath)?.name ?? null;
  }

  /** The notes this type (as drafted) matches, with notes gained or lost against the saved type. */
  fillMatchPreview(container: HTMLElement): void {
    const result = this.result;
    let matched: string[];
    let added: string[] = [];
    let removed: string[] = [];
    if (result && !("error" in result)) {
      ({ matched, added, removed } = result.impact);
    } else {
      const name = this.savedTypeName();
      if (!this.ctx.records || !name || (result && "error" in result && this.deps.dirty())) {
        container.createDiv({
          cls: "mdbase-muted",
          text: !this.ctx.records ? "Counting notes…" : result && "error" in result ? "Fix errors to preview matching notes." : "Save the type to preview matching notes.",
        });
        return;
      }
      matched = [...this.currentStats().recordTypes].filter(([, names]) => names.includes(name)).map(([path]) => path);
    }
    const summary = container.createDiv({ cls: "mdbase-match-summary" });
    summary.createSpan({ text: `${matched.length.toLocaleString()} ${matched.length === 1 ? "note matches" : "notes match"}` });
    if (added.length) summary.createSpan({ cls: "mdbase-match-added", text: `${added.length} added` });
    if (removed.length) summary.createSpan({ cls: "mdbase-match-removed", text: `${removed.length} no longer match` });
    const addedSet = new Set(added);
    const ordered: Array<{ path: string; change: "added" | "removed" | null }> = [
      ...added.map((path) => ({ path, change: "added" as const })),
      ...removed.map((path) => ({ path, change: "removed" as const })),
      ...matched.filter((path) => !addedSet.has(path)).map((path) => ({ path, change: null })),
    ];
    if (!ordered.length) return;
    const limit = this.showAllMatches ? 200 : 5;
    const list = container.createDiv({ cls: "mdbase-match-list" });
    for (const entry of ordered.slice(0, limit)) {
      const row = list.createEl("button", { cls: "mdbase-match-row" });
      if (entry.change) {
        row.setAttr("data-change", entry.change);
        row.createSpan({
          cls: "mdbase-match-marker",
          text: entry.change === "added" ? "+" : "−",
          attr: { "aria-label": entry.change === "added" ? "Added" : "No longer matches" },
        });
      }
      row.createSpan({ text: entry.path });
      row.setAttr("title", `Open ${entry.path}`);
      row.onclick = () => void this.ctx.host.openFileByPath(entry.path);
    }
    if (ordered.length > 5) {
      const more = container.createEl("button", {
        cls: "mdbase-link-button",
        text: this.showAllMatches
          ? "Show fewer"
          : ordered.length > 200
            ? `Show 200 of ${ordered.length.toLocaleString()}`
            : `Show all ${ordered.length.toLocaleString()}`,
      });
      more.onclick = () => {
        this.showAllMatches = !this.showAllMatches;
        container.empty();
        this.fillMatchPreview(container);
      };
    }
  }

  /** What saving the draft would do to existing notes. */
  fillImpact(container: HTMLElement): void {
    const result = this.result;
    if (!result) {
      container.createDiv({ cls: "mdbase-muted", text: this.ctx.records ? "Checking notes…" : "Counting notes…" });
      return;
    }
    if ("error" in result) {
      container.createDiv({ cls: "mdbase-muted", text: "Fix errors to check existing notes." });
      return;
    }
    const { impact } = result;
    const newlyFailing = impact.failing.filter((record) => record.isNew);
    const alreadyFailing = impact.failing.length - newlyFailing.length;
    const heading = container.createDiv({ cls: "mdbase-impact-heading" });
    heading.setAttr("data-tone", newlyFailing.length ? "warning" : "normal");
    heading.createEl("strong", {
      text: newlyFailing.length
        ? `${newlyFailing.length} ${newlyFailing.length === 1 ? "note" : "notes"} would fail`
        : "No notes newly fail",
    });
    const facts = [`${impact.matched.length.toLocaleString()} ${impact.matched.length === 1 ? "note" : "notes"} checked`];
    if (impact.fixed) facts.push(`${impact.fixed} fixed`);
    if (alreadyFailing) facts.push(`${alreadyFailing} already failing`);
    heading.createSpan({ cls: "mdbase-muted", text: facts.join(" · ") });
    if (!newlyFailing.length) return;
    const list = container.createDiv({ cls: "mdbase-impact-list" });
    for (const record of newlyFailing.slice(0, 10)) {
      const row = list.createDiv({ cls: "mdbase-impact-row" });
      const open = row.createEl("button", { cls: "mdbase-link-button", text: record.path });
      open.onclick = () => void this.ctx.host.openFileByPath(record.path, record.issues[0]?.field);
      row.createSpan({
        cls: "mdbase-muted",
        text: `${record.issues[0]?.message ?? ""}${record.issues.length > 1 ? ` · +${record.issues.length - 1} more` : ""}`,
      });
    }
    if (newlyFailing.length > 10) {
      list.createDiv({ cls: "mdbase-muted", text: `${newlyFailing.length - 10} more notes` });
    }
  }
}
