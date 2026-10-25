import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { Notice } from "obsidian";
import { MdbaseSettingTab } from "../src/settingsTab";
import type { SyncSnapshot } from "../src/sync/controller";

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  const collection = {
    id: "0b6f1c1e-6f77-4a4b-9a57-7f2a1d1f0c11", name: "Project notes", root: "/vaults/notes", mode: "synced_e2e" as const, state: "ready" as const, log: "hosted" as const,
    sync: { confirmed_through: 1, head_known: 1, pending: 0, holds: 0, unresolved: 0, connection: "online" }, notices: [],
  };
  return {
    daemon: "running", error: null, collection, prefix: "", live: null, link: "open", holds: [], approvals: [], merged: [], signingIn: null, busy: null,
    status: { account: { signed_in: true, online: true, computer_name: "Laptop" }, collections: [collection] }, ...overrides,
  };
}

function fixture(initial: SyncSnapshot = snapshot()) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  Object.assign(dom.window.HTMLElement.prototype, {
    createEl(this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const el = this.ownerDocument.createElement(tag);
      for (const [key, value] of Object.entries(options)) {
        if (key === "text") el.textContent = String(value);
        else if (key === "cls") el.className = String(value);
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
    isShown(this: HTMLElement) { return this.isConnected; },
  });
  const notices = (Notice as unknown as { messages: string[] }).messages;
  notices.length = 0;
  let current = initial;
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const controller = {
    get snapshot() { return current; },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: async () => { calls.push("refresh"); },
    signIn: async () => { calls.push("signIn"); },
    signOut: async () => { calls.push("signOut"); },
    disconnect: async () => { calls.push("disconnect"); },
  };
  const opened: string[] = [];
  const plugin = {
    settings: { validateOnSave: true, validateOnOpen: true, showNoticeOnSave: true, interopEnabled: true, mdbaseAppPath: "" },
    saveSettings: async () => undefined,
    syncController: controller,
    openWorkspace: async (destination: string) => { opened.push(destination); },
  };
  let settingsClosed = 0;
  const app = { setting: { close: () => { settingsClosed++; } } };
  const tab = new MdbaseSettingTab(app as never, plugin as never);
  dom.window.document.body.appendChild(tab.containerEl);
  tab.display();
  return {
    dom, plugin, tab, root: tab.containerEl, notices, calls, opened, settingsClosed: () => settingsClosed,
    set(next: Partial<SyncSnapshot>) { current = { ...current, ...next }; for (const l of listeners) l(); },
  };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(root.querySelectorAll("button")).find((el) => el.textContent === label || el.getAttribute("aria-label") === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}

const modal = (f: { dom: JSDOM }) => f.dom.window.document.body.lastElementChild as HTMLElement;

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("sync settings show status, account and collection in plain words", () => {
  const f = fixture();
  const text = f.root.textContent!;
  assert.match(text, /Synced/);
  assert.match(text, /Signed in\. This computer is "Laptop"\./);
  assert.match(text, /Project notes.*Private/);
  assert.doesNotMatch(text, /key|device ID|server|Connect URL/i);
  f.dom.window.close();
});

test("Open sync closes settings before showing the workspace", async () => {
  const f = fixture();
  button(f.root, "Open sync").click();
  await settle();
  assert.equal(f.settingsClosed(), 1);
  assert.deepEqual(f.opened, ["sync"]);
  f.dom.window.close();
});

test("sign out is hidden until re-sign-in works on the same computer", () => {
  const f = fixture();
  assert.match(f.root.textContent!, /Signed in/);
  assert.equal([...f.root.querySelectorAll("button")].some((b) => b.textContent === "Sign out"), false);
  f.dom.window.close();
});

test("disconnecting asks first and says what stays", async () => {
  for (const [label, action, call] of [["Disconnect…", "Stop syncing", "disconnect"]] as const) {
    const f = fixture();
    button(f.root, label).click();
    assert.match(modal(f).textContent!, /Your notes stay/);
    button(modal(f), "Cancel").click();
    await settle();
    assert.deepEqual(f.calls, []);
    button(f.root, label).click();
    button(modal(f), action).click();
    await settle();
    assert.deepEqual(f.calls.filter((c) => c !== "refresh"), [call]);
    f.dom.window.close();
  }
});

test("signed out offers sign-in; a missing app offers its location", async () => {
  const f = fixture(snapshot({ collection: null, status: { account: { signed_in: false, online: true }, collections: [] } }));
  button(f.root, "Sign in").click();
  await settle();
  assert.deepEqual(f.calls, ["signIn"]);
  assert.deepEqual(f.opened, ["sync"]);
  assert.equal(f.settingsClosed(), 1);
  f.set({ daemon: "not_installed", status: null });
  assert.match(f.root.textContent!, /can't find the mdbase app/);
  const path = f.root.querySelector<HTMLInputElement>("input[type='text']")!;
  path.value = " /opt/mdbase/mdbase ";
  path.dispatchEvent(new f.dom.window.Event("input"));
  await settle();
  assert.equal(f.plugin.settings.mdbaseAppPath, "/opt/mdbase/mdbase");
  f.dom.window.close();
});

test("failed actions report a human notice", async () => {
  const f = fixture();
  Object.assign(f.plugin.syncController, { disconnect: async () => { throw Object.assign(new Error("x"), { code: "unavailable", message: "x" }); } });
  button(f.root, "Disconnect…").click();
  button(modal(f), "Stop syncing").click();
  await settle();
  assert.deepEqual(f.notices, ["mdbase can't reach the server right now. Check your connection and try again."]);
  f.dom.window.close();
});
