import { plural, t } from "@lingui/core/macro";
import { formatDate, formatNumber } from "../i18n/runtime";
import { Notice, Setting, setIcon } from "obsidian";
import type { HeldFile, HoldChoice, SyncKind, SyncSnapshot } from "../sync/controller";
import type { DirectFailure, MergePrompt, SyncTotals } from "../sync/native/plugin";
import type { ActivityEntry, ActivityKind, CollectionInclusion } from "../sync/native/device";
import { CHOOSE_AGAIN_HINT, errorText, holdReasonText, modeName, summarize, unlockProblemText } from "../sync/words";
import { renderStatus, type WorkspaceContext } from "./shared";

export const DOWNLOAD_URL = "https://mdbase.dev/downloads";
export const MANAGE_APPS = "Manage apps";
export const SET_UP_HERE = "Set up sync here";

/** A Connect address safe to open: https, or http on this computer; null otherwise. */
export function connectUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && loopback)) ? url : null;
  } catch {
    return null;
  }
}

/**
 * The Connect page listing the apps that can use a collection, as the SDK
 * builds it (`links.manageAccess`): the account's server, `/access?collection=`.
 */
export function manageAppsUrl(server: string | undefined, collectionId: string): string | null {
  const url = connectUrl(server);
  return url ? `${url.origin}/access?collection=${encodeURIComponent(collectionId)}` : null;
}

