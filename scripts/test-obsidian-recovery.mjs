#!/usr/bin/env node
// Opt-in desktop acceptance. No hosted requests, credentials, or account changes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, writeFileSync, unlinkSync, readdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map(process.argv.slice(2).map((arg) => {
  const separator = arg.indexOf("=");
  return [arg.slice(0, separator), arg.slice(separator + 1)];
}));
const vault = args.get("--vault");
if (!vault || args.get("--confirm") !== "DISPOSABLE_VAULT") {
  throw new Error("Usage: node scripts/test-obsidian-recovery.mjs --vault=test --confirm=DISPOSABLE_VAULT");
}
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runRoot = join(homedir(), ".local/state/mdbase-obsidian/acceptance");
mkdirSync(runRoot, { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(join(runRoot, "recovery-"));
const result = { result: "running", checks: [], cleanup: "not-started", bundle_sha256: "" };
function cli(command, ...parameters) {
  try {
    const output = execFileSync("obsidian", [`vault=${vault}`, command, ...parameters], {
      encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output.startsWith("Error:")) throw new Error("CLI reported an error");
    return output;
  } catch {
    // CLI error bodies can contain private paths/content. Do not forward them.
    throw new Error(`Obsidian command failed: ${command}`);
  }
}
function evaluate(code) {
  const output = cli("eval", `code=(async()=>JSON.stringify(await (${code})))()`);
  if (!output.startsWith("=> ")) throw new Error("Obsidian evaluation failed; raw output withheld.");
  return JSON.parse(output.slice(3));
}
function assert(value, message) { if (!value) throw new Error(message); }
const pluginId = "mdbase-obsidian";
const plugin = `app.plugins.plugins[${JSON.stringify(pluginId)}]`;
let pluginDir, markerPath, metadataDir, originalFiles;
let changed = false;
let madeMetadataDirectory = false;
const canary = "[test] invalid adoption checkpoint: recovery acceptance";
const checkRecovery = async (code) => {
  const state = evaluate(`(()=>{const p=${plugin};return {loaded:!!p,code:p?.connectSync.getRecoveryStatus()?.code}})()`);
  assert(state.loaded && state.code === code, `Expected loaded plugin with recovery code ${code}`);
  cli("command", "id=mdbase-obsidian:mdbase-open");
  const checked = evaluate(`(async()=>{
    const p=${plugin};
    const panel=document.querySelector('.mdbase-recovery');
    if(!panel || !panel.textContent.includes('Collection recovery')) return false;
    let blocked=0;
    for(const operation of [()=>p.saveSettings(),()=>p.initializeCollection(),()=>p.connectSync.preview(),()=>p.saveTypeModel({},null)]) {
      try{await operation()}catch(error){if(error.code==='initialization_required')blocked++}
    }
    return blocked===4 && !panel.textContent.includes(${JSON.stringify(canary)});
  })()`);
  assert(checked, "Recovery panel missing, diagnostics leaked raw input, or writes were not fenced");
  result.checks.push(`${code}: workspace available; writes blocked; raw checkpoint hidden`);
};
function clickRetry() {
  const recovered = evaluate(`(async()=>{
    const panel=document.querySelector('.mdbase-recovery');
    const button=Array.from(panel?.querySelectorAll('button')||[]).find(b=>b.textContent==='Retry initialization');
    if(!button || button.disabled)return false;
    button.click();
    for(let attempt=0;attempt<100;attempt++){
      await new Promise(resolve=>setTimeout(resolve,50));
      if(!${plugin}.connectSync.getRecoveryStatus()){
        ${plugin}.connectSync.assertLocalAuthorityWritable();
        return !document.querySelector('.mdbase-recovery');
      }
    }
    return false;
  })()`);
  assert(recovered, "Actual Retry initialization button did not restore the normal workspace");
}
try {
  const initial = evaluate(`(()=>{const p=${plugin};return {name:app.vault.getName(),path:app.vault.adapter.getBasePath(),configDir:app.vault.configDir,enabled:!!p,connected:!!p?.getMirrorProfile(),recovering:!!p?.connectSync.getRecoveryStatus?.()}})()`);
  assert(initial.name === vault, "Obsidian resolved a different vault; refusing to modify it");
  assert(initial.enabled && !initial.connected && !initial.recovering, "Use an enabled, healthy, local-only disposable vault");
  pluginDir = join(initial.path, initial.configDir, "plugins", pluginId);
  metadataDir = join(initial.path, ".mdbase");
  markerPath = join(metadataDir, "authority-adoption.json");
  for (const name of ["authority-adoption.json", "authority-adoption-snapshot.json", "connect-role.json"]) {
    assert(!existsSync(join(metadataDir, name)), "Refusing to test a vault with existing Connect role/adoption metadata");
  }
  const backup = join(evidence, "original-plugin");
  mkdirSync(backup, { mode: 0o700 });
  originalFiles = new Map();
  for (const name of ["main.js", "manifest.json", "styles.css", "data.json"]) {
    const source = join(pluginDir, name);
    originalFiles.set(name, existsSync(source));
    if (existsSync(source)) copyFileSync(source, join(backup, name));
  }
  for (const name of ["main.js", "manifest.json", "styles.css"]) assert(existsSync(join(repo, name)), "Build the plugin before acceptance");
  result.bundle_sha256 = createHash("sha256").update(readFileSync(join(repo, "main.js"))).digest("hex");
  cli("plugin:disable", `id=${pluginId}`);
  changed = true;
  for (const name of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(repo, name), join(pluginDir, name));
  madeMetadataDirectory = !existsSync(metadataDir);
  evaluate(`(async()=>{if(!await app.vault.adapter.exists('.mdbase'))await app.vault.adapter.mkdir('.mdbase');await app.vault.adapter.write('.mdbase/authority-adoption.json',${JSON.stringify(canary)});return true})()`);
  cli("plugin:enable", `id=${pluginId}`);
  await checkRecovery("invalid_authority_adoption_checkpoint");
  assert(readFileSync(markerPath, "utf8") === canary, "Failed initialization modified the recovery checkpoint");
  // Only remove the exact invalid checkpoint created by this test, never user state.
  evaluate(`(async()=>{if(await app.vault.adapter.read('.mdbase/authority-adoption.json')!==${JSON.stringify(canary)})return false;await app.vault.adapter.remove('.mdbase/authority-adoption.json');return true})()`);
  clickRetry();
  result.checks.push("repaired checkpoint: actual retry button unlocks normal workspace");

  cli("plugin:disable", `id=${pluginId}`);
  writeFileSync(join(pluginDir, "data.json"), "[test] malformed plugin settings", { mode: 0o600 });
  cli("plugin:enable", `id=${pluginId}`);
  await checkRecovery("invalid_plugin_settings");
  assert(readFileSync(join(pluginDir, "data.json"), "utf8") === "[test] malformed plugin settings", "Recovery overwrote settings with defaults");
  if (originalFiles.get("data.json")) copyFileSync(join(backup, "data.json"), join(pluginDir, "data.json"));
  else unlinkSync(join(pluginDir, "data.json"));
  clickRetry();
  result.checks.push("repaired settings: retry rereads disk without restarting Obsidian");
  result.result = "passed";
} catch (error) {
  result.result = changed ? "failed" : "blocked";
  result.failure = error.message;
  process.exitCode = changed ? 1 : 2;
} finally {
  if (changed) {
    try {
      cli("plugin:disable", `id=${pluginId}`);
      let checkpointClean = true;
      if (existsSync(markerPath)) {
        if (readFileSync(markerPath, "utf8") === canary) unlinkSync(markerPath);
        else checkpointClean = false; // Never erase state changed by another actor.
      }
      for (const [name, existed] of originalFiles) {
        const target = join(pluginDir, name);
        if (existed) copyFileSync(join(evidence, "original-plugin", name), target);
        else if (existsSync(target)) unlinkSync(target);
      }
      if (madeMetadataDirectory && readdirSync(metadataDir).length === 0) rmdirSync(metadataDir);
      cli("plugin:enable", `id=${pluginId}`);
      for (const [name, existed] of originalFiles) {
        if (existed) assert(readFileSync(join(pluginDir, name)).equals(readFileSync(join(evidence, "original-plugin", name))), "Original plugin restoration did not verify");
        else assert(!existsSync(join(pluginDir, name)), "A test-created plugin file remains");
      }
      result.cleanup = checkpointClean ? "original-plugin-restored; owned-checkpoint-removed" : "original-plugin-restored; externally-changed-checkpoint-retained";
      if (!checkpointClean) { result.result = "failed"; process.exitCode = 1; }
    } catch {
      result.cleanup = "incomplete; original plugin backup retained for manual recovery";
      result.result = "failed";
      process.exitCode = 1;
    }
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...result, evidence }, null, 2));
}
