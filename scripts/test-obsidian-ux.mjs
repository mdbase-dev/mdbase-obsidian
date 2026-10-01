/** Live Obsidian acceptance tests. NEVER point this at a personal vault.
 * OBSIDIAN_UX_VAULT=mdbase-ux-e2e OBSIDIAN_UX_VAULT_PATH=/absolute/disposable/vault
 * XDG_RUNTIME_DIR=<the running Obsidian CLI socket directory> node scripts/test-obsidian-ux.mjs
 * Installs first-party People pack if missing; retains fixtures and screenshots as evidence.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

const vault = process.env.OBSIDIAN_UX_VAULT;
const vaultPath = process.env.OBSIDIAN_UX_VAULT_PATH;
assert.ok(vault && vaultPath, "Explicit disposable vault name AND path are required.");
const evidence = process.env.OBSIDIAN_UX_EVIDENCE || `/tmp/mdbase-ux-evidence-${Date.now()}`;
await mkdir(evidence, { recursive: true });
const results = [];
function cli(...args) {
  const result = spawnSync("obsidian", [`vault=${vault}`, ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr || result.stdout || result.error}`);
  assert.ok(!result.stdout.startsWith("Error:"), result.stdout);
  return result.stdout.trim();
}
function evaluate(code) {
  // CLI parameter decoding expands backslash escapes, even inside JS strings.
  const expression = `(async()=>{const value=await (async()=>{${code}})();return JSON.stringify(value===undefined?null:value)})()`;
  const encoded = Buffer.from(expression).toString("base64");
  const output = cli("eval", `code=eval(new TextDecoder().decode(Uint8Array.from(atob('${encoded}'),c=>c.charCodeAt(0))))`);
  return JSON.parse(output.replace(/^=>\s*/, ""));
}
async function wait(code, description, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (evaluate(`return Boolean(${code})`)) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out: ${description}\n${evaluate("return document.body.innerText.slice(-5000)")}`);
}
async function waitReady() {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    try { if (evaluate("return !!app.plugins.plugins['mdbase-obsidian']")) return; } catch { /* CLI registrations are temporarily unavailable during reload. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Obsidian did not finish reloading.");
}
async function check(name, action) {
  const start = Date.now();
  try { await action(); results.push({ name, passed: true, milliseconds: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); throw error; }
  finally { await writeFile(path.join(evidence, "results.json"), JSON.stringify(results, null, 2)); }
}
function click(text, root = "activeDocument") {
  evaluate(`const button=[...${root}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!button||button.disabled)throw Error('Unavailable button: '+${JSON.stringify(text)});button.click();`);
}
function input(selector, value) {
  evaluate(`const e=activeDocument.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));`);
}
function screenshot(name) { cli("dev:screenshot", `path=${path.join(evidence, `${name}.png`)}`); }

assert.equal(evaluate("return app.vault.adapter.basePath"), vaultPath, "Refusing to write to an unexpected vault.");
evaluate("require('electron').remote.getCurrentWindow().focus();");
await wait("activeWindow===window", "focus test vault");
cli("dev:debug", "on");
evaluate("window.uxPlugin=app.plugins.plugins['mdbase-obsidian'];if(!uxPlugin)throw Error('Plugin not loaded');window.uxView=await uxPlugin.openWorkspace('types');");

await check("first-run choices and contract-based onboarding", async () => {
  if (!evaluate("return !!app.vault.getAbstractFileByPath('mdbase.yaml')")) {
    assert.match(evaluate("return uxView.containerEl.innerText"), /Initialize to manage a local collection/);
    click("Initialize collection", "uxView.containerEl");
    await wait("!uxView.busy && uxView.schema", "initialize collection");
    assert.equal(evaluate("return uxView.schema.types.size"), 0);
    assert.match(evaluate("return uxView.containerEl.innerText"), /mdbase-contracts/);
    screenshot("onboarding");
  }
  if (!evaluate("return uxView.schema.types.has('person')")) {
    await evaluate("await uxPlugin.openContractCatalog();");
    await wait("[...activeDocument.querySelectorAll('.modal-content h3')].some(e=>e.textContent==='People')", "load real catalog");
    evaluate("[...activeDocument.querySelectorAll('.modal-content .mdbase-editor-section')].find(s=>s.querySelector('h3')?.textContent==='People').querySelector('button').click();");
    await wait("[...activeDocument.querySelectorAll('button')].some(b=>b.textContent==='Install reviewed pack')", "review digest-verified People pack");
    screenshot("pack-review");
    click("Install reviewed pack");
    await wait("!activeDocument.querySelector('.modal') && uxView.schema.types.has('person')", "transactional pack installation");
  }
  assert.ok(evaluate("return !!app.vault.getAbstractFileByPath('mdbase.lock.yaml')"));
  // Exercise the real installed starter, not just a synthetic schema fixture.
  evaluate("await uxView.editType('_types/person.md');");
  click("New note", "uxView.containerEl");
  await wait("activeDocument.querySelector('#mdbase-note-name')", "People starter creation form");
  input("#mdbase-note-name", `UX Person ${Date.now()}`);
  await wait("activeDocument.querySelector('#mdbase-note-location')?.value.startsWith('ux-person')", "Person naming preview");
  evaluate("window.uxPersonPath=activeDocument.querySelector('#mdbase-note-location').value;");
  click("Create note");
  await wait("!activeDocument.querySelector('.mdbase-create-note')", "create a real contract-compatible Person");
  assert.ok(evaluate("return !!app.vault.getAbstractFileByPath(uxPersonPath)"));
});

const id = `ux_${Date.now()}`;
evaluate(`window.uxFixtureId=${JSON.stringify(id)}; window.uxFixtureFolder='UX acceptance/'+uxFixtureId;await app.vault.createFolder('UX acceptance').catch(()=>{});await app.vault.createFolder(uxFixtureFolder);`);
const definition = { kind: "mdbase.type", name: id, version: 1, description: "Live UX acceptance fixture", collection: { display: { name_field: "title" } },
  schema: { dialect: "json-schema-2020-12", value: { type: "object", required: ["title", "count", "status", "active", "when"], properties: {
    title: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1, maximum: 10 },
    status: { type: "string", enum: ["planned", "done"] }, active: { type: "boolean" }, when: { type: "string", format: "date" },
  } } } };
evaluate(String.raw`await app.vault.create('_types/'+uxFixtureId+'.md','---\n'+JSON.stringify(${JSON.stringify(definition)})+'\n---\n');await uxView.refresh(true);await uxView.editType('_types/'+uxFixtureId+'.md');`);
await check("typed creation keeps invalid values, validates constraints, and previews location", async () => {
  click("New note", "uxView.containerEl");
  await wait("activeDocument.querySelector('#mdbase-note-count')", "creation form");
  input("#mdbase-note-title", "Live acceptance note"); input("#mdbase-note-count", "12abc");
  input("#mdbase-note-status", "0"); input("#mdbase-note-active", "1"); input("#mdbase-note-when", "2026-09-30");
  click("Create note");
  assert.equal(evaluate("return activeDocument.querySelector('#mdbase-note-title').value"), "Live acceptance note");
  assert.match(evaluate("return activeDocument.querySelector('.modal-content').innerText"), /whole integer/);
  input("#mdbase-note-count", "11"); click("Create note");
  assert.match(evaluate("return activeDocument.querySelector('.modal-content').innerText"), /10/);
  input("#mdbase-note-count", "7"); input("#mdbase-note-location", "../outside"); click("Create note");
  assert.match(evaluate("return activeDocument.querySelector('.modal-content').innerText"), /vault-relative/);
  input("#mdbase-note-location", `UX acceptance/${id}/created.md`);
  screenshot("creation-form"); click("Create note");
  await wait("!activeDocument.querySelector('.mdbase-create-note')", "create valid note");
  const content = evaluate("return await app.vault.read(app.vault.getAbstractFileByPath(uxFixtureFolder+'/created.md'))");
  assert.match(content, /count: 7/); assert.match(content, /active: false/);
});

await check("validation freshness, full scan, live changes and safe cancellation", async () => {
  await evaluate("uxView.showDestination('issues');await uxPlugin.runCollectionValidation(false);");
  assert.match(evaluate("return uxPlugin.getValidationSummary()"), /Validated/);
  evaluate(String.raw`await app.vault.modify(app.vault.getAbstractFileByPath(uxFixtureFolder+'/created.md'),'---\ntype: '+uxFixtureId+'\ntitle: Broken\ncount: bad\n---\n');`);
  await wait("/Changed since/.test(uxPlugin.getValidationSummary())", "invalidate validation on change");
  evaluate("await uxPlugin.runCollectionValidation(false);");
  assert.ok(evaluate("return uxPlugin.getIssues().some(i=>i.path===uxFixtureFolder+'/created.md')"));
  screenshot("validation-issues");
  // 300 real vault files; delayed reads make cancellation deterministic on fast devices.
  evaluate(String.raw`await Promise.all(Array.from({length:300},(_,i)=>app.vault.create(uxFixtureFolder+'/scan-'+i+'.md','---\ntype: '+uxFixtureId+'\ntitle: Scan\ncount: 5\nstatus: planned\nactive: false\nwhen: 2026-09-30\n---\n')));window.uxRead=app.vault.cachedRead.bind(app.vault);app.vault.cachedRead=async(...args)=>{await new Promise(r=>setTimeout(r,20));return uxRead(...args)};uxView.showDestination('issues');void uxPlugin.runCollectionValidation(false);`);
  try {
    await wait("uxPlugin.isValidating() && [...uxView.containerEl.querySelectorAll('button')].some(b=>b.textContent==='Stop validation')", "visible cancellation without waiting for record loading");
    click("Stop validation", "uxView.containerEl");
    await wait("!uxPlugin.isValidating()", "stop validation");
    assert.match(evaluate("return uxPlugin.getValidationSummary()"), /incomplete/);
  } finally { evaluate("app.vault.cachedRead=uxRead;"); }
});

await check("stale drafts can be compared and exported and survive source changes", async () => {
  evaluate("await uxView.editType('_types/'+uxFixtureId+'.md');");
  const descriptionSelector = ".mdbase-type-editor-pane textarea[data-focus-key='form-description']";
  input(descriptionSelector, "My unsaved recovery work");
  evaluate("await uxView.flushTypeDraft();await app.vault.process(app.vault.getAbstractFileByPath('_types/'+uxFixtureId+'.md'),s=>s.replace('Live UX acceptance fixture','External source change'));await uxView.refresh(true);");
  assert.ok(evaluate("return [...uxView.containerEl.querySelectorAll('button')].some(b=>b.textContent==='Compare draft')"));
  click("Compare draft", "uxView.containerEl");
  assert.match(evaluate("return activeDocument.querySelector('.modal-content').innerText"), /My unsaved recovery work/);
  screenshot("draft-recovery"); evaluate("activeDocument.querySelector('.modal-header-button').click();");
  click("Export draft", "uxView.containerEl"); await wait("!uxView.busy", "export recovery");
  assert.ok(evaluate("return app.vault.getFiles().some(f=>f.path.startsWith('mdbase-draft-recovery/'))"));
  input(descriptionSelector, "Fresh draft after external change"); evaluate("await uxView.flushTypeDraft();");
  assert.ok(evaluate("return uxPlugin.getArchivedTypeDrafts('_types/'+uxFixtureId+'.md').length>0"));
});

await check("workspace state restores navigation but never transfer approval", async () => {
  evaluate("uxView.showDestination('issues');uxView.issueQuery=uxFixtureFolder;uxView.render();window.uxSavedState=uxView.getState();const leaf=app.workspace.getLeaf(true);await leaf.setViewState({type:'mdbase-workspace-view',state:uxSavedState});window.uxRestored=leaf.view;");
  assert.equal(evaluate("return uxRestored.getState().issueQuery"), `UX acceptance/${id}`);
  assert.equal(evaluate("return uxRestored.getState().destination"), "issues");
  assert.equal(evaluate("return uxRestored.model.name"), id);
  assert.equal(evaluate("return 'mirrorPreview' in uxRestored.getState()"), false);
  evaluate("uxRestored.leaf.detach();await app.workspace.revealLeaf(uxView.leaf);uxView.showDestination('types');");
});

await check("attachment scope supports folders with commas and explains size and retention", async () => {
  evaluate("window.uxPolicySurface=uxView.containerEl.createDiv();uxView.renderFilePolicyControls(uxPolicySurface,{connected:false});");
  assert.match(evaluate("return uxPolicySurface.innerText"), /32 MiB/);
  assert.match(evaluate("return uxPolicySurface.innerText"), /does not delete hosted/);
  input("#mdbase-excluded-folder", "Private, exports"); click("Exclude folder", "uxPolicySurface");
  assert.ok(evaluate("return uxView.filePolicyDraft.excluded_folders.includes('Private, exports')"));
});

await check("large live transfer ledger is completely browsable; filters never narrow approval", async () => {
  // UI fixture only: no synthetic plan is ever submitted to a Connect server.
  evaluate("window.uxOriginalProfile=uxPlugin.getMirrorProfile.bind(uxPlugin);uxPlugin.getMirrorProfile=()=>({name:'UX ledger fixture',collectionId:'ux-ui-only',mode:'read_write',controlUrl:'https://connect.mdbase.dev'});uxView.destination='sync';uxView.mirrorStatus={state:'up_to_date',conflicts:[],local_issues:[]};const entries=Array.from({length:601},(_,i)=>({path:'Ledger/'+i+'.md',direction:'download',action:i===600?'delete':'update',detail:'UI fixture only'}));uxView.mirrorPreview={phase:'incremental',entries,collisions:[],local_issues:[],plan:{actions:entries,issues:[],summary:{blocking_issues:0}}};uxView.render();");
  try {
    assert.equal(evaluate("return uxView.containerEl.querySelectorAll('.mdbase-transfer-row').length"), 250);
    click("Next downloads", "uxView.containerEl");
    assert.equal(evaluate("return uxView.containerEl.querySelectorAll('.mdbase-transfer-row').length"), 250);
    click("Next downloads", "uxView.containerEl");
    assert.equal(evaluate("return uxView.containerEl.querySelectorAll('.mdbase-transfer-row').length"), 101);
    input("select[aria-label='Filter transfers']", "delete");
    assert.equal(evaluate("return uxView.containerEl.querySelectorAll('.mdbase-transfer-row').length"), 1);
    assert.equal(evaluate("return uxView.mirrorPreview.plan.actions.length"), 601);
    screenshot("large-ledger-filtered");
    evaluate("uxView.transferQuery='';uxView.transferFilter='all';uxView.mirrorPreview.entries=[{path:'safe.md',direction:'upload',action:'create',detail:'UI fixture only'},{path:'broken.md',direction:'attention',action:'review',detail:'Cannot read this file'}];uxView.mirrorPreview.local_issues=[{path:'broken.md',code:'file_read_failed',message:'Cannot read this file'}];uxView.mirrorPreview.plan={actions:[{command:'put_remote'}],issues:[{path:'broken.md',code:'file_read_failed',blocking:true,message:'Cannot read this file'}],summary:{blocking_issues:1}};uxView.render();");
    assert.ok(evaluate("return [...uxView.containerEl.querySelectorAll('button')].some(b=>b.textContent==='Sync 1 available change' && !b.disabled)"));
    assert.match(evaluate("return uxView.containerEl.innerText"), /isolated.*do not stop independent/);
    screenshot("partial-sync-review");
    // Never click Apply: this is an isolated UI fixture, not a remote sync plan.
  } finally { evaluate("uxPlugin.getMirrorProfile=uxOriginalProfile;uxView.mirrorPreview=null;uxView.mirrorStatus=null;uxView.showDestination('types');"); }
});

await check("mobile essentials and draft recovery survive real app reloads", async () => {
  cli("dev:mobile", "on");
  try {
    await waitReady();
    cli("dev:debug", "on");
    evaluate(`window.uxPlugin=app.plugins.plugins['mdbase-obsidian'];window.uxView=await uxPlugin.openWorkspace('types');await uxView.editType(${JSON.stringify(`_types/${id}.md`)});`);
    assert.ok(evaluate("return [...uxView.containerEl.querySelectorAll('button')].some(b=>b.textContent==='New note')"));
    assert.match(evaluate("return uxView.model.description"), /Fresh draft after external change/);
    cli("dev:cdp", "method=Emulation.setDeviceMetricsOverride", 'params={"width":390,"height":844,"deviceScaleFactor":1,"mobile":true}');
    screenshot("mobile-type");
    click("New note", "uxView.containerEl");
    await wait("activeDocument.querySelector('#mdbase-note-count')", "mobile creation form");
    // Native phone modals animate onto the screen after their inputs exist.
    await new Promise(resolve => setTimeout(resolve, 400));
    screenshot("mobile-creation");
    click("Cancel");
  } finally {
    try { cli("dev:cdp", "method=Emulation.clearDeviceMetricsOverride"); } catch { /* The reload may already have detached the debugger. */ }
    cli("dev:mobile", "off");
    await waitReady();
    cli("dev:debug", "on");
    evaluate(`window.uxPlugin=app.plugins.plugins['mdbase-obsidian'];window.uxView=await uxPlugin.openWorkspace('types');await uxView.editType(${JSON.stringify(`_types/${id}.md`)});`);
  }
});

await check("draft recovery survives a real plugin reload", async () => {
  const typePath = `_types/${id}.md`;
  const archived = evaluate(`return uxPlugin.getArchivedTypeDrafts(${JSON.stringify(typePath)}).length`);
  cli("plugin:reload", "id=mdbase-obsidian");
  evaluate(`window.uxPlugin=app.plugins.plugins['mdbase-obsidian'];window.uxView=await uxPlugin.openWorkspace('types');await uxView.editType(${JSON.stringify(typePath)});`);
  assert.equal(evaluate(`return uxPlugin.getArchivedTypeDrafts(${JSON.stringify(typePath)}).length`), archived);
  assert.match(evaluate("return uxView.model.description"), /Fresh draft after external change/);
});

console.log(`Evidence: ${evidence}`);
await writeFile(path.join(evidence, "console.txt"), cli("dev:console", "limit=100"));
await writeFile(path.join(evidence, "errors.txt"), cli("dev:errors"));
