# mdbase for Obsidian

The Obsidian gateway to mdbase v0.3 collections and mdbase sync.

The plugin is deliberately type-first. Its main workspace provides:

- a searchable type workbench with guided and YAML editing;
- local collection initialization;
- read-only support for mdbase v0.2.x and reviewed migration to v0.3.x;
- sync through the mdbase desktop app: sign-in, Private or Cloud copy
  collections, live status, and decisions about edits made in two places;
- collection validation with bounded issue rendering for large vaults.

Types and validation work through Obsidian's Vault APIs on desktop and mobile.
Sync is desktop-only: the plugin talks to the mdbase desktop app on the same
computer and never syncs files itself. Node modules and the sync client load
only when sync is used, so the bundle stays safe on mobile (checked by
`npm run check:mobile`).

Canonical view files remain ordinary v0.3 records in this adapter. When a
collection materializes `_types/view.md` (normally referring to
`schemas/v0.3/view.schema.json`), the plugin validates their nested shared
`query` and named-view frontmatter like any other typed record. This plugin does
not execute named views or advertise the optional `view_records` feature; it
leaves execution and presentation to query-capable companion tools.

## Collection roles

On first open, the workspace asks where the collection lives. **Start a
collection** makes this vault a local mdbase collection. The **Sync** tab turns
sync on for the vault, or adds a collection you already sync on another device.

### Local collection

**Start a collection** creates a canonical v0.3 `mdbase.yaml` and `_types/`
directory. The vault is authoritative and remains an ordinary collection of
files. First run offers published [mdbase-contracts](https://mdbase.dev/contracts/catalog.json)
packs with reviewed, digest-verified installation and a portable lockfile;
it does not invent a starter type. Local starter customizations are preserved.
Pack upgrades and custom mappings remain in mdbase editor.

### Sync

Sync needs the mdbase desktop app on the same computer. The app runs a
background service that watches the vault folder and syncs it; the plugin is a
window onto it. Obsidian keeps saving files as usual, and edits from other
devices arrive in open notes without losing the cursor.

- **Sign in** opens the mdbase sign-in page in the browser (with **Copy sign-in
  link** if no browser opens). Sign-in belongs to the computer, not the vault.
- **Sync this vault** offers **Cloud copy** (recommended: mdbase keeps a copy
  online, so web apps and new devices get notes straight away) or **Private**
  (end-to-end encrypted; a new device needs approval from one you already use).
- **Add a collection you already sync** takes the link copied from another
  device's Sync tab. An empty vault becomes the collection; otherwise it goes
  into a new folder.
- The first time Obsidian talks to the app, the app asks to allow it.

The status bar and the Sync tab say whether the vault is synced, sending or
getting changes, offline (changes stay on this computer), waiting for approval,
or stopped, in plain words with the next step. Files changed in two places at
once are listed with **Keep this computer's**, **Use the other version** and
**Keep both**; edits that mdbase merged on its own are listed under "changes to
check", with a way to use the other value. **Copy link** shares the collection
with your other devices.

Settings carry sign-out, disconnecting this vault (notes stay; other devices
keep syncing) and the app location for unusual installs. Phones and tablets
show types and validation; sync there is not available yet.

Commands: **Open workspace**, **Open sync**, **Create type definition**, **Edit
type definition** (the current note's type, or a picker), **Create note from
type**, **Validate current note** and **Validate collection**. **Initialize
collection** appears only when it applies.

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
- Stale drafts can be compared, exported or explicitly discarded without losing
  newer edits.
- `New note` opens one validated form with a location preview and retained input.
- Validation quick fixes target exact nested properties, preserve sibling data,
  and use Obsidian's atomic file processing API. Ambiguous legacy nested paths
  are not offered automatic fixes.
- v0.2 definitions are browsable but read-only until migration.

Validation reports coverage and freshness, not merely an empty issue list.
Collection scans show progress and can be stopped without claiming completion.
Transfer review searches and paginates the full plan; filters never narrow the
approved transfer scope. A bad file no longer pauses the entire sync: independent
files transfer while blocked files and related moves remain untouched for retry.
Unscoped inspection failures and competing-write protections still stop unsafe
operations. See [UX acceptance](docs/user-experience-acceptance.md)
for the live Obsidian harness, verification evidence and implementation limits.

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

Additional gates:

```bash
npm run check:mobile
npm run profile:testvault
npm run build:test
```

`build:test` copies the build to configured test vaults.
`profile:testvault` scans the registered Obsidian vault named `test` without
writing it and enforces checked-in schema, migration-analysis, validation, and
issue-render budgets. Set `OBSIDIAN_TEST_VAULT` to profile another registered
disposable vault with the exact installed bundle.

`mdbase-test-vault/` is a small committed local collection for trying the
plugin in a real Obsidian: `book`, `person` and `note` types, valid records,
one record that breaks every rule of its type, and one typed only by its path.
Its `Welcome.md` says what each is for, and a unit test keeps the records
validating as described. Open a copy of it, not the committed folder, so test
runs don't leave plugin state behind; never enroll it in Connect.

Sync uses `@mdbase-dev/sdk` (its `thin-client` entry, loaded on demand) from
the tarball in `vendor/`, and the `mdbase` command-line tool that ships with the
desktop app (`mdbase --json …`) for setup and status. mdbase interop is pinned to
`0.1.0-rc.2`. To update the SDK, replace the tarball, update `package.json` and
`package-lock.json`, and rerun the tests and `npm run check:mobile`.

## Compatibility

- Authoring target: mdbase v0.3.x
- Read and migration input: mdbase v0.2.x
- Obsidian minimum version: 1.11.4
- Types and validation on desktop and mobile; sync on desktop (Windows, macOS,
  Linux) with the mdbase desktop app

The plugin is not a general record editor, query dashboard, or Connect server
administration client.
