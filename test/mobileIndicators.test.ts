import * as assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { Platform } from "obsidian";
import MdbasePlugin from "../main";
import type { SyncIndicator } from "../src/syncUx";

function fixture(state: SyncIndicator["state"]) {
  const dom = new JSDOM("<!doctype html><button id='ribbon'></button>");
  const ribbon = dom.window.document.getElementById("ribbon") as unknown as HTMLElement;
  ribbon.setAttr = (name, value) => ribbon.setAttribute(name, String(value));
  const calls: string[] = [];
  const indicator: SyncIndicator = { state, label: `mdbase: ${state}`, detail: `Sync is ${state}`, destination: "sync" };
  const plugin = Object.assign(Object.create(MdbasePlugin.prototype) as {
    updateStatusBar(): void; onRibbonClick(): Promise<void>;
  }, {
    ribbonEl: ribbon,
    statusBarEl: undefined,
    noteStatusEl: undefined,
    getIssues: () => [],
    syncIndicator: () => indicator,
    updateNoteStatus: async () => undefined,
    openWorkspace: async () => { calls.push("types"); },
    openStatusDestination: async () => { calls.push("sync"); },
  });
  return { plugin, ribbon, calls, dom };
}

test("mobile ribbon reports sync state even without a status bar", () => {
  const previous = Platform.isMobile;
  Platform.isMobile = true;
  try {
    const f = fixture("offline");
    f.plugin.updateStatusBar();
    assert.equal(f.ribbon.getAttribute("data-state"), "offline");
    assert.match(f.ribbon.getAttribute("aria-label") ?? "", /offline/i);
    assert.match(f.ribbon.getAttribute("title") ?? "", /offline/i);
    f.dom.window.close();
  } finally { Platform.isMobile = previous; }
});

test("mobile ribbon opens pending sync instead of making the person hunt behind Types", async () => {
  const previous = Platform.isMobile;
  Platform.isMobile = true;
  try {
    for (const state of ["offline", "paused", "attention", "syncing", "waiting"] as const) {
      const f = fixture(state);
      await f.plugin.onRibbonClick();
      assert.deepEqual(f.calls, ["sync"], state);
      f.dom.window.close();
    }
    const settled = fixture("synced");
    await settled.plugin.onRibbonClick();
    assert.deepEqual(settled.calls, ["types"], "settled sync keeps Types as the primary surface");
    settled.dom.window.close();
  } finally { Platform.isMobile = previous; }
});

test("desktop ribbon retains its Types destination when the status bar can handle sync", async () => {
  const previous = Platform.isMobile;
  Platform.isMobile = false;
  try {
    const f = fixture("offline");
    await f.plugin.onRibbonClick();
    assert.deepEqual(f.calls, ["types"]);
    f.dom.window.close();
  } finally { Platform.isMobile = previous; }
});
