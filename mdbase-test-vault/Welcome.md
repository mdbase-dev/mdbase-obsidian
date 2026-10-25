---
type: note
title: Welcome
---

# mdbase test vault

A small local collection for trying the plugin by hand: open **mdbase: Open
workspace**, run **mdbase: Validate collection**, or open a note in `Library/`
and run **mdbase: Validate current note**.

- `_types/`: `book` (matched by `Library/**`), `person` (`People/**`) and `note`
  (by its `type` key only).
- `Library/Broken record.md` breaks every rule of `book` on purpose.
- `Library/Untyped draft.md` is typed only by its path.

It isn't connected to mdbase Connect. To test sync, enroll a copy of it, never
this committed one.
