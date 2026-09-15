# mdbase for Obsidian

## Product promise

mdbase for Obsidian is the native Obsidian gateway to an mdbase collection. It makes type definitions understandable and safe to edit, and it connects a vault to mdbase Connect without turning Obsidian into a second administration dashboard.

The plugin supports two collection roles:

- A local collection, initialized by writing a canonical mdbase v0.3 `mdbase.yaml`.
- A hosted mirror, enrolled through mdbase Connect and synchronized into the vault through the portable directory-mirror engine.

The local vault remains useful while offline. Synchronization is explicit, observable, resumable, and conservative in the face of conflicts or ambiguous state.

## Primary users

- People who edit an mdbase collection in Obsidian and need a first-class way to understand and change its types.
- People who want a hosted mdbase Connect collection available as ordinary Markdown in an Obsidian vault.
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

### Connect a hosted collection

- Enroll using a Connect enrollment code.
- Store credentials in Obsidian SecretStorage, not plugin data or collection files.
- Preview and run mirror synchronization.
- Show progress, last successful checkpoint, failures, and conflicts in plain language.
- Refuse unsafe role changes or resource overwrites.
- Keep the workspace available when initialization fails, with plugin writes
  blocked, bounded diagnostics, and an explicit retry after verified repair.

## Product principles

- Obsidian-native: use workspace views, commands, settings, notices, and vault APIs as users expect.
- Type-first: the type workbench is the primary surface; sync management is important but secondary.
- Files remain real: configuration, types, and records stay ordinary files in the vault.
- Conservative writes: validate before saving, preflight sync writes, and leave recovery artifacts for migration.
- Mobile-capable: no Node filesystem dependency, no desktop-only path assumptions, and touch-sized controls.
- Quiet precision: prefer rows, rules, whitespace, and concise status text over cards, dashboards, or ornamental UI.
- Honest state: never imply that a sync, migration, or save succeeded until it has completed and been verified.

## Compatibility contract

- Canonical authoring target: mdbase v0.3.x.
- Compatibility input: mdbase v0.2.x is readable and validatable.
- v0.2 authoring is read-only until migration.
- Migration writes canonical v0.3 configuration and type files, retains a recovery manifest and backups, and never rewrites records.
- Hosted mirroring uses the released mdbase Connect SDK/protocol rather than a plugin-specific sync protocol.

## Out of scope

- A general-purpose record editor or database dashboard.
- Automatic background sync that cannot communicate failures to the user.
- Simultaneous ownership of the same mirror directory by multiple sync engines.
- Server administration, collection creation, billing, or access-policy management.
- Silent or automatic v0.2 migration.

## Success criteria

- A new user can initialize or enroll a vault without opening documentation.
- Type definitions are faster and safer to edit than raw YAML alone.
- A large vault remains responsive during scanning and synchronization.
- Interrupted or failed operations do not leave an unverifiable success state.
- Desktop and mobile expose the same essential capabilities with layouts appropriate to each.

