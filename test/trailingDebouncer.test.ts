import "obsidian";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { KeyedTrailingDebouncer } from "../src/trailingDebouncer";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("coalesces a burst into the latest value after the quiet period", async () => {
  const observed: string[] = [];
  const debouncer = new KeyedTrailingDebouncer<string, string>(15, async (value) => {
    observed.push(value);
  });

  debouncer.schedule("note.md", "a");
  await wait(5);
  debouncer.schedule("note.md", "ab");
  await wait(5);
  debouncer.schedule("note.md", "abc");

  await wait(30);
  assert.deepEqual(observed, ["abc"]);
  assert.equal(debouncer.has("note.md"), false);
});

test("does not overlap work for one key and suppresses stale publication", async () => {
  const started: string[] = [];
  const published: string[] = [];
  const first = deferred();
  const debouncer = new KeyedTrailingDebouncer<string, string>(5, async (value, isCurrent) => {
    started.push(value);
    if (value === "first") await first.promise;
    if (isCurrent()) published.push(value);
  });

  debouncer.schedule("note.md", "first");
  await wait(10);
  debouncer.schedule("note.md", "second");
  await wait(10);
  assert.deepEqual(started, ["first"]);

  first.resolve();
  await wait(15);
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(published, ["second"]);
});

test("cancel invalidates running work and removes queued work", async () => {
  const published: string[] = [];
  const task = deferred();
  const debouncer = new KeyedTrailingDebouncer<string, string>(5, async (value, isCurrent) => {
    await task.promise;
    if (isCurrent()) published.push(value);
  });

  debouncer.schedule("old.md", "old");
  await wait(10);
  debouncer.cancel("old.md");
  task.resolve();
  await wait(10);

  assert.deepEqual(published, []);
  assert.equal(debouncer.has("old.md"), false);
});
