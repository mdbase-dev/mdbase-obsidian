import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createLinkedNote, CreateTypedNoteModal } from "../src/createTypedNoteModal";
import { MdbaseWorkspaceView } from "../src/workspaceView";
import { createDefaultTypeModel } from "../src/typeModel";
import { typeDefFromDraft } from "../src/typeImpact";
import { AbstractInputSuggest as RealInputSuggest, Menu } from "obsidian";
import { MdbaseSettingTab } from "../src/settingsTab";
import type { SyncSnapshot } from "../src/sync/controller";
import type { CollectionStatus } from "../src/sync/daemon";
import { manageAppsUrl } from "../src/workspace/syncPane";
import { summarize } from "../src/sync/words";

type TypeModel = ReturnType<typeof createDefaultTypeModel>;
/** The test double records each suggester attached to an input. */
const AbstractInputSuggest = RealInputSuggest as unknown as { instances: unknown[] };

test("settings search definitions share the legacy renderer's labels and controls", async () => {
  const fixtureState = fixture();
  let saves = 0;
  const plugin = {
    register: () => {},
    settings: { validateOnOpen: true, validateOnSave: true, showNoticeOnSave: false, interopEnabled: false, linkSuggestions: true, mdbaseAppPath: "" },
    syncController: fixtureState.sync.controller,
    saveSettings: async () => { saves++; },
    openWorkspace: async () => {},
  };
  const tab = new MdbaseSettingTab(fixtureState.view.app, plugin as never);
  const definitions = tab.getSettingDefinitions();
  assert.equal(tab.containerEl.children.length, 0);
  assert.deepEqual(definitions.filter(definition => "name" in definition).map(definition => definition.name), [
    "Validate notes automatically", "Show validation notices", "Suggest links when typing @", "Allow plugin integrations",
  ]);
  const group = definitions.find(definition => "items" in definition);
  assert.ok(group && "items" in group);
  assert.equal(group.heading, "Sync");
  assert.ok(group.items.some(item => item.name === "mdbase app location"));
  tab.display();
  assert.match(tab.containerEl.textContent ?? "", /Validate notes automatically/);
  const toggle = tab.containerEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(toggle);
  toggle.checked = false;
  toggle.dispatchEvent(new fixtureState.dom.window.Event("change"));
  await Promise.resolve();
  assert.equal(plugin.settings.validateOnOpen, false);
  assert.equal(plugin.settings.validateOnSave, false);
  assert.equal(saves, 1);
  const notices = tab.getSettingDefinitions().find(definition => "name" in definition && definition.name === "Show validation notices");
  assert.ok(notices && typeof notices.visible === "function");
  assert.equal(notices.visible(), false);
  assert.doesNotMatch(tab.containerEl.textContent ?? "", /Show validation notices/);
  tab.hide();
  fixtureState.dom.window.close();
});

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
  const sync = fakeSync(connected ? syncedSnapshot() : signedInSnapshot());
  let settingsOpened = 0;
  const host = {
    syncController: sync.controller,
    legacyConnect: () => null as { name: string; collectionId: string } | null,
    vaultTopLevelEntries: () => ["Notes.md"],
    getIssues: () => [] as Array<{ path: string; severity: string; code: string; message: string }>,
    saveTypeDraft: async () => undefined,
    loadTypeDraft: () => null,
    clearTypeDraft: async () => undefined,
    getArchivedTypeDrafts: () => [] as import("../src/typeEditorTypes").StoredTypeDraft[],
    discardArchivedTypeDraft: async () => undefined,
    createNoteFromType: async () => undefined,
    openContractCatalog: async () => undefined,
    getValidationSummary: () => "Not checked yet",
    isValidationUntouched: () => true,
    isValidating: () => false,
    cancelValidation: () => undefined,
    loadCollectionRecords: async () => [] as Array<{ path: string; frontmatter: Record<string, unknown> }>,
    getQuickFixLabel: () => null as string | null,
    getCreateLinkLabel: () => null as string | null,
    openSettings: () => { settingsOpened++; },
  };
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
  };
  state.destination = "sync";
  const text = () => visibleText(root);
  return { dom, root, host, sync, state, text, view, settingsOpened: () => settingsOpened };
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

function collectionStatus(overrides: Partial<CollectionStatus> = {}): CollectionStatus {
  return {
    id: "0b6f1c1e-6f77-4a4b-9a57-7f2a1d1f0c11", name: "Project notes", root: "/vaults/notes", mode: "synced", state: "ready", log: "hosted",
    sync: { confirmed_through: 4, head_known: 4, pending: 0, holds: 0, unresolved: 0, connection: "online" }, notices: [], ...overrides,
  };
}

function baseSnapshot(): SyncSnapshot {
  return {
    daemon: "running", error: null, collection: null, prefix: "", live: null, link: "off", holds: [], approvals: [], merged: [], signingIn: null, busy: null,
    status: { account: { signed_in: false, online: true }, collections: [] },
  };
}

function signedInSnapshot(): SyncSnapshot {
  const s = baseSnapshot();
  s.status = { account: { signed_in: true, online: true, computer_name: "Laptop" }, collections: [] };
  return s;
}

function syncedSnapshot(overrides: Partial<CollectionStatus> = {}): SyncSnapshot {
  const s = signedInSnapshot();
  s.collection = collectionStatus(overrides);
  s.status!.collections = [s.collection];
  s.link = "open";
  return s;
}

