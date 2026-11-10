import { Notice, Setting, SuggestModal, TFolder, setIcon, type App } from "obsidian";
import type { HeldFile, HoldChoice, SyncKind, SyncSnapshot } from "../sync/controller";
import type { DirectFailure, MergePrompt, SyncTotals } from "../sync/native/plugin";
import { MEDIA_CLASSES, type ActivityEntry, type ActivityKind, type CollectionInclusion, type DeviceFilter, type MediaClass } from "../sync/native/device";
import { PRIVATE_COLLECTIONS_HINT, PRIVATE_SIGN_IN_HINT, errorText, holdReasonText, modeName, summarize, unlockProblemText } from "../sync/words";
import { renderStatus, type WorkspaceContext } from "./shared";

export const DOWNLOAD_URL = "https://mdbase.dev/downloads";

const MAX_FAILURES_SHOWN = 50;
const TONE_ICONS: Record<string, string> = {
  ok: "check-circle-2",
  busy: "refresh-cw",
  attention: "alert-triangle",
  problem: "alert-circle",
  quiet: "cloud",
};
const MEDIA_NAMES: Record<MediaClass, [string, string]> = {
  image: ["Images", "png, jpg, gif, svg, webp and other pictures"],
  audio: ["Audio", "mp3, m4a, wav, ogg and other recordings"],
  video: ["Videos", "mp4, mov, webm and other video"],
  pdf: ["PDFs", "PDF documents"],
  other: ["Other files", "Any other attachment, such as canvas, zip or csv files"],
};
const ACTIVITY: Record<ActivityKind, [string, string]> = {
  uploaded: ["upload", "Sent"],
  downloaded: ["download", "Received"],
  deleted_here: ["trash-2", "Deleted here (removed on another device)"],
  deleted_remote: ["trash-2", "Deleted everywhere"],
  moved: ["folder-input", "Moved"],
  conflict: ["copy", "Both versions kept"],
  not_synced: ["alert-triangle", "Couldn't sync"],
};
type ActivityFilter = "all" | "sent" | "received" | "deleted" | "problems";
const FILTERS: [ActivityFilter, string, ActivityKind[]][] = [
  ["all", "All", []],
  ["sent", "Sent", ["uploaded"]],
  ["received", "Received", ["downloaded"]],
  ["deleted", "Deleted and moved", ["deleted_here", "deleted_remote", "moved"]],
  ["problems", "Problems", ["conflict", "not_synced"]],
];
const ACTIVITY_PAGE = 25;
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
  private activityFilter: ActivityFilter = "all";
  private activityShown = ACTIVITY_PAGE;
  /** Sync now: running, then what it did (kept until the next press). */
  /** Typed into the unlock form. Dropped the moment it is sent, and whenever the form goes away. */
  private unlockSecret = "";
  private unlockWith: "password" | "recovery" = "password";
  private syncingNow = false;
  private syncNowResult: { at: number; text: string; tone: "ok" | "attention" } | null = null;

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
    setIcon(heading.createDiv({ cls: "mdbase-sync-heading-icon" }), TONE_ICONS[summary.tone] ?? "cloud");
    const headingText = heading.createDiv({ cls: "mdbase-sync-heading-text" });
    headingText.createEl("h2", { text: summary.syncing ? summary.label : "Sync" });
    const detail = headingText.createEl("p", { cls: "mdbase-sync-detail", text: summary.detail });
    detail.setAttr("role", "status");
    if (s.busy) root.createEl("p", { cls: "mdbase-muted", text: `${s.busy}…` });

    if (s.direct) {
      const controller = this.ctx.host.syncController;
      const native = controller.native;
      if (!native) return;
      const phase = s.direct.phase.kind;
      if (phase !== "needs_unlock") this.unlockSecret = "";
      if (s.direct.merge) {
        this.renderMerge(root, s.direct.merge);
      } else if (phase === "authorizing" && s.direct.bound) {
        // Request access again is waiting in the browser; this reopens that page.
        this.actions(root, [["Open approval page", true, () => this.run(() => native.signIn())]]);
      } else if (phase === "signed_out" || phase === "authorizing") {
        this.actions(root, [["Sign in", true, () => this.run(() => native.signIn())]]);
        root.createEl("p", { cls: "mdbase-muted", text: PRIVATE_SIGN_IN_HINT });
      } else if (phase === "starting" && s.direct.phase.stalled) {
        this.actions(root, [[RESTART_SYNC, true, () => this.run(() => controller.restartNative())]]);
      } else if (phase === "needs_unlock") {
        this.renderUnlock(root, s.direct.phase);
      } else if (phase === "choosing") {
        this.actions(root, [
          ["Choose collection", true, () => native.choose()],
          ["Add a collection", false, () => this.run(() => native.addCollection())],
        ]);
        root.createEl("p", { cls: "mdbase-muted", text: PRIVATE_COLLECTIONS_HINT });
      } else if (phase === "ready") {
        this.renderSyncNow(root, () => native.enqueue(() => native.reconcileAll(false, undefined, true)));
        this.renderDirectFailures(root, s.direct.failures ?? []);
        this.renderOverview(root, s.direct.lastSynced ?? null, s.direct.totals ?? null, s.direct.phase.sync);
        this.renderDevice(root, s.direct.device ?? { skip: [], folders: [] }, s.direct.inclusion ?? null, (next) => this.run(() => native.setDevice(next)));
        this.renderActivity(root, s.direct.activity ?? []);
        const advanced = this.group(root, "Advanced", undefined, true);
        new Setting(advanced).setName("Edits on two devices at once")
          .setDesc("Both versions are kept: the other one as a conflict file beside the original.");
        const transfer = new Setting(advanced).setName("Move sync to the mdbase app")
          .setDesc("Obsidian is syncing this vault itself. To let the mdbase desktop app do it instead, Obsidian sends any remaining changes and stops. Then add this folder in the mdbase app and pick the same collection. If anything can't be sent, Obsidian carries on syncing.");
        transfer.addButton(button => button.setButtonText("Move to mdbase app").onClick(() => this.run(() => native.handover())));
      } else if (phase === "handed_over") {
        // Done on purpose; the heading says what's next.
        this.actions(root, [["Get the mdbase app", false, () => window.open(DOWNLOAD_URL)]]);
      } else if (phase === "needs_approval") {
        this.actions(root, [["Request access again", true, () => this.run(() => native.requestAccess())]]);
      } else if (phase === "problem") {
        const problem = s.direct.phase.problem as { action?: unknown; code?: unknown } | null | undefined;
        const step = problemStep(problem?.action, Boolean((s.direct.phase as { collectionId?: unknown }).collectionId), problem?.code);
        const buttons: [string, boolean, () => void][] = [];
        if (step === "sign_in") buttons.push(["Sign in again", true, () => this.run(() => native.signIn())]);
        else if (step === "approve") buttons.push(["Request access again", true, () => this.run(() => native.requestAccess())]);
        else if (step === "restart") buttons.push([RESTART_SYNC, true, () => this.run(() => controller.restartNative())]);
        else if (step === "retry") buttons.push(["Try again", false, () => this.run(() => native.retry())]);
        // Nothing synced and nothing waiting: signing out can't lose anything.
        // With the SDK's Worker gone, the controller restarts the host first.
        const startOver = native.canStartOver;
        if (startOver) buttons.push(["Start over", false, () => this.run(() => controller.startOver())]);
        if (buttons.length) this.actions(root, buttons);
        if (startOver) root.createEl("p", { cls: "mdbase-muted", text: START_OVER_HINT });
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
      if (!HANDLED_NOTICES.has(notice.code)) this.callout(root).createEl("p", { text: notice.message });
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

  /** A settings-style group: an optional heading above a bordered list, as in Obsidian's settings. */
  /** `list` groups hold setting rows and keep Obsidian's own row dividers and padding. */
  private group(root: HTMLElement, title?: string, cls?: string, list = false): HTMLElement {
    const group = root.createDiv({ cls: "setting-group mdbase-sync-group" });
    if (title) {
      const heading = group.createDiv({ cls: "setting-item setting-item-heading" });
      heading.createDiv({ cls: "setting-item-info" }).createDiv({ cls: "setting-item-name", text: title });
    }
    const body = group.createDiv({ cls: list ? "setting-items mdbase-sync-list" : "setting-items mdbase-sync-section" });
    if (cls) body.addClass(cls);
    return body;
  }

  private renderSyncNow(root: HTMLElement, sync: () => Promise<unknown>): void {
    const row = root.createDiv({ cls: "mdbase-actions mdbase-sync-now" });
    const button = row.createEl("button", { cls: "mdbase-sync-now-button" });
    button.setAttr("data-focus-key", "sync-now");
    setIcon(button.createSpan({ cls: "mdbase-sync-now-icon" }), "refresh-cw");
    button.createSpan({ text: this.syncingNow ? "Syncing…" : "Sync now" });
    button.toggleClass("is-syncing", this.syncingNow);
    button.disabled = this.syncingNow || this.s.busy !== null;
    button.setAttr("aria-busy", String(this.syncingNow));
    const result = row.createSpan({ cls: "mdbase-sync-now-result" });
    result.setAttr("role", "status");
    if (this.syncingNow) result.setText("Checking every file against the collection…");
    else if (this.syncNowResult) {
      result.setText(`${this.syncNowResult.text} · ${ago(this.syncNowResult.at).toLowerCase()}`);
      result.setAttr("data-tone", this.syncNowResult.tone);
    }
    button.onclick = () => {
      const started = Date.now();
      const failedBefore = this.s.direct?.failures?.length ?? 0;
      this.syncingNow = true;
      this.syncNowResult = null;
      this.ctx.render();
      void sync().finally(() => {
        const direct = this.s.direct;
        const done = (direct?.activity ?? []).filter((e) => e.at >= started);
        const failed = direct?.failures?.length ?? 0;
        this.syncingNow = false;
        this.syncNowResult = syncNowSummary(done, failed, failedBefore, direct?.phase.kind === "ready" && !/stopped/i.test(direct.text));
        this.ctx.render();
      });
    };
  }

  private renderOverview(root: HTMLElement, lastSynced: number | null, totals: SyncTotals | null, sync?: { pending: number; live?: boolean | null; holds?: number; conflicts?: number }): void {
    const list = this.group(root, "Overview", "mdbase-sync-overview", true);
    const row = (name: string, value: string, desc?: string) => {
      const setting = new Setting(list).setName(name);
      if (desc) setting.setDesc(desc);
      setting.controlEl.createSpan({ cls: "mdbase-sync-value", text: value });
    };
    row("Last synced", lastSynced ? ago(lastSynced) : "Not yet");
    if (sync?.pending) row("Waiting to send", count(sync.pending, "change"));
    if (sync?.live === false) row("Live updates", "Paused", "Changes from other devices arrive when Obsidian is in front, or when you choose Sync now.");
    if (!totals) {
      row("Synced here", "Counting…");
      return;
    }
    row("Notes", totals.notes.toLocaleString());
    row("Attachments", totals.attachments.toLocaleString(), totals.attachments ? `${size(totals.attachmentBytes)} in total` : undefined);
    row("Types and settings", totals.definitions.toLocaleString(), "Type definitions and mdbase.yaml");
    if (totals.notHere) row("Not on this device", count(totals.notHere, "file"), totals.byCollection === totals.notHere ? "In the collection, but its own file settings leave them out." : "In the collection, but left out here by your choices below or the collection's file settings.");
  }

  private renderDevice(root: HTMLElement, device: DeviceFilter, inclusion: CollectionInclusion | null, save: (next: DeviceFilter) => void): void {
    const list = this.group(root, "On this device", "mdbase-sync-device", true);
    new Setting(list).setName("Notes and types").setDesc("Always synced, apart from the folders you leave out below.");
    for (const media of MEDIA_CLASSES) {
      const [name, desc] = MEDIA_NAMES[media];
      // The collection's own setting wins: a kind it doesn't sync is off on every device.
      const collectionOff = inclusion !== null && !inclusion.include.includes(media);
      new Setting(list).setName(name)
        .setDesc(collectionOff ? "Not synced in this collection. Change this in the mdbase app." : desc)
        .addToggle((toggle) => toggle
          .setValue(!collectionOff && !device.skip.includes(media))
          .setDisabled(collectionOff)
          .onChange((on) => save({ ...device, skip: on ? device.skip.filter((m) => m !== media) : [...device.skip, media] })));
    }
    const limits = collectionLimits(inclusion);
    if (limits) new Setting(list).setName("Collection limits").setDesc(`${limits} Set for every device in the mdbase app.`);
    const folders = new Setting(list).setName("Folders left out")
      .setDesc(device.folders.length ? "Nothing in these folders syncs to or from this device." : "Choose folders whose notes and files stay off this device.");
    folders.addButton((button) => button.setButtonText("Add folder").onClick(() => {
      new FolderPicker(this.ctx.app, device.folders, (folder) => save({ ...device, folders: [...device.folders, folder] })).open();
    }));
    for (const folder of device.folders) {
      const row = new Setting(list).setName(folder);
      row.settingEl.addClass("mdbase-sync-folder");
      row.addExtraButton((button) => button
        .setIcon("x").setTooltip(`Sync ${folder} again`)
        .onClick(() => save({ ...device, folders: device.folders.filter((f) => f !== folder) })));
    }
    list.createDiv({ cls: "setting-item mdbase-sync-device-note", text: "These choices apply to this device only. Turning something off never deletes it, here or anywhere else; turning it back on brings it here again." });
  }

  private renderActivity(root: HTMLElement, activity: ActivityEntry[]): void {
    const group = root.createDiv({ cls: "setting-group mdbase-sync-group" });
    const heading = group.createDiv({ cls: "setting-item setting-item-heading" });
    heading.createDiv({ cls: "setting-item-info" }).createDiv({ cls: "setting-item-name", text: "Activity" });
    const filters = heading.createDiv({ cls: "setting-item-control mdbase-activity-filters" });
    filters.setAttr("role", "radiogroup");
    filters.setAttr("aria-label", "Show activity");
    for (const [key, label] of FILTERS) {
      const button = filters.createEl("button", { cls: "mdbase-activity-filter", text: label });
      button.setAttr("role", "radio");
      button.setAttr("aria-checked", String(this.activityFilter === key));
      button.toggleClass("is-active", this.activityFilter === key);
      button.onclick = () => { this.activityFilter = key; this.activityShown = ACTIVITY_PAGE; this.ctx.render(); };
    }
    const kinds = FILTERS.find(([key]) => key === this.activityFilter)?.[2] ?? [];
    const entries = kinds.length ? activity.filter((e) => kinds.includes(e.kind)) : activity;
    const list = group.createDiv({ cls: "setting-items mdbase-activity" });
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-activity-empty", text: activity.length ? "Nothing of this kind yet." : "Files sent and received appear here." });
      return;
    }
    for (const entry of entries.slice(0, this.activityShown)) {
      const row = list.createDiv({ cls: "mdbase-activity-row" });
      row.setAttr("data-kind", entry.kind);
      const [icon, verb] = ACTIVITY[entry.kind] ?? ["dot", entry.kind];
      setIcon(row.createSpan({ cls: "mdbase-activity-icon" }), icon);
      const text = row.createDiv({ cls: "mdbase-activity-text" });
      const target = entry.to ?? entry.path;
      const name = text.createEl("a", { cls: "mdbase-activity-path", text: target, href: "#" });
      name.onclick = (event) => { event.preventDefault(); void this.ctx.host.openFileByPath(target); };
      text.createDiv({ cls: "mdbase-activity-detail", text: entry.kind === "moved" ? `Moved from ${entry.path}${entry.from === "remote" ? " on another device" : ""}` : verb });
      const time = row.createSpan({ cls: "mdbase-activity-time", text: ago(entry.at) });
      time.setAttr("title", new Date(entry.at).toLocaleString());
    }
    if (entries.length > this.activityShown) {
      const more = group.createEl("button", { cls: "mdbase-load-more", text: `Show more (${(entries.length - this.activityShown).toLocaleString()})` });
      more.onclick = () => { this.activityShown += ACTIVITY_PAGE * 4; this.ctx.render(); };
    }
  }

  /** A warning callout, using Obsidian's callout markup and colours. */
  private callout(root: HTMLElement): HTMLElement {
    const callout = root.createDiv({ cls: "callout mdbase-sync-notice" });
    callout.setAttr("data-callout", "warning");
    return callout.createDiv({ cls: "callout-content" });
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
      const note = this.callout(root);
      note.createEl("p", { text: `This vault used the earlier mdbase Connect sync for "${legacy.name}", which has been replaced. Your notes here are untouched.` });
      note.createEl("p", { text: `To keep working on "${legacy.name}", add it below: its latest version arrives in a new folder, and you can delete the old copy once you've checked it.` });
      if (!this.joinText) this.joinText = legacy.collectionId;
      if (!this.joinFolder) this.joinFolder = legacy.name;
    }

    const section = this.group(root, isCollection ? "Turn on sync" : "Sync this vault");
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
    const join = this.group(root, "Add a collection you already sync");
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
      const section = this.group(root, `${approval.name} wants to join`);
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

  /** First sync of a vault that has notes into a collection that has items. */
  private renderMerge(root: HTMLElement, merge: MergePrompt): void {
    const native = this.ctx.host.syncController.native;
    if (!native) return;
    const section = this.group(root, `Combine this vault with “${merge.name}”?`);
    const files = (n: number) => n === 1 ? "1 file" : `${n} files`;
    section.createEl("p", { text: `This vault has ${files(merge.local)} and “${merge.name}” has ${files(merge.remote)}. Nothing has synced yet.` });
    section.createEl("p", { cls: "mdbase-muted", text: "Combining copies the collection's notes into this vault and this vault's notes into the collection. Nothing is deleted. If the same file differs on each side, both versions are kept." });
    this.actions(section, [
      ["Combine and sync", true, () => this.run(() => native.confirmMerge())],
      ["Use a different collection", false, () => native.chooseAnother()],
    ]);
  }

  /** Paths in-plugin sync couldn't send or receive, each with its reason. */
  private renderDirectFailures(root: HTMLElement, failures: DirectFailure[]): void {
    if (!failures.length) return;
    const native = this.ctx.host.syncController.native;
    const section = this.group(root, failures.length === 1 ? "1 file not synced" : `${failures.length} files not synced`);
    section.createEl("p", { cls: "mdbase-muted", text: "Everything else is in sync. These stay as they are on this computer until they're fixed; sync tries them again when they change." });
    const list = section.createDiv({ cls: "mdbase-hold-list" });
    for (const failure of failures.slice(0, MAX_FAILURES_SHOWN)) {
      const row = list.createDiv({ cls: "mdbase-hold" });
      const name = row.createEl("a", { cls: "mdbase-hold-path", text: failure.path, href: "#" });
      name.onclick = (event) => { event.preventDefault(); void this.ctx.host.openFileByPath(failure.path); };
      row.createDiv({ text: failure.title });
      row.createDiv({ cls: "mdbase-muted", text: failure.detail });
      if (failure.choose && native) this.actions(row, [
        ["Keep this vault's", false, () => this.run(() => native.resolveDefinition(failure.path, "local"))],
        ["Keep the collection's", false, () => this.run(() => native.resolveDefinition(failure.path, "remote"))],
      ]);
    }
    if (failures.length > MAX_FAILURES_SHOWN) section.createEl("p", { cls: "mdbase-muted", text: `And ${failures.length - MAX_FAILURES_SHOWN} more.` });
  }

  private renderHolds(root: HTMLElement): void {
    const holds = this.s.holds;
    if (!holds.length) return;
    const section = this.group(root);
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

  /**
   * A Private collection keeps its key on the user's own devices, so this vault
   * has to be given it once: with the encryption password or the recovery key.
   */
  private renderUnlock(root: HTMLElement, phase: NonNullable<SyncSnapshot["direct"]>["phase"]): void {
    const native = this.ctx.host.syncController.native;
    if (!native) return;
    const lock = phase.unlock ?? { mode: "password" as const, unlocking: false, name: null };
    const name = lock.name ? `“${lock.name}”` : "This collection";
    const section = this.group(root, lock.name ? `Unlock “${lock.name}”` : "Unlock this collection");
    const other: [string, boolean, () => void][] = native.canChooseAnother ? [["Use a different collection", false, () => native.chooseAnother()]] : [];
    if (lock.mode !== "password") {
      this.unlockSecret = "";
      section.createEl("p", { text: lock.mode === "strict"
        ? `${name} is Private, and your account approves each new device from one you already use instead of with an encryption password. Obsidian can't be approved that way yet.`
        : `${name} is Private, and your account has no encryption password yet. Set one in the mdbase app on a computer that already has this collection.` });
      section.createEl("p", { cls: "mdbase-muted", text: lock.mode === "strict"
        ? "To sync this vault, add its folder in the mdbase app on this computer. Your notes here are untouched."
        : "Then come back and check again. Your notes here are untouched." });
      this.actions(section, [["Check again", lock.mode === "none", () => this.run(() => native.recheckLock())], ...other]);
      return;
    }
    const recovery = this.unlockWith === "recovery";
    section.createEl("p", { text: `${name} is Private: only your own devices can read it. To open it in this vault, enter your ${recovery ? "recovery key" : "encryption password"}.` });
    const form = section.createEl("form", { cls: "mdbase-unlock" });
    const label = form.createEl("label", { cls: "mdbase-unlock-label", text: recovery ? "Recovery key" : "Encryption password" });
    const input = form.createEl("input", { cls: "mdbase-unlock-input" });
    input.type = recovery ? "text" : "password";
    input.id = "mdbase-unlock-secret"; label.htmlFor = input.id;
    input.autocomplete = recovery ? "off" : "current-password";
    input.spellcheck = false;
    input.value = this.unlockSecret;
    input.disabled = lock.unlocking;
    input.setAttr("data-focus-key", "sync-unlock-secret");
    input.oninput = () => { this.unlockSecret = input.value; submit.disabled = lock.unlocking || !input.value.trim(); };
    const problem = lock.unlocking ? null : unlockProblemText(phase.problem);
    if (problem) {
      const error = form.createEl("p", { cls: "mdbase-unlock-problem", text: problem });
      error.id = "mdbase-unlock-problem"; error.setAttr("role", "alert");
      input.setAttr("aria-describedby", error.id); input.setAttr("aria-invalid", "true");
    }
    const row = form.createDiv({ cls: "mdbase-actions" });
    const submit = row.createEl("button", { cls: "mod-cta", text: lock.unlocking ? "Unlocking…" : "Unlock" });
    submit.type = "submit";
    submit.setAttr("data-focus-key", "sync-unlock");
    submit.disabled = lock.unlocking || !this.unlockSecret.trim();
    const swap = row.createEl("button", { cls: "mdbase-link-button", text: recovery ? "Use your encryption password instead" : "Use your recovery key instead" });
    swap.type = "button";
    swap.setAttr("data-focus-key", "sync-unlock-swap");
    swap.disabled = lock.unlocking;
    swap.onclick = () => { this.unlockWith = recovery ? "password" : "recovery"; this.unlockSecret = ""; this.ctx.render(); };
    form.onsubmit = (event) => {
      event.preventDefault();
      const typed = this.unlockSecret;
      if (lock.unlocking || !typed.trim()) return;
      // Nothing here keeps it: the field and this pane's copy are emptied as it is sent.
      this.unlockSecret = ""; input.value = "";
      this.run(() => native.unlock(recovery ? { recoveryKey: typed.trim() } : { password: typed }));
    };
    section.createEl("p", { cls: "mdbase-muted mdbase-unlock-note", text: recovery
      ? "It's used once and isn't saved. The recovery key is the one mdbase showed when you set your encryption password."
      : "It's used once and isn't saved." });
    if (other.length) this.actions(section, other);
  }
  private renderMerged(root: HTMLElement): void {
    const merged = this.s.merged;
    if (!merged.length) return;
    const controller = this.ctx.host.syncController;
    const section = this.group(root, merged.length === 1 ? "1 change to check" : `${merged.length} changes to check`);
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
    const details = this.group(root, undefined, "mdbase-status-list");
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

/** The button for a stop only a fresh sync host can get past (a page reload, for a web app). */
export const RESTART_SYNC = "Restart sync";

export const START_OVER_HINT = "Start over signs this vault out of mdbase, so you can sign in again with any account. Nothing has synced yet, so your notes aren't affected.";

/**
 * The one button a stop gets, by the sync engine's suggested action
 * (describeError's MdbaseErrorAction). Actions the plugin can't carry out here
 * (update, free space, set up, contact support) get none: the words say what to do.
 */
export function problemStep(action: unknown, hasCollection: boolean, code?: unknown): "sign_in" | "approve" | "restart" | "retry" | null {
  // The SDK's Worker quarantined itself and refuses every call: only a fresh host helps.
  if (typeof code === "string" && /^application_worker_/.test(code)) return "restart";
  switch (action) {
    case "sign_in": return "sign_in";
    // Approval is per collection; without one there is nothing to approve.
    case "approve": return hasCollection ? "approve" : null;
    // What a web app does by reloading the page: tear the SDK host down and build a new one.
    case "reload": return "restart";
    // Ask the engine to start again: it restarts a blocked sign-in or reopens the collection.
    case "retry": case "check_connection": case "wait": case "resolve_outcome": return "retry";
    case "choose_collection": case "set_up": case "update_app": case "free_space": case "contact_support": case "none": return null;
    default: return "retry";
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

class FolderPicker extends SuggestModal<string> {
  constructor(app: App, private readonly taken: string[], private readonly pick: (folder: string) => void) {
    super(app);
    this.setPlaceholder("Folder to leave off this device");
  }
  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && !f.path.split("/").some((part) => part.startsWith(".")))
      .map((f) => f.path)
      .filter((p) => !this.taken.includes(p) && p.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 100);
  }
  renderSuggestion(folder: string, el: HTMLElement): void { el.setText(folder); }
  onChooseSuggestion(folder: string): void { this.pick(folder); }
}

const count = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "just now", "5 minutes ago", "yesterday at 14:02", then a date. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  const time = new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (h < 12) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const day = new Date(at), today = new Date(now);
  const yesterday = new Date(now); yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return `Today at ${time}`;
  if (day.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return day.toLocaleDateString(undefined, { day: "numeric", month: "short", year: day.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** The collection's size and folder limits on attachments, in a sentence, or "" when none. */
export function collectionLimits(inclusion: CollectionInclusion | null): string {
  if (!inclusion) return "";
  const parts: string[] = [];
  if (typeof inclusion.maxSize === "number") parts.push(`Attachments over ${size(inclusion.maxSize)} don't sync.`);
  const folders = (inclusion.exclude ?? []).map((f) => f.replace(/\/+$/, "")).filter(Boolean);
  if (folders.length) parts.push(`Attachments in ${folders.join(", ")} don't sync.`);
  return parts.join(" ");
}

/** What a Sync now press did, in one line. */
export function syncNowSummary(done: ActivityEntry[], failed: number, failedBefore: number, healthy: boolean): { at: number; text: string; tone: "ok" | "attention" } {
  const at = Date.now();
  if (!healthy) return { at, text: "Sync stopped. See above", tone: "attention" };
  const n = (kinds: ActivityKind[]) => done.filter((e) => kinds.includes(e.kind)).length;
  const parts = [
    [n(["uploaded"]), "sent"],
    [n(["downloaded"]), "received"],
    [n(["deleted_here", "deleted_remote"]), "deleted"],
    [n(["moved"]), "moved"],
    [n(["conflict"]), "kept as two versions"],
  ].filter(([k]) => k).map(([k, verb]) => `${count(k as number, "file")} ${verb}`);
  const problems = failed ? `${count(failed, "file")} couldn't sync` : "";
  if (!parts.length && !problems) return { at, text: "Already up to date", tone: "ok" };
  const text = [...parts, problems].filter(Boolean).join(", ");
  return { at, text: text[0].toUpperCase() + text.slice(1), tone: failed > failedBefore || (failed && !parts.length) ? "attention" : "ok" };
}
