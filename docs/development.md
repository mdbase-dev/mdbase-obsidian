# Developing mdbase for Obsidian

Notes for working on the plugin. For what it does and how to use it, see the
[README](../README.md). How sync is built is in [sdk-sync.md](sdk-sync.md).

The plugin id is `mdbase-sync`, and its display name is **mdbase**.

## Build and test

```bash
npm install
npm test
npm run build
```

Additional gates:

```bash
npm run lint
npm run test:release
npm run check:mobile
npm run profile:testvault
npm run build:test
```

- `check:mobile` builds the bundle and checks that it loads without Node and
  stays within its size budget. Node modules load only on desktop, and only
  when sync is used.
- `build:test` copies the build to configured test vaults.
- `profile:testvault` scans the registered Obsidian vault named `test` without
  writing to it. It enforces checked-in budgets for schema loading, migration
  analysis, validation and issue rendering. Set `OBSIDIAN_TEST_VAULT` to profile
  another registered, disposable vault with the exact installed bundle.

`mdbase-test-vault/` is a small committed local collection for trying the plugin
in a real Obsidian. It has `book`, `person` and `note` types, valid records, one
record that breaks every rule of its type, and one typed only by its path. Its
`Welcome.md` says what each is for, and a unit test keeps the records
validating as described. Open a copy of it, not the committed folder, so test
runs don't leave plugin state behind. Never enroll it in Connect.

## Sync dependencies

Sync uses `@mdbase-dev/sdk` (its `thin-client` entry, loaded on demand) from the
tarball in `vendor/`. When the mdbase desktop app owns a vault, the plugin uses
the `mdbase` command-line tool that ships with the app (`mdbase --json …`) for
setup and status. mdbase interop is pinned to `0.1.0-rc.2`.

SDK updates normally arrive as automated `automation/sdk-repin` pull requests.
To update by hand:
1. Replace the tarball.
2. Update `package.json` and `package-lock.json`.
3. Rerun the tests and `npm run check:mobile`.

## Lint checks

Run `npm run lint` from the project root. It runs three checks, all with
`--max-warnings=0`:
- the `eslint-plugin-obsidianmd` 0.6.0 recommended rules;
- the newest-submission rules of Obsidian's community plugin scanner;
- Stylelint.

