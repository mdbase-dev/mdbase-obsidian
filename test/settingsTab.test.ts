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
    setText(this: HTMLElement, value: string) { this.textContent = value; },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
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
    openWorkspace: async (_destination: string) => ({ reconnectCollection: async () => undefined }),
    connectSync: { getSelectiveSync: () => policy },
    sync: {
      isSyncing: () => false,
      configureSelectiveSync: async (next: typeof policy) => { policy = next; },
    },
  };
  let settingsClosed = 0;
  const app = { vault: { getAllLoadedFiles: () => [] }, setting: { close: () => { settingsClosed++; } } };
  const tab = new MdbaseSettingTab(app as never, plugin as never);
  tab.display();
  return { dom, plugin, tab, root: tab.containerEl, notices, policy: () => policy, settingsClosed: () => settingsClosed };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(root.querySelectorAll("button")).find(el => el.textContent === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("attachment settings use sentence case without lowercasing the PDF acronym", () => {
  const f = fixture();
  assert.match(f.root.textContent!, /Sync images/);
  assert.match(f.root.textContent!, /Sync PDFs/);
  assert.match(f.root.textContent!, /Sync other files/);
  f.dom.window.close();
});

test("Open sync and Reconnect close settings before handing off to the workspace", async () => {
  for (const connected of [false, true]) {
    const f = fixture();
    if (!connected) Object.assign(f.plugin, { getMirrorProfile: () => null });
    let opened = 0;
    let reconnected = 0;
    f.plugin.openWorkspace = async (destination) => {
      assert.equal(destination, "sync");
      assert.equal(f.settingsClosed(), 1, "approval and cancellation must not stay hidden behind settings");
      opened++;
      return { reconnectCollection: async () => { reconnected++; } };
    };
    f.tab.display();
    button(f.root, connected ? "Reconnect" : "Open sync").click();
    await settle();
    assert.equal(opened, 1);
    assert.equal(reconnected, connected ? 1 : 0);
    f.dom.window.close();
  }
});

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

test("disconnect stays disabled through its decision and completion, without duplicate requests", async () => {
  const f = fixture();
  let disconnected = 0;
  let finish: () => void = () => assert.fail("Disconnect not started");
  Object.assign(f.plugin.sync, {
    state: { message: "Disconnected. Local files kept." },
    disconnect: async () => { disconnected++; await new Promise<void>(resolve => { finish = resolve; }); },
  });
  const disconnect = button(f.root, "Disconnect…");
  disconnect.click();
  assert.equal(disconnect.disabled, true, "only one disconnect decision at a time");
  button(f.dom.window.document.body, "Keep files").click();
  await settle();
  assert.equal(disconnect.disabled, true, "do not offer another disconnect while cleanup is running");
  assert.equal(disconnect.textContent, "Disconnecting…");
  disconnect.click();
  assert.equal(disconnected, 1);
  finish();
  await settle();
  assert.deepEqual(f.notices, ["Disconnected. Local files kept."]);
  assert.equal(button(f.root, "Disconnect…").disabled, false);
  f.dom.window.close();
});

test("cancelling disconnect restores its original action without rerendering settings", async () => {
  const f = fixture();
  const disconnect = button(f.root, "Disconnect…");
  disconnect.click();
  button(f.dom.window.document.body, "Cancel").click();
  await settle();
  assert.equal(button(f.root, "Disconnect…"), disconnect, "native focus can return to the same button");
  assert.equal(disconnect.disabled, false);
  assert.deepEqual(f.notices, []);
  f.dom.window.close();
});

test("Open sync failures report a notice instead of an unhandled settings rejection", async () => {
  const f = fixture();
  Object.assign(f.plugin, { getMirrorProfile: () => null });
  f.plugin.openWorkspace = async () => { throw new Error("Workspace could not open"); };
  f.tab.display();
  button(f.root, "Open sync").click();
  await settle();
  assert.deepEqual(f.notices, ["Workspace could not open"]);
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
