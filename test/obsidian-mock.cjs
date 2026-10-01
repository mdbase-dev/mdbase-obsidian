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
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
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
      onClick(handler) { el.onclick = handler; return api; },
    };
    build(api);
    return this;
  }
  addToggle(build) {
    const el = this.controlEl.createEl("input", { type: "checkbox" });
    const api = {
      setValue(value) { el.checked = value; return api; },
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
  Setting,
  Platform,
  setIcon,
  requestUrl,
};
