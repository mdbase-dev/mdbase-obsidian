import { Notice, Setting } from "obsidian";
import type { HeldFile, HoldChoice, SyncKind, SyncSnapshot } from "../sync/controller";
import { errorText, holdReasonText, modeName, summarize } from "../sync/words";
import { renderStatus, type WorkspaceContext } from "./shared";

export const DOWNLOAD_URL = "https://mdbase.dev/downloads";

const HANDLED_NOTICES = new Set(["holds_pending", "devices_waiting_for_approval"]);

/**
 * The Sync destination. It answers, in order: is this vault synced, is it
 * healthy, and what can be done now. Everything about keys, devices and
 * servers stays inside the mdbase app unless a person has to act.
 */
export class SyncPane {
  private kind: SyncKind = "cloud";
  private name = "";
  private joinText = "";
  private joinFolder = "";
  private codes = new Map<string, string>();

  constructor(private readonly ctx: WorkspaceContext) {}

  getState(): Record<string, unknown> {
    return {};
  }

  setState(_state: Record<string, unknown>): void {}

  async refresh(): Promise<void> {
    await this.ctx.host.syncController.refresh();
  }

  dispose(): void {}

  prefillJoin(collection: string, name: string): void {
    this.joinText = collection;
    if (name) this.joinFolder = name;
  }

  private get s(): SyncSnapshot {
    return this.ctx.host.syncController.snapshot;
  }

  private run(action: () => Promise<unknown>): void {
    this.ctx.message = "";
    void action().catch((error: unknown) => {
      const text = error && typeof error === "object" && "code" in error ? errorText(error as { code: string; reason?: string; message: string }) : String(error);
      // Shown in the workspace's message bar, which stays above the scrolling content.
      this.ctx.message = text;
      this.ctx.render();
    });
  }

  render(container: HTMLElement): void {
    const s = this.s;
    const summary = summarize(s);
    const root = container.createDiv({ cls: "mdbase-sync" });
    const heading = root.createDiv({ cls: "mdbase-sync-heading" });
    heading.setAttr("data-tone", summary.tone);
    heading.createEl("h2", { text: summary.syncing ? summary.label : "Sync" });
    const detail = heading.createEl("p", { cls: "mdbase-sync-detail", text: summary.detail });
    detail.setAttr("role", "status");
    if (s.busy) root.createEl("p", { cls: "mdbase-muted", text: `${s.busy}…` });

    if (s.direct) {
      const native = this.ctx.host.syncController.native;
      if (!native) return;
      const phase = s.direct.phase.kind;
      if (phase === "signed_out" || phase === "authorizing") {
        this.actions(root, [["Sign in", true, () => this.run(() => native.signIn())]]);
      } else if (phase === "choosing") {
        this.actions(root, [
          ["Choose collection", true, () => native.choose()],
          ["Add a collection", false, () => this.run(() => native.addCollection())],
        ]);
      } else if (phase === "ready") {
        root.createEl("p", { text: "Edits made in two places are kept as separate conflict files beside the original." });
        this.actions(root, [["Check again", false, () => this.run(() => native.enqueue(() => native.reconcileAll(false, undefined, true)))]]);
        const transfer = new Setting(root).setName("Continue syncing with mdbase")
          .setDesc("Finish sending changes and stop syncing in Obsidian. Then add this folder to the mdbase app using the same collection. If sending fails, Obsidian keeps ownership.");
        transfer.addButton(button => button.setButtonText("Finish and stop").onClick(() => this.run(() => native.handover())));
      } else {
        this.actions(root, [["Check again", false, () => this.run(() => this.refreshAndRender())]]);
      }
      return;
    }
    switch (s.daemon) {
      case "mobile":
        root.createEl("p", { text: "Sync this vault from Obsidian on your computer, with the mdbase app installed. Types and validation work here as usual." });
        return;
      case "checking":
        return;
      case "not_installed":
        this.renderInstall(root);
        return;
      case "not_running":
        this.actions(root, [["Start mdbase", true, () => this.run(() => this.ctx.host.syncController.startApp())], ["Check again", false, () => this.run(() => this.refreshAndRender())]]);
        return;
      case "error":
        this.actions(root, [["Try again", true, () => this.run(() => this.refreshAndRender())]]);
        return;
      default:
        break;
    }

    const collection = s.collection;
    const signedIn = s.status?.account.signed_in === true;
    if (!signedIn) this.renderSignIn(root, Boolean(collection && collection.mode !== "local"));
    if (!collection || collection.mode === "local") {
      if (signedIn) this.renderSetup(root, collection !== null);
      return;
    }
    this.renderLink(root);
    this.renderApprovals(root);
    this.renderHolds(root);
    this.renderMerged(root);
    for (const notice of collection.notices) {
      if (!HANDLED_NOTICES.has(notice.code)) root.createEl("p", { cls: "mdbase-sync-notice", text: notice.message });
    }
    this.renderDetails(root);
  }

