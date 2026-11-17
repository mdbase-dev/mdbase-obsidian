import { plural, t } from "@lingui/core/macro";
import { formatDate } from "./i18n/runtime";

export interface ValidationProgress {
  completed: number;
  total: number;
  phase: "notes" | "uniqueness";
}

/** Session-only: never claim results from a previous plugin lifetime are current. */
export class ValidationState {
  private checked = new Set<string>();
  revision = 0;
  lastCompletedAt: string | null = null;
  completedRevision = -1;
  cancelled = false;
  progress: ValidationProgress | null = null;

  changed(path?: string): void {
    this.revision++;
    if (path) this.checked.delete(path);
    else this.checked.clear();
  }

  markChecked(path: string): void { this.checked.add(path); }
  isChecked(path: string): boolean { return this.checked.has(path); }

  /** True until anything has been checked in this session (the summary reads "Not checked yet"). */
  untouched(): boolean {
    return !this.progress && !this.cancelled && !this.lastCompletedAt && this.checked.size === 0;
  }

  summary(paths: string[]): string {
    if (this.progress) {
      const { completed, total } = this.progress;
      return this.progress.phase === "uniqueness"
        ? t`Checked ${completed} of ${plural(total, { one: "# note", other: "# notes" })} · checking for duplicate values…`
        : t`Checking ${completed} of ${plural(total, { one: "# note", other: "# notes" })}…`;
    }
    const checked = paths.filter(path => this.checked.has(path)).length;
    const total = paths.length;
    if (this.cancelled) return t`Validation stopped · ${checked} of ${plural(total, { one: "# note", other: "# notes" })} checked · results incomplete`;
    if (this.lastCompletedAt && this.completedRevision === this.revision) {
      const time = formatDate(new Date(this.lastCompletedAt), { hour: "2-digit", minute: "2-digit" });
      return t`Checked ${plural(total, { one: "# note", other: "# notes" })} at ${time}`;
    }
    if (this.lastCompletedAt) return t`Changed since last collection validation · ${checked} of ${plural(total, { one: "# note", other: "# notes" })} checked`;
    return checked ? t`Checked ${checked} of ${plural(total, { one: "# note", other: "# notes" })} · duplicate values not checked yet` : t`Not checked yet`;
  }
}