/** A controller double: the pane only reads `snapshot` and calls actions. */
function fakeSync(initial: SyncSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return name === "join" ? "" : undefined; };
  const controller = {
    get snapshot() { return snapshot; },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: async () => undefined,
    startApp: record("startApp"), signIn: record("signIn"), signOut: record("signOut"), setUp: record("setUp"), join: record("join"),
    resolve: record("resolve"), dismissMerged: record("dismissMerged"), useOtherValue: record("useOtherValue"), approve: record("approve"), reject: record("reject"), linkAgain: record("linkAgain"), disconnect: record("disconnect"),
    restartNative: record("restartNative"), startOver: record("startOver"),
    cancelSignIn: () => { calls.push(["cancelSignIn"]); },
  };
  return {
    controller, calls,
    set(next: Partial<SyncSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
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

test("the workspace opens on Sync, the first tab", () => {
  const f = fixture(true);
  assert.equal(f.state.destination, "sync");
  f.state.render();
  const tabs = Array.from(f.root.querySelectorAll<HTMLButtonElement>("[role='tab']"));
  assert.deepEqual(tabs.map((tab) => tab.textContent?.trim()), ["Sync", "Types", "Issues"]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  f.dom.window.close();
});

test("destination tabs expose a labelled panel and native roving keyboard navigation", async () => {
  const f = fixture(true);
  f.state.destination = "issues";
  f.state.render();
  const selected = () => f.root.querySelector<HTMLButtonElement>("[role='tab'][aria-selected='true']")!;
  assert.equal(f.root.querySelectorAll("[role='tab'][tabindex='0']").length, 1);
  assert.equal(f.root.querySelectorAll("[role='tab'][tabindex='-1']").length, 2);
  const panel = f.root.querySelector("[role='tabpanel']")!;
  assert.ok(panel);
  assert.equal(panel.getAttribute("aria-labelledby"), selected().id);
  assert.equal(selected().getAttribute("aria-controls"), panel.id);
  selected().focus();
  for (const [key, destination] of [["ArrowRight", "sync"], ["ArrowLeft", "issues"], ["Home", "sync"], ["End", "issues"], ["ArrowLeft", "types"]]) {
    const event = new f.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    selected().dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.state.destination, destination);
    assert.equal(f.dom.window.document.activeElement, selected());
    assert.equal(selected().tabIndex, 0);
  }
  await settle();
  f.dom.window.close();
});

test("destination tabs leave modified or already handled keys to Obsidian", () => {
  const f = fixture(true);
  f.state.render();
  const tab = f.root.querySelector<HTMLButtonElement>("[data-focus-key='destination-sync']")!;
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
    const event = new f.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", [modifier]: true, bubbles: true, cancelable: true });
    tab.dispatchEvent(event);
    assert.equal(f.state.destination, "sync");
    assert.equal(event.defaultPrevented, false);
  }
  const handled = new f.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  handled.preventDefault();
  tab.dispatchEvent(handled);
  assert.equal(f.state.destination, "sync");
  f.dom.window.close();
});

test("empty Issues has no redundant filters, counts, or empty panels", () => {
  const f = fixture();
  f.state.destination = "issues";
  f.state.render();
  assert.equal(f.text(), "Sync Types Issues Validation Not checked yet Validate");
  assert.equal(f.root.querySelector(".mdbase-issue-controls"), null);
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
    create: () => (inner.types as unknown as { createType(): Promise<void> }).createType(),
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
  const rows = Array.from(f.root.querySelectorAll(".mdbase-type-row")).map((row) =>
    [row.querySelector(".mdbase-type-name")?.textContent, ...Array.from(row.querySelectorAll(".tree-item-flair")).map((flair) => flair.getAttribute("aria-label"))].join(" "));
  assert.deepEqual(rows, ["note 1 note", "task 1 error 2 notes"]);
  const taskRow = Array.from(f.root.querySelectorAll<HTMLElement>(".mdbase-type-row")).find((row) => row.textContent?.includes("task"))!;
  assert.match(visibleText(taskRow), /task 1 2 notes/, "the note count says what it counts");
  assert.equal(taskRow.querySelector(".mdbase-type-issues")?.getAttribute("data-severity"), "error", "errors take the Issues tab's error colour");
  assert.match(visibleText(fieldNode(f.root, "priority").querySelector("summary")!), /priority Integer At most 3/);
  assert.match(visibleText(fieldNode(f.root, "status").querySelector("summary")!), /status Choice 1, 2, done, later/);
  f.dom.window.close();
});

test("a field with a fixed value shows the value, and field boxes have visible labels", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  f.state.model.fields.push({ name: "kind", definition: { const: "task" } });
  f.state.render();
  const kind = fieldNode(f.root, "kind");
  assert.match(visibleText(kind.querySelector("summary")!), /kind Fixed value Always task/);
  assert.doesNotMatch(visibleText(kind.querySelector("summary")!), /Any value/);
  kind.open = true;
  const labels = Array.from(kind.querySelectorAll<HTMLLabelElement>(".mdbase-field-cell > label")).map((label) => label.textContent);
  assert.deepEqual(labels, ["Name", "Type", "Description"]);
  for (const label of kind.querySelectorAll<HTMLLabelElement>(".mdbase-field-cell > label")) {
    assert.ok(kind.querySelector(`#${label.htmlFor}`), `${label.textContent} labels its box`);
  }
  f.dom.window.close();
});

test("the editor header says when there are unsaved changes", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  assert.equal(f.root.querySelector(".mdbase-editor-dirty"), null);
  const description = f.root.querySelector<HTMLTextAreaElement>("[data-focus-key='form-description']")!;
  description.value = "Edited";
  description.dispatchEvent(new f.dom.window.Event("input"));
  assert.match(visibleText(f.root.querySelector(".mdbase-editor-header")!), /task Unsaved changes/);
  await f.view.onClose();
  f.dom.window.close();
});

test("a new type starts in Name and holds the missing-name error until Name loses focus", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  await (f.view as unknown as { create(): Promise<void> }).create();
  const name = f.root.querySelector<HTMLInputElement>("[data-focus-key='form-name']")!;
  assert.equal(f.root.ownerDocument.activeElement, name, "focus is in Name");
  assert.doesNotMatch(f.text(), /error|name is required|Give the type a name/i);
  name.dispatchEvent(new f.dom.window.Event("blur"));
  assert.match(visibleText(f.root.querySelector(".mdbase-draft-bar")!), /1 error/);
  assert.match(f.text(), /Give the type a name/);
  assert.equal(button(f.root, "Save").disabled, true);
  await f.view.onClose();
  f.dom.window.close();
});

test("Discard asks first, names what would be lost, and can be cancelled", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  const description = f.root.querySelector<HTMLTextAreaElement>("[data-focus-key='form-description']")!;
  description.value = "Edited";
  description.dispatchEvent(new f.dom.window.Event("input"));
  const body = f.root.ownerDocument.body;
  button(f.root, "Discard").click();
  assert.match(body.textContent ?? "", /Discard changes to task\?/);
  assert.match(body.textContent ?? "", /_types\/task\.md goes back to how it was last saved/);
  assert.ok(body.querySelector(".mdbase-confirm-change-list li"), "the changes are listed");
  button(body, "Keep editing").click();
  await settle();
  assert.equal(f.state.dirty, true);
  assert.equal(f.state.model.description, "Edited");
  button(f.root, "Discard").click();
  button(body, "Discard changes").click();
  await settle();
  assert.equal(f.state.dirty, false);
  assert.equal(f.state.model.description, "");
  await f.view.onClose();
  f.dom.window.close();
});

