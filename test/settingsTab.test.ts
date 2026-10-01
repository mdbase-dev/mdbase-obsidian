import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { Notice } from "obsidian";
import { MdbaseSettingTab } from "../src/settingsTab";

function fixture() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.assign(dom.window.HTMLElement.prototype, {
    createEl(this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const el = this.ownerDocument.createElement(tag);
      for (const [key, value] of Object.entries(options)) {
        if (key === "text") el.textContent = String(value);
        else if (key === "cls") el.className = String(value);
        else if (key === "attr") for (const [name, val] of Object.entries(value as object)) el.setAttribute(name, String(val));
        else el.setAttribute(key, String(value));
      }
      this.appendChild(el);
      return el;
    },
    createDiv(this: HTMLElement, options = {}) { return this.createEl("div", options); },
    setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
    empty(this: HTMLElement) { this.replaceChildren(); },
  });
  const notices = (Notice as unknown as { messages: string[] }).messages;
  notices.length = 0;
  let policy = { file_classes: [], excluded_folders: [] };
  const plugin = {
    settings: { autoSync: true },
    saveSettings: async () => undefined,
    requestSync: () => undefined,
    getMirrorProfile: () => ({ name: "Notes", mode: "read_write", controlUrl: "https://connect.example" }),
    openWorkspace: async () => ({ reconnectCollection: async () => undefined }),
    connectSync: { getSelectiveSync: () => policy },
    sync: {
      isSyncing: () => false,
      configureSelectiveSync: async (next: typeof policy) => { policy = next; },
    },
  };
  const tab = new MdbaseSettingTab({ vault: { getAllLoadedFiles: () => [] } } as never, plugin as never);
  tab.display();
  return { dom, plugin, tab, root: tab.containerEl, notices, policy: () => policy };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(root.querySelectorAll("button")).find(el => el.textContent === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("failed exclusion changes report only failure and leave the saved scope unchanged", async () => {
  const f = fixture();
  f.plugin.sync.configureSelectiveSync = async () => { throw new Error("Settings could not be saved"); };
  const input = f.root.querySelector<HTMLInputElement>("[aria-label='Excluded folder']")!;
  input.value = "Private";
  button(f.root, "Exclude folder").click();
  button(f.root, "Apply").click();
  await settle();
  assert.deepEqual(f.policy().excluded_folders, []);
  assert.deepEqual(f.notices, ["Settings could not be saved"]);
  assert.equal(button(f.root, "Apply").disabled, false);
  f.dom.window.close();
});

test("applying exclusions waits for persistence and prevents duplicate requests", async () => {
  const f = fixture();
  let save: () => void = () => assert.fail("Save not started");
  let calls = 0;
  f.plugin.sync.configureSelectiveSync = async () => {
    calls++;
    await new Promise<void>(resolve => { save = resolve; });
  };
  const apply = button(f.root, "Apply");
  apply.click();
  assert.equal(apply.disabled, true);
  apply.click();
  assert.equal(calls, 1);
  assert.deepEqual(f.notices, []);
  save();
  await settle();
  assert.deepEqual(f.notices, ["Excluded folders updated. The next sync applies them."]);
  assert.equal(apply.disabled, false);
  f.dom.window.close();
});

test("reconnect failures restore the settings action and report the error", async () => {
  const f = fixture();
  f.plugin.openWorkspace = async () => { throw new Error("Workspace could not open"); };
  button(f.root, "Reconnect").click();
  await settle();
  assert.equal(button(f.root, "Reconnect").disabled, false);
  assert.deepEqual(f.notices, ["Workspace could not open"]);
  f.dom.window.close();
});
