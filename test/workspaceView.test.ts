import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { CreateTypedNoteModal } from "../src/createTypedNoteModal";
import { MdbaseWorkspaceView } from "../src/workspaceView";
import { createDefaultTypeModel } from "../src/typeModel";
import { typeDefFromDraft } from "../src/typeImpact";
import { Menu } from "obsidian";
import type { SyncHistoryRun } from "../src/syncHistory";
import { SyncSession } from "../src/syncSession";

type TypeModel = ReturnType<typeof createDefaultTypeModel>;

// Exercise the actual renderer with Obsidian's DOM convenience methods, not
// source-string assertions. Browser screenshots separately cover real styles.
function fixture(connected = false) {
  const dom = new JSDOM("<!doctype html><html><body><div id='view'></div></body></html>");
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement, MutationObserver: window.MutationObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id) });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
  });
  Object.assign(window.HTMLElement.prototype, {
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
    createSpan(this: HTMLElement, options = {}) { return this.createEl("span", options); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    toggleClass(this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); },
    setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
    getAttr(this: HTMLElement, name: string) { return this.getAttribute(name); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    appendText(this: HTMLElement, text: string) { this.appendChild(this.ownerDocument.createTextNode(text)); },
    scrollIntoView() {},
  });
  const root = window.document.getElementById("view") as HTMLElement;
  const profile = connected ? { name: "Project notes", collectionId: "hidden-collection-id", mode: "read_write",
    controlUrl: "https://connect.example", selectiveSync: { file_classes: [], excluded_folders: [] } } : null;
  const historyRuns: SyncHistoryRun[] = [];
  const history = {
    list: () => historyRuns,
    append: async (run: SyncHistoryRun) => { historyRuns.push(run); },
    remove: async (id: string) => { historyRuns.splice(historyRuns.findIndex((run) => run.id === id), 1); },
    clear: async () => { historyRuns.length = 0; },
  };
  let settingsOpened = 0;
  const host = {
    getMirrorProfile: () => profile,
    getIssues: () => [] as Array<{ path: string; severity: string; code: string; message: string }>,
    saveTypeDraft: async () => undefined,
    loadTypeDraft: () => null,
    clearTypeDraft: async () => undefined,
    getArchivedTypeDrafts: () => [] as import("../src/typeEditorTypes").StoredTypeDraft[],
    discardArchivedTypeDraft: async () => undefined,
    createNoteFromType: async () => undefined,
    openContractCatalog: async () => undefined,
    getValidationSummary: () => "Not checked yet",
    isValidating: () => false,
    cancelValidation: () => undefined,
    loadCollectionRecords: async () => [] as Array<{ path: string; frontmatter: Record<string, unknown> }>,
    getQuickFixLabel: () => null as string | null,
    openSettings: () => { settingsOpened++; },
    otherSyncServices: () => [],
    copySyncDiagnostics: async () => undefined,
    connectSync: {
      getAdoptionMarker: () => null,
      getSelectiveSync: () => ({ file_classes: [] as string[], excluded_folders: [] as string[] }),
      isSyncing: () => false,
    } as Record<string, unknown>,
    sync: null as unknown as SyncSession,
  };
  host.sync = new SyncSession(host.connectSync as never, () => profile as never, history);
  const view = new MdbaseWorkspaceView({ containerEl: root, app: { vault: { getName: () => "Notes", getAbstractFileByPath: () => null, getAllLoadedFiles: () => [], createFolder: async () => undefined, create: async () => ({ path: "export.txt" }) } } } as never, host as never);
  const views = view as unknown as {
    types: { dirty: boolean; model: TypeModel; originalModel: TypeModel; selectedPath: string };
    sync: Record<string, unknown>;
    destination: string; message: string; schema: unknown; render(): void;
  };
  // Test-only access to view state: all rendering and DOM handlers are real.
  const state = {
    render: () => views.render(),
    get destination() { return views.destination; },
    set destination(value: string) { views.destination = value; },
    get transientMessage() { return views.message; },
    set transientMessage(value: string) { views.message = value; },
    get schema() { return views.schema; },
    set schema(value: unknown) { views.schema = value; },
    get dirty() { return views.types.dirty; },
    set dirty(value: boolean) { views.types.dirty = value; },
    get model() { return views.types.model; },
    set model(value: TypeModel) { views.types.model = value; },
    get originalModel() { return views.types.originalModel; },
    set originalModel(value: TypeModel) { views.types.originalModel = value; },
    get selectedPath() { return views.types.selectedPath; },
    set selectedPath(value: string) { views.types.selectedPath = value; },
    set mirrorStatus(value: unknown) { host.sync.update({ status: value as never }); },
    set mirrorPreview(value: unknown) { host.sync.update({ preview: value as never }); },
    set adoptionPreview(value: unknown) { views.sync.adoptionPreview = value; },
  };
  state.destination = "sync";
  state.mirrorStatus = { state: "up_to_date", last_synced_at: new Date().toISOString(), conflicts: [], local_issues: [] };
  const text = () => visibleText(root);
  return { dom, root, host, state, text, view, historyRuns, settingsOpened: () => settingsOpened };
}

function visibleText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  const el = node as HTMLElement;
  if (el.tagName === "DETAILS" && !(el as HTMLDetailsElement).open) {
    return visibleText(el.querySelector("summary")!);
  }
  return Array.from(node.childNodes).map(visibleText).join(" ").replace(/\s+/g, " ").trim();
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(root.querySelectorAll("button")).find(el => el.textContent === label || el.getAttribute("aria-label") === label);
  assert.ok(result, `Missing button: ${label}`);
  return result;
}