test("YAML opens at its top; Design keeps its own scroll position", async () => {
  const f = typesFixture();
  await f.view.selectType("_types/task.md");
  const documentEl = () => f.root.querySelector<HTMLElement>(".mdbase-editor-document")!;
  assert.equal(documentEl().getAttribute("data-scroll-key"), "type-document-design");
  documentEl().scrollTop = 400;
  button(f.root, "YAML").click();
  assert.equal(documentEl().getAttribute("data-scroll-key"), "type-document-yaml");
  assert.equal(documentEl().scrollTop, 0);
  button(f.root, "Design").click();
  assert.equal(documentEl().getAttribute("data-scroll-key"), "type-document-design");
  assert.equal(documentEl().scrollTop, 400);
  await f.view.onClose();
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
  assert.match(f.text(), /task · title · missing/);
  assert.equal(f.root.querySelector(".mdbase-issue-file-count")!.getAttribute("aria-label"), "2 notes");
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

test("popout inputs retain their selection even when DOM constructors belong to another window", () => {
  const popout = fixture(true);
  // A second realm represents the main window where the plugin module executes.
  const main = fixture();
  popout.host.getIssues = () => [{ path: "notes.md", severity: "error", code: "required", message: "Missing title" }];
  popout.state.destination = "issues";
  popout.state.render();
  let search = popout.root.querySelector<HTMLInputElement>("[data-focus-key='issue-search']")!;
  search.value = "notes";
  search.dispatchEvent(new popout.dom.window.Event("input"));
  search = popout.root.querySelector<HTMLInputElement>("[data-focus-key='issue-search']")!;
  search.focus();
  search.setSelectionRange(1, 3);
  popout.state.render();
  const restored = popout.root.querySelector<HTMLInputElement>("[data-focus-key='issue-search']")!;
  assert.equal(popout.dom.window.document.activeElement, restored);
  assert.equal(restored.selectionStart, 1);
  assert.equal(restored.selectionEnd, 3);
  popout.dom.window.close();
  main.dom.window.close();
});

test("moving an existing workspace input to a popout preserves its first redraw selection", () => {
  const original = fixture(true);
  original.host.getIssues = () => [{ path: "notes.md", severity: "error", code: "required", message: "Missing title" }];
  original.state.destination = "issues";
  original.state.render();
  let search = original.root.querySelector<HTMLInputElement>("[data-focus-key='issue-search']")!;
  search.value = "notes";
  search.dispatchEvent(new original.dom.window.Event("input"));
  const popout = fixture();
  popout.dom.window.document.body.appendChild(original.root);
  search = original.root.querySelector<HTMLInputElement>("[data-focus-key='issue-search']")!;
  search.focus();
  search.setSelectionRange(1, 3);
  original.state.render();
  const restored = original.root.querySelector<HTMLInputElement>("[data-focus-key='issue-search']")!;
  assert.equal(popout.dom.window.document.activeElement, restored);
  assert.equal(restored.selectionStart, 1);
  assert.equal(restored.selectionEnd, 3);
  original.dom.window.close();
  popout.dom.window.close();
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
  assert.match(f.text(), /ready-made type/);
  assert.doesNotMatch(f.text(), /mdbase-contracts|contracts/);
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
  const titleLabel = root.querySelector<HTMLLabelElement>("label[for='mdbase-note-title']")!;
  assert.equal(titleLabel.firstChild?.textContent, "title", "the label is the field name, without a bare asterisk");
  assert.equal(titleLabel.querySelector(".mdbase-required-tag")?.textContent, "Required");
  assert.equal(root.querySelector("#mdbase-note-title")!.getAttribute("aria-required"), "true");
  const reset = button(root, "Use suggested location");
  assert.ok(reset.classList.contains("mdbase-hidden"), "nothing to reset while the suggestion is in the field");
  set("mdbase-note-location", "created.md");
  assert.ok(!reset.classList.contains("mdbase-hidden"), "offered once the location differs");
  button(root, "Create note").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(created, { type: "sample", title: "Keep this text", count: 12, active: false, status: 10 });
  assert.equal(modal.containerEl.parentNode, null);
  f.dom.window.close();
});

test("creation modal applies v0.3 lifecycle.on_create and coerces datetime-local inputs to RFC 3339", async () => {
  const f = fixture();
  const config = { spec_version: "0.3.0", settings: { types_folder: "_types", explicit_type_keys: ["type"], exclude: [] } };
  const schema = {
    type: "object",
    additionalProperties: true,
    required: ["id", "state", "dateCreated", "dateModified", "scheduled"],
    properties: {
      id: { type: "string", minLength: 1 },
      state: { enum: ["active", "converted"] },
      title: { type: "string" },
      dateCreated: { type: "string", format: "date-time" },
      dateModified: { type: "string", format: "date-time" },
      scheduled: { type: "string", format: "date-time" },
    },
  };
  const scratch = {
    name: "tasknotes-scratch",
    filePath: "_types/tasknotes-scratch.md",
    specProfile: "v0.3" as const,
    display_name_key: "title",
    schema,
    fields: {
      id: { type: "string", required: true },
      state: { type: "enum", values: ["active", "converted"], required: true },
      title: { type: "string", required: false },
      dateCreated: { type: "datetime", required: true },
      dateModified: { type: "datetime", required: true },
      scheduled: { type: "datetime", required: true },
    },
    lifecycle: {
      on_create: {
        set: {
          id: { uuid: true as const },
          dateCreated: { now: true as const },
          dateModified: { now: true as const },
        },
      },
    },
  };

  let created: Record<string, unknown> | null = null;
  const modal = new CreateTypedNoteModal(
    { vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] } } as never,
    scratch,
    config,
    new Map([["tasknotes-scratch", scratch]]),
    async (_path, data) => { created = data; },
  );
  modal.open();
  const root = modal.contentEl;
  assert.equal(root.querySelector("#mdbase-note-id"), null, "lifecycle-generated id is not prompted");
  assert.equal(root.querySelector("#mdbase-note-dateCreated"), null, "lifecycle-generated dateCreated is not prompted");
  assert.equal(root.querySelector("#mdbase-note-dateModified"), null, "lifecycle-generated dateModified is not prompted");

  const set = (id: string, value: string) => {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
    el.value = value;
    el.dispatchEvent(new f.dom.window.Event("input"));
  };
  set("mdbase-note-title", "Outline");
  set("mdbase-note-state", "0");
  set("mdbase-note-scheduled", "2026-11-23T19:24");
  await settle();
  button(root, "Create note").click();
  await settle();

  assert.ok(created, `note passed v0.3 format validation and was created: ${root.querySelector("[role='alert']")?.textContent ?? ""}`);
  const written = created as Record<string, unknown>;
  assert.equal(written.type, "tasknotes-scratch");
  assert.equal(written.title, "Outline");
  assert.equal(written.state, "active");
  assert.match(String(written.id), /^[0-9a-f-]{36}$/i);
  assert.equal(written.dateCreated, written.dateModified);
  assert.match(String(written.dateCreated), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const expectedScheduled = new Date(0);
  expectedScheduled.setFullYear(2026, 10, 23);
  expectedScheduled.setHours(19, 24, 0, 0);
  assert.equal(written.scheduled, expectedScheduled.toISOString());
  assert.equal(modal.containerEl.parentNode, null);
  f.dom.window.close();
});

test("createLinkedNote evaluates derived lifecycle.on_create fields without opening the form", async () => {
  const f = fixture();
  const config = { spec_version: "0.3.0", settings: { types_folder: "_types", explicit_type_keys: ["type"], exclude: [] } };
  const schema = {
    type: "object",
    required: ["id", "title", "slug", "dateCreated"],
    properties: {
      id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      slug: { type: "string", minLength: 1 },
      dateCreated: { type: "string", format: "date-time" },
    },
  };
  const noteType = {
    name: "article",
    filePath: "_types/article.md",
    specProfile: "v0.3" as const,
    display_name_key: "title",
    schema,
    fields: {
      id: { type: "string", required: true },
      title: { type: "string", required: true },
      slug: { type: "string", required: true },
      dateCreated: { type: "datetime", required: true },
    },
    lifecycle: {
      on_create: {
        set: {
          id: { uuid: true as const },
          slug: { slugify: "title" },
          dateCreated: { now: true as const },
        },
      },
    },
  };
  const written: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
  const host = {
    app: { vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] } } as never,
    createTypedNote: async (path: string, frontmatter: Record<string, unknown>) => {
      written.push({ path, frontmatter });
      return { path, basename: path.replace(/\.md$/, "") } as never;
    },
  };
  const target = await createLinkedNote(host, noteType, "Hello World!", config, new Map([["article", noteType]]));
  assert.deepEqual(target, { path: "Hello World!.md", name: "Hello World!", types: ["article"] });
  assert.equal(written.length, 1);
  assert.equal(written[0].frontmatter.slug, "hello-world");
  assert.match(String(written[0].frontmatter.id), /^[0-9a-f-]{36}$/i);
  assert.match(String(written[0].frontmatter.dateCreated), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  f.dom.window.close();
});

