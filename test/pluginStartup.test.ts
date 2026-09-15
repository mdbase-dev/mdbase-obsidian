import assert from "node:assert/strict";
import test from "node:test";
import MdbasePlugin from "../main";
import { MDBASE_WORKSPACE_VIEW } from "../src/workspaceView";

// Test the actual Plugin.onload orchestration, not a second startup implementation.
function pluginFixture() {
  const settingsPath = ".obsidian/plugins/mdbase-obsidian/data.json";
  let loadFailure = false;
  let saves = 0;
  const commands = new Set<string>();
  const views = new Set<string>();
  const status: { text: string; attrs: Record<string, string> } = { text: "", attrs: {} };
  const files = new Map<string, string>();
  const app = {
    vault: { on() {}, adapter: {
      exists: async (path: string) => files.has(path) || (loadFailure && path === settingsPath),
      read: async (path: string) => {
        if (loadFailure && path === settingsPath) throw new Error("private settings payload");
        return files.get(path);
      },
    } },
    workspace: { on() {}, getActiveFile: () => null, getLeavesOfType: () => [] },
  };
  const plugin = new MdbasePlugin(app as never, { id: "mdbase-obsidian", version: "test", dir: ".obsidian/plugins/mdbase-obsidian" } as never);
  Object.assign(plugin, {
    loadData: async () => { throw new Error("Do not use the lossy loadData API for authority settings"); },
    saveData: async () => { saves++; },
    addStatusBarItem: () => ({
      addClass() {},
      setText: (text: string) => { status.text = text; },
      setAttr: (name: string, value: string) => { status.attrs[name] = value; },
    }),
    registerView: (id: string) => { views.add(id); },
    addCommand: ({ id }: { id: string }) => { commands.add(id); },
    addSettingTab() {}, addRibbonIcon() {}, registerDomEvent() {}, registerEvent() {},
    registerInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
  });
  Object.assign(globalThis, { window: globalThis });
  return { plugin, commands, views, status, files, settingsPath, get saves() { return saves; },
    setStored(value: unknown) { files.set(settingsPath, JSON.stringify(value)); }, setLoadFailure(value: boolean) { loadFailure = value; } };
}

test("actual plugin startup registers commands, settings and recovery view despite corrupt adoption metadata", async () => {
  const f = pluginFixture();
  f.files.set(".mdbase/authority-adoption.json", "corrupt checkpoint");
  await f.plugin.onload();
  assert.equal(f.plugin.connectSync.getRecoveryStatus()?.code, "invalid_authority_adoption_checkpoint");
  assert.equal(f.views.has(MDBASE_WORKSPACE_VIEW), true);
  assert.equal(f.commands.has("mdbase-open"), true);
  assert.match(f.status.text, /recovery required/);
  await assert.rejects(f.plugin.saveSettings(), /recovery workspace/);
  assert.equal(f.saves, 0);
  f.files.delete(".mdbase/authority-adoption.json");
  await f.plugin.retryInitialization();
  assert.equal(f.plugin.connectSync.getRecoveryStatus(), null);
  assert.doesNotMatch(f.status.text, /recovery required/);
  await f.plugin.saveSettings();
  assert.equal(f.saves, 1);
  f.plugin.onunload();
});

test("actual plugin startup keeps unreadable settings intact and retry reloads repaired settings", async () => {
  const f = pluginFixture();
  f.setLoadFailure(true);
  await f.plugin.onload();
  assert.equal(f.plugin.connectSync.getRecoveryStatus()?.code, "invalid_plugin_settings");
  assert.equal(f.views.has(MDBASE_WORKSPACE_VIEW), true);
  await assert.rejects(f.plugin.saveSettings());
  assert.equal(f.saves, 0);
  assert.equal(f.plugin.api.getInteropStatus().enabled, false);
  f.setLoadFailure(false);
  f.setStored({ validateOnSave: false });
  await f.plugin.retryInitialization();
  assert.equal(f.plugin.settings.validateOnSave, false);
  assert.equal(f.plugin.connectSync.getRecoveryStatus(), null);
  f.plugin.onunload();
});

test("malformed JSON and null settings are not mistaken for first-run defaults", async () => {
  for (const invalid of ["[test] broken JSON", "null", "[]"]) {
    const f = pluginFixture();
    f.files.set(f.settingsPath, invalid);
    await f.plugin.onload();
    assert.equal(f.plugin.connectSync.getRecoveryStatus()?.code, "invalid_plugin_settings");
    await assert.rejects(f.plugin.saveSettings());
    assert.equal(f.saves, 0);
    assert.equal(f.files.get(f.settingsPath), invalid);
    f.setStored({});
    await f.plugin.retryInitialization();
    assert.equal(f.plugin.connectSync.getRecoveryStatus(), null);
    f.plugin.onunload();
  }
});

test("invalid persisted mirror profiles are not silently discarded or overwritten", async () => {
  const f = pluginFixture();
  f.setStored({ mirrorProfile: { mode: "corrupt" }, interopEnabled: true });
  await f.plugin.onload();
  assert.equal(f.plugin.connectSync.getRecoveryStatus()?.code, "invalid_plugin_settings");
  assert.equal(f.plugin.api.getInteropStatus().enabled, false);
  await assert.rejects(f.plugin.saveSettings());
  assert.equal(f.saves, 0);
  f.plugin.onunload();
});
