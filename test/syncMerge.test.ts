import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { mergeDocuments } from "../src/syncMerge";

const validYaml = (text: string) => {
  try {
    const value: unknown = parse(text);
    return value === null || (typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
};

const merge = (base: string, local: string, remote: string) => mergeDocuments(base, local, remote, validYaml);

const doc = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n${body}`;

test("edits to different fields on two devices merge, even on adjacent lines", () => {
  const base = doc("status: open\npriority: low\ntitle: Plan", "Body\n");
  const local = doc("status: done\npriority: low\ntitle: Plan", "Body\n");
  const remote = doc("status: open\npriority: high\ntitle: Plan", "Body\n");
  assert.deepEqual(merge(base, local, remote), {
    clean: true,
    text: doc("status: done\npriority: high\ntitle: Plan", "Body\n"),
  });
});

test("frontmatter and body edits merge independently", () => {
  const base = doc("status: open", "\nFirst paragraph.\n\nSecond paragraph.\n");
  const local = doc("status: done", "\nFirst paragraph.\n\nSecond paragraph.\n");
  const remote = doc("status: open", "\nFirst paragraph.\n\nSecond paragraph, revised.\n");
  assert.deepEqual(merge(base, local, remote), {
    clean: true,
    text: doc("status: done", "\nFirst paragraph.\n\nSecond paragraph, revised.\n"),
  });
});

test("body edits in separate places merge; the same line edited twice does not", () => {
  const base = "# Title\n\nalpha\n\nbeta\n\ngamma\n";
  assert.deepEqual(merge(base, base.replace("alpha", "ALPHA"), base.replace("gamma", "GAMMA")), {
    clean: true,
    text: "# Title\n\nALPHA\n\nbeta\n\nGAMMA\n",
  });
  assert.equal(merge(base, base.replace("beta", "local"), base.replace("beta", "remote")).clean, false);
});

test("the same field changed differently on both devices keeps both versions", () => {
  const base = doc("status: open", "");
  assert.equal(merge(base, doc("status: done", ""), doc("status: blocked", "")).clean, false);
});

test("a field added on the other device lands after the field it followed there", () => {
  const base = doc("title: Plan\nstatus: open", "Body\n");
  const local = doc("title: Plan\nstatus: done", "Body\n");
  const remote = doc("title: Plan\ndue: 2026-10-02\nstatus: open", "Body\n");
  assert.deepEqual(merge(base, local, remote), {
    clean: true,
    text: doc("title: Plan\ndue: 2026-10-02\nstatus: done", "Body\n"),
  });
});

test("a field removed on one device and untouched on the other stays removed", () => {
  const base = doc("title: Plan\ndraft: true\nstatus: open", "");
  const local = doc("title: Plan\nstatus: open", "");
  const remote = doc("title: Plan\ndraft: true\nstatus: done", "");
  assert.deepEqual(merge(base, local, remote), { clean: true, text: doc("title: Plan\nstatus: done", "") });
});

test("multi-line field values move as a unit", () => {
  const base = doc("tags:\n  - a\n  - b\nstatus: open", "");
  const local = doc("tags:\n  - a\n  - b\n  - c\nstatus: open", "");
  const remote = doc("tags:\n  - a\n  - b\nstatus: done", "");
  assert.deepEqual(merge(base, local, remote), { clean: true, text: doc("tags:\n  - a\n  - b\n  - c\nstatus: done", "") });
});

test("byte order marks and Windows line endings survive a merge", () => {
  const base = "﻿---\r\nstatus: open\r\ntitle: A\r\n---\r\nBody\r\n";
  const local = "﻿---\r\nstatus: done\r\ntitle: A\r\n---\r\nBody\r\n";
  const remote = "﻿---\r\nstatus: open\r\ntitle: B\r\n---\r\nBody\r\n";
  assert.deepEqual(merge(base, local, remote), { clean: true, text: "﻿---\r\nstatus: done\r\ntitle: B\r\n---\r\nBody\r\n" });
});

test("blank lines in empty frontmatter survive an independent body edit", () => {
  const base = doc("", "Body\n");
  const local = doc("\nstatus: done", "Body\n");
  const remote = doc("", "Changed body\n");
  assert.deepEqual(merge(base, local, remote), {
    clean: true,
    text: doc("\nstatus: done", "Changed body\n"),
  });
});

test("a hosted field reorder is never silently discarded", () => {
  const base = doc("title: Plan\nstatus: open\npriority: low", "Body\n");
  const local = doc("title: Plan\nstatus: done\npriority: low", "Body\n");
  const remote = doc("priority: low\ntitle: Plan\nstatus: open", "Body\n");
  const result = merge(base, local, remote);
  if (result.clean) assert.equal(result.text, doc("priority: low\ntitle: Plan\nstatus: done", "Body\n"));
});

test("changes to a closing fence's line ending are not silently discarded", () => {
  const base = doc("status: open", "Body\n");
  const local = doc("status: done", "Body\n");
  const remote = base.replace("\n---\n", "\n---\r\n");
  assert.deepEqual(merge(base, local, remote), {
    clean: true,
    text: local.replace("\n---\n", "\n---\r\n"),
  });
});

test("CRLF flow values at the end of frontmatter validate without a bare CR", () => {
  const base = doc("status: open\ntags: [a]", "Body\n").split("\n").join("\r\n");
  const local = base.replace("status: open", "status: done");
  const remote = base.replace("[a]", "[a, b]");
  assert.deepEqual(merge(base, local, remote), { clean: true, text: local.replace("[a]", "[a, b]") });
});

test("trivial cases need no merge at all", () => {
  assert.deepEqual(merge("a", "a", "b"), { clean: true, text: "b" });
  assert.deepEqual(merge("a", "b", "a"), { clean: true, text: "b" });
  assert.deepEqual(merge("a", "c", "c"), { clean: true, text: "c" });
});

test("frontmatter added on only one side, or a merge that breaks YAML, keeps both versions", () => {
  assert.equal(merge("Body\n", doc("a: 1", "Body\n"), "Body changed\n").clean, false);
  const base = doc("a: 1\nb: 2", "");
  const result = mergeDocuments(base, doc("a: 3\nb: 2", ""), doc("a: 1\nb: 4", ""), () => false);
  assert.equal(result.clean, false);
});
