# mdbase for Obsidian

## Product promise

mdbase for Obsidian is the native Obsidian gateway to an mdbase collection. It makes type definitions understandable and safe to edit, and it syncs a vault without turning Obsidian into a second administration dashboard. When the mdbase desktop app owns the folder, Obsidian connects to it; otherwise the plugin uses the mdbase SDK.

The plugin supports two collection roles:

- A local collection, initialized by writing a canonical mdbase v0.3 `mdbase.yaml`.
- A synced collection (Cloud copy or Private), kept in sync by the folder’s owner: mdbase desktop or the plugin’s SDK replica.

The local vault remains useful while offline. Sync should feel like a mature desktop sync client: it runs continuously, edits from other devices arrive in open notes, network failures are ridden out, and no edit is lost. Edits made in two places are merged where possible; otherwise the person chooses, and the plugin says so in plain words.

## Primary users

- People who edit an mdbase collection in Obsidian and need a first-class way to understand and change its types.
- People who want their mdbase collections available as ordinary Markdown in an Obsidian vault, synced across their devices.
- Existing mdbase v0.2 users who need to inspect their collection and migrate safely to v0.3.

## Core jobs

### Work with types

- Browse and search type definitions without hunting through `_types`.
- Edit identity, membership rules, JSON Schema fields, lifecycle metadata, and extension data.
- Switch between a guided design surface and the canonical YAML.
- See validation and compatibility implications before saving.
- Preserve unknown extension fields rather than silently discarding them.
- Use the same core workflow on desktop and mobile.

### Manage a collection

- Initialize an unconfigured vault as a canonical mdbase v0.3 collection.
- Read and validate mdbase v0.2 collections without mutating them.
- Produce a migration plan from v0.2 to v0.3, including diagnostics and recovery information.
- Apply migration only after explicit review. Do not rewrite records as part of schema migration.

### Sync a vault

- Sign in through the browser. The SDK keeps its account state in per-vault browser storage; credentials are never written into synced files.
- Turn sync on as Cloud copy or Private, or add a collection already synced on another device.
- Tell synced, sending, offline, waiting for approval, stopped and signed-out apart, with the next step.
- Let the person decide about files changed in two places, and check merges mdbase made on its own.
- Keep record validation separate from sync; never silently repair records during sync.
- Keep trust machinery (keys, devices, fingerprints) out of the plugin.

## Product principles

- Obsidian-native: use workspace views, commands, settings, notices, and vault APIs as users expect.
- Type-first: the type workbench is the primary surface; sync management is important but secondary.
- Files remain real: configuration, types, and records stay ordinary files in the vault.
- Conservative writes: validate before saving and leave recovery artifacts for migration.
- Mobile-capable: types and validation work on phones and tablets with touch-sized controls; desktop-only code loads only for sync.
- Quiet precision: prefer rows, rules, whitespace, and concise status text over cards, dashboards, or ornamental UI.
- Honest state: never imply that a sync, migration, or save succeeded until it has completed and been verified.

## Compatibility contract

- Canonical authoring target: mdbase v0.3.x.
- Compatibility input: mdbase v0.2.x is readable and validatable.
- v0.2 authoring is read-only until migration.
- Migration writes canonical v0.3 configuration and type files, retains a recovery manifest and backups, and never rewrites records.
- Sync uses the mdbase SDK and desktop app rather than a plugin-specific sync protocol.

## Out of scope

- A general-purpose record editor or database dashboard.
- Automatic background sync that cannot communicate failures to the user. Background sync reports problems in the status bar and Sync destination and backs off rather than failing silently.
- Syncing on phones and tablets (not yet).
- Server administration, collection creation, billing, or access-policy management.
- Silent or automatic v0.2 migration.

## Success criteria

- A new user can start a collection or turn on sync without opening documentation.
- Type definitions are faster and safer to edit than raw YAML alone.
- A large vault remains responsive during scanning and synchronization.
- Interrupted or failed operations do not leave an unverifiable success state.
- Desktop and mobile expose the same essential capabilities with layouts appropriate to each.