test("opening waits for the requested destination before scanning collection records", async () => {
  const f = fixture(true);
  f.state.destination = "types";
  let recordLoads = 0;
  Object.assign(f.host, {
    loadWorkspaceSchema: async () => ({ config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() }),
    loadCollectionRecords: async () => { recordLoads++; return []; },
  });
  await f.view.onOpen();
  assert.equal(recordLoads, 0, "onOpen must not scan Types before setState can restore Sync");
  await f.view.setState({ destination: "sync" }, {} as never);
  assert.equal(recordLoads, 0);
  await f.view.setState({ destination: "types" }, {} as never);
  assert.equal(recordLoads, 1, "opening Types still loads its statistics");
  await f.view.onClose();
  f.dom.window.close();
});

test("Sync and Issues refreshes do not parse all records or run type impact scans", async () => {
  const f = fixture(true);
  let recordLoads = 0;
  Object.assign(f.host, {
    loadWorkspaceSchema: async () => ({ config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() }),
    loadCollectionRecords: async () => { recordLoads++; return []; },
  });
  await f.view.refresh();
  assert.equal(recordLoads, 0, "Sync does not consume collection records");
  f.state.destination = "issues";
  await f.view.refresh();
  assert.equal(recordLoads, 0, "Issues does not consume collection records either");
  let pending: Promise<void> | null = null;
  const refresh = f.view.refresh.bind(f.view);
  f.view.refresh = (...args) => (pending = refresh(...args));
  f.view.showDestination("types");
  assert.ok(pending, "switching to Types must load its record statistics");
  await pending;
  assert.equal(recordLoads, 1);
  await f.view.onClose();
  f.dom.window.close();
});

test("transfer notifications coalesce renders, keep completion immediate, and cancel on close", async () => {
  const f = fixture(true);
  await f.view.onOpen();
  let renders = 0;
  let badgeRenders = 0;
  f.view.render = () => { renders++; };
  (f.view as unknown as { renderTopbarOnly(): void }).renderTopbarOnly = () => { badgeRenders++; };
  const timers = new Map<number, () => void>();
  let next = 0;
  f.dom.window.setTimeout = ((callback: () => void) => {
    timers.set(++next, callback);
    return next;
  }) as typeof window.setTimeout;
  f.dom.window.clearTimeout = (id: number) => { timers.delete(id); };
  for (let completed = 0; completed < 1_000; completed++) {
    f.host.sync.update({ progress: { phase: "downloading", completed, total: 1_000, done: false } });
  }
  assert.equal(renders, 0, "a fast transfer must not rebuild the pane once per file");
  assert.equal(timers.size, 1);
  const [id, callback] = [...timers][0];
  timers.delete(id);
  callback();
  assert.equal(renders, 1);
  f.host.sync.update({ progress: null, message: "Sync complete." });
  assert.equal(renders, 2, "completion is visible immediately");
  f.state.destination = "types";
  f.host.sync.update({ progress: { phase: "downloading", completed: 0, total: 10, done: false } });
  assert.equal(badgeRenders, 0, "transfer-only changes cannot affect tab badges");
  f.state.destination = "sync";
  f.host.sync.update({ progress: { phase: "downloading", completed: 1, total: 10, done: false } });
  assert.equal(timers.size, 1);
  await f.view.onClose();
  assert.equal(timers.size, 0, "closing the view must cancel a queued render");
  f.dom.window.close();
});

test("connected Sync is one status and one primary action; settings live in the settings tab", () => {
  const f = fixture(true);
  f.state.render();
  assert.match(f.text(), /Project notes.*Up to date.*Read and write · Whole vault.*Settings.*Sync now/);
  assert.ok(f.text().split(" ").length < 30, f.text());
  assert.doesNotMatch(f.text(), /hidden-collection-id|Attachments|Disconnect|Hosted authority|checkpoint/);
  assert.equal(f.root.querySelectorAll(".mdbase-sync-actions button").length, 1);
  assert.equal(f.root.querySelector("[data-disclosure='sync-settings']"), null);
  button(f.root, "Open sync settings").click();
  assert.equal(f.settingsOpened(), 1);
  f.dom.window.close();
});

test("recovery states have one next action and never show a stale healthy heading", () => {
  for (const scenario of [
    { patch: { paused: true }, action: "Resume sync", label: "Paused" },
    { patch: { status: { state: "up_to_date", recovery_required: true, conflicts: [], local_issues: [] } }, action: "Resume recovery", label: "Needs attention" },
    { patch: { problem: { code: "stale_mirror_plan", kind: "decision", title: "The collection changed again", message: "Review the newest versions.", action: "review", actionLabel: "Review newest changes" } }, action: "Review newest changes", label: "Needs attention" },
  ]) {
    const f = fixture(true);
    f.host.sync.update(scenario.patch as never);
    f.state.render();
    assert.equal(f.root.querySelectorAll(".mod-cta").length, 1, f.text());
    assert.ok(button(f.root, scenario.action));
    assert.match(f.root.querySelector(".mdbase-sync-heading")!.textContent!, new RegExp(scenario.label));
    assert.doesNotMatch(f.text(), /Up to date|Sync now/);
    f.dom.window.close();
  }
});

test("a stale reviewed plan cannot be applied before refreshing the newest changes", () => {
  const f = fixture(true);
  f.state.mirrorPreview = {
    phase: "incremental", plan: { actions: [{ command: "delete_local" }], issues: [], summary: { blocking_issues: 0 } },
    entries: [{ path: "old.md", direction: "download", action: "delete", detail: "Delete old file" }], collisions: [], local_issues: [],
  };
  f.host.sync.reportProblem(Object.assign(new Error("Plan changed"), { code: "stale_mirror_plan" }));
  f.state.render();
  assert.equal(f.root.querySelectorAll(".mod-cta").length, 1, f.text());
  assert.ok(button(f.root, "Review newest changes"));
  assert.doesNotMatch(f.text(), /Sync 1 change|Refresh review/);
  f.dom.window.close();
});

