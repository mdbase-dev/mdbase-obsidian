// Plugin code uses window timers (Obsidian's popout-safe convention); plain
// Node tests have no window, so give them the global object.
globalThis.window ??= globalThis;

function normalizePath(path) {
  return String(path).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

// Obsidian parses real YAML; so does the mock (YAML is a superset of JSON).
const YAML = require("yaml");

function parseYaml(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  return YAML.parse(trimmed);
}

function stringifyYaml(value) {
  return JSON.stringify(value, null, 2);
}

function getFrontMatterInfo(content) {
  const source = String(content);
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (!match || match.index !== 0) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const openingLength = match[0].indexOf("\n") + 1;
  const closingOffset = match[0].lastIndexOf("\n---") + 1;
  return {
    exists: true,
    frontmatter: match[1],
    from: openingLength,
    to: closingOffset,
    contentStart: match[0].length,
  };
}

class TFile {
  constructor(path) {
    this.path = normalizePath(path);
    this.stat = { size: 0, mtime: 0, ctime: 0 };
    const segments = this.path.split("/");
    const filename = segments[segments.length - 1] || "";
    const dotIndex = filename.lastIndexOf(".");
    this.basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
    this.extension = dotIndex >= 0 ? filename.slice(dotIndex + 1) : "";
  }
}

class TFolder {
  constructor(path) {
    this.path = normalizePath(path);
    const segments = this.path.split("/");
    this.name = segments[segments.length - 1] || "";
  }
}

class Vault {}
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  registerEvent() {}
  registerDomEvent() {}
}
class FileSystemAdapter {}
class MarkdownView {}
const apiVersion = "1.12.0";
function addIcon() {}

class ItemView {
  constructor(leaf) {
    this.app = leaf.app;
    this.containerEl = leaf.containerEl;
  }
  registerDomEvent(element, type, listener) { element.addEventListener(type, listener); }
  async setState() {}
}
class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = document.createElement("div");
    this.titleEl = document.createElement("h2");
    this.contentEl = document.createElement("div");
    this.containerEl.append(this.titleEl, this.contentEl);
  }
  open() { document.body.append(this.containerEl); this.onOpen?.(); }
  close() { this.onClose?.(); this.containerEl.remove(); }
}

class SuggestModal extends Modal {}
class Notice {
  static messages = [];
  constructor(message) { Notice.messages.push(message); }
}
class PluginSettingTab {
  static apiVersion = apiVersion;
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
    this.settingItems = [];
    this.updateCalls = 0;
    this.refreshDomStateCalls = 0;
    this.predicateRows = [];
  }
  show() {
    if (requireApiVersion("1.13.0")) this.update();
    else this.display();
  }
  update() {
    if (!requireApiVersion("1.13.0")) throw new Error("update is unavailable before 1.13");
    this.updateCalls++;
    this.settingItems = this.getSettingDefinitions();
    if (!this.containerEl.isConnected) return;
    this.containerEl.empty();
    this.predicateRows = [];
    const preferences = new SettingGroup(this.containerEl);
    for (const definition of this.settingItems) {
      if (definition.type === "group") {
        const group = new SettingGroup(this.containerEl).setHeading(definition.heading);
        for (const item of definition.items) this.renderDeclarativeDefinition(group, item);
      } else this.renderDeclarativeDefinition(preferences, definition);
    }
  }
  renderDeclarativeDefinition(group, definition) {
    const setting = new Setting(group.listEl).setName(definition.name);
    if (definition.desc !== undefined) setting.setDesc(definition.desc);
    definition.render(setting, group);
    this.predicateRows.push({ element: setting.settingEl, definition });
    this.applyVisibility(setting.settingEl, definition);
  }
  applyVisibility(element, definition) {
    element.hidden = !(typeof definition.visible === "function" ? definition.visible() : definition.visible ?? true);
  }
  refreshDomState() {
    if (!requireApiVersion("1.13.0")) throw new Error("refreshDomState is unavailable before 1.13");
    this.refreshDomStateCalls++;
    for (const { element, definition } of this.predicateRows) this.applyVisibility(element, definition);
  }
  hide() {}
}
function requireApiVersion(version) {
  const actual = PluginSettingTab.apiVersion.split(".").map(Number);
  const required = version.split(".").map(Number);
  for (let index = 0; index < required.length; index++) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}
