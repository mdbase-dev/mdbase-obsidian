import assert from "node:assert/strict";
import { test } from "node:test";
import { safeFolderName, type SyncSnapshot } from "../src/sync/controller";
import { candidateBinaries, collectionIdFrom, stateDir, vaultCollection, type CollectionStatus, type DaemonStatus } from "../src/sync/daemon";
import { applyScalarEdits, EditorFence, hashText, minimalChange, scalarToUtf16 } from "../src/sync/editorFence";
import { errorText, modeName, summarize } from "../src/sync/words";
import { differingLines, nameFromLink } from "../src/workspace/syncPane";

const ID = "0b6f1c1e-6f77-4a4b-9a57-7f2a1d1f0c11";

function collection(overrides: Partial<CollectionStatus> = {}): CollectionStatus {
  return {
    id: ID, name: "Notes", root: "/home/me/Notes", mode: "synced", state: "ready", log: "hosted", notices: [],
    sync: { confirmed_through: 3, head_known: 3, pending: 0, holds: 0, unresolved: 0, connection: "online" }, ...overrides,
  };
}

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  const c = collection();
  return {
    daemon: "running", error: null, status: { account: { signed_in: true, online: true }, collections: [c] }, collection: c, prefix: "",
    live: null, link: "open", holds: [], approvals: [], merged: [], signingIn: null, busy: null, ...overrides,
  };
}

test("the status summary prefers what needs a person, then progress, then calm", () => {
  assert.equal(summarize(snapshot()).label, "Synced");
  assert.equal(summarize(snapshot()).tone, "ok");
  assert.equal(summarize(snapshot({ collection: collection({ state: "moving" }) })).label, "Setting up sync");
  assert.equal(summarize(snapshot({ collection: collection({ sync: { confirmed_through: 1, head_known: 3, pending: 0, holds: 0, unresolved: 0, connection: "online" } }) })).label, "Updating");
  const offline = summarize(snapshot({ collection: collection({ sync: { confirmed_through: 3, head_known: 3, pending: 2, holds: 0, unresolved: 0, connection: "offline" } }) }));
  assert.equal(offline.label, "Offline");
  assert.match(offline.detail, /2 changes are saved here/);
  const held = summarize(snapshot({ holds: [{ id: "h", path: "a.md", reason: "conflict", hasTheirs: true, mine: null, theirs: null }] }));
  assert.equal(held.label, "1 file needs you");
  assert.equal(held.tone, "attention");
  const signedOut = summarize(snapshot({ status: { account: { signed_in: false, online: true }, collections: [] } }));
  assert.equal(signedOut.label, "Signed out");
  assert.equal(summarize(snapshot({ collection: collection({ state: "failed", reason: "folder_missing" }) })).detail, "The vault folder moved or was renamed. Re-add it from Sync.");
  assert.match(summarize(snapshot({ collection: collection({ state: "unavailable", reason: "sync_not_eligible" }) })).detail, /sign-in stopped working/);
  const live = summarize(snapshot({ live: { confirmedThrough: 3, headKnown: 3, pending: 1, holds: 0, unresolved: 0, connection: "online", incidents: [] } as never }));
  assert.equal(live.label, "Syncing", "live link status wins over the last CLI poll");
  assert.equal(summarize(snapshot({ live: { confirmedThrough: 3, headKnown: 3, pending: 0, holds: 0, unresolved: 0, connection: "online", incidents: [{ kind: "quota_exceeded" }] } as never })).detail,
    "Your mdbase storage is full. Changes stay on this computer until there's room.");
  assert.equal(summarize(snapshot({ collection: null })).syncing, false);
  const joining = summarize(snapshot({ collection: collection({ mode: "synced_e2e", state: "opening", sync: { confirmed_through: 2, head_known: 4, pending: 0, holds: 0, unresolved: 0, connection: "online", last_error: "waiting_for_key" } }) }));
  assert.equal(joining.label, "Private: first computer only");
  assert.match(joining.detail, /first computer only for now.*Cloud copy collections have no such limit/);
  const unreachable = summarize(snapshot({
    status: { account: { signed_in: true, online: false }, collections: [] },
    live: { confirmedThrough: 3, headKnown: 3, pending: 1, holds: 0, unresolved: 0, connection: "connecting", incidents: [] } as never,
  }));
  assert.equal(unreachable.label, "Offline", "a server that can't be reached reads as offline, not as connecting forever");
  assert.match(unreachable.detail, /1 change is saved here/);
  const stopped = summarize(snapshot({ daemon: "not_running", status: null }));
  assert.equal(stopped.syncing, true, "a synced vault keeps its status bar while the app is stopped");
  assert.equal(summarize(snapshot({ daemon: "not_installed", collection: null, status: null })).label, "Sync off");
});