  private async refreshAndRender(): Promise<void> {
    await this.ctx.host.syncController.refresh();
    this.ctx.render();
  }

  private actions(container: HTMLElement, buttons: [string, boolean, () => void][]): void {
    const row = container.createDiv({ cls: "mdbase-actions" });
    for (const [label, primary, onClick] of buttons) {
      const button = row.createEl("button", { text: label, cls: primary ? "mod-cta" : "" });
      button.setAttr("data-focus-key", `sync-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      button.disabled = this.s.busy !== null;
      button.onclick = onClick;
    }
  }

  private renderInstall(root: HTMLElement): void {
    root.createEl("p", { text: "mdbase syncs this vault through the mdbase app. It runs in the background and keeps your notes on this computer in step with your other devices." });
    this.actions(root, [
      ["Download mdbase", true, () => window.open(DOWNLOAD_URL)],
      ["Check again", false, () => this.run(() => this.refreshAndRender())],
    ]);
    const hint = root.createEl("p", { cls: "mdbase-muted" });
    hint.appendText("Installed it somewhere unusual? Set its location in ");
    const link = hint.createEl("a", { text: "settings", href: "#" });
    link.onclick = (event) => { event.preventDefault(); this.ctx.host.openSettings(); };
    hint.appendText(".");
  }

  private renderSignIn(root: HTMLElement, syncing: boolean): void {
    const controller = this.ctx.host.syncController;
    if (this.s.signingIn) {
      root.createEl("p", { text: "Finish signing in in your browser, then come back here. If no page opened, copy the sign-in link into your browser." });
      const page = this.s.signingIn;
      this.actions(root, [
        ["Open the sign-in page again", false, () => window.open(page)],
        ["Copy sign-in link", false, () => void navigator.clipboard.writeText(page).then(() => new Notice("Copied. Paste it into your browser."))],
        ["Cancel", false, () => { controller.cancelSignIn(); this.ctx.render(); }],
      ]);
      return;
    }
    if (!syncing) root.createEl("p", { text: "Sign in to mdbase to sync this vault with your other devices." });
    this.actions(root, [["Sign in", true, () => this.run(async () => { await controller.signIn(); this.ctx.render(); })]]);
  }

  private renderSetup(root: HTMLElement, isCollection: boolean): void {
    const controller = this.ctx.host.syncController;
    if (!this.name) this.name = this.ctx.app.vault.getName();
    const legacy = this.ctx.host.legacyConnect();
    if (legacy) {
      const note = root.createDiv({ cls: "mdbase-sync-notice" });
      note.createEl("p", { text: `This vault used the earlier mdbase Connect sync for "${legacy.name}", which has been replaced. Your notes here are untouched.` });
      note.createEl("p", { text: `To keep working on "${legacy.name}", add it below: its latest version arrives in a new folder, and you can delete the old copy once you've checked it.` });
      if (!this.joinText) this.joinText = legacy.collectionId;
      if (!this.joinFolder) this.joinFolder = legacy.name;
    }

    const section = root.createDiv({ cls: "mdbase-sync-section" });
    section.createEl("h3", { text: isCollection ? "Turn on sync" : "Sync this vault" });
    if (!isCollection) {
      new Setting(section).setName("Name").setDesc("How this vault appears on your other devices.").addText((text) => text
        .setValue(this.name)
        .onChange((value) => { this.name = value; }));
    }
    const choice = section.createDiv({ cls: "mdbase-sync-choice" });
    choice.setAttr("role", "radiogroup");
    const option = (kind: SyncKind, title: string, description: string) => {
      const label = choice.createEl("label", { cls: "mdbase-sync-option" });
      const input = label.createEl("input", { type: "radio" });
      input.name = "mdbase-sync-kind";
      input.checked = this.kind === kind;
      label.toggleClass("is-selected", input.checked);
      input.setAttr("data-focus-key", `sync-kind-${kind}`);
      input.onchange = () => {
        this.kind = kind;
        choice.querySelectorAll("label").forEach((el) => el.toggleClass("is-selected", el === label));
      };
      const text = label.createDiv();
      text.createDiv({ cls: "mdbase-sync-option-title", text: title });
      text.createDiv({ cls: "mdbase-muted", text: description });
    };
    option("cloud", "Cloud copy (recommended)", "mdbase keeps a copy online, so your notes open in mdbase apps on the web and arrive on a new device straight away.");
    option("private", "Private", "Encrypted so only your devices can read it. For now it works on this computer only: other computers can't be added yet. Web apps work only while this computer is on.");
    this.actions(section, [["Turn on sync", true, () => this.run(async () => {
      await controller.setUp(this.kind, this.name);
      new Notice("Sync is on for this vault.");
    })]]);

    if (isCollection) return;
    const join = root.createDiv({ cls: "mdbase-sync-section" });
    join.createEl("h3", { text: "Add a collection you already sync" });
    join.createEl("p", { cls: "mdbase-muted", text: "On a device that already syncs it, copy the link from the sync tab of the mdbase view, then paste it here. For now, private collections work on the first computer only, so only cloud copy collections can be added here." });
    new Setting(join).setName("Link or ID").addText((text) => {
      text.setPlaceholder("Paste the collection link").setValue(this.joinText).onChange((value) => { this.joinText = value; });
      text.inputEl.setAttr("data-focus-key", "sync-join-link");
    });
    const empty = this.ctx.host.vaultTopLevelEntries().length === 0;
    if (!empty) {
      new Setting(join).setName("Folder").setDesc("This vault already has notes, so the collection goes into a new folder.").addText((text) => {
        text.setPlaceholder("Folder name").setValue(this.joinFolder).onChange((value) => { this.joinFolder = value; });
        text.inputEl.setAttr("data-focus-key", "sync-join-folder");
      });
    }
    this.actions(join, [["Add collection", false, () => this.run(async () => {
      const folder = await controller.join(this.joinText, this.joinFolder || nameFromLink(this.joinText) || "Synced notes");
      this.joinText = "";
      new Notice(folder ? `Added. Notes arrive in "${folder}".` : "Added. Notes arrive in this vault.");
    })]]);
  }

  private renderLink(root: HTMLElement): void {
    const controller = this.ctx.host.syncController;
    const link = this.s.link;
    if (link === "connecting" && !this.s.live) {
      root.createEl("p", { cls: "mdbase-muted", text: "If mdbase asks whether Obsidian may use this vault, allow it. Obsidian then shows live status and keeps open notes in step." });
    } else if (link === "declined") {
      root.createEl("p", { text: "Obsidian isn't allowed to use this vault's sync yet. Sync still runs, but open notes can't update while you type." });
      this.actions(root, [["Allow Obsidian", false, () => this.run(() => controller.linkAgain())]]);
    }
  }

  private renderApprovals(root: HTMLElement): void {
    const controller = this.ctx.host.syncController;
    for (const approval of this.s.approvals) {
      const section = root.createDiv({ cls: "mdbase-sync-section" });
      section.createEl("h3", { text: `${approval.name} wants to join` });
      section.createEl("p", { text: "If you're setting up a new device, type the six-digit code it shows. Only approve devices you own." });
      new Setting(section).setName("Code").addText((text) => {
        text.setPlaceholder("123456").setValue(this.codes.get(approval.device) ?? "").onChange((value) => this.codes.set(approval.device, value));
        text.inputEl.inputMode = "numeric";
        text.inputEl.setAttr("data-focus-key", `sync-code-${approval.device}`);
      });
      this.actions(section, [
        ["Approve", true, () => this.run(async () => {
          await controller.approve(approval.device, this.codes.get(approval.device) ?? "");
          this.codes.delete(approval.device);
          new Notice("Approved. The new device is syncing.");
        })],
        ["Decline", false, () => this.run(() => controller.reject(approval.device))],
      ]);
    }
  }

  private renderHolds(root: HTMLElement): void {
    const holds = this.s.holds;
    if (!holds.length) return;
    const section = root.createDiv({ cls: "mdbase-sync-section" });
    section.createEl("p", { cls: "mdbase-muted", text: "mdbase didn't overwrite anything. Until you choose, the version on this computer stays as it is." });
    const list = section.createDiv({ cls: "mdbase-hold-list" });
    for (const hold of holds) this.renderHold(list, hold);
  }

  private renderHold(list: HTMLElement, hold: HeldFile): void {
    const controller = this.ctx.host.syncController;
    const vaultPath = this.s.prefix ? `${this.s.prefix}/${hold.path}` : hold.path;
    const row = list.createDiv({ cls: "mdbase-hold" });
    const name = row.createEl("a", { cls: "mdbase-hold-path", text: vaultPath, href: "#" });
    name.setAttr("data-focus-key", `hold-${hold.id}`);
    name.onclick = (event) => { event.preventDefault(); void this.ctx.host.openFileByPath(vaultPath); };
    row.createDiv({ cls: "mdbase-muted", text: holdReasonText(hold.reason) });
    if (hold.mine !== null && hold.theirs !== null) {
      this.compare(row, `hold-${hold.id}`, "Compare versions", ["On this computer", hold.mine], ["From your other device", hold.theirs]);
    }
    const choose = (choice: HoldChoice) => () => this.run(() => controller.resolve(hold, choice));
    const buttons: [string, boolean, () => void][] = [["Keep this computer's", true, choose("keep_mine")]];
    if (hold.reason === "deleted_elsewhere") buttons.push(["Delete it", false, choose("delete")]);
    else if (hold.hasTheirs) buttons.push(["Use the other version", false, choose("take_theirs")], ["Keep both", false, choose("keep_both")]);
    this.actions(row, buttons);
  }

  /** Two versions, showing only the lines that differ (with one line around them). */
  private compare(row: HTMLElement, key: string, label: string, a: [string, string], b: [string, string]): void {
    const body = this.ctx.disclosure(row, key, label);
    const [x, y] = differingLines(a[1], b[1]);
    body.createDiv({ cls: "mdbase-hold-label", text: a[0] });
    body.createEl("pre", { cls: "mdbase-hold-text", text: x });
    body.createDiv({ cls: "mdbase-hold-label", text: b[0] });
    body.createEl("pre", { cls: "mdbase-hold-text", text: y });
  }

  private renderMerged(root: HTMLElement): void {
    const merged = this.s.merged;
    if (!merged.length) return;
    const controller = this.ctx.host.syncController;
    const section = root.createDiv({ cls: "mdbase-sync-section" });
    section.createEl("h3", { text: merged.length === 1 ? "1 change to check" : `${merged.length} changes to check` });
    section.createEl("p", { cls: "mdbase-muted", text: "These were edited on two devices at once. mdbase kept one side so sync could carry on; check that it kept what you want." });
    const list = section.createDiv({ cls: "mdbase-hold-list" });
    for (const change of merged) {
      const row = list.createDiv({ cls: "mdbase-hold" });
      const vaultPath = change.path && this.s.prefix ? `${this.s.prefix}/${change.path}` : change.path;
      if (vaultPath) {
        const name = row.createEl("a", { cls: "mdbase-hold-path", text: vaultPath, href: "#" });
        name.onclick = (event) => { event.preventDefault(); void this.ctx.host.openFileByPath(vaultPath); };
      } else {
        row.createDiv({ cls: "mdbase-hold-path", text: "A note that was since removed" });
      }
      const key = `merged-${change.entry.mutation}-${change.field ?? change.kind}`;
      if (change.kind === "field" && change.field !== null) {
        row.createDiv({ cls: "mdbase-muted", text: `"${change.field}" was set to ${change.kept}. The other device set it to ${change.lost}.` });
        this.actions(row, [
          ["Keep it", true, () => this.run(() => controller.dismissMerged(change))],
          [`Use ${clip(change.lost)}`, false, () => this.run(() => controller.useOtherValue(change))],
        ]);
        continue;
      }
      row.createDiv({ cls: "mdbase-muted", text: mergedText(change.kind) });
      if (change.kept || change.lost) this.compare(row, key, "Show both versions", ["Kept", change.kept], ["Replaced", change.lost]);
      this.actions(row, [["OK", false, () => this.run(() => controller.dismissMerged(change))]]);
    }
  }

  private renderDetails(root: HTMLElement): void {
    const s = this.s;
    const collection = s.collection;
    if (!collection) return;
    const details = root.createDiv({ cls: "mdbase-sync-section mdbase-status-list" });
    const row = (label: string, value: string) => renderStatus(details, label, value);
    row("Collection", collection.name);
    row("Kind", modeName(collection.mode));
    if (s.prefix) row("Folder", s.prefix);
    if (s.status?.account.computer_name) row("This computer", s.status.account.computer_name);
    this.actions(root, [
      ["Copy link", false, () => {
        const link = `obsidian://mdbase-join?collection=${collection.id}&name=${encodeURIComponent(collection.name)}`;
        void navigator.clipboard.writeText(link).then(() => new Notice("Copied. Open the link on your other device, or paste it into the sync tab there."));
      }],
      ["Sync settings", false, () => this.ctx.host.openSettings()],
    ]);
  }
}

/** The collection name carried by a copied link (`…&name=…`), if any. */
export function nameFromLink(text: string): string {
  const match = /[?&]name=([^&\s]*)/.exec(text);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1].replace(/\+/g, " ")).trim();
  } catch {
    return "";
  }
}

function mergedText(kind: string): string {
  switch (kind) {
    case "body": return "The text was changed on two devices. mdbase kept one version.";
    case "frontmatter": return "The properties were changed on two devices. mdbase kept one version.";
    case "path": return "It was renamed or moved on two devices. mdbase kept one name.";
    case "delete": return "It was deleted on one device and changed on another.";
    default: return "It was changed on two devices. mdbase kept one version.";
  }
}

const clip = (value: string) => (value.length > 24 ? `${value.slice(0, 23)}…` : value);

/** The differing middle of two texts, by line, with one line of context. */
export function differingLines(a: string, b: string): [string, string] {
  const x = a.split("\n");
  const y = b.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
  const from = Math.max(0, start - 1);
  const cut = (lines: string[]) => {
    const to = Math.min(lines.length, lines.length - end + 1);
    const more = (rest: string[]) => rest.some((line) => line.trim());
    return `${more(lines.slice(0, from)) ? "…\n" : ""}${lines.slice(from, to).join("\n")}${more(lines.slice(to)) ? "\n…" : ""}`;
  };
  return [cut(x), cut(y)];
}
