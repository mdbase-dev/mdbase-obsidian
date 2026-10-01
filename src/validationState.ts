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

  summary(paths: string[]): string {
    if (this.progress) return this.progress.phase === "uniqueness"
      ? `Checked ${this.progress.completed} of ${this.progress.total} notes · checking uniqueness…`
      : `Checking ${this.progress.completed} of ${this.progress.total} notes…`;
    const checked = paths.filter(path => this.checked.has(path)).length;
    if (this.cancelled) return `Validation stopped · ${checked} of ${paths.length} notes checked · results incomplete`;
    if (this.lastCompletedAt && this.completedRevision === this.revision) {
      return `Validated ${new Date(this.lastCompletedAt).toLocaleTimeString()} · ${paths.length} notes · including uniqueness`;
    }
    if (this.lastCompletedAt) return `Changed since last collection validation · ${checked} of ${paths.length} notes checked`;
    return checked ? `Checked ${checked} of ${paths.length} notes · collection uniqueness not checked` : "Not checked yet";
  }
}