test("enrollment exposes only essential controls but retains the upload warning and advanced options", () => {
  const f = fixture();
  f.state.render();
  assert.match(f.text(), /Existing notes may upload/);
  assert.doesNotMatch(f.text(), /Connect URL|Collection ID|Attachments|Choose connection|empty vault/);
  assert.ok(f.text().split(" ").length < 65, f.text());
  assert.ok(button(f.root, "Connect"));
  const advanced = f.root.querySelector<HTMLDetailsElement>("[data-disclosure='enrollment-options']")!;
  advanced.open = true;
  f.state.render();
  assert.match(f.text(), /Connect URL.*Collection ID.*Attachments/);
  const access = f.root.querySelector<HTMLSelectElement>("#mdbase-enrollment-access")!;
  access.value = "read_only";
  access.dispatchEvent(new f.dom.window.Event("change"));
  assert.match(f.text(), /Downloads only/);
  assert.doesNotMatch(f.text(), /Existing notes may upload/);
  f.dom.window.close();
});

test("type editing has one save location, optional sections, and an expandable review", () => {
  const f = fixture();
  f.state.destination = "types";
  f.state.schema = { config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() };
  f.state.model = createDefaultTypeModel();
  f.state.model.name = "note";
  f.state.originalModel = structuredClone(f.state.model);
  f.state.selectedPath = "_types/note.md";
  f.state.render();
  assert.doesNotMatch(f.text(), /Stable type|Path glob|Display field|No pending changes|No record contracts/);
  assert.equal(f.root.querySelectorAll(".mdbase-editor-actions button").length, 2, "source and new note actions");
  f.state.dirty = true;
  f.state.model.description = "Edited";
  f.state.render();
  assert.equal(Array.from(f.root.querySelectorAll("button")).filter(b => b.textContent === "Save").length, 1);
  button(f.root, "Review").click();
  assert.ok(f.root.querySelector<HTMLDetailsElement>("[data-disclosure='type-review']")!.open);
  f.state.render();
  assert.ok(f.root.querySelector<HTMLDetailsElement>("[data-disclosure='type-review']")!.open);
  assert.equal(f.root.querySelector(".mdbase-section-nav"), null);
  f.dom.window.close();
});

test("restoring an incomplete design draft opens it without serializing invalid fields", async () => {
  const f = fixture();
  const source = createDefaultTypeModel();
  source.name = "task";
  const model = structuredClone(source);
  model.fields.push({ name: "", definition: { type: "string" } });
  Object.assign(f.host, {
    loadTypeModel: async () => source,
    loadTypeDraft: () => ({ version: 1, sourceRevision: null, model, editorMode: "design" }),
  });
  f.state.destination = "types";
  f.state.schema = { config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() };
  await (f.view as unknown as { types: { selectType(path: string): Promise<void> } }).types.selectType("_types/task.md");
  assert.equal(f.state.dirty, true);
  assert.equal(f.state.model.fields.at(-1)?.name, "");
  assert.match(f.text(), /Recovered unsaved changes/);
  assert.equal(button(f.root, "Save").disabled, true);
  assert.equal(source.fields.length, 1, "saved source was not changed");
  f.dom.window.close();
});

test("restoring an empty YAML draft preserves the unsaved empty text", async () => {
  const f = fixture();
  const source = createDefaultTypeModel();
  source.name = "task";
  Object.assign(f.host, {
    loadTypeModel: async () => source,
    loadTypeDraft: () => ({ version: 1, sourceRevision: null, model: source, editorMode: "yaml", yamlDraft: "" }),
  });
  f.state.destination = "types";
  f.state.schema = { config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() };
  await (f.view as unknown as { types: { selectType(path: string): Promise<void> } }).types.selectType("_types/task.md");
  assert.equal(f.state.dirty, true);
  const editor = f.root.querySelector<HTMLElement>(".mdbase-yaml-editor.cm-editor");
  assert.ok(editor, "YAML mode uses the CodeMirror editor");
  assert.equal(editor.querySelector(".cm-content")!.textContent, "");
  f.dom.window.close();
});

test("empty Issues has no redundant filters, counts, or empty panels", () => {
  const f = fixture();
  f.state.destination = "issues";
  f.state.render();
  assert.equal(f.text(), "Types Sync Issues Validation Not checked yet Validate");
  assert.equal(f.root.querySelector(".mdbase-issue-controls"), null);
  f.dom.window.close();
});

test("blocking review shows the issue without a misleading apply button or duplicate issue section", () => {
  const f = fixture(true);
  const issue = { path: "broken.md", message: "Invalid YAML" };
  f.state.mirrorStatus = { state: "attention", conflicts: [], local_issues: [issue] };
  f.state.mirrorPreview = {
    phase: "incremental", plan: { actions: [], summary: { blocking_issues: 1 } },
    entries: [{ path: "broken.md", direction: "attention", action: "fix", detail: "Invalid YAML" }],
    collisions: [], local_issues: [issue],
  };
  f.state.render();
  assert.equal(f.root.querySelectorAll(".mdbase-sync-actions button").length, 1);
  assert.ok(button(f.root, "Refresh review"));
  assert.equal((f.text().match(/Invalid YAML/g) ?? []).length, 1);
  assert.doesNotMatch(f.text(), /Nothing is blocking|Local files needing attention/);
  f.dom.window.close();
});

