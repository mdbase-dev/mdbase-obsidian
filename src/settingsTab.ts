import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { FileMediaClass, SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import type MdbasePlugin from "../main";
import { ATTACHMENT_SCOPE_DESCRIPTION, renderFolderExclusions } from "./folderExclusions";
import { DisconnectMirrorModal } from "./modals";

const FILE_CLASSES: Array<[FileMediaClass, string]> = [
  ["image", "Images"],
  ["audio", "Audio"],
  ["video", "Video"],
  ["pdf", "PDFs"],
  ["other", "Other files"],
];

/**
 * Validation and sync preferences live here, where Obsidian users look for
 * them. The workspace Sync destination keeps only status, the next action,
 * conflicts and history.
 */
export class MdbaseSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MdbasePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();

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

  /** Settings can be a native popout; finish that surface before approval opens. */
  private openSync(): ReturnType<MdbasePlugin["openWorkspace"]> {
    (this.app as unknown as { setting?: { close(): void } }).setting?.close();
    return this.plugin.openWorkspace("sync");
  }

  private displaySync(containerEl: HTMLElement): void {
    const { plugin } = this;
    const profile = plugin.getMirrorProfile();
    new Setting(containerEl).setName("Sync").setHeading();
    if (!profile) {
      new Setting(containerEl)
        .setName("Not connected")
        .setDesc("Connect this vault to mdbase Connect from the sync tab of the mdbase workspace.")
        .addButton((button) => button.setButtonText("Open sync").onClick(async () => {
          try {
            await this.openSync();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }));
      return;
    }

    new Setting(containerEl)
      .setName(profile.name)
      .setDesc(`${profile.mode === "read_write" ? "Read and write" : "Read only"} · ${new URL(profile.controlUrl).host}`)
      .addButton((button) => button.setButtonText("Reconnect").onClick(async () => {
        button.setDisabled(true);
        try {
          await this.openSync().then((view) => view.reconnectCollection());
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          button.setDisabled(false);
        }
      }));

    new Setting(containerEl)
      .setName("Sync automatically")
      .setDesc("Keep this vault in sync in the background. Deleted files go to the trash, and conflicting edits are merged or kept as two files. Deleting many files at once on this device waits for your review.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.autoSync).onChange(async (value) => {
          plugin.settings.autoSync = value;
          await plugin.saveSettings();
          plugin.requestSync();
        }),
      );

    const policy = plugin.connectSync.getSelectiveSync();
    const apply = async (next: SelectiveSyncPolicy) => {
      try {
        await plugin.sync.configureSelectiveSync(next);
        return true;
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        this.display();
        return false;
      }
    };
    for (const [value, label] of FILE_CLASSES) {
      new Setting(containerEl)
        .setName(`Sync ${label.toLowerCase()}`)
        .setDesc(value === "other" ? "All remaining visible file formats. Markdown always syncs." : "")
        .addToggle((toggle) =>
          toggle.setValue(policy.file_classes.includes(value)).onChange(async (enabled) => {
            const current = plugin.connectSync.getSelectiveSync();
            await apply({
              ...current,
              file_classes: enabled
                ? [...new Set([...current.file_classes, value])]
                : current.file_classes.filter((entry) => entry !== value),
            });
          }),
        );
    }

    let folders = [...policy.excluded_folders];
    const exclusions = new Setting(containerEl).setName("Excluded folders").setDesc(ATTACHMENT_SCOPE_DESCRIPTION);
    renderFolderExclusions(this.app, exclusions.controlEl, folders, next => { folders = next; });
    exclusions.addButton(button => button.setButtonText("Apply").onClick(async () => {
      button.setDisabled(true);
      try {
        if (await apply({ ...plugin.connectSync.getSelectiveSync(), excluded_folders: folders })) {
          new Notice("Excluded folders updated. The next sync applies them.");
        }
      } finally {
        button.setDisabled(false);
      }
    }));

    new Setting(containerEl)
      .setName("Disconnect")
      .setDesc("Stop syncing this vault. The hosted collection is not deleted.")
      .addButton((button) => button
        .setButtonText("Disconnect…")
        .setWarning()
        .setDisabled(plugin.sync.isSyncing())
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const choice = await new DisconnectMirrorModal(this.app).choose(profile.name);
            if (!choice) return;
            button.setButtonText("Disconnecting…");
            await plugin.sync.disconnect(profile, choice === "remove");
            new Notice(plugin.sync.state.message);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          } finally {
            button.setDisabled(false);
          }
          this.display();
        }));
  }
}
