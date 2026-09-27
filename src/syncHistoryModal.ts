import { type App, Modal } from "obsidian";
import { describeHistoryFile, formatHistoryTime, historyForPath, type SyncHistoryRun } from "./syncHistory";
import type { SyncActivityEntry } from "./syncUx";

/** Everything this device recorded about one path: transfers and conflict decisions. */
export class NoteSyncHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly runs: readonly SyncHistoryRun[],
    private readonly activity: readonly SyncActivityEntry[],
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Sync history · ${this.path.split("/").pop() ?? this.path}`);
    this.contentEl.addClass("mdbase-note-history");
    const rows = [
      ...historyForPath(this.runs, this.path).map(({ file }) => ({
        at: file.at,
        label: describeHistoryFile(file),
        detail: file.fromPath ? `From ${file.fromPath}` : file.message,
      })),
      ...this.activity
        .filter((entry) => entry.path === this.path)
        .map((entry) => ({ at: entry.occurredAt, label: entry.summary, detail: undefined })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    if (!rows.length) {
      this.contentEl.createEl("p", { cls: "mdbase-muted", text: "No syncs of this note are recorded on this device." });
      return;
    }
    const list = this.contentEl.createDiv({ cls: "mdbase-transfer-ledger" });
    for (const row of rows) {
      const item = list.createDiv({ cls: "mdbase-note-history-row" });
      item.createSpan({ cls: "mdbase-muted", text: formatHistoryTime(row.at) });
      const body = item.createDiv();
      body.createDiv({ text: row.label });
      if (row.detail) body.createDiv({ cls: "mdbase-muted", text: row.detail });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
