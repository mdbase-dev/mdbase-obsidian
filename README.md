# mdbase for Obsidian

The Obsidian gateway to mdbase v0.3 collections and mdbase Connect.

The plugin is deliberately type-first. Its main workspace provides:

- a searchable type workbench with guided and YAML editing;
- local collection initialization;
- read-only support for mdbase v0.2.x and reviewed migration to v0.3.x;
- hosted collection enrollment, sync preview, mirroring, progress, and conflict handling;
- collection validation with bounded issue rendering for large vaults.

It works through Obsidian's Vault, HTTP, IndexedDB, and SecretStorage APIs. The
production bundle has no Node filesystem dependency and is checked against a
mobile bundle budget.

Canonical view files remain ordinary v0.3 records in this adapter. When a
collection materializes `_types/view.md` (normally referring to
`schemas/v0.3/view.schema.json`), the plugin validates their nested shared
`query` and named-view frontmatter like any other typed record. This plugin does
not execute named views or advertise the optional `view_records` feature; it
leaves execution and presentation to query-capable companion tools.

## Collection roles

### Local collection

`Initialize this vault` creates a canonical v0.3 `mdbase.yaml` and `_types/`
directory. The vault is authoritative and remains an ordinary collection of
files.

### Hosted mirror

`Connect a hosted collection` enrolls the vault through mdbase Connect. The
portable directory-mirror engine syncs hosted resources, records, and opt-in
collection files into the vault. A mirror role marker is stored below
`.mdbase/`; credentials are stored only in Obsidian SecretStorage.

The plugin refuses to enroll a directory that contains local collection
authority metadata. Sync is explicit, preflighted, protected by an in-process
lease, and conservative around conflicts.

Before every sync, the workspace presents an exact transfer ledger grouped by
downloads, uploads, and items needing attention. If the hosted head or local
changes move after review, the plugin stops and asks for a fresh review. Sync
can be stopped safely after the current request without losing its durable
checkpoint, and path collisions never overwrite local files silently. Disabling
the plugin cancels sync/enrollment/adoption and fences subsequent mirror content
writes; an already-issued Vault write or HTTP request may still finish.

Markdown always syncs. Binary files are an explicit per-device choice, grouped
as images, audio, video, PDFs, and other files, with collection-relative folder
exclusions. Hidden, reserved, Markdown, and non-portable file paths are never
materialized. Downloads and uploads are digest-verified; writable uploads are
staged in a chunked, content-addressed IndexedDB cache so an interrupted sync
can resume safely. Binary sync and adoption currently enforce a **32 MiB per-file
limit** on desktop and mobile: Obsidian's Vault APIs require whole-file buffers,
so chunked network transfer does not imply bounded-memory streaming. Oversized
files fail explicitly; exclude their folder from file sync before retrying.
Binary creates, updates, moves, deletes, and conflicts appear
as files—not Markdown—in the preflight ledger. Local collection adoption uses
the same policy and stages exact bytes for both warm and fenced snapshots.

The status bar reports whether the mirror is synced, has changes waiting, is
transferring a named file, is paused, or needs attention. The sync workspace
keeps a bounded recent-activity ledger, shows byte progress for large files,
and translates expired approval, offline service, stale review, cancellation,
and durable recovery into explicit next actions. Conflict review provides a
bounded Markdown diff or binary metadata and a local image preview, with
**Keep local**, **Use hosted**, and collision-safe **Keep both** decisions.

Disconnecting is explicit: retain the vault as a local unsynced copy, or remove
only files that still exactly match the last durable checkpoint. Locally
changed files are always preserved. The plugin removes the connection before
it starts file deletion, so failed settings persistence cannot turn local
cleanup into remote deletions.

Useful Obsidian commands include **mdbase: Review sync changes**, **mdbase: Sync
now**, **mdbase: Cancel current sync**, **mdbase: Open sync activity**,
**mdbase: Resolve sync conflicts**, and **mdbase: Reconnect collection**.

## Initialization recovery

Unreadable settings or invalid authority checkpoints no longer prevent the plugin
workspace from loading. A **Collection recovery** screen explains what failed,
keeps plugin writes/settings/sync blocked, offers a redacted diagnostic summary,
and lets you retry after repairing the underlying state. It never offers a
shortcut that deletes authority checkpoints or overwrites settings with defaults.
Other plugins and normal Obsidian editing are not locked.

