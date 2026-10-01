# Temporary Connect sync SDK reliability patch

`@mdbase-dev/connect-sync` is pinned to beta.120 (with `connect-protocol` at the
same version). `npm ci` applies the adjacent version-specific patch through
`postinstall` and fails if it cannot apply. The plugin bundle includes the patched
SDK; no patching occurs in users' vaults.

The patch was rebased from beta.91 without changing its effect. The published
beta.120 distribution and the Connect source at its release contain none of the
fixes below; against unpatched beta.120, five tests in `test/v3-foundations.test.ts`
fail. When upgrading again, run `npm ci --ignore-scripts && npm test` first to
see which fixes the new release carries.

These fixes belong in the upstream SDK and are proposed there on the
`feat/sync-just-works` branch of mdbase-connect (the same changes, in source, with
SDK tests). This patch keeps clean builds reproducible without requiring an
unpublished package or modifying a separate Connect checkout.
When a released SDK includes them, upgrade both Connect packages, remove this patch
and the patch-package tooling, and retain the integration regression tests.

Changes (published distribution files; no protocol change; the only persisted-state
addition is the optional `ancestor_document` below):

- `mirror-materializer.js` / `mirror-state.d.ts`: pass the last inspected text to
  `write(path, value, expected)`. Obsidian checks it inside `Vault.process`, rather
  than performing an unconditional `Vault.modify`. `null` means the destination
  must be absent. Existing adapters may ignore the optional argument; the safety
  guarantee applies to this plugin's conditional-write implementation. This uses
  Obsidian's serialized read/modify/write contract, not an OS-wide lock against
  arbitrary external writers.
- `mirror-materializer.js` / `mirror-state.d.ts`: pass the inspected binary
  destination to `writeBinary(path, source, expected)`. `null` requires absence;
  otherwise the plugin rechecks digest/size after draining the stream. This
  prevents a competing create/edit between SDK preflight and adapter invocation
  from becoming the overwrite baseline. Existing adapters may ignore this
  optional argument. Obsidian has no binary `Vault.process`, so this is a
  pre-write check rather than an OS-wide atomic compare-and-swap. This API still
  needs an upstream SDK source port before removing/upgrading the patch.
  Regression: `test/syncReliability.test.ts` SDK binary preflight race.
- `mirror-materializer.js` / `mirror-state.d.ts`: pass inspected text/binary
  expectations to managed-file removal (`remove(path, expected)`) and recheck
  them in the plugin before trashing. This rejects competing edits between SDK
  preflight and adapter removal. Like binary writes, it is a pre-trash check,
  not an OS-wide atomic delete. The optional argument is backward compatible
  with old adapters and needs an upstream SDK source port. Regression:
  `test/syncReliability.test.ts` SDK delete preflight race and binary removal.
  `directory-mirror.js` also binds hosted-deletion conflict resolution to the
  inspected local revision and passes its expected bytes to removal; binary
  binding cleanup does likewise. `sync-executor.js` checks the expected resource
  revision before its missing-metadata removal branch. These close the same gap
  outside MirrorMaterializer; the final trash API still is not atomic.
- `sync-inspector.js` / `mirror-state.d.ts`: optional physical `pathKind` detects
  destination directories and ancestor files. Blocking issues enter the normal
  planner/fingerprint instead of creating an impossible transfer. No local file
  or directory is removed to resolve an obstruction.
- `sync-inspector.js` / `sync-executor.js`: retain remote file descriptors during
  review and fetch verified blobs only when executing the prepared action. The
  controller's sync cancellation and byte-progress callbacks now cover downloads.
  Failed/cancelled downloads keep a recoverable journal but do not advance the
  checkpoint or install partial bytes. Resumption fetches/verifies missing blobs.
- `sync-executor.js`: persist `cancelled`, not a generic blocked failure, when the
  apply signal aborts during a transfer.
- `sync-planner.js`: scoped inspection issues isolate only the affected objects
  and connected path transitions. Independent uploads, downloads and conflicts
  remain in the fingerprinted plan. Unscoped failures still stop planning.
  Path ownership is indexed so many blocked files do not cause a quadratic scan.
  Partial completion retains the old cursor, ensuring skipped remote changes are
  revisited; completed effects retain their normal receipts and managed bases.
- `sync-executor.js`: the special receive-only malformed-frontmatter repair
  allowance applies only to that explicitly identified target, never every
  download in a partial plan. Conditional writes remain enforced.
- `directory-mirror.js`: a hosted conflict resolution accepts only the inspected
  local document revision, not whatever bytes happen to exist after loading the
  authority snapshot. A user edit or recreated file during that await leaves
  the decision stale instead of silently overwriting bytes absent from the copy.
  Ported exactly from mdbase-connect `56dabd74` (local revalidation after the
  snapshot, decision-bound `acceptedHash`). Integration regression:
  `test/connectSync.settlement.test.ts`.
- `directory-mirror.js` / `.d.ts`: `resolveConflict(identity, decisionId, "local",
  mergedDocument?)` optionally persists a merged record with the adapter's
  conditional write before clearing its durable conflict. Without this ordering,
  a hard restart between clearing and the plugin's write could upload unmerged
  local text over the hosted edit. Only an exact local record accepts a merged
  document; a failed write leaves the conflict intact. No protocol or persisted
  state change. This additional SDK API needs an upstream source port before
  upgrading/removing the patch. Regressions simulate restart at the write
  boundary, disk-full failure, and a user edit during the atomic write.
- `directory-mirror.js`: partial completion reports attention, not failure or
  falsely complete synchronization, while preserving its unresolved diagnostics.
- `directory-mirror.js`: release stale batches at the SDK's existing safe journal
  boundary (earlier effects have receipts) so the next explicit review can show a
  competing edit rather than repeatedly executing the old plan.

- `mirror-materializer.js`: a receive-only repair over bytes that are not valid
  UTF-8 reads with `readText` and writes with no text expectation (`undefined`),
  instead of throwing on the read. The plugin adapter then replaces the bytes.
- `directory-mirror.js` / `.d.ts`: `review()` returns the plan and its status from
  one inspection under one lease; `status()` uses it. The plugin used to inspect
  the vault and authority two or three times per sync.
- `sync-executor.js` / `mirror-state.js` / `.d.ts`: a recorded record conflict
  keeps the last common version as optional `ancestor_document` (captured once,
  before the base is rebased onto the remote; validated on load; not part of the
  decision). The plugin uses it for its three-way merge; without it, a merge
  would have to treat the hosted version as the ancestor and drop hosted edits.

Regression coverage is in `test/v3-foundations.test.ts` and `test/syncReliability.test.ts`: the real SDK planner,
executor, journal, and Obsidian adapter run against MemoryAuthority, with controlled
interleavings. Tests cover competing writes, conflict recovery, path obstructions,
metadata-only status/review, cancelled transfers/restart, corrupt-blob recovery,
partial uploads/downloads, unreadable managed files without accidental deletes,
related rename isolation, cursor retention and retry after repairs.