test("conflicts reveal resolution actions only after loading the versions", async () => {
  const f = fixture(true);
  f.state.mirrorStatus = { state: "attention", local_issues: [], conflicts: [{
    entity: "record", object_id: "record", decision_id: "decision", path: "note.md", message: "Both versions changed.",
  }] };
  Object.assign(f.host.connectSync, { conflictComparison: async () => ({
    entity: "record", objectId: "record", decisionId: "decision",
    local: { state: "exact", document: "Local version" }, remote: { state: "exact", document: "Hosted version" },
  }) });
  f.state.render();
  assert.doesNotMatch(f.text(), /Keep local|Use hosted|Keep both/);
  button(f.root, "Resolve…").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(f.text(), /Keep local.*Use hosted.*Keep both/);
  assert.match(f.text(), /Local version.*Hosted version/);
  f.dom.window.close();
});

test("the single save bar updates validity while typing without replacing the focused input", async () => {
  const f = fixture();
  f.state.destination = "types";
  f.state.schema = { config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() };
  f.state.model = createDefaultTypeModel();
  f.state.model.name = "note";
  f.state.originalModel = structuredClone(f.state.model);
  f.state.render();
  const input = () => f.root.querySelector<HTMLInputElement>("[data-focus-key='form-name']")!;
  input().value = "";
  input().dispatchEvent(new f.dom.window.Event("input"));
  assert.equal(button(f.root, "Save").disabled, true);
  const focused = input();
  focused.focus();
  focused.value = "task";
  focused.dispatchEvent(new f.dom.window.Event("input"));
  assert.equal(button(f.root, "Save").disabled, false);
  assert.equal(f.root.ownerDocument.activeElement, focused);
  assert.equal(f.root.querySelector(".mdbase-dirty"), null, "do not recreate the removed duplicate badge");
  await f.view.onClose();
  f.dom.window.close();
});

test("missing adoption authorization offers recovery instead of dead Resume/Cancel actions", () => {
  for (const recovery of [
    { canReset: true, canReconnect: false },
    { canReset: false, canReconnect: false },
    { canReset: false, canReconnect: true },
  ]) {
    const f = fixture();
    const checkpoint = { phase: recovery.canReconnect ? "activating" : "uploading", session: {
      controlUrl: "https://connect.example", verificationUri: "https://connect.example/adopt/old",
      expiresAt: "2026-01-01T00:00:00Z", requested: { collectionId: "collection", mirrorName: "Obsidian" },
    } };
    Object.assign(f.host.connectSync, {
      getAdoptionMarker: () => checkpoint,
      getAdoptionRecovery: () => recovery,
    });
    f.state.render();
    assert.ok(button(f.root, recovery.canReset ? "Reset setup" : recovery.canReconnect ? "Reconnect collection" : "Check again"));
    assert.doesNotMatch(f.text(), /Resume upload|Cancel upload|Upload paused/);
    assert.equal(f.root.querySelector(".mdbase-approval-link"), null, "do not send users to the stale approval link");
    if (!recovery.canReset && !recovery.canReconnect) {
      recovery.canReset = true;
      button(f.root, "Check again").click();
      assert.ok(button(f.root, "Reset setup"));
    }
    f.dom.window.close();
  }
});

test("approved moves expose upload progress and keep failures distinct from an intentional pause", async () => {
  const f = fixture();
  const checkpoint = { phase: "uploading", session: {
    controlUrl: "https://connect.example", verificationUri: "https://connect.example/adopt/old",
    requested: { collectionId: "collection", mirrorName: "Obsidian" },
  } };
  let uploading = false;
  Object.assign(f.host.connectSync, {
    getAdoptionMarker: () => checkpoint,
    getAdoptionRecovery: () => null,
    previewAdoption: async () => ({ records: 19, resources: 2, files: 0, conflicts: [["A.md", "a.md"]] }),
    resumeAdoption: async (callbacks: { onProgress(progress: { stage: string; records: number }): void }) => {
      callbacks.onProgress({ stage: "uploading", records: 19 });
      uploading = /Approval received. Uploading 19 notes/.test(f.text());
      throw new Error("Import rejected");
    },
  });
  f.state.render();
  assert.equal(f.root.querySelector(".mdbase-approval-link"), null, "approval already succeeded");
  button(f.root, "Resume upload").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(uploading, true);
  assert.match(f.text(), /Approval received. Upload stopped/);
  assert.doesNotMatch(f.text(), /Upload paused/);
  assert.match(f.text(), /A.md.*a.md/);
  assert.equal(button(f.root, "Resume upload").disabled, true);
  assert.equal(button(f.root, "Check files").disabled, false);
  f.dom.window.close();
});

test("collision renames require a review and explicit confirmation, and never auto-resume upload", async () => {
  const f = fixture();
  let preview = { records: 2, resources: 1, files: 0, conflicts: [["A.md", "a.md"]] };
  const plan = { renames: [{ from: "a.md", to: "a (2).md" }], manual: [], revision: "review" };
  let applied = 0;
  Object.assign(f.host.connectSync, {
    getAdoptionMarker: () => ({ phase: "uploading", session: { controlUrl: "https://connect.example", requested: { collectionId: "collection" } } }),
    getAdoptionRecovery: () => null,
    previewAdoption: async () => preview,
    planAdoptionRenames: async () => plan,
    applyAdoptionRenames: async (review: unknown) => {
      assert.equal(review, plan);
      applied++;
      preview = { ...preview, conflicts: [] };
      return 1;
    },
    resumeAdoption: () => assert.fail("renaming must not start an upload"),
  });
  Object.assign(f.state, { adoptionPreview: preview });
  f.state.render();
  button(f.root, "Review renames…").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(f.text(), /a.md.*→.*a \(2\).md/);
  assert.equal(applied, 0);
  button(f.root, "Cancel").click();
  assert.equal(applied, 0);
  button(f.root, "Review renames…").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  button(f.root, "Rename 1 file").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(applied, 1);
  assert.match(f.text(), /Renamed 1 file/);
  assert.equal(button(f.root, "Resume upload").disabled, false);
  f.dom.window.close();
});

