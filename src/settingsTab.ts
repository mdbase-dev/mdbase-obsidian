import { type App, type ButtonComponent, Modal, Notice, Platform, PluginSettingTab, requireApiVersion, Setting, type SettingDefinitionGroup, type SettingDefinitionRender, SettingGroup, SuggestModal, TFolder } from "obsidian";
import type MdbasePlugin from "../main";
import { MEDIA_CLASSES, type DeviceFilter, type MediaClass } from "./sync/native/device";
import { SIGN_OUT_DESC, errorText, modeName, summarize } from "./sync/words";
import { MANAGE_APPS, SIGN_OUT, collectionLimits, connectUrl } from "./workspace/syncPane";

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
    const device = this.deviceDefinitions();
    if (device.length) definitions.push({ type: "group", heading: "On this device", items: device });
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

    if (s.direct) return [...definitions, ...this.directDefinitions()];

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

  /** Once the plugin syncs this vault itself: apps, moving to the mdbase app, signing out. */
  private directDefinitions(): SearchableSetting[] {
    const controller = this.plugin.syncController;
    const s = controller.snapshot;
    const native = controller.native;
    if (!native || s.direct?.phase.kind !== "ready") return [];
    const definitions: SearchableSetting[] = [];
    const apps = connectUrl(s.direct.phase.manageAccess ?? null)?.href;
    if (apps) definitions.push({
      name: "Apps",
      desc: "See which apps can use this collection, and remove their access, on the mdbase website.",
      render: setting => { setting.addButton((button) => button.setButtonText(MANAGE_APPS).onClick(() => window.open(apps))); },
    });
    // The mdbase app runs on computers only.
    if (!Platform.isMobile) definitions.push({
      name: "Move sync to the mdbase app",
      desc: "Let the mdbase desktop app sync this vault instead of Obsidian.",
      render: setting => { setting.addButton((button) => button.setButtonText("Move to mdbase app…").onClick(async () => {
        if (!await confirm(this.app, "Move sync to the mdbase app?", "Obsidian sends any remaining changes and stops syncing this vault. Then add this folder in the mdbase app and pick the same collection. If anything can't be sent, Obsidian carries on syncing.", "Move to mdbase app", false)) return;
        await this.attempt(() => native.handover());
      })); },
    });
    definitions.push({
      name: SIGN_OUT,
      desc: SIGN_OUT_DESC,
      render: setting => { setting.addButton((button) => destructive(button).setButtonText(`${SIGN_OUT}…`).onClick(async () => {
        if (!await confirm(this.app, "Sign out of mdbase in this vault?", "Sync stops here and this device is signed out. Your notes stay in this vault, and your other devices keep syncing.", SIGN_OUT)) return;
        await this.attempt(() => native.signOut());
      })); },
    });
    return definitions;
  }

  /** What this device syncs, once the plugin syncs this vault itself. Choices apply here only. */
  private deviceDefinitions(): SearchableSetting[] {
    const controller = this.plugin.syncController;
    const s = controller.snapshot;
    const native = controller.native;
    if (!native || s.direct?.phase.kind !== "ready") return [];
    const device: DeviceFilter = s.direct.device ?? { skip: [], folders: [] };
    const inclusion = s.direct.inclusion ?? null;
    const save = (next: DeviceFilter) => this.attempt(() => native.setDevice(next));
    const definitions: SearchableSetting[] = [{
      name: "Notes and types",
      desc: "Always synced, apart from folders you leave out. These choices apply to this device only, and turning something off never deletes it.",
      render: () => {},
    }];
    for (const media of MEDIA_CLASSES) {
      const [name, desc] = MEDIA_NAMES[media];
      // The collection's own setting wins: a kind it doesn't sync is off on every device.
      const collectionOff = inclusion !== null && !inclusion.include.includes(media);
      definitions.push({
        name,
        desc: collectionOff ? "Not synced in this collection. Change this in the mdbase app." : desc,
        render: setting => { setting.addToggle((toggle) => toggle
          .setValue(!collectionOff && !device.skip.includes(media))
          .setDisabled(collectionOff)
          .onChange((on) => save({ ...device, skip: on ? device.skip.filter((m) => m !== media) : [...device.skip, media] }))); },
      });
    }
    const limits = collectionLimits(inclusion);
    if (limits) definitions.push({ name: "Collection limits", desc: `${limits} Set for every device in the mdbase app.`, render: () => {} });
    definitions.push({
      name: "Folders left out",
      desc: device.folders.length ? "Nothing in these folders syncs to or from this device." : "Choose folders whose notes and files stay off this device.",
      render: setting => { setting.addButton((button) => button.setButtonText("Add folder").onClick(() => {
        new FolderPicker(this.app, device.folders, (folder) => void save({ ...device, folders: [...device.folders, folder] })).open();
      })); },
    });
    for (const folder of device.folders) definitions.push({
      name: folder,
      render: setting => {
        setting.settingEl.addClass("mdbase-sync-folder");
        setting.addExtraButton((button) => button.setIcon("x").setTooltip(`Sync ${folder} again`)
          .onClick(() => save({ ...device, folders: device.folders.filter((f) => f !== folder) })));
      },
    });
    return definitions;
  }
}

export function destructive(button: ButtonComponent): ButtonComponent {
  if (requireApiVersion("1.13.0")) return button.setDestructive();
  return button.setClass("mod-warning");
}

export function confirm(app: App, title: string, body: string, action: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.titleEl.setText(title);
    modal.contentEl.createEl("p", { text: body });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((button) => (danger ? destructive(button) : button.setCta()).setButtonText(action).onClick(() => {
        answered = true;
        modal.close();
      }));
    modal.onClose = () => resolve(answered);
    modal.open();
  });
}

const MEDIA_NAMES: Record<MediaClass, [string, string]> = {
  image: ["Images", "png, jpg, gif, svg, webp and other pictures"],
  audio: ["Audio", "mp3, m4a, wav, ogg and other recordings"],
  video: ["Videos", "mp4, mov, webm and other video"],
  pdf: ["PDFs", "PDF documents"],
  other: ["Other files", "Any other attachment, such as canvas, zip or csv files"],
};

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
