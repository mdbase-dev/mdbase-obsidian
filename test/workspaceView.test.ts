import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { CreateTypedNoteModal } from "../src/createTypedNoteModal";
import { MdbaseWorkspaceView } from "../src/workspaceView";
import { createDefaultTypeModel } from "../src/typeModel";
import { typeDefFromDraft } from "../src/typeImpact";
import { Menu } from "obsidian";
import type { SyncSnapshot } from "../src/sync/controller";
import type { CollectionStatus } from "../src/sync/daemon";

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
    isValidating: () => false,
    cancelValidation: () => undefined,
    loadCollectionRecords: async () => [] as Array<{ path: string; frontmatter: Record<string, unknown> }>,
    getQuickFixLabel: () => null as string | null,
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
  for (const [key, destination] of [["ArrowRight", "types"], ["ArrowLeft", "issues"], ["Home", "types"], ["End", "issues"], ["ArrowLeft", "sync"]]) {
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
  assert.equal(f.text(), "Types Sync Issues Validation Not checked yet Validate");
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

test("phones and tablets say plainly that sync runs on the computer", () => {
  const f = fixture();
  f.sync.set({ daemon: "mobile", status: null });
  f.state.render();
  assert.match(f.text(), /Sync isn't available on phones and tablets yet.*Types and validation work here as usual/);
  assert.equal(f.root.querySelectorAll(".mdbase-sync button").length, 0);
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