test("new live-file collisions do not block reconciling an already frozen snapshot", () => {
  const f = fixture();
  Object.assign(f.host.connectSync, {
    getAdoptionMarker: () => ({ phase: "activating", session: { controlUrl: "https://connect.example", requested: { collectionId: "collection" } } }),
    getAdoptionRecovery: () => null,
  });
  Object.assign(f.state, { adoptionPreview: { records: 2, files: 0, conflicts: [["A.md", "a.md"]] } });
  f.state.render();
  assert.match(f.text(), /Activation outcome is pending/);
  assert.equal(button(f.root, "Resume upload").disabled, false);
  assert.doesNotMatch(f.text(), /Review renames/);
  f.dom.window.close();
});

test("status notices can be dismissed without changing connection state", () => {
  const f = fixture(true);
  f.state.transientMessage = "Sync complete.";
  f.state.render();
  button(f.root, "Dismiss message").click();
  assert.doesNotMatch(f.text(), /Sync complete/);
  assert.match(f.text(), /Project notes/);
  f.dom.window.close();
});

const typeConfig = {
  spec_version: "0.3.0",
  settings: { types_folder: "_types", explicit_type_keys: ["type"], default_strict: false, include_subfolders: true, exclude: [] },
};

function taskSource() {
  const model = createDefaultTypeModel();
  model.name = "task";
  model.matchPathGlob = "tasks/**";
  model.fields = [
    { name: "title", definition: { type: "string", required: true } },
    { name: "priority", definition: { type: "integer", max: 3 } },
    { name: "status", definition: { type: "enum", values: [1, 2, "done, later"] } },
  ];
  return model;
}

/** A Types fixture with real type definitions, records, and persisted drafts. */
function typesFixture() {
  const f = fixture();
  const task = taskSource();
  const note = createDefaultTypeModel();
  note.name = "note";
  note.matchPathGlob = "notes/**";
  const sources: Record<string, ReturnType<typeof createDefaultTypeModel>> = {
    "_types/task.md": task,
    "_types/note.md": note,
  };
  const drafts = new Map<string, unknown>();
  const records = [
    { path: "tasks/a.md", frontmatter: { title: "A", priority: 1 } },
    { path: "tasks/b.md", frontmatter: { title: "B", priority: 2 } },
    { path: "notes/c.md", frontmatter: { title: "C" } },
  ];
  Object.assign(f.host, {
    loadTypeModel: async (path: string) => structuredClone(sources[path]),
    loadTypeDraft: (path: string | null) => structuredClone(drafts.get(path ?? "__new__") ?? null),
    saveTypeDraft: async (draft: { path: string | null }) => { drafts.set(draft.path ?? "__new__", structuredClone(draft)); },
    clearTypeDraft: async (path: string | null) => { drafts.delete(path ?? "__new__"); },
    loadCollectionRecords: async () => records,
  });
  f.state.destination = "types";
  f.state.schema = {
    config: typeConfig,
    types: new Map([
      ["task", typeDefFromDraft(task, "_types/task.md")],
      ["note", typeDefFromDraft(note, "_types/note.md")],
    ]),
    contracts: new Map(),
  };
  const inner = f.view as unknown as {
    types: { selectType(path: string): Promise<void> };
    openTypeField(path: string, field?: string): Promise<void>;
    onClose(): Promise<void>;
    records: unknown;
  };
  inner.records = records;
  const view = {
    selectType: (path: string) => inner.types.selectType(path),
    openTypeField: (path: string, field?: string) => inner.openTypeField(path, field),
    onClose: () => inner.onClose(),
  };
  return { ...f, drafts, records, view };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function fieldNode(root: HTMLElement, name: string): HTMLDetailsElement {
  const node = Array.from(root.querySelectorAll<HTMLDetailsElement>(".mdbase-field-node"))
    .find((candidate) => candidate.querySelector(".mdbase-field-summary-name")?.textContent === name);
  assert.ok(node, `Missing field ${name}`);
  return node;
}

test("the type list shows note and issue counts, and field rows show their constraints", async () => {
  const f = typesFixture();
  f.host.getIssues = () => [{ path: "tasks/a.md", severity: "error", code: "schema_required", message: "", type: "task" }] as never;
  await f.view.selectType("_types/task.md");
  const rows = Array.from(f.root.querySelectorAll(".mdbase-type-row")).map((row) => visibleText(row));
  assert.deepEqual(rows, ["note 1 note", "task 2 notes 1 issue"]);
  assert.match(visibleText(fieldNode(f.root, "priority").querySelector("summary")!), /priority Integer ≤ 3/);
  assert.match(visibleText(fieldNode(f.root, "status").querySelector("summary")!), /status Enum 1, 2, done, later/);
  f.dom.window.close();
});

test("matching previews the notes a type matches, and the review lists notes a draft would break", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  await settle();
  assert.match(visibleText(f.root.querySelector("[data-disclosure='type-matching'] > summary")!), /Matching · 2 notes/);
  const max = f.root.querySelector<HTMLInputElement>("[aria-label='priority maximum']")!;
  max.value = "1";
  max.dispatchEvent(new f.dom.window.Event("input"));
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  assert.match(visibleText(f.root.querySelector(".mdbase-draft-summary")!), /1 note would fail/);
  button(f.root, "Review").click();
  assert.match(visibleText(f.root.querySelector(".mdbase-impact")!), /1 note would fail.*tasks\/b\.md.*'priority' is 2; must be at most 1/);
  await f.view.onClose();
  f.dom.window.close();
});