class SettingGroup {
  constructor(container) { this.containerEl = container.createDiv(); this.listEl = this.containerEl.createDiv(); }
  setHeading(text) {
    const heading = this.containerEl.createDiv({ cls: "setting-item-heading", text });
    this.containerEl.prepend(heading);
    return this;
  }
}
class Setting {
  constructor(container) {
    this.settingEl = container.createDiv({ cls: "setting-item" });
    this.nameEl = this.settingEl.createDiv();
    this.descEl = this.settingEl.createDiv();
    this.controlEl = this.settingEl.createDiv();
  }
  setName(name) { this.nameEl.textContent = name; return this; }
  setDesc(desc) { this.descEl.textContent = desc; return this; }
  setHeading() { return this; }
  addButton(build) {
    const el = this.controlEl.createEl("button");
    const api = {
      setButtonText(text) { el.textContent = text; return api; },
      setDisabled(value) { el.disabled = value; return api; },
      setWarning() { el.classList.add("mod-warning"); return api; },
      setDestructive() {
        if (!requireApiVersion("1.13.0")) throw new Error("setDestructive is unavailable before 1.13");
        el.classList.add("mod-destructive"); return api;
      },
      setClass(value) { el.classList.add(value); return api; },
      setCta() { el.classList.add("mod-cta"); return api; },
      onClick(handler) { el.onclick = handler; return api; },
    };
    build(api);
    return this;
  }
  addExtraButton(build) {
    const el = this.controlEl.createEl("button");
    const api = {
      setIcon() { return api; },
      setTooltip(text) { el.setAttribute("aria-label", text); return api; },
      onClick(handler) { el.onclick = handler; return api; },
    };
    build(api);
    return this;
  }
  addText(build) {
    const el = this.controlEl.createEl("input", { type: "text" });
    const api = {
      inputEl: el,
      setValue(value) { el.value = value; return api; },
      setPlaceholder(value) { el.placeholder = value; return api; },
      onChange(handler) { el.oninput = () => handler(el.value); return api; },
    };
    build(api);
    return this;
  }
  addToggle(build) {
    const el = this.controlEl.createEl("input", { type: "checkbox" });
    const api = {
      setValue(value) { el.checked = value; return api; },
      setDisabled(value) { el.disabled = value; return api; },
      onChange(handler) { el.onchange = () => handler(el.checked); return api; },
    };
    build(api);
    return this;
  }
}
// Records the most recently shown menu so tests can invoke its items.
class Menu {
  constructor() { this.items = []; }
  addItem(build) {
    const item = { title: "", disabled: false, click: null };
    const api = {
      setTitle(title) { item.title = title; return api; },
      setIcon() { return api; },
      setDisabled(disabled) { item.disabled = disabled; return api; },
      setWarning() { return api; },
      onClick(click) { item.click = click; return api; },
    };
    build(api);
    this.items.push(item);
    return this;
  }
  addSeparator() { return this; }
  showAtMouseEvent() { Menu.last = this; }
  showAtPosition(position) { Menu.last = this; this.position = position; }
}
Menu.last = null;
const Platform = { isMobile: false };
function setIcon(element, icon) { element.setAttribute("data-icon", icon); }

async function requestUrl() {
  throw new Error("requestUrl is not configured in this unit test.");
}


module.exports = {
  normalizePath,
  getFrontMatterInfo,
  parseYaml,
  stringifyYaml,
  TFile,
  TFolder,
  Vault,
  Plugin,
  FileSystemAdapter,
  MarkdownView,
  apiVersion,
  addIcon,
  ItemView,
  Menu,
  Modal,
  SuggestModal,
  Notice,
  PluginSettingTab,
  requireApiVersion,
  Setting,
  SettingGroup,
  Platform,
  setIcon,
  requestUrl,
};
