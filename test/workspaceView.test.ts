import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { MdbaseWorkspaceView } from "../src/workspaceView";
import { createDefaultTypeModel } from "../src/typeModel";
import { typeDefFromDraft } from "../src/typeImpact";
import { Menu } from "obsidian";

// Exercise the actual renderer with Obsidian's DOM convenience methods, not
// source-string assertions. Browser screenshots separately cover real styles.
function fixture(connected = false) {
  const dom = new JSDOM("<!doctype html><html><body><div id='view'></div></body></html>");
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, MutationObserver: window.MutationObserver,
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
    appendText(this: HTMLElement, text: string) { this.appendChild(this.ownerDocument.createTextNode(text)); },
    scrollIntoView() {},
  });
  const root = window.document.getElementById("view") as HTMLElement;
  const profile = connected ? { name: "Project notes", collectionId: "hidden-collection-id", mode: "read_write",
    controlUrl: "https://connect.example", selectiveSync: { file_classes: [], excluded_folders: [] } } : null;
  const host = {
    getMirrorProfile: () => profile,
    getIssues: () => [] as Array<{ path: string; severity: string; code: string; message: string }>,
    getCurrentSyncProblem: () => null,
    getSyncActivity: () => [],
    saveTypeDraft: async () => undefined,
    loadTypeDraft: () => null,
    clearTypeDraft: async () => undefined,
    loadCollectionRecords: async () => [] as Array<{ path: string; frontmatter: Record<string, unknown> }>,
    getQuickFixLabel: () => null as string | null,
    connectSync: {
      getAdoptionMarker: () => null,
      getSelectiveSync: () => ({ file_classes: [] as string[], excluded_folders: [] as string[] }),
      isSyncing: () => false,
    },
  };
  const view = new MdbaseWorkspaceView({ containerEl: root, app: { vault: { getName: () => "Notes", getAbstractFileByPath: () => null } } } as never, host as never);
  // Test-only access to view state: all rendering and DOM handlers are real.
  const state = view as unknown as {
    destination: string; render(): void; dirty: boolean; transientMessage: string;
    model: ReturnType<typeof createDefaultTypeModel>; originalModel: ReturnType<typeof createDefaultTypeModel>;
    schema: unknown; selectedPath: string; mirrorStatus: unknown; mirrorPreview: unknown;
  };
  state.destination = "sync";
  state.mirrorStatus = { state: "up_to_date", last_synced_at: new Date().toISOString(), conflicts: [], local_issues: [] };
  const text = () => visibleText(root);
  return { dom, root, host, state, text, view };
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

test("connected Sync is one status and one primary action; settings stay collapsed and retain their open state", () => {
  const f = fixture(true);
  f.state.render();
  assert.match(f.text(), /Project notes.*Up to date.*Read and write · Whole vault.*Check for changes/);
  assert.ok(f.text().split(" ").length < 30, f.text());
  assert.doesNotMatch(f.text(), /hidden-collection-id|Attachments|Disconnect|Hosted authority|checkpoint/);
  assert.equal(f.root.querySelectorAll(".mdbase-sync-actions button").length, 1);
  assert.equal(f.root.querySelector(".mdbase-sync-hero"), null);
  const settings = f.root.querySelector<HTMLDetailsElement>("[data-disclosure='sync-settings']")!;
  settings.open = true;
  f.state.render();
  assert.ok(f.root.querySelector<HTMLDetailsElement>("[data-disclosure='sync-settings']")!.open);
  assert.match(f.text(), /Attachments.*Disconnect/);
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
  assert.equal(f.root.querySelectorAll(".mdbase-editor-actions button").length, 1, "source action only");
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
  await (f.view as unknown as { selectType(path: string): Promise<void> }).selectType("_types/task.md");
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
  await (f.view as unknown as { selectType(path: string): Promise<void> }).selectType("_types/task.md");
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
  assert.equal(f.text(), "Types Sync Issues No issues Validate");
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
    assert.doesNotMatch(f.text(), /Resume move|Cancel move|Move paused/);
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
  button(f.root, "Resume move").click();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(uploading, true);
  assert.match(f.text(), /Approval received. Upload stopped/);
  assert.doesNotMatch(f.text(), /Move paused/);
  assert.match(f.text(), /A.md.*a.md/);
  assert.equal(button(f.root, "Resume move").disabled, true);
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
  assert.equal(button(f.root, "Resume move").disabled, false);
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
  assert.equal(button(f.root, "Resume move").disabled, false);
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
  const view = f.view as unknown as {
    selectType(path: string): Promise<void>;
    openTypeField(path: string, field?: string): Promise<void>;
    onClose(): Promise<void>;
    records: unknown;
  };
  view.records = records;
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
  assert.match(visibleText(fieldNode(f.root, "priority").querySelector("summary")!), /priority integer ≤ 3/);
  assert.match(visibleText(fieldNode(f.root, "status").querySelector("summary")!), /status enum 1, 2, done, later/);
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
    phase: "incremental", plan: { actions: [{}], summary: { blocking_issues: 0 } },
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
