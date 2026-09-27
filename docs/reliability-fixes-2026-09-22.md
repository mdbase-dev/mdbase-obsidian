# Live reliability findings: fixes and verification

## Scope

Addresses the five findings from the September 22 Obsidian/Connect LAB campaign.
No server deployment, protocol change, credential renewal, release, or publication.

| Finding | Fix |
| --- | --- |
| Download overwrites a competing local text edit | SDK passes observed text to the adapter; `Vault.process` compares it at Obsidian's serialized write boundary. A mismatch rejects as stale. Safe stale-journal retirement allows the next review to expose the conflict. |
| Status/review downloads attachment bodies without progress or cancellation | Inspection keeps remote descriptors only; the journaled apply action fetches and verifies the blob through the existing progress-reporting, cancellable transport. |
| Pre-existing directory causes endless stale reviews | Optional physical-path inspection detects destination directories and ancestor files. The normal planner emits actionable blocking issues rather than impossible write/move actions. |
| Adoption “Stop waiting” destroys its checkpoint | A local abort is a pause, distinct from a server-side terminal cancellation. Retain marker, credential and any fenced snapshot; expose Resume. Terminal cancellation/expiry still clears the checkpoint and its approval link. |
| Disconnect succeeds but leaves a false configuration error | Serialize disconnection with status/review/apply, and ignore late status results/errors belonging to a replaced connection in both the workspace and plugin status bar. |

The SDK changes are carried as a version-specific, fail-closed install patch;
see [`../patches/README.md`](../patches/README.md) for upstream removal criteria.
The generated `main.js` contains these changes. No installed personal vault was updated.

### Safety boundaries

- Conditional text writes rely on Obsidian's `Vault.process` contract. They do not
  claim an OS-wide atomic compare-and-swap against arbitrary external processes.
- No obstructions are automatically deleted or renamed.
- Failed/cancelled downloads do not install partial bytes or advance checkpoints.
  Their prepared descriptors remain durable for restart/retry.
- Earlier action receipts remain intact when an explicitly stale batch is retired.
- Pausing adoption never assumes an uncertain activation failed or unfreezes a
  fenced snapshot; Resume still reconciles the durable checkpoint with Connect.

## Automated verification

Passed on a clean installation:

```sh
npm ci                  # applies the exact beta.91 patch, fails on mismatch
npm test                # 98 passed, 0 failed
npm run check:mobile    # production build + desktop-import/bundle-budget checks
npm run lint
git diff --check
```

New/extended regression tests cover:

- Competing note/configuration writes at the `Vault.process` boundary, a newly
  occupied destination, and disappearance of a previously inspected file.
- Actual SDK apply rejecting a competing edit, then generating/applying a conflict
  plan instead of trapping recovery on the stale plan.
- Repeated folder and ancestor-file collision reviews, preservation of the
  obstruction, and successful transfer after its deliberate removal.
- Metadata-only review/status, verified download during apply, cancellation and
  resumption through a new controller, and corrupt-blob recovery without an
  advanced checkpoint.
- Stop waiting retaining the adoption checkpoint/credential across restart;
  terminal server cancellation and expiry still retiring it.
- Disconnect waiting for a suspended status reader, while retaining existing
  settings-save rollback and changed-file preservation coverage.

Mobile bundle: 689,309 raw bytes / 196,152 gzip bytes, within existing budgets.
This is a bundle compatibility check, not live mobile acceptance.

## Live verification

Two isolated Obsidian instances ran the rebuilt plugin against one newly owned
LAB collection. Bundle SHA-256:

`76cf9519a487643fb82100570b52adddc296f028af50eaff5ce50a10f909bf00`

| Scenario | Observed result |
| --- | --- |
| Actual UI Stop waiting → Resume → approve adoption | Marker stays `waiting_for_approval`; correct pause message appears; Resume completes hosted adoption and clears the marker. |
| External filesystem writer injected immediately before real `Vault.process` | Competing bytes independently visible; apply returns `stale`; competing bytes survive; next review produces a conflict. Explicit Keep local subsequently converges both clients. |
| Existing `folder-block.md` directory vs hosted note | Two independent reviews yield blocking attention and zero actions, not stale. The directory stays intact. Removing the owned empty directory allows sync to apply. |
| Status plus review of uncached 16,777,223-byte attachment | 0 download requests, 0 attachment bytes, no vault file; combined inspection took 1.44 seconds in this run. |
| Actual attachment sync, cancel on first positive progress | Progress reports 0 then 8,388,608 bytes while sync is active. Cancellation retains recovery state and installs no partial file. |
| Renderer reload and attachment resume | Applies successfully with progress through all 16,777,223 bytes; SHA-256 exactly matches source. |
| UI Remove unchanged synced files with a suspended status reader | Disconnect waits for the reader. Changed note survives; unchanged note/binary and role marker are removed. Profile is cleared; success is visible; no false missing-configuration error. |

The final disconnect race was exercised on the writable receiver; the original
observation used read-only enrollment. Queue ownership and UI result fencing are
shared across both modes. The external-writer timing is deliberately injected,
not a measurement of how frequently the race occurs naturally.

Sanitized scripts and JSON evidence are retained locally under:

`~/.local/state/mdbase-connect/environments/lab/browser-agent/sessions/20260922T211450Z-910216/obsidian-fixes/`

Both mirrors disconnected. The exact run-owned collection was deleted and its
absence verified after reload. Both isolated application processes and the owned
LAB browser were stopped; disposable application profiles were removed. Because
isolated startup still required `--password-store=basic`, no personal credentials
or vaults were used. No shared daemon reset or shared fixture mutation occurred.