test("collection kinds and errors read as plain words", () => {
  assert.equal(modeName("synced_e2e"), "Private");
  assert.equal(modeName("synced"), "Cloud copy");
  assert.equal(modeName("local"), "This computer only");
  assert.equal(errorText({ code: "invalid_request", reason: "folder_not_empty", message: "x" }), "That folder already has files. Choose a new folder name.");
  assert.equal(errorText({ code: "rate_limited", message: "x" }), "Too many attempts. Wait a few minutes, then try again.");
  assert.equal(errorText({ code: "internal", message: "disk is full" }), "Disk is full.");
  assert.match(errorText({ code: "unavailable", reason: "sync_refused", message: "server refused (409 not_current_private)" }), /couldn't find that collection/);
  assert.match(errorText({ code: "unauthenticated", reason: "registration_mismatch", message: "this account does not own the local registration" }), /sign-in stopped working/);
  assert.match(errorText({ code: "unavailable", reason: "daemon_unreachable", message: "daemon protocol: credential store unavailable: platform failure" }), /password store/);
});

test("the mdbase tool is looked for where each OS installer puts it", () => {
  const none = () => undefined;
  assert.deepEqual(candidateBinaries("linux", "/home/me", none, () => []).slice(0, 2), ["/usr/bin/mdbase", "/usr/local/bin/mdbase"]);
  assert.equal(candidateBinaries("darwin", "/Users/me", none, () => [])[0], "/Applications/mdbase connect.app/Contents/Resources/mdbase-next/mdbase");
  const win = candidateBinaries("win32", "C:\\Users\\me", (name) => (name === "LOCALAPPDATA" ? "C:\\Users\\me\\AppData\\Local" : undefined), () => ["app-0.9.0", "app-0.10.2", "packages"]);
  assert.deepEqual(win.slice(0, 2), [
    "C:\\Users\\me\\AppData\\Local\\mdbase_connect\\app-0.10.2\\resources\\mdbase-next\\mdbase.exe",
    "C:\\Users\\me\\AppData\\Local\\mdbase_connect\\app-0.9.0\\resources\\mdbase-next\\mdbase.exe",
  ]);
  assert.ok(candidateBinaries("linux", "/home/me", (name) => (name === "PATH" ? "/opt/bin:/usr/bin" : undefined), () => []).includes("/opt/bin/mdbase"));
  assert.equal(stateDir("linux", "/home/me", none), "/home/me/.local/state/mdbase");
  assert.equal(stateDir("darwin", "/Users/me", none), "/Users/me/Library/Application Support/mdbase");
});

test("the vault's collection is its own folder or one folder inside it", () => {
  const status = (roots: string[]): DaemonStatus => ({ account: { signed_in: true, online: true }, collections: roots.map((root) => collection({ root })) });
  assert.deepEqual(vaultCollection(status(["/home/me/Notes/"]), "/home/me/Notes", "linux")?.prefix, "");
  assert.equal(vaultCollection(status(["/home/me/Notes/Team"]), "/home/me/Notes", "linux")?.prefix, "Team");
  assert.equal(vaultCollection(status(["/home/me/Notes2"]), "/home/me/Notes", "linux"), null);
  assert.equal(vaultCollection(status(["C:\\Users\\Me\\notes"]), "c:\\users\\me\\Notes", "win32")?.prefix, "");
});

test("pasted links and folder names are cleaned up", () => {
  assert.equal(collectionIdFrom(`obsidian://mdbase-join?collection=${ID.toUpperCase()}&name=Notes`), ID);
  assert.equal(collectionIdFrom("not an id"), null);
  assert.equal(nameFromLink(`obsidian://mdbase-join?collection=${ID}&name=%5Btest%5D%20Team%20notes`), "[test] Team notes");
  assert.equal(nameFromLink(ID), "");
  assert.equal(safeFolderName(' ..Team: "notes"/2026 '), "Team notes 2026");
  assert.equal(safeFolderName("///"), "mdbase");
});

test("scalar offsets count astral characters once", () => {
  const text = "a😀b";
  assert.deepEqual(scalarToUtf16(text, [0, 1, 2, 3]), [0, 1, 3, 4]);
  assert.equal(applyScalarEdits(text, [[2, 3, "c"], [0, 1, ""]]), "😀c");
  assert.throws(() => applyScalarEdits(text, [[0, 2, "x"], [1, 3, "y"]]), RangeError);
  assert.deepEqual(minimalChange("hello world", "hello there world"), { from: 6, to: 6, text: "there " });
  assert.equal(minimalChange("same", "same"), null);
});

function editorView(path: string, value: string, saved: string | null = value) {
  const transactions: unknown[] = [];
  const view = {
    file: { path },
    lastSavedData: saved,
    editor: {
      getValue: () => value,
      offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
      transaction: (tx: { changes: { from: { ch: number }; to?: { ch: number }; text: string }[] }) => {
        transactions.push(tx);
        const change = tx.changes[0];
        value = value.slice(0, change.from.ch) + change.text + value.slice(change.to?.ch ?? change.from.ch);
      },
    },
  };
  return { view, transactions, value: () => value };
}

test("the fence reports open notes inside the collection folder and applies only on the expected base", () => {
  const a = editorView("Team/Plan.md", "one two", "one");
  const outside = editorView("Other.md", "x");
  const fence = new EditorFence({ getLeavesOfType: () => [{ view: a.view }, { view: outside.view }, { view: {} }] }, "Team");
  assert.deepEqual(fence.report(), [{ path: "Plan.md", dirty: true, buffer: hashText("one two") }]);
  assert.deepEqual(fence.apply({ path: "Missing.md", base: hashText(""), edits: [], expected: hashText("") }), { outcome: "not_open" });
  assert.deepEqual(fence.apply({ path: "Plan.md", base: hashText("one"), edits: [[3, 3, "!"]], expected: hashText("one!") }), { outcome: "buffer_changed", buffer: "one two" });
  assert.deepEqual(fence.apply({ path: "Plan.md", base: hashText("one two"), edits: [[3, 3, " and"]], expected: hashText("one and two") }), { outcome: "applied" });
  assert.equal(a.value(), "one and two");
  assert.equal(a.transactions.length, 1);
  assert.deepEqual(fence.apply({ path: "Plan.md", base: hashText("one two"), edits: [[3, 3, " and"]], expected: hashText("one and two") }), { outcome: "applied" }, "already applied in this buffer");
  assert.equal(a.transactions.length, 1);
  const unknownSaveState = editorView("Team/Plan.md", "one", null);
  assert.equal(new EditorFence({ getLeavesOfType: () => [{ view: unknownSaveState.view }] }, "Team").report()[0].dirty, true, "unknown save state reports dirty");
});

test("comparisons show only the lines that differ, with one line around them", () => {
  assert.deepEqual(differingLines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne"), ["…\nb\nc\nd\n…", "…\nb\nX\nd\n…"]);
  assert.deepEqual(differingLines("one", "two"), ["one", "two"]);
  assert.deepEqual(differingLines("a\nb", "a\nb\nc"), ["…\nb", "…\nb\nc"]);
});
