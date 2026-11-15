import { type App, type ButtonComponent, Modal, Notice, PluginSettingTab, requireApiVersion, Setting, type SettingDefinitionGroup, type SettingDefinitionRender, SettingGroup } from "obsidian";
import type MdbasePlugin from "../main";
import { errorText, modeName, summarize } from "./sync/words";

type SearchableSetting = SettingDefinitionRender;

interface SearchableGroup extends SettingDefinitionGroup {
  type: "group";
  heading: string;
  items: SearchableSetting[];
}

/**
 * Validation and sync preferences live here, where Obsidian users look for
 * them. The workspace Sync destination keeps status, setup and decisions.
 */
export class MdbaseSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MdbasePlugin) {
    super(app, plugin);
    plugin.register(plugin.syncController.subscribe(() => this.refresh()));
  }

  display(): void {
    if (requireApiVersion("1.13.0")) return;
    this.renderLegacy();
  }

  private refresh(): void {
    const { containerEl } = this;
    if (containerEl.contains(containerEl.ownerDocument.activeElement)) return;
    if (requireApiVersion("1.13.0")) this.update();
    else if (containerEl.isShown()) this.renderLegacy();
  }

  private refreshVisibility(): void {
    if (requireApiVersion("1.13.0")) this.refreshDomState();
    else this.renderLegacy();
  }

  private renderLegacy(): void {
    const { containerEl } = this;
    containerEl.empty();
    const preferences = new SettingGroup(containerEl);

    for (const definition of this.getSettingDefinitions()) {
      if ("items" in definition) {
        const group = new SettingGroup(containerEl).setHeading(definition.heading);
        for (const item of definition.items) this.renderDefinition(group, item);
      } else this.renderDefinition(preferences, definition);
    }
  }

  private renderDefinition(group: SettingGroup, definition: SearchableSetting): void {
    if (!(typeof definition.visible === "function" ? definition.visible() : definition.visible ?? true)) return;
    const setting = new Setting(group.listEl).setName(definition.name);
    if (definition.desc !== undefined) setting.setDesc(definition.desc);
    definition.render(setting, group);
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
          this.refreshVisibility();
        }),
      ); },
    }];

    definitions.push({
      name: "Show validation notices",
      desc: "Notify when saving a note with issues.",
      visible: () => plugin.settings.validateOnSave,
      render: setting => { setting.addToggle((toggle) =>
        toggle.setValue(plugin.settings.showNoticeOnSave).onChange(async (value) => {
          plugin.settings.showNoticeOnSave = value;
          await plugin.saveSettings();
        }),
      ); },
    });

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
    this.refresh();
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
        render: setting => { setting.addButton((button) => destructive(button)
          .setButtonText("Disconnect…")
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

function destructive(button: ButtonComponent): ButtonComponent {
  if (requireApiVersion("1.13.0")) return button.setDestructive();
  return button.setClass("mod-warning");
}

function confirm(app: App, title: string, body: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.titleEl.setText(title);
    modal.contentEl.createEl("p", { text: body });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((button) => destructive(button).setButtonText(action).onClick(() => {
        answered = true;
        modal.close();
      }));
    modal.onClose = () => resolve(answered);
    modal.open();
  });
}
