# Sync that just works: live acceptance

Two isolated Obsidian 1.13.7 instances ran this branch against one disposable
`[test]` collection on Connect LAB. Each had its own profile and vault, and
started with `--password-store=basic`. The vault on device A was uploaded to
Connect and device B enrolled into it. No scenario called sync directly unless
noted; everything else was the scheduler acting on its own.

Final bundle SHA-256: `9a70f277d1a81e7f07261dd61fac1db142b0ad2fcccbe5407f4c04b546e325f9`

| Scenario | Observed |
| --- | --- |
| A connects after upload | Automatic sync took A to **Synced** without a click. |
| B enrolls into an empty vault | The first sync was download-only, so it ran without review and finished in 4 s. |
| Edit, create and trash on A | Reached B in 13 s. The deletion did not ask for review and went to B's `.trash`. |
| Different frontmatter fields edited on both devices at once | **Merged** on both devices: `status: done` and `priority: high`, with no copy. Converged in 64 s, including one 30 s probe cycle. |
| Same line edited on both devices at once | **Kept both**: the hosted version stays in place, and the other version is saved as `race-line (local conflict copy).md` on both devices. A history entry was pinned. |
| A offline (sync URL pointed at a closed port) | Status bar showed **Offline**, the card showed "Trying again in …", and backoff was 8–14 s. No history entry was pinned. B did not receive the edit made while A was offline. |
| A back online (`online` event) | B received the offline edit 7 s later. A returned to **Synced**. |
| Soak: 8 alternating edits, A↔B | 8/8 delivered with no clicks, in 11–20 s each. No conflict copies. Both schedulers were still armed afterwards. |
| 25 files trashed on A | A held them for review ("25 deletions") and B kept its copies. After approval on A, B applied them without asking and put them in its trash. |
| Credentials missing / copied vault (separate instance) | **Sign in again** and **Set up this device** respectively. Polling stopped. Diagnostics contained no credentials. |

## Defects found live and fixed on this branch

- **Every desktop request failed.** Electron's `remote` cannot pass a renderer
  `AbortSignal` to `net.fetch`. The desktop stack now creates its
  `AbortController` in the main process, which also gives real cancellation.
  Headers cross the bridge as a plain object.
- **Credentials could not be saved.** Per-replica secret IDs exceeded Obsidian's
  64-character limit. Secrets are now keyed by replica ID alone, which is 58
  characters. The test secret store enforces Obsidian's rule.
- **Simultaneous edits were never merged.** When the server reports a conflict
  on upload, the SDK recorded it without the common ancestor, so the merge saw
  nothing to merge. Fixed in the SDK and in this plugin's patch, with tests in
  both.
- **The scheduler could stop for good.** A timer that fired while a sync was
  running left a stale due time behind, and every later schedule call treated
  it as already pending. Fixed, with a regression test.
- **Every device asked again after a deletion burst.** An incoming burst of
  deletions stopped for review on each device. The gate now counts only
  deletions made on this device; incoming deletions go to the trash.
- **Obsidian Sync warning shown for every vault.** It appeared whenever the core
  plugin was enabled. It now requires a configured remote vault.

The disposable collection was created by this run and deleted afterwards; see
cleanup in the PR.
