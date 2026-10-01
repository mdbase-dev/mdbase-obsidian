# UX changes and acceptance

## User-facing changes

- Validation distinguishes unchecked notes, partial coverage, completed scans and changed data. Completion includes uniqueness checking. Progress and Stop are available without waiting for the workbench's record scan; stopped or failed scans retain partial diagnostics without claiming completion. Validation freshness is session-local, so reopening the app never presents unchecked data as valid.
- Stale type drafts remain recoverable separately from current edits. Compare shows the current source and saved draft; export produces a standalone text copy; discard requires confirmation. Starting or saving another draft does not delete older recovery copies.
- Typed creation is one form with retained inputs, enum/boolean/date controls, inline constraint errors and a location preview. Numeric input is strict; structured lists accept YAML/JSON. Suggestions do not create folders. Excluded definition folders and unsafe paths are rejected.
- Transfer review searches and filters the full plan, with independent 250-row pages per direction. Every entry remains reachable without unbounded DOM growth. Filters never change the plan approved for transfer.
- Local first run offers the published **mdbase-contracts** catalog, rather than manufacturing starter types. Installation reviews files, verifies published SHA-256 digests, preserves editable local starters and writes portable `mdbase.lock.yaml`. A durable rollback journal recovers interrupted installations and preserves competing edits. Fresh installs and same-version repairs are supported; upgrades, custom resource mappings and hosted mirror installs direct users to mdbase editor.
- Workspace navigation, selected type, search/filter state, editor mode and disclosures persist through Obsidian view state. Transfer plans/approvals never persist. Restoring a type also restores the matching model, not merely its path.
- Attachment exclusions use folder suggestions and removable chips, including folder names containing commas. The UI explains scope, the 32 MiB limit and the treatment of already-synced files.

## Automated checks

```sh
npm test
npm run lint
npm run build
npm run check:mobile
```

Final verification including resilient partial sync: **204 tests passed, 0 failed**; TypeScript/CSS lint and build passed. All nine live stages passed, with no captured Obsidian developer errors. The deployed vault bundle's SHA-256 matched the final built artifact.

The mobile bundle has no Node-only runtime imports. The reviewed UX implementation adds about 29 KiB raw / 8 KiB gzip over the previous production bundle, without adding runtime dependencies; the size budgets retain a narrow margin over that new baseline.

## Live Obsidian acceptance

Harness: `scripts/test-obsidian-ux.mjs`. It requires both an explicit vault name and an explicit matching vault path; use a disposable vault only. It creates fixtures and retains them for inspection.

```sh
XDG_RUNTIME_DIR=/tmp/tn2360/runtime \
OBSIDIAN_UX_VAULT=mdbase-ux-e2e \
OBSIDIAN_UX_VAULT_PATH=/home/calluma/testvault/mdbase-ux-e2e \
OBSIDIAN_UX_EVIDENCE=/tmp/mdbase-pr-live-evidence \
node scripts/test-obsidian-ux.mjs
```

Deploy the built `main.js`, `manifest.json` and `styles.css` into that vault's plugin directory first, then reload the plugin.

Verified in native Obsidian 1.13.7:

1. Empty local initialization, real catalog review/install of People, and creation of a Person note using its installed starter.
2. Invalid numeric input and out-of-range values retain all other inputs; valid creation succeeds at the previewed path.
3. Validation freshness after note changes, completed coverage, live progress and cancellation while scanning 300 newly created notes.
4. Stale-draft comparison, export, separate current edits and retained older versions.
5. Workspace-state restoration, including the actual selected model, without restoring transfer approval.
6. Folder exclusions containing commas, and visible size/retention guidance.
7. All 601 entries of a synthetic transfer ledger are reachable through bounded pages; search and attention filters do not narrow approval. A separate synthetic partial plan shows an enabled “Sync 1 available change” action despite an unreadable-file diagnostic. Neither synthetic plan is submitted.
8. A 390×844 mobile-emulated viewport exposes type actions and the creation form; drafts survive the real app reloads triggered by mobile emulation.
9. Draft recovery after a real plugin reload; captured Obsidian developer errors are empty.

Evidence contains `results.json`, desktop/mobile screenshots, console output and developer errors. The transfer ledger is synthetic and is **never submitted to a server**. This acceptance run does not claim physical-phone or live hosted-transfer testing.

Earlier UX-baseline read-only performance profiling against the disposable vault (1,213 Markdown files, 5 types) passed existing budgets: schema 5 ms, validation 356.3 ms, issue rendering 10.6 ms, 16 rendered issue rows. These are one-run measurements, not a large-vault benchmark.

### Resilient partial sync

Integration with current main preserves the modular workspace panes, shared SyncSession and beta.120 SDK. Routine partial transfers also remain eligible for opt-in automatic sync; deletions, conflicts, attachment uploads, initial syncs and rebuilds still require review. Beta.120's opaque malformed-YAML synchronization remains supported.

The pinned SDK patch now plans independent transfers despite scoped inspection issues. Blocked objects and connected rename paths are isolated, with review diagnostics retained. Unreadable managed files are not interpreted as deletions. Partial runs keep the cursor at the previous boundary so skipped remote changes remain discoverable; completed effects are journaled normally and are not re-uploaded on retry. Fixing a file makes it eligible on the next explicit review. Unscoped inspection failures still block the entire plan, and conditional-write, stale-plan, integrity and recovery checks remain in place.

Real SDK integration tests use MemoryAuthority, the executor/journal and the Obsidian adapter to verify simultaneous safe uploads/downloads, unchanged malformed bytes, no repeated uploads, eventual completion after repair, unreadable managed-file preservation and connected-rename isolation. This is engine execution testing, not only a mocked UI.

### CLI pitfalls repaired during acceptance

The running app's exact 1.13.7 installer path had been deleted; restoring that version made new vault windows available again. Commands were explicitly directed to the live app's runtime socket. CLI parameter decoding expands JavaScript backslash escapes, so the harness encodes eval expressions rather than sending raw escaped source. Mobile-mode commands reload the app, so the harness waits for plugin and CLI registration before issuing further commands. During the partial-sync rerun, Obsidian's own metadata/file-recovery IndexedDB connection was closing; reloading only the disposable vault window restored it, and the fresh full run passed. Modal creation can target another active window: the harness focuses the test vault window before interacting, and allows native mobile modal animations to finish before screenshots.