See [recovery and acceptance gates](docs/recovery-and-lab-acceptance.md) for the
implemented boundaries, opt-in live CLI test, and remaining hosted LAB scenarios.

## Type workbench

Open **mdbase: Open workspace** and choose **Types**.

- Design mode edits identity, membership, placement, and recursive field
  schemas—including nested objects, lists, lists of objects, enums, and links.
- The application compatibility section discovers local record contracts under
  `_contracts/`, lets you map contract fields to type fields, and edits binding
  settings from their JSON Schema.
- YAML mode exposes the canonical type definition.
- Unknown v0.3 schema and extension data is preserved by guided edits.
- Drafts survive plugin reloads and Obsidian restarts; stale source revisions
  are blocked, and high-impact schema changes require an explicit review.
- Dirty changes and validation failures are shown before save.
- Validation quick fixes target exact nested properties, preserve sibling data,
  and use Obsidian's atomic file processing API. Ambiguous legacy nested paths
  are not offered automatic fixes.
- v0.2 definitions are browsable but read-only until migration.

On mobile, the type list and editor use separate navigation states with
touch-sized actions instead of a compressed desktop split view.

## Migrating v0.2 to v0.3

The migration review shows the source and target versions, every planned write,
warnings, lossy diagnostics, record-equivalence results, and the recovery
location.

Migration:

- verifies that source files have not changed since analysis;
- requires explicit consent for any lossy conversion;
- writes backups and a recovery manifest below `.mdbase/migrations/`;
- writes configuration and type definitions sequentially and rolls back on
  failure;
- verifies the result;
- never rewrites records.

Existing v0.3 collections are not offered migration.

## Application interoperability

The plugin also hosts local application interoperability for companion plugins:

```ts
const host = app.plugins.getPlugin("mdbase-obsidian");
const client = host?.api.interop.connect(yourPlugin);
```

Enable **Allow local application interoperability** in mdbase settings first.
The grant is deliberately off by default and is independent of contract
compatibility: matching schemas do not authorize an application.

The bridge verifies each caller from Obsidian's active plugin registry. Event
sources publish CloudEvents 1.0 envelopes to every compatible subscriber.
Actions resolve to exactly one compatible provider; zero providers and
ambiguous providers fail explicitly. Every delivered event and action outcome
records the exact contract version and digest plus application and
implementation identity.

The bridge is cooperative, same-process transport for Obsidian plugins. It does
not claim to be a durable runtime: workflows, scheduling, retries, recovery,
and runtime-policy admission belong to a Runtime 0.2 host such as Connect. It
does not claim durable delivery or cross-device execution.

## Development

```bash
npm install
npm test
npm run build
```

Stability regression tests cover interrupted adoption cleanup, unload during
binary materialization, nested quick fixes, binary size limits, and production
IndexedDB adapters using `fake-indexeddb` (including aborted transactions and
mirror restart recovery). These are not a substitute for real Obsidian/mobile
suspension, quota, and restart acceptance testing.

Additional gates:

```bash
npm run check:mobile
npm run profile:testvault
npm run build:test
npm run build:test:staging
```

`build:test` copies the production-default build to configured test vaults.
`build:test:staging` builds the enrollment UI with
`https://connect-staging.mdbase.dev` as its default and copies that exact bundle.
`profile:testvault` scans the registered Obsidian vault named `test` without
writing it and enforces checked-in schema, migration-analysis, validation, and
issue-render budgets. Set `OBSIDIAN_TEST_VAULT` to profile another registered
disposable vault with the exact installed bundle.

The Connect protocol and sync SDKs are pinned to `0.1.0-beta.91`, and mdbase
interop is pinned to `0.1.0-rc.2`. Update `package.json`, regenerate
`package-lock.json`, and rerun the binary round-trip and mobile gates when
advancing them.

## Compatibility

- Authoring target: mdbase v0.3.x
- Read and migration input: mdbase v0.2.x
- Obsidian minimum version: 1.11.4
- Desktop and mobile supported

The plugin is not a general record editor, query dashboard, or Connect server
administration client.
