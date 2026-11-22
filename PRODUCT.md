# mdbase for Obsidian

## Product promise

mdbase for Obsidian keeps a vault in sync with an mdbase collection, on desktop and on Android, without turning Obsidian into a second administration dashboard. It also makes the collection's type definitions understandable and safe to edit when someone needs to. When the mdbase desktop app owns the folder, Obsidian connects to it; otherwise the plugin syncs the vault itself through the mdbase SDK.

The plugin supports two collection roles:

- A synced collection (Cloud copy or Private), kept in sync by the folder’s owner: mdbase desktop or the plugin’s SDK replica.
- A local collection, initialized by writing a canonical mdbase v0.3 `mdbase.yaml`.

The local vault remains useful while offline. Sync should feel like a mature desktop sync client: it runs continuously, edits from other devices arrive in open notes, network failures are ridden out, and no edit is lost. Edits made in two places are merged where possible; otherwise the person chooses, and the plugin says so in plain words.

## Primary users

- People who want their mdbase collections available as ordinary Markdown in an Obsidian vault, synced across their devices and mdbase apps.
- People who edit an mdbase collection in Obsidian and want a first-class way to understand and change its types.
- People who write in a typed vault and want their notes about books, people and projects to link to each other as those things.
- Existing mdbase v0.2 users who need to inspect their collection and migrate safely to v0.3.

## Core jobs

### Sync a vault

- Sign in through the browser. The SDK keeps its account state in per-vault browser storage; credentials are never written into synced files.
- Turn sync on as Cloud copy or Private, or add a collection already synced on another device.
- Tell synced, sending, offline, waiting for approval, stopped and signed-out apart, with the next step. Every state has a way forward: no screen leaves the person with nothing to press.
- Let the person decide about files changed in two places, and check merges mdbase made on its own.
- Sign out of this vault, and say plainly if mdbase could not be told.
- Keep record validation separate from sync; never silently repair records during sync.
- Keep trust machinery (keys, devices, fingerprints) out of the plugin, and app access in mdbase (**Manage apps** links there).

### Work with types

- Browse and search type definitions without hunting through `_types`.
- Edit identity, membership rules, JSON Schema fields, lifecycle metadata, and extension data.
- Switch between a guided design surface and the canonical YAML.
- See validation and compatibility implications before saving.
- Preserve unknown extension fields rather than silently discarding them.
- Use the same core workflow on desktop and mobile.

### Link notes by type

- Link to a note from the note being written, seeing each candidate's name and type.
- Create the note a link needs without leaving the sentence: of the chosen type, in that type's folder, with what the type requires.
- Settle a link property whose note is missing by creating the note its type calls for.
- Leave Obsidian's own links, properties and backlinks as they are. This adds what types know; it does not replace them.

### Manage a collection

- Initialize an unconfigured vault as a canonical mdbase v0.3 collection.
- Read and validate mdbase v0.2 collections without mutating them.
- Produce a migration plan from v0.2 to v0.3, including diagnostics and recovery information.
- Apply migration only after explicit review. Do not rewrite records as part of schema migration.

## Product principles

- Obsidian-native: use workspace views, commands, settings, notices, and vault APIs as users expect.
- Sync first: most people come to mdbase to sync, so the workspace opens on Sync. Types are the power tool: most people rarely edit a type definition by hand, but when they do, the type workbench should make it fast and safe.
- Types at work while writing: a type earns its keep when creating and linking notes, not only when checking them. That help arrives in the editor, through Obsidian's own suggestion list and forms.
- Files remain real: configuration, types, and records stay ordinary files in the vault.
- Conservative writes: validate before saving and leave recovery artifacts for migration.
- Mobile-capable: types, validation and sync work on phones and tablets with touch-sized controls. Sync code loads only when sync is used; Node-only code loads only on desktop.
- Quiet precision: prefer rows, rules, whitespace, and concise status text over cards, dashboards, or ornamental UI.
- Honest state: never imply that a sync, sign-out, migration, or save succeeded until it has completed and been verified.

## Compatibility contract

- Canonical authoring target: mdbase v0.3.x.
- Compatibility input: mdbase v0.2.x is readable and validatable.
- v0.2 authoring is read-only until migration.
- Migration writes canonical v0.3 configuration and type files, retains a recovery manifest and backups, and never rewrites records.
- Sync uses the mdbase SDK and desktop app rather than a plugin-specific sync protocol.

## Out of scope

- A general-purpose record editor or database dashboard. Linking and creating notes by type is part of writing; tables, boards and a record browser are not.
- Replacing Obsidian's Properties panel or backlinks pane. Neither can be extended through Obsidian's public API, and the plugin does not reach past it.
- Automatic background sync that cannot communicate failures to the user. Background sync reports problems in the status bar and Sync destination and backs off rather than failing silently.
- Sync on iPhone and iPad (not yet: the Sync tab says so in plain words). Obsidian serves plugins there from `capacitor://localhost`, which sync and Connect haven't been qualified for.
- Creating, approving or serving Private collections from Obsidian. Phones and Obsidian join and sync; the desktop app stays the always-on device.
- Listing or suggesting other apps. Which apps can use a collection is managed in mdbase.
- Server administration, billing, or access-policy management.
- Silent or automatic v0.2 migration.

## Success criteria

- A new user can turn on sync or start a collection without opening documentation.
- No sync state is a dead end: each one names what happened and offers the next step.
- Type definitions are faster and safer to edit than raw YAML alone.
- A large vault remains responsive during scanning and synchronization.
- Interrupted or failed operations do not leave an unverifiable success state.
- Desktop and mobile expose the same essential capabilities with layouts appropriate to each.