test("a link asking for more than a name opens the form with the name filled in and the link field searching its type", async () => {
  const f = fixture();
  const config = { spec_version: "0.3.0", settings: { types_folder: "_types", explicit_type_keys: ["type"], exclude: [] } };
  const person = { name: "person", filePath: "_types/person.md", display_name_key: "name", fields: { name: { type: "string", required: true } } };
  const book = { name: "book", filePath: "_types/book.md", display_name_key: "title",
    collection: { links: { author: { target_type: "person" } } },
    fields: { title: { type: "string", required: true }, author: { type: "string", required: true } } };
  const types = new Map<string, unknown>([["book", book], ["person", person]]);
  const written: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
  const host = {
    app: { vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] } } as never,
    createTypedNote: async (path: string, frontmatter: Record<string, unknown>) => {
      written.push({ path, frontmatter });
      return { path, basename: path.split("/").pop()!.replace(/\.md$/, "") } as never;
    },
  };
  const links = {
    targets: async () => [{ path: "People/ted-chiang.md", name: "Ted Chiang", types: ["person"] }, { path: "Library/Exhalation.md", name: "Exhalation", types: ["book"] }],
    create: (type: typeof person, name: string) => createLinkedNote(host, type as never, name, config, types as never, { links }),
  };
  AbstractInputSuggest.instances.length = 0;
  const pending = createLinkedNote(host, book as never, "Dune", config, types as never, { links });
  await settle();
  assert.deepEqual(written, [], "a book needs an author first");
  const root = f.dom.window.document.body.querySelector<HTMLElement>(".mdbase-create-note")!;
  const title = root.querySelector<HTMLInputElement>("#mdbase-note-title")!;
  const author = root.querySelector<HTMLInputElement>("#mdbase-note-author")!;
  assert.equal(title.value, "Dune");
  assert.equal(f.dom.window.document.activeElement, author, "the first field still to give has the keyboard");
  assert.equal(root.querySelector<HTMLInputElement>("#mdbase-note-location")!.value, "Dune.md");
  assert.doesNotMatch(root.textContent ?? "", /Required\s*Required/, "nothing is reported before anything is typed");
  assert.equal(author.placeholder, "Search notes");

  const [suggest] = AbstractInputSuggest.instances as unknown as Array<{
    getSuggestions(query: string): Promise<Array<{ kind: string }>>; selectSuggestion(row: unknown): void; renderSuggestion(row: unknown, el: HTMLElement): void }>;
  assert.equal(AbstractInputSuggest.instances.length, 1, "only the link field suggests notes");
  const rows = await suggest.getSuggestions("frank herbert");
  assert.deepEqual(rows.map(row => row.kind), ["create"], "books are not people");
  const rendered = f.dom.window.document.createElement("div");
  suggest.renderSuggestion(rows[0], rendered);
  assert.equal(rendered.querySelector(".suggestion-title")?.textContent, "New person “frank herbert”");
  suggest.renderSuggestion((await suggest.getSuggestions("ted"))[0], rendered);
  assert.match(rendered.textContent ?? "", /Ted Chiang\s*People\s*person/);

  // A person needs only a name, so choosing the row creates it and fills the field.
  suggest.selectSuggestion(rows[0]);
  await settle();
  assert.deepEqual(written, [{ path: "frank herbert.md", frontmatter: { type: "person", name: "frank herbert" } }]);
  assert.equal(author.value, "[[frank herbert]]");
  button(root, "Create note").click();
  await settle();
  assert.deepEqual(written[1], { path: "Dune.md", frontmatter: { type: "book", title: "Dune", author: "[[frank herbert]]" } });
  assert.deepEqual(await pending, { path: "Dune.md", name: "Dune", types: ["book"] });
  f.dom.window.close();
});

test("a link's form closed without creating settles to nothing, and a fixed location stays put", async () => {
  const f = fixture();
  const config = { spec_version: "0.3.0", settings: { types_folder: "_types", explicit_type_keys: ["type"], exclude: [] } };
  const person = { name: "person", filePath: "_types/person.md", display_name_key: "name",
    fields: { name: { type: "string", required: true }, born: { type: "date", required: true } } };
  const host = { app: { vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] } } as never,
    createTypedNote: async () => { throw new Error("nothing should be created"); } };
  const pending = createLinkedNote(host, person as never, "Nobody", config, new Map([["person", person]]) as never, { path: "People/Nobody.md" });
  await settle();
  const root = f.dom.window.document.body.querySelector<HTMLElement>(".mdbase-create-note")!;
  const location = root.querySelector<HTMLInputElement>("#mdbase-note-location")!;
  assert.equal(location.value, "People/Nobody.md");
  assert.ok(location.readOnly);
  assert.ok(button(root, "Use suggested location").classList.contains("mdbase-hidden"));
  button(root, "Create note").click();
  await settle();
  assert.match(root.textContent ?? "", /Required/, "the missing date is reported");
  button(root, "Cancel").click();
  assert.equal(await pending, null);
  f.dom.window.close();
});

test("a missing link to a known type offers to create its note", async () => {
  const f = typesFixture();
  const issue = { path: "tasks/a.md", severity: "error", code: "link_not_found", field: "owner", type: "task",
    message: "Field 'owner' references a missing note", details: { link: "[[People/Nobody]]", target_type: "person" } };
  const created: unknown[] = [];
  Object.assign(f.host, {
    getIssues: () => [issue, { ...issue, path: "tasks/b.md" }],
    getCreateLinkLabel: () => "Create person “Nobody”",
    createMissingLink: async (selected: unknown) => { created.push(selected); },
  });
  f.state.destination = "issues";
  f.state.render();
  const buttons = Array.from(f.root.querySelectorAll("button")).filter(el => el.textContent === "Create person “Nobody”");
  assert.equal(buttons.length, 2, "one per note, with no bulk action");
  buttons[0].click();
  await settle();
  assert.deepEqual(created, [issue]);
  await f.view.onClose();
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a synced vault says so in one heading and offers only the link and settings", () => {
  const f = fixture(true);
  f.state.render();
  assert.equal(f.root.querySelector(".mdbase-sync-heading h2")?.textContent, "Synced");
  assert.equal(f.root.querySelector(".mdbase-sync-heading")?.getAttribute("data-tone"), "ok");
  assert.match(f.text(), /Collection Project notes Kind Cloud copy This computer Laptop/);
  assert.ok(button(f.root, "Copy link"));
  button(f.root, "Sync settings").click();
  assert.equal(f.settingsOpened(), 1);
  assert.doesNotMatch(f.text(), /Turn on sync|Sign in|key|device ID|server/i);
  f.dom.window.close();
});

/** Records `window.open` calls on the fixture's window. */
function captureOpen(f: ReturnType<typeof fixture>): string[] {
  const opened: string[] = [];
  Object.assign(f.dom.window, { open: (url: string) => { opened.push(url); return null; } });
  return opened;
}

test("Manage apps opens the collection's access page on the account's server (desktop app)", () => {
  const f = fixture(true);
  f.sync.set({ ...f.sync.controller.snapshot, status: { ...f.sync.controller.snapshot.status!, account: { signed_in: true, online: true, computer_name: "Laptop", server: "https://connect.mdbase.dev/" } } });
  f.state.render();
  const opened = captureOpen(f);
  button(f.root, "Manage apps").click();
  assert.deepEqual(opened, ["https://connect.mdbase.dev/access?collection=0b6f1c1e-6f77-4a4b-9a57-7f2a1d1f0c11"]);
  f.dom.window.close();
});