const MAX_FAILURES_SHOWN = 50;
const TONE_ICONS: Record<string, string> = {
  ok: "check-circle-2",
  busy: "refresh-cw",
  attention: "alert-triangle",
  problem: "alert-circle",
  quiet: "cloud",
};
function activityLabels(): Record<ActivityKind, [string, string]> {
  return {
  uploaded: ["upload", t`Sent`],
  downloaded: ["download", t`Received`],
  deleted_here: ["trash-2", t`Deleted here (removed on another device)`],
  deleted_remote: ["trash-2", t`Deleted everywhere`],
  moved: ["folder-input", t`Moved`],
  conflict: ["copy", t`Both versions kept`],
  not_synced: ["alert-triangle", t`Couldn't sync`],
  };
}
type ActivityFilter = "all" | "sent" | "received" | "deleted" | "problems";
function activityFilters(): [ActivityFilter, string, ActivityKind[]][] {
  return [
  ["all", t`All`, []],
  ["sent", t`Sent`, ["uploaded"]],
  ["received", t`Received`, ["downloaded"]],
  ["deleted", t`Deleted and moved`, ["deleted_here", "deleted_remote", "moved"]],
  ["problems", t`Problems`, ["conflict", "not_synced"]],
  ];
}
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
    headingText.createEl("h2", { text: summary.syncing ? summary.label : t`Sync` });
    const detail = headingText.createEl("p", { cls: "mdbase-sync-detail", text: summary.detail });
    detail.setAttr("role", "status");
    const busy = s.busy;
    if (busy) root.createEl("p", { cls: "mdbase-muted", text: t`${busy}…` });

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
        this.actions(root, [["open-approval-page", t`Open approval page`, true, () => this.run(() => native.signIn())]]);
      } else if (phase === "signed_out" || phase === "authorizing") {
        const buttons: [string, string, boolean, () => void][] = [["sign-in", t`Sign in`, true, () => this.run(() => native.signIn())]];
        // A sign-in that can't finish (wrong account, closed page) can be dropped straight away.
        if (phase === "authorizing" && native.canStartOver) buttons.push(["cancel-sign-in", t`Cancel sign-in`, false, () => this.run(() => controller.startOver())]);
        this.actions(root, buttons);
      } else if (phase === "blocked" && s.direct.phase.takeover) {
        // Only ever on the person's click: the folder's last owner looks like an earlier install of this plugin.
        this.actions(root, [["set-up-sync-here", t`Set up sync here`, true, () => this.run(() => controller.takeOver())]]);
      } else if (phase === "starting" && s.direct.phase.stalled) {
        this.actions(root, [["restart-sync", t`Restart sync`, true, () => this.run(() => controller.restartNative())]]);
      } else if (phase === "needs_unlock") {
        this.renderUnlock(root, s.direct.phase);
      } else if (phase === "choosing") {
        this.actions(root, [
          ["choose-collection", t`Choose collection`, true, () => native.choose()],
          ["add-a-collection", t`Add a collection`, false, () => this.run(() => native.addCollection())],
          ["sign-out", t`Sign out`, false, () => this.run(() => native.signOut())],
        ]);
      } else if (phase === "ready") {
        this.renderSyncNow(root, () => native.enqueue(() => native.reconcileAll(false, undefined, true)));
        this.renderDirectFailures(root, s.direct.failures ?? []);
        this.renderDirectConflicts(root, s.direct.conflicts ?? []);
        // The heading already says whether it's synced; the rest is there when wanted.
        const details = this.ctx.disclosure(root, "sync-details", t`Details`);
        details.addClass("mdbase-sync-details");
        this.renderOverview(details, s.direct.lastSynced ?? null, s.direct.totals ?? null, s.direct.phase.sync);
        this.renderActivity(details, s.direct.activity ?? []);
        // What this device syncs, Sign out and moving to the mdbase app live in settings.
        const apps = connectUrl(s.direct.phase.manageAccess ?? null)?.href;
        this.actions(root, [
          ...(apps ? [["manage-apps", t`Manage apps`, false, () => window.open(apps)] as [string, string, boolean, () => void]] : []),
          ["sync-settings", t`Sync settings`, false, () => this.ctx.host.openSettings()],
        ]);
      } else if (phase === "handed_over") {
        // Done on purpose; the heading says what's next.
        this.actions(root, [["get-the-mdbase-app", t`Get the mdbase app`, false, () => window.open(DOWNLOAD_URL)]]);
      } else if (phase === "needs_approval") {
        this.actions(root, [["request-access-again", t`Request access again`, true, () => this.run(() => native.requestAccess())]]);
      } else if (phase === "problem") {
        const problem = s.direct.phase.problem as { action?: unknown; code?: unknown; key?: unknown } | null | undefined;
        const step = problemStep(problem?.action, Boolean((s.direct.phase as { collectionId?: unknown }).collectionId), problem?.code);
        const buttons: [string, string, boolean, () => void][] = [];
        if (step === "sign_in") buttons.push(["sign-in-again", t`Sign in again`, true, () => this.run(() => native.signIn())]);
        else if (step === "approve") buttons.push(["request-access-again", t`Request access again`, true, () => this.run(() => native.requestAccess())]);
        else if (step === "restart") buttons.push(["restart-sync", t`Restart sync`, true, () => this.run(() => controller.restartNative())]);
        else if (step === "retry") buttons.push(["try-again", t`Try again`, false, () => this.run(() => native.retry())]);
        else if (step === "choose") {
          buttons.push(["choose-another-collection", t`Choose another collection`, true, () => this.run(() => native.chooseAgain())]);
          // Unavailable or access removed may come back; a deleted collection won't.
          if (problem?.key !== "collection_deleted") buttons.push(["try-again", t`Try again`, false, () => this.run(() => native.retry())]);
        }
        // Nothing synced and nothing waiting: signing out can't lose anything.
        // With the SDK's Worker gone, the controller restarts the host first.
        const startOver = native.canStartOver;
        // A sign-in that broke before anything was bound: a fresh host resumes
        // the same sign-in and stops again (production retest 2), so Start over
        // is the step that works and Restart sync the lesser one.
        const brokenSignIn = startOver && step === "restart";
        if (brokenSignIn) for (const button of buttons) button[2] = false;
        if (startOver) buttons[brokenSignIn ? "unshift" : "push"](["start-over", t`Start over`, brokenSignIn, () => this.run(() => controller.startOver())]);
        if (buttons.length) this.actions(root, buttons);
        if (startOver) root.createEl("p", { cls: "mdbase-muted", text: t`Start over signs this vault out of mdbase, so you can sign in again with any account. Nothing has synced yet, so your notes aren't affected.` });
        if (step === "choose") root.createEl("p", { cls: "mdbase-muted", text: CHOOSE_AGAIN_HINT });
      }
      return;
    }
    switch (s.daemon) {
      case "checking":
        return;
      case "not_installed":
        this.renderInstall(root);
        return;
      case "not_running":
        this.actions(root, [["start-mdbase", t`Start mdbase`, true, () => this.run(() => this.ctx.host.syncController.startApp())], ["check-again", t`Check again`, false, () => this.run(() => this.refreshAndRender())]]);
        return;
      case "error":
        this.actions(root, [["try-again", t`Try again`, true, () => this.run(() => this.refreshAndRender())]]);
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

  private actions(container: HTMLElement, buttons: [string, string, boolean, () => void][]): void {
    const row = container.createDiv({ cls: "mdbase-actions" });
    for (const [key, label, primary, onClick] of buttons) {
      const button = row.createEl("button", { text: label, cls: primary ? "mod-cta" : "" });
      button.setAttr("data-focus-key", `sync-${key}`);
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
    button.createSpan({ text: this.syncingNow ? t`Syncing…` : t`Sync now` });
    button.toggleClass("is-syncing", this.syncingNow);
    button.disabled = this.syncingNow || this.s.busy !== null;
    button.setAttr("aria-busy", String(this.syncingNow));
    const result = row.createSpan({ cls: "mdbase-sync-now-result" });
    result.setAttr("role", "status");
    if (this.syncingNow) result.setText(t`Checking every file against the collection…`);
    else if (this.syncNowResult) {
      const summary = this.syncNowResult.text;
      const time = ago(this.syncNowResult.at).toLowerCase();
      result.setText(t`${summary} · ${time}`);
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
    const list = this.group(root, t`Overview`, "mdbase-sync-overview", true);
    const row = (name: string, value: string, desc?: string) => {
      const setting = new Setting(list).setName(name);
      if (desc) setting.setDesc(desc);
      setting.controlEl.createSpan({ cls: "mdbase-sync-value", text: value });
    };
    row(t`Last synced`, lastSynced ? ago(lastSynced) : t`Not yet`);
    const pending = sync?.pending ?? 0;
    if (pending) row(t`Waiting to send`, plural(pending, { one: "# change", other: "# changes" }));
    if (sync?.live === false) row(t`Live updates`, t`Paused`, t`Changes from other devices arrive when Obsidian is in front, or when you choose Sync now.`);
    if (!totals) {
      row(t`Synced here`, t`Counting…`);
      return;
    }
    row(t`Notes`, formatNumber(totals.notes));
    const attachmentSize = size(totals.attachmentBytes);
    row(t`Attachments`, formatNumber(totals.attachments), totals.attachments ? t`${attachmentSize} in total` : undefined);
    row(t`Types and settings`, formatNumber(totals.definitions), t`Type definitions and mdbase.yaml`);
    const notHere = totals.notHere;
    if (notHere) row(t`Not on this device`, plural(notHere, { one: "# file", other: "# files" }), totals.byCollection === totals.notHere ? t`In the collection, but its own file settings leave them out.` : t`In the collection, but left out here by your choices below or the collection's file settings.`);
  }

  private renderActivity(root: HTMLElement, activity: ActivityEntry[]): void {
    const group = root.createDiv({ cls: "setting-group mdbase-sync-group" });
    const heading = group.createDiv({ cls: "setting-item setting-item-heading" });
    heading.createDiv({ cls: "setting-item-info" }).createDiv({ cls: "setting-item-name", text: t`Activity` });
    const filters = heading.createDiv({ cls: "setting-item-control mdbase-activity-filters" });
    filters.setAttr("role", "radiogroup");
    filters.setAttr("aria-label", t`Show activity`);
    for (const [key, label] of activityFilters()) {
      const button = filters.createEl("button", { cls: "mdbase-activity-filter", text: label });
      button.setAttr("role", "radio");
      button.setAttr("aria-checked", String(this.activityFilter === key));
      button.toggleClass("is-active", this.activityFilter === key);
      button.onclick = () => { this.activityFilter = key; this.activityShown = ACTIVITY_PAGE; this.ctx.render(); };
    }
    const kinds = activityFilters().find(([key]) => key === this.activityFilter)?.[2] ?? [];
    const entries = kinds.length ? activity.filter((e) => kinds.includes(e.kind)) : activity;
    const list = group.createDiv({ cls: "setting-items mdbase-activity" });
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-activity-empty", text: activity.length ? t`Nothing of this kind yet.` : t`Files sent and received appear here.` });
      return;
    }
    for (const entry of entries.slice(0, this.activityShown)) {
      const row = list.createDiv({ cls: "mdbase-activity-row" });
      row.setAttr("data-kind", entry.kind);
      const [icon, verb] = activityLabels()[entry.kind] ?? ["dot", entry.kind];
      setIcon(row.createSpan({ cls: "mdbase-activity-icon" }), icon);
      const text = row.createDiv({ cls: "mdbase-activity-text" });
      const target = entry.to ?? entry.path;
      const name = text.createEl("a", { cls: "mdbase-activity-path", text: target, href: "#" });
      name.onclick = (event) => { event.preventDefault(); void this.ctx.host.openFileByPath(target); };
      const path = entry.path;
      text.createDiv({ cls: "mdbase-activity-detail", text: entry.kind === "moved" ? (entry.from === "remote" ? t`Moved from ${path} on another device` : t`Moved from ${path}`) : verb });
      const time = row.createSpan({ cls: "mdbase-activity-time", text: ago(entry.at) });
      time.setAttr("title", formatDate(new Date(entry.at), { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }));
    }
    if (entries.length > this.activityShown) {
      const remaining = formatNumber(entries.length - this.activityShown);
      const more = group.createEl("button", { cls: "mdbase-load-more", text: t`Show more (${remaining})` });
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
    root.createEl("p", { text: t`mdbase syncs this vault through the mdbase app. It runs in the background and keeps your notes on this computer in step with your other devices.` });
    this.actions(root, [
      ["download-mdbase", t`Download mdbase`, true, () => window.open(DOWNLOAD_URL)],
      ["check-again", t`Check again`, false, () => this.run(() => this.refreshAndRender())],
    ]);
    const hint = root.createEl("p", { cls: "mdbase-muted" });
    const link = hint.createEl("a", { text: t`Installed it somewhere unusual? Set its location in settings.`, href: "#" });
    link.onclick = (event) => { event.preventDefault(); this.ctx.host.openSettings(); };
  }

  private renderSignIn(root: HTMLElement, syncing: boolean): void {
    const controller = this.ctx.host.syncController;
    if (this.s.signingIn) {
      root.createEl("p", { text: t`Finish signing in in your browser, then come back here. If no page opened, copy the sign-in link into your browser.` });
      const page = this.s.signingIn;
      this.actions(root, [
        ["open-the-sign-in-page-again", t`Open the sign-in page again`, false, () => window.open(page)],
        ["copy-sign-in-link", t`Copy sign-in link`, false, () => void navigator.clipboard.writeText(page).then(() => new Notice(t`Copied. Paste it into your browser.`))],
        ["cancel", t`Cancel`, false, () => { controller.cancelSignIn(); this.ctx.render(); }],
      ]);
      return;
    }
    if (!syncing) root.createEl("p", { text: t`Sign in to mdbase to sync this vault with your other devices.` });
    this.actions(root, [["sign-in", t`Sign in`, true, () => this.run(async () => { await controller.signIn(); this.ctx.render(); })]]);
  }

  private renderSetup(root: HTMLElement, isCollection: boolean): void {
    const controller = this.ctx.host.syncController;
    if (!this.name) this.name = this.ctx.app.vault.getName();
    const legacy = this.ctx.host.legacyConnect();
    if (legacy) {
      const name = legacy.name;
      const note = this.callout(root);
      note.createEl("p", { text: t`This vault used the earlier mdbase Connect sync for "${name}", which has been replaced. Your notes here are untouched.` });
      note.createEl("p", { text: t`To keep working on "${name}", add it below: its latest version arrives in a new folder, and you can delete the old copy once you've checked it.` });
      if (!this.joinText) this.joinText = legacy.collectionId;
      if (!this.joinFolder) this.joinFolder = legacy.name;
    }

    const section = this.group(root, isCollection ? t`Turn on sync` : t`Sync this vault`);
    if (!isCollection) {
      new Setting(section).setName(t`Name`).setDesc(t`How this vault appears on your other devices.`).addText((text) => text
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
    option("cloud", t`Cloud copy (recommended)`, t`mdbase keeps a copy online, so your notes open in mdbase apps on the web and arrive on a new device straight away.`);
    option("private", t`Private`, t`Encrypted so only your devices can read it. For now it works on this computer only, and web apps work only while it's on.`);
    this.actions(section, [["turn-on-sync", t`Turn on sync`, true, () => this.run(async () => {
      await controller.setUp(this.kind, this.name);
      new Notice(t`Sync is on for this vault.`);
    })]]);

    if (isCollection) return;
    const join = this.group(root, t`Add a collection you already sync`);
    join.createEl("p", { cls: "mdbase-muted", text: t`On a device that already syncs it, choose Copy link in mdbase's Sync tab, then paste the link here. Only Cloud copy collections can be added for now.` });
    new Setting(join).setName(t`Link or ID`).addText((text) => {
      text.setPlaceholder(t`Paste the collection link`).setValue(this.joinText).onChange((value) => { this.joinText = value; });
      text.inputEl.setAttr("data-focus-key", "sync-join-link");
    });
    const empty = this.ctx.host.vaultTopLevelEntries().length === 0;
    if (!empty) {
      new Setting(join).setName(t`Folder`).setDesc(t`This vault already has notes, so the collection goes into a new folder.`).addText((text) => {
        text.setPlaceholder(t`Folder name`).setValue(this.joinFolder).onChange((value) => { this.joinFolder = value; });
        text.inputEl.setAttr("data-focus-key", "sync-join-folder");
      });
    }
    this.actions(join, [["add-collection", t`Add collection`, false, () => this.run(async () => {
      const folder = await controller.join(this.joinText, this.joinFolder || nameFromLink(this.joinText) || "Synced notes");
      this.joinText = "";
      new Notice(folder ? t`Added. Notes arrive in "${folder}".` : t`Added. Notes arrive in this vault.`);
    })]]);
  }

  private renderLink(root: HTMLElement): void {
    const controller = this.ctx.host.syncController;
    const link = this.s.link;
    if (link === "connecting" && !this.s.live) {
      root.createEl("p", { cls: "mdbase-muted", text: t`If mdbase asks whether Obsidian may use this vault, allow it. Obsidian then shows live status and keeps open notes in step.` });
    } else if (link === "declined") {
      root.createEl("p", { text: t`Obsidian isn't allowed to use this vault's sync yet. Sync still runs, but open notes can't update while you type.` });
      this.actions(root, [["allow-obsidian", t`Allow Obsidian`, false, () => this.run(() => controller.linkAgain())]]);
    }
  }

  private renderApprovals(root: HTMLElement): void {
    const controller = this.ctx.host.syncController;
    for (const approval of this.s.approvals) {
      const name = approval.name;
      const section = this.group(root, t`${name} wants to join`);
      section.createEl("p", { text: t`If you're setting up a new device, type the six-digit code it shows. Only approve devices you own.` });
      new Setting(section).setName(t`Code`).addText((text) => {
        text.setPlaceholder("123456").setValue(this.codes.get(approval.device) ?? "").onChange((value) => this.codes.set(approval.device, value));
        text.inputEl.inputMode = "numeric";
        text.inputEl.setAttr("data-focus-key", `sync-code-${approval.device}`);
      });
      this.actions(section, [
        ["approve", t`Approve`, true, () => this.run(async () => {
          await controller.approve(approval.device, this.codes.get(approval.device) ?? "");
          this.codes.delete(approval.device);
          new Notice(t`Approved. The new device is syncing.`);
        })],
        ["decline", t`Decline`, false, () => this.run(() => controller.reject(approval.device))],
      ]);
    }
  }

  /** First sync of a vault that has notes into a collection that has items. */
  private renderMerge(root: HTMLElement, merge: MergePrompt): void {
    const native = this.ctx.host.syncController.native;
    if (!native) return;
    const { name, local, remote } = merge;
    const section = this.group(root, t`Combine this vault with “${name}”?`);
    section.createEl("p", { text: t`This vault has ${plural(local, { one: "# file", other: "# files" })} and “${name}” has ${plural(remote, { one: "# file", other: "# files" })}. Nothing has synced yet.` });
    section.createEl("p", { cls: "mdbase-muted", text: t`Combining copies the collection's notes into this vault and this vault's notes into the collection. Nothing is deleted. If the same file differs on each side, both versions are kept.` });
    this.actions(section, [
      ["combine-and-sync", t`Combine and sync`, true, () => this.run(() => native.confirmMerge())],
      ["use-a-different-collection", t`Use a different collection`, false, () => native.chooseAnother()],
    ]);
  }

  /** Paths in-plugin sync couldn't send or receive, each with its reason. */
  private renderDirectFailures(root: HTMLElement, failures: DirectFailure[]): void {
    if (!failures.length) return;
    const native = this.ctx.host.syncController.native;
    // The heading already counts them and says everything else is in sync.
    const section = this.group(root, t`Not synced`);
    section.createEl("p", { cls: "mdbase-muted", text: t`These stay as they are on this device until they're fixed. Sync tries them again when they change.` });
    const list = section.createDiv({ cls: "mdbase-hold-list" });
    for (const failure of failures.slice(0, MAX_FAILURES_SHOWN)) {
      const row = list.createDiv({ cls: "mdbase-hold" });
      const name = row.createEl("a", { cls: "mdbase-hold-path", text: failure.path, href: "#" });
      name.onclick = (event) => { event.preventDefault(); void this.ctx.host.openFileByPath(failure.path); };
      row.createDiv({ text: failure.title });
      row.createDiv({ cls: "mdbase-muted", text: failure.detail });
      if (failure.choose && native) this.actions(row, [
        ["keep-this-vault-s", t`Keep this vault's`, false, () => this.run(() => native.resolveDefinition(failure.path, "local"))],
        ["keep-the-collection-s", t`Keep the collection's`, false, () => this.run(() => native.resolveDefinition(failure.path, "remote"))],
      ]);
    }
    const remaining = failures.length - MAX_FAILURES_SHOWN;
    if (remaining > 0) section.createEl("p", { cls: "mdbase-muted", text: t`And ${remaining} more.` });
  }

  private renderDirectConflicts(root: HTMLElement, conflicts: NonNullable<SyncSnapshot["direct"]>["conflicts"]): void {
    if (!conflicts?.length) return;
    const native = this.ctx.host.syncController.native;
    if (!native) return;
    const section = this.group(root, t`Conflicts`);
    section.createEl("p", { cls: "mdbase-muted", text: t`Both versions are kept. Review the current file and its conflict copy before choosing to keep both.` });
    const list = section.createDiv({ cls: "mdbase-hold-list" });
    for (const conflict of conflicts.slice(0, MAX_FAILURES_SHOWN)) {
      const row = list.createDiv({ cls: "mdbase-hold" });
      row.createDiv({ cls: "mdbase-hold-path", text: conflict.path });
      row.createDiv({ cls: "mdbase-muted", text: conflict.copy });
      this.actions(row, [
        ["open-current-file", t`Open current file`, false, () => this.ctx.host.openFileByPath(conflict.path)],
        ["open-conflict-copy", t`Open conflict copy`, false, () => this.ctx.host.openFileByPath(conflict.copy)],
        ["keep-both", t`Keep both`, false, () => this.run(() => native.keepConflictCopies(conflict.copy))],
      ]);
    }
  }

  private renderHolds(root: HTMLElement): void {
    const holds = this.s.holds;
    if (!holds.length) return;
    const section = this.group(root);
    section.createEl("p", { cls: "mdbase-muted", text: t`mdbase didn't overwrite anything. Until you choose, the version on this computer stays as it is.` });
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
      this.compare(row, `hold-${hold.id}`, t`Compare versions`, [t`On this computer`, hold.mine], [t`From your other device`, hold.theirs]);
    }
    const choose = (choice: HoldChoice) => () => this.run(() => controller.resolve(hold, choice));
    const buttons: [string, string, boolean, () => void][] = [["keep-this-computer-s", t`Keep this computer's`, true, choose("keep_mine")]];
    if (hold.reason === "deleted_elsewhere") buttons.push(["delete-it", t`Delete it`, false, choose("delete")]);
    else if (hold.hasTheirs) buttons.push(["use-the-other-version", t`Use the other version`, false, choose("take_theirs")], ["keep-both", t`Keep both`, false, choose("keep_both")]);
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
    const name = lock.name ? `“${lock.name}”` : t`This collection`;
    const collectionName = lock.name;
    const section = this.group(root, collectionName ? t`Unlock “${collectionName}”` : t`Unlock this collection`);
    const other: [string, string, boolean, () => void][] = native.canChooseAnother ? [["use-a-different-collection", t`Use a different collection`, false, () => native.chooseAnother()]] : [];
    if (lock.mode !== "password") {
      this.unlockSecret = "";
      section.createEl("p", { text: lock.mode === "strict"
        ? t`${name} is Private, and your account approves each new device from one you already use instead of with an encryption password. Obsidian can't be approved that way yet.`
        : t`${name} is Private, and your account has no encryption password yet. Set one in the mdbase app on a computer that already has this collection.` });
      section.createEl("p", { cls: "mdbase-muted", text: lock.mode === "strict"
        ? t`To sync this vault, add its folder in the mdbase app on this computer. Your notes here are untouched.`
        : t`Then come back and check again. Your notes here are untouched.` });
      this.actions(section, [["check-again", t`Check again`, lock.mode === "none", () => this.run(() => native.recheckLock())], ...other]);
      return;
    }
    const recovery = this.unlockWith === "recovery";
    section.createEl("p", { text: recovery ? t`${name} is Private: only your own devices can read it. To open it in this vault, enter your recovery key.` : t`${name} is Private: only your own devices can read it. To open it in this vault, enter your encryption password.` });
    const form = section.createEl("form", { cls: "mdbase-unlock" });
    const label = form.createEl("label", { cls: "mdbase-unlock-label", text: recovery ? t`Recovery key` : t`Encryption password` });
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
    const submit = row.createEl("button", { cls: "mod-cta", text: lock.unlocking ? t`Unlocking…` : t`Unlock` });
    submit.type = "submit";
    submit.setAttr("data-focus-key", "sync-unlock");
    submit.disabled = lock.unlocking || !this.unlockSecret.trim();
    const swap = row.createEl("button", { cls: "mdbase-link-button", text: recovery ? t`Use your encryption password instead` : t`Use your recovery key instead` });
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
      ? t`It's used once and isn't saved. The recovery key is the one mdbase showed when you set your encryption password.`
      : t`It's used once and isn't saved.` });
    if (other.length) this.actions(section, other);
  }
  private renderMerged(root: HTMLElement): void {
    const merged = this.s.merged;
    if (!merged.length) return;
    const controller = this.ctx.host.syncController;
    const mergedCount = merged.length;
    const section = this.group(root, plural(mergedCount, { one: "# change to check", other: "# changes to check" }));
    section.createEl("p", { cls: "mdbase-muted", text: t`These were edited on two devices at once. mdbase kept one side so sync could carry on; check that it kept what you want.` });
    const list = section.createDiv({ cls: "mdbase-hold-list" });
    for (const change of merged) {
      const row = list.createDiv({ cls: "mdbase-hold" });
      const vaultPath = change.path && this.s.prefix ? `${this.s.prefix}/${change.path}` : change.path;
      if (vaultPath) {
        const name = row.createEl("a", { cls: "mdbase-hold-path", text: vaultPath, href: "#" });
        name.onclick = (event) => { event.preventDefault(); void this.ctx.host.openFileByPath(vaultPath); };
      } else {
        row.createDiv({ cls: "mdbase-hold-path", text: t`A note that was since removed` });
      }
      const key = `merged-${change.entry.mutation}-${change.field ?? change.kind}`;
      if (change.kind === "field" && change.field !== null) {
        const { field, kept, lost } = change;
        const otherValue = clip(lost);
        row.createDiv({ cls: "mdbase-muted", text: t`"${field}" was set to ${kept}. The other device set it to ${lost}.` });
        this.actions(row, [
          ["keep-it", t`Keep it`, true, () => this.run(() => controller.dismissMerged(change))],
          ["use-other-value", t`Use ${otherValue}`, false, () => this.run(() => controller.useOtherValue(change))],
        ]);
        continue;
      }
      row.createDiv({ cls: "mdbase-muted", text: mergedText(change.kind) });
      if (change.kept || change.lost) this.compare(row, key, t`Show both versions`, [t`Kept`, change.kept], [t`Replaced`, change.lost]);
      this.actions(row, [["ok", t`OK`, false, () => this.run(() => controller.dismissMerged(change))]]);
    }
  }

  private renderDetails(root: HTMLElement): void {
    const s = this.s;
    const collection = s.collection;
    if (!collection) return;
    const details = this.group(root, undefined, "mdbase-status-list");
    const row = (label: string, value: string) => renderStatus(details, label, value);
    row(t`Collection`, collection.name);
    row(t`Kind`, modeName(collection.mode));
    if (s.prefix) row(t`Folder`, s.prefix);
    if (s.status?.account.computer_name) row(t`This computer`, s.status.account.computer_name);
    const apps = manageAppsUrl(s.status?.account.server, collection.id);
    this.actions(root, [
      ["copy-link", t`Copy link`, false, () => {
        const link = `obsidian://mdbase-join?collection=${collection.id}&name=${encodeURIComponent(collection.name)}`;
        void navigator.clipboard.writeText(link).then(() => new Notice(t`Copied. Open the link on your other device, or paste it into the sync tab there.`));
      }],
      ...(apps ? [["manage-apps", t`Manage apps`, false, () => window.open(apps)] as [string, string, boolean, () => void]] : []),
      ["sync-settings", t`Sync settings`, false, () => this.ctx.host.openSettings()],
    ]);
  }
}

/** The button for a stop only a fresh sync host can get past (a page reload, for a web app). */
export const RESTART_SYNC = "Restart sync";

export const SIGN_OUT = "Sign out";
export const SYNC_SETTINGS = "Sync settings";
export const CHOOSE_ANOTHER = "Choose another collection";

export const START_OVER_HINT = "Start over signs this vault out of mdbase, so you can sign in again with any account. Nothing has synced yet, so your notes aren't affected.";

/**
 * The one button a stop gets, by the sync engine's suggested action
 * (describeError's MdbaseErrorAction). Actions the plugin can't carry out here
 * (update, free space, set up, contact support) get none: the words say what to do.
 */
export function problemStep(action: unknown, hasCollection: boolean, code?: unknown): "sign_in" | "approve" | "restart" | "retry" | "choose" | null {
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
    // Deleted, access removed, unavailable: release this vault and list the collections.
    case "choose_collection": return "choose";
    case "set_up": case "update_app": case "free_space": case "contact_support": case "none": return null;
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
    case "body": return t`The text was changed on two devices. mdbase kept one version.`;
    case "frontmatter": return t`The properties were changed on two devices. mdbase kept one version.`;
    case "path": return t`It was renamed or moved on two devices. mdbase kept one name.`;
    case "delete": return t`It was deleted on one device and changed on another.`;
    default: return t`It was changed on two devices. mdbase kept one version.`;
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


export function size(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const amount = value < 10 ? formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : formatNumber(Math.round(value));
  return `${amount} ${units[unit]}`;
}

/** "just now", "5 minutes ago", "yesterday at 14:02", then a date. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return t`Just now`;
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, { one: "# minute ago", other: "# minutes ago" });
  const h = Math.round(m / 60);
  const time = formatDate(new Date(at), { hour: "2-digit", minute: "2-digit" });
  if (h < 12) return plural(h, { one: "# hour ago", other: "# hours ago" });
  const day = new Date(at), today = new Date(now);
  const yesterday = new Date(now); yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return t`Today at ${time}`;
  if (day.toDateString() === yesterday.toDateString()) return t`Yesterday at ${time}`;
  return formatDate(day, { day: "numeric", month: "short", year: day.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** The collection's size and folder limits on attachments, in a sentence, or "" when none. */
export function collectionLimits(inclusion: CollectionInclusion | null): string {
  if (!inclusion) return "";
  const parts: string[] = [];
  if (typeof inclusion.maxSize === "number") {
    const maximum = size(inclusion.maxSize);
    parts.push(t`Attachments over ${maximum} don't sync.`);
  }
  const folders = (inclusion.exclude ?? []).map((f) => f.replace(/\/+$/, "")).filter(Boolean);
  if (folders.length) {
    const paths = folders.join(", ");
    parts.push(t`Attachments in ${paths} don't sync.`);
  }
  return parts.join(" ");
}

/** What a Sync now press did, in one line. */
export function syncNowSummary(done: ActivityEntry[], failed: number, failedBefore: number, healthy: boolean): { at: number; text: string; tone: "ok" | "attention" } {
  const at = Date.now();
  if (!healthy) return { at, text: t`Sync stopped. See above`, tone: "attention" };
  const n = (kinds: ActivityKind[]) => done.filter((e) => kinds.includes(e.kind)).length;
  const sent = n(["uploaded"]);
  const received = n(["downloaded"]);
  const deleted = n(["deleted_here", "deleted_remote"]);
  const moved = n(["moved"]);
  const conflicts = n(["conflict"]);
  const parts = [
    sent ? plural(sent, { one: "# file sent", other: "# files sent" }) : "",
    received ? plural(received, { one: "# file received", other: "# files received" }) : "",
    deleted ? plural(deleted, { one: "# file deleted", other: "# files deleted" }) : "",
    moved ? plural(moved, { one: "# file moved", other: "# files moved" }) : "",
    conflicts ? plural(conflicts, { one: "# file kept as two versions", other: "# files kept as two versions" }) : "",
  ].filter(Boolean);
  const problems = failed ? plural(failed, { one: "# file couldn't sync", other: "# files couldn't sync" }) : "";
  if (!parts.length && !problems) return { at, text: t`Already up to date`, tone: "ok" };
  const text = [...parts, problems].filter(Boolean).join(", ");
  return { at, text: text[0].toUpperCase() + text.slice(1), tone: failed > failedBefore || (failed && !parts.length) ? "attention" : "ok" };
}