`npm run lint:scanner` runs the scanner check on its own.
`eslint.scanner.config.mjs` follows the full configuration and newest-layer
adjustments in the upstream 0.6.0
[configuration guide](https://github.com/obsidianmd/eslint-plugin/blob/0.6.0/docs/configuration.md#community-plugin-scanner-configuration).
Build output, tests and tooling are excluded, as in the scanner. The TypeScript
project includes `DOM.AsyncIterable` for the SDK's streaming downloads.

The repository check also validates `manifest.json` and `LICENSE` with the
plugin's `validate-manifest` and `validate-license` rules. The scanner check
leaves them off, as the scanner does.

Legacy v0.2 collection exclusion lists live in `src/legacyConfig.json`. They are
defaults from the stored collection format, not a lookup of Obsidian's runtime
config folder. Keeping them as data preserves migration and validation
behaviour for old vaults.

Settings use `getSettingDefinitions()` on Obsidian 1.13 and later, so they
appear in Obsidian's settings search. On older versions, `display()` renders
the same definitions. Mobile sync requires Obsidian 1.12.3, enforced with
`requireApiVersion` as well as an adapter capability check.

## Translations

The plugin follows Obsidian's display language. It ships English, French,
German, Spanish, Italian, Brazilian Portuguese, Russian, Japanese, Korean and
Simplified Chinese, the languages of the mdbase ecosystem, and falls back to
English for any other language. It uses the shared `@mdbase-dev/i18n` kit
(Lingui).

- Write UI text with the macros from `@lingui/core/macro`: `` t`…` ``,
  `plural(…)`, and `` msg`…` `` for text defined at module level. Write whole
  sentences with named placeholders, never fragments joined together. Format
  numbers and dates with `formatNumber` and `formatDate` from
  `src/i18n/runtime.ts`.
- Never compare translated text or decide behaviour from it. Use a code or a
  flag instead.
- The ESLint rule `plugin-review/untranslated-ui-text` flags literal text
  passed to Obsidian UI methods.
- After changing UI text, run `npm run i18n:extract` to update the PO files in
  `src/i18n/locales/`, then translate the new entries in every locale.
  `node scripts/i18n-locale-check.mjs <locale>…` lists everything still to do in
  each locale.
- A translation that is correct unchanged from English, such as a placeholder
  pattern or a word both languages share, needs its message ID in
  `i18n-policy.json` under `allowIdentical`.
- `npm run build` runs the strict `npm run i18n:check`, which needs every
  locale complete. `npm test`, `npm run dev` and lint compile the catalogues
  without it, so work in progress still runs; missing translations show in
  English.
- The release bundle stores the non-English catalogues compressed and unpacks
  only the active one. They add about 0.33 MB, which counts against the
  `check:mobile` budget.

## Behaviour details

- **Views:** canonical view files remain ordinary v0.3 records. When a
  collection materializes `_types/view.md` (normally referring to
  `schemas/v0.3/view.schema.json`), the plugin validates their nested shared
  `query` and named-view frontmatter like any other typed record. It doesn't
  execute named views or advertise the optional `view_records` feature.
- **Type packs:** **Start a collection** creates a canonical v0.3
  `mdbase.yaml` and `_types/`. It offers published
  [mdbase-contracts](https://mdbase.dev/contracts/catalog.json) packs, installed
  after review and digest verification, with a portable lockfile. Local
  customizations of starter types are preserved. Pack upgrades and custom
  mappings stay in mdbase editor.
- **Contracts:** the type workbench's application compatibility section
  discovers local record contracts under `_contracts/`. It maps contract fields
  to type fields and edits binding settings from their JSON Schema. Unknown v0.3
  schema and extension data is preserved by guided edits.
- **Drafts:** drafts with a stale source revision are blocked from saving. They
  can be compared, exported or discarded without losing newer edits.
- **Quick fixes:** quick fixes target exact nested properties, preserve sibling
  data, and use Obsidian's atomic file processing API. Ambiguous legacy nested
  paths get no automatic fix.
- **Validation:** validation reports coverage and freshness, not only an issue
  list. A stopped scan doesn't claim to be complete.
- **Transfers:** transfer review searches and paginates the full plan, and
  filters never narrow the approved transfer scope. A bad file doesn't pause
  the whole sync: independent files transfer, while blocked files and related
  moves stay untouched for retry. Unscoped inspection failures and
  competing-write protections still stop unsafe operations.
- **Migration:** migration checks that source files haven't changed since
  analysis. Any lossy conversion needs explicit consent. Backups and a recovery
  manifest go below `.mdbase/migrations/`. Configuration and type definitions
  are written one at a time and rolled back on failure, and the result is
  verified. Records are never rewritten, and existing v0.3 collections aren't
  offered migration.

## Application interoperability

The plugin hosts local application interoperability for companion plugins:

```ts
const host = app.plugins.getPlugin("mdbase-sync");
const client = host?.api.interop.connect(yourPlugin);
```

The user must turn on **Allow plugin integrations** in mdbase settings first.
It's off by default and independent of contract compatibility: matching
schemas don't authorize an application.

The bridge verifies each caller from Obsidian's active plugin registry:
- Event sources publish CloudEvents 1.0 envelopes to every compatible
  subscriber.
- Actions resolve to exactly one compatible provider. Zero providers, or more
  than one, fail explicitly.
- Every delivered event and action outcome records the exact contract version
  and digest, plus the application and implementation identity.

The bridge is cooperative, same-process transport for Obsidian plugins. It
isn't a durable runtime, and it doesn't claim durable delivery or cross-device
execution. Workflows, scheduling, retries, recovery and runtime-policy
admission belong to a Runtime 0.2 host such as Connect.

## Scope

The plugin isn't a general record editor, a query dashboard, or a Connect
server administration client.