test("without a known server there is no Manage apps button (desktop app)", () => {
  const f = fixture(true);
  f.state.render();
  assert.ok(!Array.from(f.root.querySelectorAll("button")).some((el) => el.textContent === "Manage apps"));
  f.dom.window.close();
});

test("manageAppsUrl accepts https and loopback http only", () => {
  assert.equal(manageAppsUrl("https://connect-lab.mdbase.dev", "a b"), "https://connect-lab.mdbase.dev/access?collection=a%20b");
  assert.equal(manageAppsUrl("http://127.0.0.1:8787", "c"), "http://127.0.0.1:8787/access?collection=c");
  for (const server of [undefined, "", "http://connect.mdbase.dev", "javascript:alert(1)", "https://user:pw@connect.mdbase.dev", "not a url"]) {
    assert.equal(manageAppsUrl(server, "c"), null, String(server));
  }
});

test("missing or stopped mdbase app offers one next step", async () => {
  const f = fixture();
  f.sync.set({ daemon: "not_installed", status: null });
  f.state.render();
  assert.match(f.text(), /Install the mdbase app/);
  assert.ok(button(f.root, "Download mdbase").classList.contains("mod-cta"));
  assert.ok(button(f.root, "Check again"));
  f.sync.set({ daemon: "not_running", status: null });
  f.state.render();
  button(f.root, "Start mdbase").click();
  await tick();
  assert.deepEqual(f.sync.calls, [["startApp"]]);
  f.dom.window.close();
});

test("signing in waits in the browser and can be cancelled", async () => {
  const f = fixture();
  f.sync.set(baseSnapshot());
  f.state.render();
  assert.doesNotMatch(f.text(), /Turn on sync/, "setup waits for sign-in");
  button(f.root, "Sign in").click();
  await tick();
  assert.deepEqual(f.sync.calls, [["signIn"]]);
  f.sync.set({ signingIn: "https://lab.example/device" });
  f.state.render();
  assert.match(f.text(), /Finish signing in in your browser/);
  assert.ok(button(f.root, "Open the sign-in page again"));
  button(f.root, "Cancel").click();
  assert.deepEqual(f.sync.calls.at(-1), ["cancelSignIn"]);
  f.dom.window.close();
});

test("setup asks for a name and one choice between Cloud copy and Private", async () => {
  const f = fixture();
  f.state.render();
  const name = f.root.querySelector<HTMLInputElement>(".mdbase-sync-section input[type='text']")!;
  assert.equal(name.value, "Notes", "named after the vault");
  const cloud = f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-kind-cloud']")!;
  const priv = f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-kind-private']")!;
  assert.equal(cloud.checked, true);
  assert.match(f.text(), /Cloud copy \(recommended\).*Private.*only your devices can read it/);
  name.value = "Research";
  name.dispatchEvent(new f.dom.window.Event("input"));
  priv.checked = true;
  priv.dispatchEvent(new f.dom.window.Event("change"));
  button(f.root, "Turn on sync").click();
  await tick();
  assert.deepEqual(f.sync.calls, [["setUp", "private", "Research"]]);
  f.dom.window.close();
});

test("adding an existing collection asks for a folder only when the vault has notes", async () => {
  const f = fixture();
  f.state.render();
  assert.ok(f.root.querySelector("[data-focus-key='sync-join-folder']"));
  const link = f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-join-link']")!;
  link.value = "obsidian://mdbase-join?collection=0b6f1c1e-6f77-4a4b-9a57-7f2a1d1f0c11";
  link.dispatchEvent(new f.dom.window.Event("input"));
  const folder = f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-join-folder']")!;
  folder.value = "Team";
  folder.dispatchEvent(new f.dom.window.Event("input"));
  button(f.root, "Add collection").click();
  await tick();
  assert.deepEqual(f.sync.calls, [["join", link.value, "Team"]]);
  f.host.vaultTopLevelEntries = () => [];
  f.state.render();
  assert.equal(f.root.querySelector("[data-focus-key='sync-join-folder']"), null);
  f.dom.window.close();
});