test("editing one enum value keeps the others' types and allows commas", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  fieldNode(f.root, "status").open = true;
  f.state.render();
  const input = f.root.querySelector<HTMLInputElement>("[aria-label='status allowed value 1']")!;
  input.value = "3";
  input.dispatchEvent(new f.dom.window.Event("input"));
  assert.deepEqual(f.state.model.fields[2].definition.values, [3, 2, "done, later"]);
  button(f.root, "Add value").click();
  assert.deepEqual(f.state.model.fields[2].definition.values, [3, 2, "done, later", ""]);
  await f.view.onClose();
  f.dom.window.close();
});

test("fields reorder from their action menu", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  fieldNode(f.root, "title").open = true;
  f.state.render();
  button(f.root, "title actions").click();
  const menu = (Menu as unknown as { last: { items: Array<{ title: string; disabled: boolean; click(): void }> } }).last;
  assert.deepEqual(menu.items.map((item) => [item.title, item.disabled]), [["Move up", true], ["Move down", false], ["Remove field", false]]);
  menu.items[1].click();
  assert.deepEqual(f.state.model.fields.map((field) => field.name), ["priority", "title", "status"]);
  assert.match(visibleText(f.root.querySelector(".mdbase-draft-bar")!), /Unsaved changes/);
  await f.view.onClose();
  f.dom.window.close();
});

test("switching types keeps unsaved work as a draft and marks it in the list", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  const name = f.root.querySelector<HTMLInputElement>("[data-focus-key='form-description']")!;
  name.value = "Edited";
  name.dispatchEvent(new f.dom.window.Event("input"));
  await f.view.selectType("_types/note.md");
  assert.equal(f.state.selectedPath, "_types/note.md", "switching is not blocked");
  assert.ok(f.drafts.has("_types/task.md"));
  const taskRow = Array.from(f.root.querySelectorAll(".mdbase-type-row")).find((row) => row.textContent?.startsWith("task"))!;
  assert.ok(taskRow.querySelector("[aria-label='Unsaved changes']"));
  await f.view.selectType("_types/task.md");
  assert.equal(f.state.model.description, "Edited");
  assert.equal(f.state.dirty, true);
  assert.doesNotMatch(f.text(), /Recovered unsaved changes/, "restoring this session's draft is not a recovery");
  await f.view.onClose();
  f.dom.window.close();
});

test("Issues grouped by rule offer one bulk fix and jump to the rule's field", async () => {
  const f = typesFixture();
  const issues = ["tasks/a.md", "tasks/b.md"].map((path) => ({
    path, severity: "error", code: "schema_required", field: "title", type: "task",
    message: "Missing required field 'title'", details: { technical_message: "JSON Schema required failed" },
  }));
  let fixed: unknown[] = [];
  Object.assign(f.host, {
    getIssues: () => issues,
    getQuickFixLabel: () => "Add placeholder",
    applyQuickFixes: async (selected: unknown[]) => { fixed = selected; return { changed: selected.length, skipped: 0 }; },
  });
  f.state.destination = "issues";
  f.state.render();
  const groupBy = f.root.querySelector<HTMLSelectElement>("[aria-label='Group issues']")!;
  groupBy.value = "rule";
  groupBy.dispatchEvent(new f.dom.window.Event("change"));
  assert.match(f.text(), /task · title · missing 2 notes/);
  assert.ok(button(f.root, "Add placeholder · 2 notes"));
  assert.equal(f.root.querySelector(".mdbase-issue-row")!.getAttribute("title"), "schema_required: JSON Schema required failed");
  button(f.root, "Edit title in task").click();
  await settle();
  assert.equal(f.state.destination, "types");
  assert.equal(f.state.selectedPath, "_types/task.md");
  assert.ok(fieldNode(f.root, "title").open, "the rule's field is expanded");
  assert.deepEqual(fixed, []);
  await f.view.onClose();
  f.dom.window.close();
});

test("pending record updates can be compared before syncing", async () => {
  const f = fixture(true);
  Object.assign(f.state, { mirrorStatus: { state: "changes_waiting", conflicts: [], local_issues: [] } });
  (f.view as unknown as { app: { vault: { getAbstractFileByPath(path: string): unknown } } }).app.vault.getAbstractFileByPath = () => ({});
  Object.assign(f.host.connectSync, { recordComparison: async () => ({
    entity: "record", objectId: "r1", decisionId: "",
    local: { state: "exact", document: "Local line" }, remote: { state: "exact", document: "Hosted line" },
  }) });
  f.state.mirrorPreview = {
    phase: "incremental", plan: { actions: [{}], issues: [], summary: { blocking_issues: 0 } },
    entries: [{ kind: "document", path: "Tasks/Plan.md", direction: "download", action: "update", detail: "Hosted record will write.", recordId: "r1" }],
    collisions: [], local_issues: [],
  };
  f.state.render();
  button(f.root, "Compare").click();
  await settle();
  assert.match(f.text(), /Local line.*Hosted line/);
  assert.ok(button(f.root, "Hide"));
  f.dom.window.close();
});

test("collapsed history does not construct hidden transfer ledgers", () => {
  const f = fixture(true);
  const at = new Date().toISOString();
  f.historyRuns.push(...Array.from({ length: 20 }, (_, index) => ({
    id: `large-${index}`, collectionId: "hidden-collection-id", startedAt: at, finishedAt: at, outcome: "applied",
    files: Array.from({ length: 250 }, (_, file) => ({ path: `${index}/${file}.md`, kind: "document" as const,
      direction: "download" as const, action: "create" as const, status: "completed" as const, at })),
  })));
  f.state.render();
  assert.equal(f.root.querySelectorAll(".mdbase-history-run").length, 0, "closed History needs only its heading");
  const history = f.root.querySelector<HTMLDetailsElement>("[data-disclosure='sync-activity']")!;
  history.open = true;
  history.dispatchEvent(new f.dom.window.Event("toggle"));
  assert.equal(f.root.querySelectorAll(".mdbase-history-run").length, 10);
  assert.equal(f.root.querySelectorAll(".mdbase-history-files .mdbase-transfer-row").length, 0,
    "closed runs need only summaries, not 2,500 hidden rows");
  const run = f.root.querySelector<HTMLDetailsElement>("[data-disclosure='history-run-large-0']")!;
  run.open = true;
  run.dispatchEvent(new f.dom.window.Event("toggle"));
  assert.equal(f.root.querySelectorAll(".mdbase-history-files .mdbase-transfer-row").length, 250);
  f.dom.window.close();
});

