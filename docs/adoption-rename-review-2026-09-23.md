# Reviewed filename repair

Sync now offers **Review renames…** for portable-path collisions. The review
shows each old/new path, then requires a separate **Rename N files** confirmation.
Cancel leaves files unchanged. Upload does not start automatically after renaming.

## Safety

- Deterministic keep-both proposals retain one original name and use numbered
  suffixes, preserving extensions and Unicode spelling.
- Reserve names against all loaded files and folders, including paths outside the
  selected upload set and other proposed destinations.
- Collection-resource collisions require manual review; no automatic rewriting
  of schemas/configuration references.
- Revalidate the reviewed namespace, source metadata, policy and proposals before
  applying. Reject stale/edited plans rather than silently choosing other names.
- Check source object identity and destination occupancy before every rename.
  Delegate to Obsidian FileManager; link updates follow the vault's preference.
- Stop on partial failure, report how many files moved, and re-check remaining
  collisions. Do not attempt an unsafe rollback over concurrent changes. A
  FileManager error after moving a file explicitly warns to check links too.
- Renaming cannot race an adoption operation or run in a frozen/mirror vault.
- Live-file conflicts do not block reconciliation of an already-frozen snapshot.
- Save the server-provided import deadline after approval instead of retaining
  only the shorter initial approval deadline in the local checkpoint.

## Verification

137 tests pass. Build, lint, whitespace and mobile bundle/import checks pass.
Tests cover deterministic proposals, Unicode/case aliases, reserved destinations,
empty folders, manual resource handling, stale/edited review, native FileManager
use, partial failures, mid-batch collisions, protected states, confirmation/cancel,
no automatic upload, and the server's updated deadline.

Installed in the registered test vault and exercised the actual review and
confirmation controls. Eight notes were renamed with automatic link updates
already enabled. All eight resulting files retained identical bytes; preflight
reports zero remaining collisions and the same 7,788 included records. The
unsaved Task-type draft was preserved. Original files and review metadata were
backed up privately at `/tmp/mdbase-rename-MC3TmS`.

The prior transfer authorization ended before activation when resumed. Its
existing terminal-state recovery retired the checkpoint without changing files.
A fresh request for the same collection is waiting for human approval; a browser
window was opened to it. Production sync completion is not claimed here.
