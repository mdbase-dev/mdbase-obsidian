import { type App, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type MdbasePlugin from "../main";
import { errorText, modeName, summarize } from "./sync/words";

/**
 * Validation and sync preferences live here, where Obsidian users look for
 * them. The workspace Sync destination keeps status, setup and decisions.
 */
export class MdbaseSettingTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;

  constructor(app: App, private readonly plugin: MdbasePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();
    this.unsubscribe ??= plugin.syncController.subscribe(() => {
      if (containerEl.isShown() && !containerEl.contains(containerEl.ownerDocument.activeElement)) this.display();
    });

    new Setting(containerEl)
      .setName("Validate notes automatically")
      .setDesc("Check notes against their types when they are opened or saved.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.validateOnSave || plugin.settings.validateOnOpen).onChange(async (value) => {
          plugin.settings.validateOnSave = value;
          plugin.settings.validateOnOpen = value;
          await plugin.saveSettings();
          this.display();
        }),
      );

    if (plugin.settings.validateOnSave) {
      new Setting(containerEl)
        .setName("Show validation notices")
        .setDesc("Notify when saving a note with issues.")
        .addToggle((toggle) =>
          toggle.setValue(plugin.settings.showNoticeOnSave).onChange(async (value) => {
            plugin.settings.showNoticeOnSave = value;
            await plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Allow plugin integrations")
      .setDesc("Let other installed plugins exchange mdbase events and actions in this vault.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.interopEnabled).onChange(async (value) => {
          plugin.settings.interopEnabled = value;
          await plugin.saveSettings();
        }),
      );

    this.displaySync(containerEl);
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private closeSettings(): void {
    (this.app as unknown as { setting?: { close(): void } }).setting?.close();
  }

  private async attempt(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const e = error as { code?: string; reason?: string; message?: string };
      new Notice(typeof e?.code === "string" ? errorText({ code: e.code, reason: e.reason, message: e.message ?? "" }) : String(error));
    }
    this.display();
  }

  private displaySync(containerEl: HTMLElement): void {
    const { plugin } = this;
    const controller = plugin.syncController;
    const s = controller.snapshot;
    new Setting(containerEl).setName("Sync").setHeading();
    if (Platform.isMobile) {
      new Setting(containerEl).setName("Sync isn't available on phones and tablets yet").setDesc("Sync this vault from Obsidian on your computer, with the mdbase app installed.");
      return;
    }
    const summary = summarize(s);
    new Setting(containerEl)
      .setName(summary.syncing ? summary.label : "Status")
      .setDesc(summary.detail)
      .addButton((button) => button.setButtonText("Open sync").onClick(() => {
        this.closeSettings();
        void plugin.openWorkspace("sync");
      }));

    if (s.daemon === "running" && s.status) {
      const account = s.status.account;
      const signIn = new Setting(containerEl).setName("Account");
      if (account.signed_in) {
        signIn.setDesc(account.computer_name ? `Signed in. This computer is "${account.computer_name}".` : "Signed in.");
        signIn.addButton((button) => button.setButtonText("Sign out").onClick(async () => {
          if (!await confirm(this.app, "Sign out of mdbase?", "Every vault on this computer stops syncing until you sign in again. Your notes stay on this computer.", "Sign out")) return;
          await this.attempt(() => controller.signOut());
        }));
      } else {
        signIn.setDesc("Not signed in.");
        signIn.addButton((button) => button.setButtonText("Sign in").setCta().onClick(async () => {
          // The browser wait (and the link to copy) shows in Sync.
          this.closeSettings();
          await plugin.openWorkspace("sync");
          await this.attempt(() => controller.signIn());
        }));
      }
    }

    const collection = s.daemon === "running" ? s.collection : null;
    if (collection) {
      new Setting(containerEl)
        .setName(collection.name)
        .setDesc(`${modeName(collection.mode)}${s.prefix ? ` · in the folder "${s.prefix}"` : ""}`)
        .addButton((button) => button
          .setButtonText("Disconnect…")
          .setWarning()
          .onClick(async () => {
            const where = s.prefix ? `the folder "${s.prefix}"` : "this vault";
            if (!await confirm(this.app, `Stop syncing ${where}?`, "This computer stops syncing it. Your notes stay here, and your other devices keep syncing as before.", "Stop syncing")) return;
            await this.attempt(() => controller.disconnect());
          }));
    }

    new Setting(containerEl)
      .setName("mdbase app location")
      .setDesc(s.daemon === "not_installed" ? "Obsidian can't find the mdbase app. If it's installed, enter the full path of its mdbase tool." : "Leave empty to find the mdbase app automatically.")
      .addText((text) => text
        .setPlaceholder("Automatic")
        .setValue(plugin.settings.mdbaseAppPath)
        .onChange(async (value) => {
          plugin.settings.mdbaseAppPath = value.trim();
          await plugin.saveSettings();
        }))
      .addExtraButton((button) => button.setIcon("refresh-cw").setTooltip("Check again").onClick(() => this.attempt(() => controller.refresh())));
  }
}

function confirm(app: App, title: string, body: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.titleEl.setText(title);
    modal.contentEl.createEl("p", { text: body });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((button) => button.setButtonText(action).setWarning().onClick(() => {
        answered = true;
        modal.close();
      }));
    modal.onClose = () => resolve(answered);
    modal.open();
  });
}