test("sync history lists runs, expands to their files and filters by path", () => {
  const f = fixture(true);
  const at = new Date().toISOString();
  f.historyRuns.push({
    id: "run-1", collectionId: "hidden-collection-id", startedAt: at, finishedAt: at, outcome: "applied",
    files: [
      { path: "Tasks/Plan.md", kind: "document", direction: "download", action: "update", status: "completed", at },
      { path: "Archive/Review.md", fromPath: "Tasks/Review.md", kind: "document", direction: "download", action: "rename", status: "completed", at },
      { path: "Notes/Ideas.md", kind: "document", direction: "upload", action: "create", status: "completed", at },
    ],
  });
  f.state.render();
  assert.match(f.text(), /History/);
  assert.doesNotMatch(f.text(), /2 downloaded/, "history starts collapsed");
  f.root.querySelector<HTMLDetailsElement>("[data-disclosure='sync-activity']")!.open = true;
  f.state.render();
  assert.match(f.text(), /2 downloaded · 1 uploaded.*Today/);
  assert.doesNotMatch(f.text(), /Tasks\/Plan\.md/, "runs start collapsed");
  f.root.querySelector<HTMLDetailsElement>("[data-disclosure='history-run-run-1']")!.open = true;
  f.state.render();
  assert.match(f.text(), /update Tasks\/Plan\.md.*rename Archive\/Review\.md From Tasks\/Review\.md.*create Notes\/Ideas\.md/);
  const search = f.root.querySelector<HTMLInputElement>("[data-focus-key='history-search']")!;
  search.value = "ideas";
  search.dispatchEvent(new f.dom.window.Event("input"));
  assert.match(f.text(), /Notes\/Ideas\.md/);
  assert.doesNotMatch(f.text(), /Tasks\/Plan\.md/);
  search.value = "missing";
  search.dispatchEvent(new f.dom.window.Event("input"));
  assert.match(f.text(), /No synced files match/);
  f.dom.window.close();
});

test("expanding a field adds a collapse action without inserting a filter above the list", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  assert.equal(f.root.querySelector("[data-focus-key='field-search']"), null);
  fieldNode(f.root, "title").open = true;
  fieldNode(f.root, "title").dispatchEvent(new f.dom.window.Event("toggle"));
  f.state.render();
  assert.equal(f.root.querySelector("[data-focus-key='field-search']"), null, "short lists never show a filter");
  button(f.root, "Collapse all fields").click();
  assert.equal(fieldNode(f.root, "title").open, false);
  // A keyboard-activated menu (click detail 0) opens beside its button.
  fieldNode(f.root, "title").open = true;
  f.state.render();
  button(f.root, "title actions").click();
  assert.ok((Menu as unknown as { last: { position?: unknown } }).last.position);
  await f.view.onClose();
  f.dom.window.close();
});

test("enrollment names the device after the vault so Connect can tell devices apart", () => {
  const f = fixture();
  f.state.render();
  const device = Array.from(f.root.querySelectorAll<HTMLInputElement>("input")).find((input) => input.value.startsWith("Notes"));
  assert.equal(device?.value, "Notes · Obsidian");
  f.dom.window.close();
});

test("first run asks one question: start a collection here, or copy one from Connect", () => {
  const f = fixture();
  f.state.destination = "types";
  f.state.render();
  assert.match(f.text(), /Set up mdbase.*Start a collection.*This vault holds the collection.*Copy from Connect.*Connect holds the collection/);
  assert.ok(button(f.root, "Start a collection").classList.contains("mod-cta"));
  button(f.root, "Copy from Connect").click();
  assert.equal(f.state.destination, "sync");
  assert.match(f.text(), /Copy a collection from Connect/);
  f.dom.window.close();
});

test("a plan held for review says why, offers to apply it, and badges the Sync tab", () => {
  const f = fixture(true);
  const target = { entity: "record", identity: "r1", path: "Old.md", revision: "x", payload_revision: "x" };
  f.state.mirrorPreview = {
    phase: "rebuild",
    plan: { kind: "rebuild", actions: [{ command: "delete_local", target }], issues: [], summary: { blocking_issues: 0 } },
    entries: [{ kind: "document", path: "Old.md", direction: "download", action: "delete", detail: "Hosted record will delete." }],
    collisions: [], local_issues: [],
  };
  f.state.render();
  assert.match(f.text(), /Review needed: mirror rebuild/);
  assert.ok(button(f.root, "Sync 1 change").classList.contains("mod-cta"));
  assert.equal(f.root.querySelector(".mdbase-nav-button.is-active .mdbase-count")?.textContent, "1");
  f.dom.window.close();
});

