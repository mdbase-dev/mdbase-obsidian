import { type App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type MdbasePlugin from "../main";
import { errorText, modeName, summarize } from "./sync/words";

interface SearchableSetting {
  name: string;
  desc?: string;
  render: (setting: Setting) => void;
}

interface SearchableGroup {
  type: "group";
  heading: string;
  items: SearchableSetting[];
}

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

    for (const definition of this.getSettingDefinitions()) {
      if ("items" in definition) {
        new Setting(containerEl).setName(definition.heading).setHeading();
        for (const item of definition.items) this.renderDefinition(containerEl, item);
      } else this.renderDefinition(containerEl, definition);
    }
  }

  private renderDefinition(container: HTMLElement, definition: SearchableSetting): void {
    const setting = new Setting(container).setName(definition.name);
    if (definition.desc !== undefined) setting.setDesc(definition.desc);
    definition.render(setting);
  }

  getSettingDefinitions(): (SearchableSetting | SearchableGroup)[] {
    const { plugin } = this;
    const definitions: (SearchableSetting | SearchableGroup)[] = [{
      name: "Validate notes automatically",
      desc: "Check notes against their types when they are opened or saved.",
      render: setting => { setting.addToggle((toggle) =>
        toggle.setValue(plugin.settings.validateOnSave || plugin.settings.validateOnOpen).onChange(async (value) => {
          plugin.settings.validateOnSave = value;
          plugin.settings.validateOnOpen = value;
          await plugin.saveSettings();
          this.display();
        }),
      ); },
    }];

    if (plugin.settings.validateOnSave) {
      definitions.push({
        name: "Show validation notices",
        desc: "Notify when saving a note with issues.",
        render: setting => { setting.addToggle((toggle) =>
          toggle.setValue(plugin.settings.showNoticeOnSave).onChange(async (value) => {
            plugin.settings.showNoticeOnSave = value;
            await plugin.saveSettings();
          }),
        ); },
      });
    }

    definitions.push({
      name: "Allow plugin integrations",
      desc: "Let other installed plugins exchange mdbase events and actions in this vault.",
      render: setting => { setting.addToggle((toggle) =>
        toggle.setValue(plugin.settings.interopEnabled).onChange(async (value) => {
          plugin.settings.interopEnabled = value;
          await plugin.saveSettings();
        }),
      ); },
    });

    definitions.push({ type: "group", heading: "Sync", items: this.syncDefinitions() });
    return definitions;
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

  private syncDefinitions(): SearchableSetting[] {
    const { plugin } = this;
    const controller = plugin.syncController;
    const s = controller.snapshot;
    const summary = summarize(s);
    const definitions: SearchableSetting[] = [{
      name: summary.syncing ? summary.label : "Status",
      desc: summary.detail,
      render: setting => { setting.addButton((button) => button.setButtonText("Open sync").onClick(() => {
        this.closeSettings();
        void plugin.openWorkspace("sync");
      })); },
    }];

    if (s.direct) return definitions;

    if (s.daemon === "running" && s.status) {
      const account = s.status.account;
      const signIn: SearchableSetting = { name: "Account", render: () => {} };
      if (account.signed_in) {
        signIn.desc = account.computer_name ? `Signed in. This computer is "${account.computer_name}".` : "Signed in.";
        // Sign out is hidden: signing in again on the same computer breaks sync
        // there until the server fix (mdbase-connect #973) ships. Restore the
        // button (it called controller.signOut() after a confirm) once it has.
      } else {
        signIn.desc = "Not signed in.";
        signIn.render = setting => { setting.addButton((button) => button.setButtonText("Sign in").setCta().onClick(async () => {
          // The browser wait (and the link to copy) shows in Sync.
          this.closeSettings();
          await plugin.openWorkspace("sync");
          await this.attempt(() => controller.signIn());
        })); };
      }
      definitions.push(signIn);
    }

    const collection = s.daemon === "running" ? s.collection : null;
    if (collection) {
      definitions.push({
        name: collection.name,
        desc: `${modeName(collection.mode)}${s.prefix ? ` · in the folder "${s.prefix}"` : ""}`,
        render: setting => { setting.addButton((button) => button
          .setButtonText("Disconnect…")
          .setWarning()
          .onClick(async () => {
            const where = s.prefix ? `the folder "${s.prefix}"` : "this vault";
            if (!await confirm(this.app, `Stop syncing ${where}?`, "This computer stops syncing it. Your notes stay here, and your other devices keep syncing as before.", "Stop syncing")) return;
            await this.attempt(() => controller.disconnect());
          })); },
      });
    }

    definitions.push({
      name: "mdbase app location",
      desc: s.daemon === "not_installed" ? "Obsidian can't find the mdbase app. If it's installed, enter the full path of its mdbase tool." : "Leave empty to find the mdbase app automatically.",
      render: setting => { setting.addText((text) => text
        .setPlaceholder("Automatic")
        .setValue(plugin.settings.mdbaseAppPath)
        .onChange(async (value) => {
          plugin.settings.mdbaseAppPath = value.trim();
          await plugin.saveSettings();
        }))
      .addExtraButton((button) => button.setIcon("refresh-cw").setTooltip("Check again").onClick(() => this.attempt(() => controller.refresh()))); },
    });
    return definitions;
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
