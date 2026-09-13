# Desktop stability acceptance — 2026-09-13

Environment: Obsidian **1.13.7**, installer 1.12.7, Linux desktop. Driven through
`obsidian vault=test ...` using CLI commands, renderer `eval`, DOM button/input
interaction, and a screenshot. The exact production bundle from the stability
worktree was temporarily installed in `/home/calluma/testvault/test`.

Full live-run bundle SHA-256:
`8afaeeb6f45e720fc71d8edea7e0924e92382b8be4b0231bd9b8259910b71f4d`

A subsequent lint-only rename of the quick-fix result property (`document` to
`content`) produced final bundle SHA-256
`a0d37e38823145663cef5e272e10b41f89f3a98aa21f651d96a90b1b99058617`.
That exact final bundle was reinstalled and the live nested-field, escaped-pointer,
stale-fix, body-preservation, and validation assertions rerun successfully.
Final automated gates: **92 tests pass**, lint passes, production build and mobile
bundle checks pass.

## Live checks passed

- Plugin enable, workspace command, and type-workbench rendering.
- Validation of a temporary nested-schema type and its records using the real
  Obsidian YAML parser and Vault APIs.
- Nested additional-property removal preserves the parent and valid siblings.
- Required-property placeholders reach nested objects and objects inside lists;
  JSON Pointer escaping and literal dotted property names are preserved.
- A repeated/stale quick fix does not rewrite the file.
- The actual Issues workspace **Remove field** button updates only the intended
  field; the resulting note validates successfully.
- Actual workbench description input and **Save** button persist a type edit.
- An external edit after opening a type causes a stale-revision save to fail.
- Binary bytes round-trip through the production adapter and real Vault APIs.
- A 33 MiB local binary and an oversized incoming stream are refused; the latter
  never creates a vault file.
- Production IndexedDB adapters persist a checkpoint and binary snapshot in
  Obsidian's real Chromium IndexedDB. An interrupted replacement source preserves
  the previous snapshot. Both checkpoint and bytes survive plugin disable/enable
  and a subsequent full **test-vault reload**.
- Disabling the actual installed plugin while a production binary-adapter write
  is paused in its input stream causes the resumed write to reject with
  `AbortError: Plugin unloaded.` No destination file is materialized.
- Adoption reconciliation removes an injected completed-adoption checkpoint and
  snapshot while retaining its matching mirror role. This uses the installed
  controller class and real Vault adapter, with metadata paths redirected into
  the disposable fixture and a test-only settings/secret host. It is **not** a
  hosted enrollment/adoption round trip.
- `obsidian vault=test dev:errors` reported no captured errors.

## Defect found live and fixed

Repeated quick fixes appended trailing blank lines because they used a generic
Markdown formatter followed by an extra newline. Quick fixes now replace only
frontmatter, preserving every byte after the closing delimiter. Added a unit
regression for repeated fixes, leading/trailing whitespace, CRLF body content,
and a missing final newline. The live assertions were rerun successfully on the
rebuilt bundle after this fix.

## Isolation and cleanup

No hosted service or production Connect account was contacted. Only the existing
test vault was modified, using uniquely named temporary records/type metadata
and random IndexedDB replica keys. The original installed plugin directory was
backed up before testing. Temporary records and IndexedDB entries were removed;
the original plugin files/settings were restored and re-enabled, with a directory
comparison confirming restoration.

Local harness scripts, screenshot, results, and original-plugin backup are under
`/home/calluma/testvault/.mdbase-stability-backup-20260905/` (the suffix is the
fixture identifier, not the execution date).

## Not established by this run

- End-to-end hosted sync/enrollment/adoption against Connect LAB.
- Real Android/iOS operation, suspension, or memory-pressure behavior.
- OS process termination or power loss during a transaction.
- Real quota exhaustion or IndexedDB corruption.
- Full visual/accessibility or cross-plugin compatibility coverage.

These checks improve desktop integration confidence; they are not a claim that
all sync or mobile stability risks have been eliminated.