test("the transfer ledger exposes all reviewed items and filters never change approval scope", () => {
  const f = fixture(true);
  const entries = Array.from({ length: 601 }, (_, index) => ({ path: `Notes/${index}.md`, direction: "download", action: index === 600 ? "delete" : "update", detail: "Reviewed exact bytes" }));
  const plan = { actions: entries, issues: [], summary: { blocking_issues: 0 } };
  f.state.mirrorPreview = { phase: "incremental", plan, entries, collisions: [], local_issues: [] };
  f.state.render();
  assert.equal(f.root.querySelectorAll(".mdbase-transfer-row").length, 250);
  button(f.root, "Next downloads").click();
  assert.equal(f.root.querySelectorAll(".mdbase-transfer-row").length, 250);
  assert.match(f.text(), /Showing 251–500 of 601/);
  button(f.root, "Next downloads").click();
  assert.equal(f.root.querySelectorAll(".mdbase-transfer-row").length, 101);
  assert.equal(button(f.root, "Next downloads").disabled, true);
  button(f.root, "Previous downloads").click();
  assert.equal(f.root.querySelectorAll(".mdbase-transfer-row").length, 250);
  const filter = f.root.querySelector<HTMLSelectElement>("select[aria-label='Filter transfers']")!;
  filter.value = "delete"; filter.dispatchEvent(new f.dom.window.Event("change"));
  assert.equal(f.root.querySelectorAll(".mdbase-transfer-row").length, 1);
  assert.match(f.text(), /Notes\/600.md/);
  assert.match(f.text(), /entire reviewed plan/);
  assert.equal(plan.actions.length, 601);
  f.dom.window.close();
});

test("an untouched stale draft survives leaving the type, and is offered recovery actions", async () => {
  const f = fixture();
  const source = createDefaultTypeModel(); source.name = "task"; source.sourceRevision = "new";
  const old = { version: 1, path: "_types/task.md", sourceRevision: "old", model: structuredClone(source), updatedAt: new Date().toISOString() };
  let cleared = false;
  Object.assign(f.host, { loadTypeModel: async () => source, loadTypeDraft: () => old, clearTypeDraft: async () => { cleared = true; } });
  f.state.destination = "types";
  f.state.schema = { config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() };
  await (f.view.types as unknown as { selectType(path: string): Promise<void> }).selectType("_types/task.md");
  assert.equal(f.state.dirty, false);
  assert.ok(button(f.root, "Compare draft")); assert.ok(button(f.root, "Export draft")); assert.ok(button(f.root, "Discard old draft"));
  await (f.view.types as unknown as { flushTypeDraft(): Promise<void> }).flushTypeDraft();
  assert.equal(cleared, false);
  f.dom.window.close();
});

test("validation freshness and cancellation remain visible without issue rows", () => {
  const f = fixture(); f.state.destination = "issues";
  Object.assign(f.host, { getValidationSummary: () => "Checking 25 of 100 notes…", isValidating: () => true });
  f.state.render();
  assert.match(f.text(), /Checking 25 of 100/);
  assert.equal(button(f.root, "Validate").disabled, true);
  assert.ok(button(f.root, "Stop validation"));
  f.dom.window.close();
});

test("empty collections offer contract packs rather than invented starter types", () => {
  const f = fixture(); f.state.destination = "types";
  f.state.schema = { config: { spec_version: "0.3.0" }, types: new Map(), contracts: new Map() };
  f.state.render();
  assert.match(f.text(), /mdbase-contracts/);
  assert.ok(button(f.root, "Browse ready-made types"));
  assert.ok(button(f.root, "Design a custom type"));
  f.dom.window.close();
});

test("native-style creation modal retains inputs across errors and preserves boolean and enum types", async () => {
  const f = fixture();
  const config = { spec_version: "0.3.0", settings: { types_folder: "_types", explicit_type_keys: ["type"], exclude: [] } };
  const type = { name: "sample", filePath: "_types/sample.md", fields: {
    title: { type: "string", required: true }, count: { type: "integer", required: true },
    active: { type: "boolean", required: true }, status: { type: "enum", values: [10, "done"], required: true },
  } };
  let created: Record<string, unknown> | null = null;
  const modal = new CreateTypedNoteModal({ vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] } } as never,
    type, config, new Map([["sample", type]]), async (_path, data) => { created = data; });
  modal.open();
  const root = modal.contentEl;
  const set = (id: string, value: string) => {
    const el = root.querySelector<HTMLInputElement>(`#${id}`)!; el.value = value;
    el.dispatchEvent(new f.dom.window.Event("input"));
  };
  set("mdbase-note-title", "Keep this text"); set("mdbase-note-count", "12abc");
  set("mdbase-note-active", "1"); set("mdbase-note-status", "0");
  button(root, "Create note").click();
  assert.match(root.textContent ?? "", /whole integer/);
  assert.equal(root.querySelector<HTMLInputElement>("#mdbase-note-title")!.value, "Keep this text");
  assert.equal(created, null);
  set("mdbase-note-count", "12");
  await new Promise<void>(resolve => setImmediate(resolve));
  set("mdbase-note-location", "created.md");
  button(root, "Create note").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(created, { type: "sample", title: "Keep this text", count: 12, active: false, status: 10 });
  assert.equal(modal.containerEl.parentNode, null);
  f.dom.window.close();
});

test("restoring a selected path replaces the initially opened type model", async () => {
  const f = fixture();
  const one = createDefaultTypeModel(); one.name = "one";
  const two = createDefaultTypeModel(); two.name = "two";
  const schema = { config: { spec_version: "0.3.0", settings: { explicit_type_keys: ["type"], types_folder: "_types", exclude: [] } },
    types: new Map([["one", typeDefFromDraft(one, "_types/one.md")], ["two", typeDefFromDraft(two, "_types/two.md")]]), contracts: new Map() };
  f.state.model = one; f.state.originalModel = structuredClone(one); f.state.selectedPath = "_types/one.md"; f.state.schema = schema;
  Object.assign(f.host, { loadWorkspaceSchema: async () => schema, loadTypeModel: async () => structuredClone(two) });
  await f.view.setState({ selectedPath: "_types/two.md", destination: "types" }, {} as never);
  assert.equal(f.state.selectedPath, "_types/two.md");
  assert.equal(f.state.model.name, "two");
  await f.view.onClose();
  f.dom.window.close();
});