test("a vault from the earlier Connect sync explains the change and prefills the collection", () => {
  const f = fixture();
  f.host.legacyConnect = () => ({ name: "Old notes", collectionId: "0b6f1c1e-6f77-4a4b-9a57-7f2a1d1f0c11" });
  f.state.render();
  assert.match(f.text(), /earlier mdbase Connect sync for "Old notes".*untouched/);
  assert.equal(f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-join-link']")!.value, "0b6f1c1e-6f77-4a4b-9a57-7f2a1d1f0c11");
  assert.equal(f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-join-folder']")!.value, "Old notes");
  f.dom.window.close();
});

test("held files show both versions and name each outcome", async () => {
  const f = fixture(true);
  f.sync.set({
    prefix: "Team",
    holds: [
      { id: "h1", path: "Plan.md", reason: "conflict", hasTheirs: true, mine: "mine", theirs: "theirs" },
      { id: "h2", path: "Old.md", reason: "deleted_elsewhere", hasTheirs: false, mine: null, theirs: null },
    ],
  });
  f.state.render();
  assert.equal(f.root.querySelector(".mdbase-sync-heading h2")?.textContent, "2 files need you");
  assert.match(f.text(), /Team\/Plan\.md Changed here and on another device Compare versions/);
  assert.match(f.text(), /Team\/Old\.md Deleted on another device, changed here/);
  const rows = f.root.querySelectorAll<HTMLElement>(".mdbase-hold");
  assert.deepEqual(Array.from(rows[0].querySelectorAll("button")).map((b) => b.textContent), ["Keep this computer's", "Use the other version", "Keep both"]);
  assert.deepEqual(Array.from(rows[1].querySelectorAll("button")).map((b) => b.textContent), ["Keep this computer's", "Delete it"]);
  assert.equal(rows[1].querySelector("details"), null, "nothing to compare");
  button(rows[0], "Keep both").click();
  await tick();
  assert.deepEqual(f.sync.calls, [["resolve", f.sync.controller.snapshot.holds[0], "keep_both"]]);
  f.dom.window.close();
});

test("a new device asks for its code before approval", async () => {
  const f = fixture(true);
  f.sync.set({ approvals: [{ device: "d1", name: "Work laptop" }] });
  f.state.render();
  assert.match(f.text(), /Work laptop wants to join/);
  const code = f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-code-d1']")!;
  code.value = "123 456";
  code.dispatchEvent(new f.dom.window.Event("input"));
  button(f.root, "Approve").click();
  await tick();
  assert.deepEqual(f.sync.calls, [["approve", "d1", "123 456"]]);
  f.dom.window.close();
});

test("a declined link explains what still works and can ask again", async () => {
  const f = fixture(true);
  f.sync.set({ link: "declined" });
  f.state.render();
  assert.match(f.text(), /Sync still runs/);
  button(f.root, "Allow Obsidian").click();
  await tick();
  assert.deepEqual(f.sync.calls, [["linkAgain"]]);
  f.dom.window.close();
});

test("sync trouble stays visible from other destinations, where mobile has no status bar", () => {
  for (const [patch, label] of [
    [{ status: baseSnapshot().status }, "Check"],
    [{ collection: collectionStatus({ state: "failed" }) }, "Problem"],
  ] as const) {
    const f = fixture(true);
    f.state.destination = "issues";
    f.sync.set(patch as Partial<SyncSnapshot>);
    f.state.render();
    const tab = f.root.querySelector<HTMLButtonElement>("[data-focus-key='destination-sync']")!;
    assert.equal(tab.querySelector(".mdbase-nav-status")?.textContent, label);
    assert.match(tab.getAttribute("aria-label")!, /^Sync · /);
    tab.click();
    assert.equal(f.root.querySelector(".mdbase-nav-status"), null, "the active pane already explains it");
    f.dom.window.close();
  }
});

test("held files badge the Sync tab with a descriptive name", () => {
  const f = fixture(true);
  f.state.destination = "issues";
  f.host.getIssues = () => [{ path: "other.md", severity: "error", code: "schema_required", message: "Missing title" }];
  f.sync.set({ holds: [{ id: "h1", path: "Plan.md", reason: "conflict", hasTheirs: true, mine: null, theirs: null }] });
  f.state.render();
  assert.equal(f.root.querySelector("[data-focus-key='destination-sync']")?.getAttribute("aria-label"), "Sync · 1 file was changed in two places. Choose which version to keep.");
  assert.equal(f.root.querySelector("[data-focus-key='destination-issues']")?.getAttribute("aria-label"), "Issues · 1 validation issue");
  f.dom.window.close();
});

test("background status updates keep focus on tabs and never rebuild Sync while typing", async () => {
  const f = fixture();
  Object.assign(f.host, { loadWorkspaceSchema: async () => null });
  await f.view.onOpen();
  await f.view.setState({ destination: "issues" }, {} as never);
  const tab = f.root.querySelector<HTMLButtonElement>("[data-focus-key='destination-issues']")!;
  tab.focus();
  f.sync.set({ approvals: [{ device: "d1", name: "Phone" }] });
  assert.equal(f.dom.window.document.activeElement?.getAttribute("data-focus-key"), "destination-issues");
  await f.view.setState({ destination: "sync" }, {} as never);
  const link = f.root.querySelector<HTMLInputElement>("[data-focus-key='sync-join-link']")!;
  link.focus();
  f.sync.set({ busy: null });
  assert.equal(f.dom.window.document.activeElement, link, "the same input survives a status update");
  await f.view.onClose();
  f.dom.window.close();
});

test("first run asks one question: start a collection here, or sync one from another device", () => {
  const f = fixture();
  f.state.destination = "types";
  f.state.render();
  assert.match(f.text(), /Set up mdbase.*Start a collection.*Sync from another device/);
  assert.ok(button(f.root, "Start a collection").classList.contains("mod-cta"));
  button(f.root, "Sync from another device").click();
  assert.equal(f.state.destination, "sync");
  assert.match(f.text(), /Add a collection you already sync/);
  f.dom.window.close();
});

/** In-plugin sync: the pane reads `direct` and calls the native host. */
function directFixture(phase: Record<string, unknown>, text: string, canStartOver = false, bound = false) {
  const f = fixture();
  const calls: string[] = [];
  const record = (name: string) => () => { calls.push(name); return Promise.resolve(); };
  (f.sync.controller as unknown as { native: unknown }).native = {
    signIn: record("signIn"), choose: record("choose"), addCollection: record("addCollection"), requestAccess: record("requestAccess"),
    retry: record("retry"), startOver: record("startOver"), canStartOver, chooseAgain: record("chooseAgain"), signOut: record("signOut"),
  };
  f.sync.set({ direct: { text, phase, bound } as SyncSnapshot["direct"] });
  f.state.render();
  return { ...f, calls };
}

test("native conflict copies are listed with non-destructive review and keep-both actions", async () => {
  const f = directFixture({ kind: "ready" }, "Synced");
  const kept: string[] = [];
  Object.assign((f.sync.controller as unknown as { native: object }).native, { keepConflictCopies: async (copy: string) => { kept.push(copy); } });
  const copy = "target (conflict 2026-11-15 0900 test-v).md";
  f.sync.set({ direct: { text: "Synced", phase: { kind: "ready" }, conflicts: [{ path: "target.md", copy }] } });
  f.state.render();
  assert.match(f.text(), /Conflicts/); assert.match(f.text(), /target \(conflict 2026-11-15 0900 test-v\)\.md/);
  assert.ok(button(f.root, "Open current file")); assert.ok(button(f.root, "Open conflict copy"));
  button(f.root, "Keep both").click(); await tick();
  assert.deepEqual(kept, [copy]);
  f.dom.window.close();
});

test("in-plugin sync offers Manage apps with the SDK's access page, and only a safe one", () => {
  const f = directFixture({ kind: "ready", manageAccess: "https://connect.mdbase.dev/access?collection=c1" }, "Synced");
  const opened = captureOpen(f);
  button(f.root, "Manage apps").click();
  assert.deepEqual(opened, ["https://connect.mdbase.dev/access?collection=c1"]);
  f.dom.window.close();
  for (const manageAccess of [null, "javascript:alert(1)", "http://connect.mdbase.dev/access"]) {
    const g = directFixture({ kind: "ready", manageAccess }, "Synced");
    assert.ok(!Array.from(g.root.querySelectorAll("button")).some((el) => el.textContent === "Manage apps"), String(manageAccess));
    g.dom.window.close();
  }
});

test("no Private collections hint before or after signing in: most accounts have none", () => {
  const choosing = directFixture({ kind: "choosing", collections: [{ id: "c", name: "Notes", private: false }] }, "Choose the collection to sync with this vault.");
  assert.doesNotMatch(choosing.text(), /Private|key/);
  choosing.dom.window.close();
  const signedOut = directFixture({ kind: "signed_out" }, "Sign in to sync this vault.");
  assert.doesNotMatch(signedOut.text(), /Private|key/);
  assert.ok(button(signedOut.root, "Sign in"));
  signedOut.dom.window.close();
});

test("a fresh install over an earlier install's sync setup offers Set up sync here, calmly, and only acts on the click", async () => {
  const text = "This vault was set up for sync before, maybe by an earlier install of this plugin. Your notes here are untouched.";
  const f = directFixture({ kind: "blocked", owner: "obsidian", takeover: true }, text);
  let takeOvers = 0;
  (f.sync.controller as unknown as { takeOver: () => Promise<void> }).takeOver = async () => { takeOvers++; };
  f.state.render();
  assert.match(f.text(), /set up for sync before, maybe by an earlier install/);
  assert.doesNotMatch(f.text(), /marker|host|owned/i);
  const summary = summarize(f.sync.controller.snapshot);
  assert.equal(summary.syncing, false, "nothing in the status bar for a vault that isn't set up");
  assert.equal(summary.tone, "quiet");
  assert.equal(takeOvers, 0);
  button(f.root, "Set up sync here").click(); await tick();
  assert.equal(takeOvers, 1);
  f.dom.window.close();
});

test("a folder the desktop app or a live Obsidian syncs names the other app, with no Set up sync here", () => {
  for (const [owner, words] of [["desktop", /Another app is already syncing this vault: the mdbase desktop app\. Turn sync off there first\./], ["obsidian", /Another copy of Obsidian is already syncing this vault/]] as const) {
    const text = owner === "desktop"
      ? "Another app is already syncing this vault: the mdbase desktop app. Turn sync off there first. Your notes here are untouched."
      : "Another copy of Obsidian is already syncing this vault, on this device or another one. Turn sync off there first. If you just reinstalled this plugin, you can set up sync here in a few minutes.";
    const f = directFixture({ kind: "blocked", owner, takeover: false }, text);
    assert.match(f.text(), words);
    assert.ok(!Array.from(f.root.querySelectorAll("button")).some((el) => el.textContent === "Set up sync here"), owner);
    assert.doesNotMatch(f.text(), /marker|host\b|owned/i);
    f.dom.window.close();
    const bound = directFixture({ kind: "blocked", owner, takeover: false }, text, false, true);
    const summary = summarize(bound.sync.controller.snapshot);
    assert.equal(summary.label, "Sync paused"); assert.equal(summary.syncing, true);
    bound.dom.window.close();
  }
});

test("an unfinished sign-in offers Sign in again, which signs in through the SDK (prod F1)", async () => {
  // As the SDK reports it after a cancelled or refused approval, and again after a restart.
  const problem = { key: "refused", action: "sign_in", title: "Sign-in wasn't finished", message: "Access wasn't approved. Sign in again when you're ready." };
  const f = directFixture({ kind: "problem", collectionId: null, problem }, "Sign-in wasn't finished. Access wasn't approved. Sign in again when you're ready.");
  assert.match(f.text(), /Access wasn't approved/);
  const again = button(f.root, "Sign in again");
  assert.ok(again.classList.contains("mod-cta"), "the primary step");
  assert.equal(Array.from(f.root.querySelectorAll("button")).some((b) => b.textContent === "Check again"), false, "no button that does nothing");
  again.click();
  await tick();
  assert.deepEqual(f.calls, ["signIn"]);
  f.dom.window.close();
});

test("a stuck sign-in with nothing synced offers Start over; a bound vault doesn't (prod F1)", async () => {
  const stuck = { kind: "problem", collectionId: null, problem: { key: "recovery_required", action: "reload", title: "Reload required", message: "The app stopped to keep your data safe. Reload to continue." } };
  const f = directFixture(stuck, "Sync stopped. Reload required. The app stopped to keep your data safe. Reload to continue.", true);
  assert.match(f.text(), /Start over signs this vault out of mdbase, so you can sign in again with any account\. Nothing has synced yet/);
  // Start over goes through the controller, which restarts the host first when the SDK's Worker is gone.
  button(f.root, "Start over").click();
  await tick();
  // The SDK asks for a reload: Restart sync, not a Try again that can't help (prod F1, second run).
  assert.equal(Array.from(f.root.querySelectorAll("button")).some((b) => b.textContent === "Try again"), false);
  button(f.root, "Restart sync").click();
  await tick();
  assert.deepEqual(f.sync.calls.map((c) => c[0]), ["startOver", "restartNative"]);
  assert.deepEqual(f.calls, [], "neither goes straight to the SDK host");
  f.dom.window.close();
  const bound = directFixture(stuck, "Sync stopped.", false);
  assert.equal(Array.from(bound.root.querySelectorAll("button")).some((b) => b.textContent === "Start over"), false);
  assert.doesNotMatch(bound.text(), /Start over/);
  bound.dom.window.close();
});

test("each sync engine action gets a fitting button, or none", () => {
  const labels = (problem: Record<string, unknown>, collectionId: string | null = "c") => {
    const f = directFixture({ kind: "problem", collectionId, problem }, "Sync stopped. Words.");
    const out = Array.from(f.root.querySelectorAll(".mdbase-sync button")).map((b) => b.textContent);
    f.dom.window.close();
    return out;
  };
  assert.deepEqual(labels({ action: "sign_in" }), ["Sign in again"]);
  assert.deepEqual(labels({ action: "approve" }), ["Request access again"]);
  assert.deepEqual(labels({ action: "approve" }, null), [], "nothing to approve without a collection");
  for (const action of ["retry", "check_connection", "wait", "resolve_outcome", "something_new"]) assert.deepEqual(labels({ action }), ["Try again"], action);
  // A page reload, for a web app; and whatever the action, a Worker that quarantined itself.
  assert.deepEqual(labels({ action: "reload" }), ["Restart sync"]);
  assert.deepEqual(labels({ action: "retry", code: "application_worker_binding" }), ["Restart sync"]);
  for (const action of ["update_app", "free_space", "set_up", "contact_support", "none"]) assert.deepEqual(labels({ action }), [], action);
  // Unavailable or access removed may come back; a deleted collection won't (issue 60).
  assert.deepEqual(labels({ action: "choose_collection", key: "collection_unavailable" }), ["Choose another collection", "Try again"]);
  assert.deepEqual(labels({ action: "choose_collection", key: "collection_deleted" }), ["Choose another collection"]);
});

test("when sign-in broke before anything was bound, Start over is the primary step and Restart sync the lesser one (prod retest 2)", async () => {
  // As reported after Sign in again from a refused approval. A fresh host
  // resumes the same sign-in and stops again, so Restart sync alone loops.
  const problem = { code: "application_worker_binding", key: "application_failed", title: "The app stopped", message: "Something inside the app stopped working. Your data is safe. Reload to continue.", action: "reload" };
  const f = directFixture({ kind: "problem", collectionId: null, problem }, "Sign-in stopped working. Your notes here are untouched. Choose Start over to sign in again.", true);
  const labels = Array.from(f.root.querySelectorAll(".mdbase-sync button")).map((b) => b.textContent);
  assert.deepEqual(labels, ["Start over", "Restart sync"], "no Try again: the Worker refuses every call");
  assert.ok(button(f.root, "Start over").classList.contains("mod-cta"), "the primary step");
  assert.ok(!button(f.root, "Restart sync").classList.contains("mod-cta"));
  assert.doesNotMatch(f.text(), /Reload to continue/);
  button(f.root, "Restart sync").click();
  await tick();
  button(f.root, "Start over").click();
  await tick();
  assert.deepEqual(f.sync.calls.map((c) => c[0]), ["restartNative", "startOver"]);
  f.dom.window.close();
  // A bound vault can't start over: Restart sync stays the one, primary step.
  const bound = directFixture({ kind: "problem", collectionId: "c1", problem }, "Sync stopped. Something inside sync stopped working. Your notes here are untouched. Choose Restart sync to continue.");
  assert.deepEqual(Array.from(bound.root.querySelectorAll(".mdbase-sync button")).map((b) => b.textContent), ["Restart sync"]);
  assert.ok(button(bound.root, "Restart sync").classList.contains("mod-cta"));
  bound.dom.window.close();
});

test("an action that fails says so in the message bar", async () => {
  const problem = { code: "response", key: "application_failed", action: "reload" };
  const f = directFixture({ kind: "problem", collectionId: null, problem }, "Sync stopped.", true);
  (f.sync.controller as unknown as { startOver: () => Promise<void> }).startOver = () => Promise.reject(Object.assign(new Error("Start over didn't finish. Choose Restart sync, then Start over again."), { code: "still_stopped" }));
  button(f.root, "Start over").click();
  await tick();
  await tick();
  assert.match(f.text(), /Start over didn't finish\. Choose Restart sync, then Start over again\./);
  f.dom.window.close();
});

test("starting that doesn't finish offers Restart sync; ordinary starting offers nothing (prod F1, second run)", async () => {
  const quiet = directFixture({ kind: "starting" }, "Starting sync");
  assert.equal(quiet.root.querySelectorAll(".mdbase-sync button").length, 0);
  quiet.dom.window.close();
  const stalled = directFixture({ kind: "starting", stalled: true }, "Sync hasn't started. Your notes here are untouched. Choose Restart sync to try again.");
  assert.match(stalled.text(), /Sync not starting/);
  assert.match(stalled.text(), /Choose Restart sync to try again/);
  button(stalled.root, "Restart sync").click();
  await tick();
  assert.deepEqual(stalled.sync.calls.map((c) => c[0]), ["restartNative"]);
  stalled.dom.window.close();
});

test("waiting for a bound collection's approval says so, and reopens the approval page (prod O3)", async () => {
  const f = directFixture({ kind: "authorizing", collectionId: "c" }, "Waiting for you to approve access in your browser. Your notes here are untouched.", false, true);
  assert.match(f.text(), /Waiting for approval/);
  assert.match(f.text(), /approve access in your browser/);
  assert.equal(Array.from(f.root.querySelectorAll("button")).some((b) => b.textContent === "Sign in"), false, "not a plain Sign in");
  assert.doesNotMatch(f.text(), /Private collections sync here only/);
  button(f.root, "Open approval page").click();
  await tick();
  assert.deepEqual(f.calls, ["signIn"], "reopens the pending link");
  f.dom.window.close();
  const first = directFixture({ kind: "authorizing" }, "Finish signing in in your browser.");
  assert.ok(button(first.root, "Sign in"), "a first sign-in is unchanged");
  first.dom.window.close();
});

test("after Move to mdbase app, Sync says what happened and what's next, without alarm (prod F5)", () => {
  const f = directFixture({ kind: "handed_over" }, "Obsidian has stopped syncing this vault. To keep it syncing, add this folder in the mdbase app and pick the same collection.");
  assert.equal(f.root.querySelector(".mdbase-sync-heading")?.getAttribute("data-tone"), "quiet");
  assert.match(f.text(), /add this folder in the mdbase app and pick the same collection/);
  assert.ok(button(f.root, "Get the mdbase app"));
  assert.doesNotMatch(f.text(), /needs attention|Check again/);
  f.dom.window.close();
});

test("access removed offers Request access again, which starts the approval flow (LAB F4)", async () => {
  const text = "Sync stopped. Access to this collection was removed in mdbase. Your notes here are untouched. To sync again, choose Request access again and approve it in your browser.";
  const f = directFixture({ kind: "problem", collectionId: "c", problem: { key: "installation_scope_removed", action: "approve" } }, text);
  assert.match(f.text(), /Access to this collection was removed/);
  const again = button(f.root, "Request access again");
  assert.ok(again.classList.contains("mod-cta"));
  again.click();
  await tick();
  assert.deepEqual(f.calls, ["requestAccess"]);
  f.dom.window.close();
  const other = directFixture({ kind: "problem", collectionId: "c", problem: { key: "unknown", action: "retry" } }, "Sync stopped. Something went wrong.");
  assert.equal(Array.from(other.root.querySelectorAll("button")).some((b) => b.textContent === "Request access again"), false, "no promise without the action");
  other.dom.window.close();
});

test("the shared SDK sync pane offers sign-in without requiring the desktop app", () => {
  const f = directFixture({ kind: "signed_out" }, "Sign in to sync this vault.");
  assert.match(f.text(), /Sign in to sync this vault/);
  assert.ok(button(f.root, "Sign in"));
  assert.doesNotMatch(f.text(), /isn't available on phones|Install the mdbase app/);
  f.dom.window.close();
});

test("changes mdbase settled on its own can be checked, and a property switched", async () => {
  const f = fixture(true);
  const entry = (kind: string, field?: string) => ({ mutation: `m-${kind}`, seq: 1, conflict: { kind, id: "r1", field, kept: { form: "text", text: "" }, lost: { form: "text", text: "" } } });
  f.sync.set({ merged: [
    { entry: entry("field", "status") as never, path: "Plan.md", kind: "field", field: "status", kept: "\"done\"", lost: "\"open\"", lostValue: "open" },
    { entry: entry("body") as never, path: "Notes.md", kind: "body", field: null, kept: "a\nB\nc", lost: "a\nb\nc", lostValue: undefined },
  ] });
  f.state.render();
  assert.match(f.text(), /2 changes to check/);
  assert.match(f.text(), /"status" was set to "done"\. The other device set it to "open"\./);
  assert.match(f.text(), /The text was changed on two devices\. mdbase kept one version\. Show both versions/);
  button(f.root, 'Use "open"').click();
  await tick();
  button(f.root, "OK").click();
  await tick();
  assert.deepEqual(f.sync.calls.map((c) => c[0]), ["useOtherValue", "dismissMerged"]);
  f.dom.window.close();
});

test("a deleted collection isn't a dead end: Choose another collection, notes kept (issue 60)", async () => {
  const f = directFixture({ kind: "problem", collectionId: "c", problem: { key: "collection_deleted", action: "choose_collection" } }, "Sync stopped. This collection was deleted, so it can't be opened any more. Choose another collection.");
  assert.ok(button(f.root, "Choose another collection").classList.contains("mod-cta"));
  assert.match(f.text(), /Your notes stay in this vault/);
  button(f.root, "Choose another collection").click();
  await tick();
  assert.deepEqual(f.calls, ["chooseAgain"]);
  f.dom.window.close();
});

test("a sign-in waiting in the browser can be cancelled straight away (issue 62)", async () => {
  const f = directFixture({ kind: "authorizing" }, "Finish signing in in your browser.", true);
  assert.ok(button(f.root, "Sign in").classList.contains("mod-cta"));
  button(f.root, "Cancel sign-in").click();
  await tick();
  assert.deepEqual(f.sync.calls.map((c) => c[0]), ["startOver"], "through the controller, as Start over");
  f.dom.window.close();
  const bound = directFixture({ kind: "authorizing", collectionId: "c" }, "Waiting for you to approve access in your browser.", false, true);
  assert.equal(Array.from(bound.root.querySelectorAll("button")).some((b) => b.textContent === "Cancel sign-in"), false);
  bound.dom.window.close();
});

test("once synced, Sync is one status: Sync now, details folded away, and settings for the rest; Sign out is in the collection chooser (issue 65)", async () => {
  const f = directFixture({ kind: "ready" }, "Synced");
  const buttons = Array.from(f.root.querySelectorAll("button")).map((b) => b.textContent);
  assert.ok(!buttons.includes("Sign out"), "Sign out lives in settings, behind a confirmation");
  assert.ok(!buttons.includes("Move to mdbase app"));
  assert.doesNotMatch(f.text(), /On this device|Edits on two devices|Advanced/);
  const details = f.root.querySelector<HTMLDetailsElement>("details[data-disclosure='sync-details']");
  assert.ok(details && !details.open, "Overview and Activity start folded");
  button(f.root, "Sync settings").click();
  assert.equal(f.settingsOpened(), 1);
  f.dom.window.close();
  const choosing = directFixture({ kind: "choosing", collections: [] }, "Choose the collection to sync with this vault.");
  button(choosing.root, "Sign out").click();
  await tick();
  assert.deepEqual(choosing.calls, ["signOut"]);
  choosing.dom.window.close();
});

test("sync now uses structured stop status rather than status wording", async () => {
  const f = directFixture({ kind: "ready" }, "Localized status");
  Object.assign((f.sync.controller as unknown as { native: object }).native, {
    enqueue: async (work: () => Promise<void>) => work(),
    reconcileAll: async () => {},
  });
  f.sync.set({ direct: { text: "Localized status", phase: { kind: "ready" }, statusKind: "problem" } });
  f.state.render();
  button(f.root, "Sync now").click();
  await tick();
  assert.match(f.text(), /Sync stopped\. See above/);
  f.dom.window.close();
});
