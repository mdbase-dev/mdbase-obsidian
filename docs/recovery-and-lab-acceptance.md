# Recovery workspace and next acceptance gates

## Implemented first increment

Initialization now owns one in-memory write gate. It starts closed, stays closed
through settings loading and authority checks, and opens only after successful
initialization. Concurrent retry requests share the same attempt. Disabling the
plugin cannot reopen the gate.

When initialization fails, the plugin still registers its workspace, commands,
settings tab, and status bar. The workspace shows **Collection recovery** instead
of normal editing/sync controls. Settings are also read-only. The screen provides:

- A bounded explanation and a conservative statement that authority is unverified.
- Explicit repair guidance for invalid settings/adoption metadata and missing or
  invalid mirror markers.
- **Retry initialization**, which rereads settings and recovery metadata.
- A copyable diagnostic containing only a format version, known code, gate state,
  and unverified-authority status. No raw exception, settings, identifier, token,
  collection path, or record content is exported.

A failed settings read no longer leaves the plugin unavailable, and an invalid
persisted mirror profile is no longer silently replaced with a local-only default.
Obsidian's `loadData()`/`Vault.readJson()` implementation can swallow non-ENOENT
parse/read errors and return undefined. Authority settings are therefore read
explicitly through the Vault adapter, distinguishing a missing settings file from
an unreadable file, malformed JSON, or an invalid top-level value.
There is no delete-checkpoint, reset-authority, or clear-storage recovery shortcut.
Ordinary Obsidian editing and other plugins are not locked by this gate.

This increment handles **startup/retry initialization failures**, not arbitrary
post-startup checkpoint corruption or an exhaustive authority-repair workflow.
Users must restore verified metadata or resolve storage errors before retrying.

## Automated coverage

`npm test` includes the controller gate, every write/sync entry point while
blocked, concurrent initialization, unload during initialization, settings reload,
missing role markers, and diagnostic redaction.

`test/pluginStartup.test.ts` invokes the actual `MdbasePlugin.onload()` and
`retryInitialization()` methods against a minimal Obsidian host. It verifies that
commands/views/status still register after failure, defaults are not persisted
over unreadable settings, and repaired settings are reread on retry. These are
host-mocked tests, not claims of desktop acceptance.

Test files now run with `--test-concurrency=1`: the suite contains a wall-clock
2,000-document regression budget, which was exceeded in parallel runs on this
busy shared host while passing serially. This isolates the benchmark from other
test-file startup work; the existing performance threshold is unchanged. External
host contention can still affect wall-clock timing.

## Opt-in real Obsidian recovery acceptance

With a **healthy, local-only, disposable vault**, an installed/enabled plugin, and
a running Obsidian instance:

```bash
npm run test:obsidian-recovery -- --vault=test --confirm=DISPOSABLE_VAULT
```

The script verifies the resolved vault name and refuses any existing Connect role
or adoption metadata. It backs up the installed plugin assets/settings privately,
temporarily installs this repository's build, injects its own invalid adoption
checkpoint and then malformed plugin settings, and exercises the actual recovery
screen and **Retry initialization** button. It checks that failed initialization
preserves metadata and that repairs unlock the normal workspace. Finally it
restores/verifies the original assets/settings and removes only its owned fixture.

Private evidence/backups live below
`~/.local/state/mdbase-obsidian/acceptance/`. Raw CLI errors are withheld. Exit code
2 means preflight was blocked, 1 means a failure after mutation or incomplete
cleanup, and 0 means acceptance and cleanup completed.

### Current live result

**Blocked, no vault mutation:** the registered `test` vault contains existing
Connect role/adoption metadata. The runner correctly refused it. A clean
explicitly disposable vault is needed; do not delete existing checkpoints simply
to make this test run.

## Hosted Connect LAB acceptance

**Blocked at infrastructure preflight:** `mdbase-env lab up` reported that LAB
loopback port **28487** is owned by another process. No process was stopped, no
credential/browser session was started, no hosted fixture was created, and no
staging/production endpoint was used. This is not a plugin failure.

After the LAB operator resolves that conflict, follow the `mdbase-lab` skill and
verify LAB identity before any testing. Use only this run's `[test]`-prefixed
collections and a dedicated Obsidian vault. Implement the hosted suite in bounded
stages rather than claiming a local adapter test proves remote behavior:

| Scenario | Required observable outcome |
| --- | --- |
| Enroll → initial review → sync | Explicit approval; exact ledger; local bytes match hosted bytes |
| Local create/update/move/delete | Hosted result matches the reviewed changes, not later edits |
| Hosted update while local changes exist | Conflict or stale-review stop; neither side silently lost |
| Resolve local/hosted/keep-both | Exact chosen bytes and collision-safe copies |
| Network loss during transfer | No false success; durable checkpoint resumes after reconnection |
| Obsidian reload mid-sync | Recovery converges without duplicate or lost mutations |
| Credential expiry/renewal | Clear next action; no credential disclosure or lost checkpoint |
| Adoption activation interruption | No accidental return to local authority; verified resumability |
| Disconnect | Exact checkpoint files removable; changed local files retained |

Server interruption scenarios require explicit ownership of a disposable LAB
fixture; do not restart or mutate shared infrastructure to force them. Keep
browser ownership, artifact redaction, fixture identification, and cleanup in the
same orchestrator. Real mobile/OS-crash/quota testing remains separate.
