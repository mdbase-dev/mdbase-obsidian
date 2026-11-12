# B4: Android sign-in after a background freeze (mdbase-obsidian mobile spike)

**Root cause.** The sign-in is lost in two layers.

1. **The engine restart forgets the request (SDK bug).** By default, when Android freezes Obsidian the SDK abandons its Worker (`entry.pageHidden`). On resume, `pageShown` starts a fresh Worker. That Worker reads the protected sign-in ledger, finds state `pending` and publishes `signed_out`. It never polls the request that the person is approving in Chrome. The ledger cannot tell "a sign-in gesture sent this request" apart from "fresh, never sent", because every ledger starts `pending` with a pre-generated requestId. So the SDK cannot safely poll every `pending` ledger.
2. **Approve needs the app online within 30 s (protocol limit).** After Approve, the portal waits `PAIRING_PREPARATION_TIMEOUT_MS = 30 s` for the app to attest. Android cuts a hidden app's network about 5 s after it is hidden (`APP_BACKGROUND` firewall) and freezes it at 60 s. If Obsidian is not reopened within 30 s of Approve, the portal gives up ("Keep the app open and try again"), and a second Approve is needed even when the engine is healthy.

**Run A (unmodified LAB SDK + instrumentation; default lifecycle).**

| Time (UTC) | Event |
|---|---|
| 02:48:54.33 | START 201 |
| 02:48:54.94 | Hidden |
| 02:49:15.24 | Exchange aborted at the SDK's 15 s timeout (outcome_unknown) |
| 02:49:35.24 | Exchange aborted at the 15 s timeout again |
| 02:49:54.94 | Freeze; `entry.pageHidden` abandons Worker `wpuh` |
| 02:53:03 | Approve in Chrome; times out in the portal |
| 02:54:08.14 | `pageShown {persisted:true}` |
| 02:54:09.32 | New Worker `bzh8` boots |
| 02:54:09.35 | `start.restored {"local":"pending"}`, then `session.status starting→signed_out`. No exchange request follows. |

**Run B (`blockFreeze`: the Worker is kept).** The Worker survived: heartbeat `gapMs 87943`. The exchange in flight at the freeze hung for **99,202 ms** and aborted only on resume (02:58:00.36). Then:

| Time (UTC) | Event |
|---|---|
| 02:58:05.50 | `account_selected` |
| 02:58:06.00 | Attest 200 |
| 02:58:07 onward | `awaiting_approval` every second; the portal's Approve (02:56:50) had already timed out |
| 03:00:32 | Second Approve |
| 03:01:31.9 | Paired, after Obsidian was reopened |

Keeping the Worker alone does not fix sign-in.

**Fix.** The ledger now records which request Connect accepted (`requestSent`). A restarted session keeps reading that one request, so no new gesture is needed. Proven on the emulator:

| Run | Hidden | Frozen | Approve | Reopen | Restarted Worker | Attest | Paired | Ready |
|---|---|---|---|---|---|---|---|---|
| ~2 min | 03:10:29.6 | 03:11:29.6 | 03:12:26.8 | 03:12:29.0 | `3pnz` 03:12:29.89 (`start.restored pending → authorizing`) | 03:12:31.34 | 03:12:32.49 | 03:12:37.5 |
| ~5 min | 03:14:10.4 | 03:15:10.4 | 03:19:07.0 | 03:19:13.6 | `3zu2` | 03:19:16.82 | 03:19:17.96 | — |

The short case (no freeze) also completes. The patch is `B4-sdk-fix.patch`.

Run by an implementation sub-agent on 2026-11-12, against LAB only.

---

## 1. Setup

| | |
|---|---|
| Environment | LAB, `https://connect-lab.mdbase.dev`. `/health` returned `environment: lab`, `public_origin` matching, revision `569ad3ffef7173213805e3b5a1aa4b276ec2f03a` (checked 03:4x UTC; the same revision is recorded in the stage report `REPORT.md`) |
| Account / collection | alias `lab-next-acceptance`; "[test] Agent sandbox TaskNotes" |
| Phone | Android emulator `emulator-5554` (medium_phone), Obsidian 1.15.0, WebView 153, Chrome as the approval browser. Driven through agent-device; adb only for push/pull, port forwards and logcat |
| SDK | Connect `746ecd49` LAB SDK (0.1.0-beta.152), built with `lab-inputs-beta180.json` |
| Run A/B build | instrumentation only (`b4/pkg-instr`) |
| Fix runs build | instrumentation + fix (`b4/pkg-fix/main.js`, sha256 `93e323ce…`). Control (a) used `b4/pkg-fix/main-ctl.js` (sha256 `6bf04db6…`), which adds `urlToFile` so the sign-in URL goes to a file instead of Chrome |
| Plugin branch | `spike/mobile-sync-b4` (plugin spike only; nothing is wired into the release build) |
| Second browser | GCP desk `gcp/b4-ctl-a` (profile `mdbase-lab`), destroyed at the end with a summary |
| Boot config for every run | `{"platform":"omit","patchWorker":true,"hideHistory":true,"blockFreeze":false,…}` (Run B: `blockFreeze:true`) |

**Instrumentation** (patch `B4-sdk-instrumentation.patch`, kept separate from the fix):

- Wall-clock events from the page and the Worker on a BroadcastChannel, forwarded by the spike page into the vault file `mdbase-engine-trace.log`.
- Events covered:
  - lifecycle handlers (`entry.pageHidden` / `pageShown`, plus the main window's `visibilitychange` / `freeze` / `resume`);
  - session status transitions;
  - the poll timer (`timer.set` / `timer.fire`, foreground flag);
  - every HTTP start, settle, timeout and error by collapsed path (`/v1/pairing-requests/:id/exchange` etc.);
  - store open steps;
  - Worker liveness: boot, a heartbeat that reports gaps over 12 s, and a 10 s page→Worker ping/pong.
- Identifiers only: no URLs, secrets or bodies.

Clock note: the emulator clock runs about 0.4 s behind the host. Times in tables marked "host" come from the driving scripts. All other times come from the trace, i.e. the emulator clock.

## 2. Failure shapes

| Run | Lifecycle | Approve | Reopen | Result |
|---|---|---|---|---|
| A | default (the freeze abandons the Worker) | 02:53:03 (about 3 min after the freeze) | 02:54:08 | **Lost.** New Worker `bzh8`: `start.restored pending → signed_out`, no exchange request. The portal had already shown its 30 s preparation timeout |
| B | `blockFreeze` (Worker kept) | 02:56:50 | 02:58:00 | Exchange hung 99.2 s until resume. Attested 02:58:06, but the portal had already timed out, so the status stayed `authorizing` (`awaiting_approval`) until a **second** Approve at 03:00:32. That click came while Obsidian was hidden, so polls failed immediately with `TypeError`. Paired 03:01:31.9 after reopening. This is the "authorizing for over 2 minutes" seen in the earlier spike. |

**What is stuck, and whether the Worker survives:**

- **Default lifecycle:** nothing is stuck. The Worker is deliberately abandoned and replaced, and the replacement decides the request is unsent.
- **`blockFreeze`:** the stuck item is the in-flight `fetch` of `/exchange`. Its 15 s `AbortSignal` timer cannot fire while the page is frozen, so it fires on resume (`ms: 99202`). After that the SDK waits its 5 s outcome-unknown backoff before polling again.
- **Worker survival:** the Worker survives the freeze in B (heartbeat gap of 87.9 s, then normal), and it is abandoned in A by design.

**Network while hidden:**

- `dumpsys netpolicy` shows `blocked=APP_BACKGROUND` for Obsidian's uid about 5 s after it is hidden.
- From then on, each fetch either hangs until the 15 s abort (Runs A, s1) or fails within milliseconds with `TypeError` (l1 from 03:31:18.47, B after the second Approve).
- Chrome keeps network access in the background long enough to finish its Approve POST once the app has attested.

## 3. Controls

**(a) Approve from another machine with Obsidian in the foreground (GCP desk): PASS.**

- Setup: sign-in started at 03:37:09.1 (START 201 at 03:37:10.87). The URL was written to a plugin-private file, pulled over adb into a 0600 file, opened in the desk's Chrome through CDP (never printed), and deleted afterwards.
- Approve on the desk at 03:37:47.06 (host clock).
- Phone, with no visibility change and Obsidian in front throughout: `account_selected` 03:37:47.64, attest 200 at 03:37:47.94, **paired at 03:37:49.08, about 2 s after Approve**. The desk page showed "can now use [test] Agent sandbox TaskNotes" at once.
- So nothing is wrong with the protocol while the app stays online.

**(b) Approve on the phone, reopen Obsidian more than 60 s later:**

- Without the fix: **lost** (Run A above).
- With the fix: **completes** (F1 and F2 in §4).

## 4. Fix and proof

### What changed (SDK, `B4-sdk-fix.patch`, 5 files, +63/−10)

**`app-host/installation-sign-in.ts`:**

- The protected ledger (State v3) gains an optional `requestSent?: string`, the requestId whose START Connect accepted (201).
- `startRequest()` saves it after a successful START: one extra protected commit per accepted START, and none on later polls.
- `renewExpiredPairing()` drops it when it mints a successor request.
- The strict `decode` accepts the key and refuses (`recovery_required`) a `requestSent` that doesn't match the current `requestId`.
- New method `requestSent(): boolean`: true only while not signed in and the current request was sent.

**`app-host/web-sign-in-session.ts`:**

- In `start()`, when the ledger is `pending` and `flow.requestSent()` is true, the session publishes `authorizing` instead of `signed_out`. The ordinary poll loop (`advance()`) then keeps reading the same request.
- If that resumed request turns out to be expired or refused, the session ends quietly as `signed_out` with no problem. The next sign-in gesture renews it through the existing `renewExpiredPairing` path.
- `beginAuthorization` clears the flag.
- An unsent `pending` ledger (a fresh install, or after sign-out) still shows `signed_out` and contacts nobody.

**Tests and public API:**

- `public-api.txt` is updated.
- Existing ledger expectations in `app-installation-sign-in.test.ts` now include `requestSent`. The failed-commit test now clears the injected commit failure before reopening.
- Three new session tests in `web-sign-in-session.test.ts`:
  - a restart keeps reading a sent request and completes it with no new gesture;
  - a request refused before the restart ends signed out, and the next sign-in renews it;
  - the same for a request expired before the restart.
- With the unfixed session file, the three new tests fail.

**Verification in the SDK worktree (fix only, instrumentation removed):**

- `tsc --noEmit` is clean.
- `public-api.mjs` matches.
- Full vitest: **2621 tests passed**. The only failure is `test/wasm-runtime.test.ts`, which cannot load because the wasm artifact is missing from this checkout. That is environmental and fails the same way on pristine HEAD.
- The four sign-in test files: 299/299.
- After the device runs, one doc comment was moved: `requestSent()` had been inserted between `hasWebPushChannel`'s JSDoc and its method. The deployed builds had the misplaced comment; behaviour is identical.

### Proof runs (instrumented + fix build, default lifecycle, `blockFreeze:false`)

| Run | START | Hidden | Frozen | Approve (host) | Reopen (host) | Restarted Worker | Attest | Paired | Approve clicks |
|---|---|---|---|---|---|---|---|---|---|
| F1 (~2 min) | 03:10:28.87 | 03:10:29.60 | 03:11:29.60 | 03:12:26.77 | 03:12:29.00 | `3pnz` 03:12:29.89 `start.restored pending → authorizing` | 03:12:31.34 | **03:12:32.49** (ready 03:12:37.5) | 1 |
| F2 (~5 min) | 03:14:09.73 | 03:14:10.43 | 03:15:10.44 | 03:19:07.01 | 03:19:13.56 | `3zu2` 03:19:14.52 `→ authorizing` | 03:19:16.82 | **03:19:17.96** | 1 |
| s1 short (no freeze) | 03:30:02.46 | 03:30:03.16 | — | 03:30:18.20 | 03:30:26.79 | none (`1m9b` kept) | 03:30:28.92 | **03:30:30.09** (ready 03:30:34.4) | 1 |
| l1 reopen 45 s after Approve | 03:31:12.46 | 03:31:13.17 | 03:32:13.18 | 03:32:32.31 | 03:33:17.01 | `1ruk` 03:33:17.82 `→ authorizing` | 03:33:19.77 | after a **second** Approve at 03:34:02.28: **03:34:04.19** | 2 (portal limit, see §5) |

**Chrome in F1, F2 and s1:**

- 4 s after the click it showed "Approving…" (`b4/shot-f2-prep.png`, `b4/shot-s1-prep.png`).
- After Obsidian was reopened and attested, Chrome finished the approval while itself in the background and showed "mdbase for Obsidian can now use [test] Agent sandbox TaskNotes" (`b4/shot-f2-after.png`, `b4/shot-s1-after.png`).

**l1:** Chrome reverted to "Open mdbase for Obsidian" (`b4/shot-l1-after.png`). The second click approved with no new request and no gesture in Obsidian, 1.9 s later.

**F2:** after pairing, the session was `unselected` (phase "choosing"). The spike plugin's auto-open belongs to its original `signIn` control, which was lost with the old frame. The collection was opened by a later `start` + `select` and reached `ready` ("Synced through 194"). A real plugin must open the approved collection when the session reaches `unselected` after a restart, not from the `authorize()` promise.

### The three candidates

| Candidate | Needed? | Why |
|---|---|---|
| Keep the pairing across freeze/resume and re-drive the poll on resume (`blockFreeze`) | **Not needed and not enough.** | Run B kept the Worker and the pairing, yet still failed the 30 s window, because the in-flight fetch hung for the whole freeze. The fix works with the default lifecycle, which abandons the Worker. Keeping a frozen Worker is not something Android guarantees anyway. |
| Timeout for in-flight polls | **Exists already** (15 s abort). **Optional improvement:** abort and re-poll at once on resume. | The timer cannot fire while frozen, and after an abort the SDK waits 5 s more. In s1 the last poll before the network cut hung from 03:30:08.3 to 03:30:23.3, and the next poll ran at 03:30:28.3, 1.5 s after reopen. That was fine here, but in the worst case it delays the first poll after reopen by up to about 20 s, which eats into the portal's 30 s. Aborting the in-flight exchange on `visibilitychange→visible` and polling immediately would remove that. Not implemented or proven here. |
| Persist the pairing request so a restarted engine picks it up | **Needed: this is the fix.** | The requestId and secret were already persisted. What was missing was the fact that the request had been **sent**. Polling every persisted `pending` request would contact Connect on every page load of a fresh install (every ledger starts `pending`). The marker also covers process death, since it is in the same protected IndexedDB record, but process death was not tested. |

## 5. What the fix does not cover

- **The portal's 30 s preparation window.** If Obsidian is reopened more than 30 s after Approve (l1), the person still has to press Approve again. Fixing that needs a portal or protocol change, for example letting a selected-but-unattested request stay approvable until the app attests, or saying so on the page. It cannot be fixed in the SDK.
- **The hung in-flight poll** (above): up to about 20 s of extra latency after reopen.
- **No return path to Obsidian** during "Preparing…" (§6). The person has to know to switch back to Obsidian.
- **Ledger downgrade.** A ledger written by the fixed SDK carries `requestSent`. An older SDK's strict `decode` refuses unknown keys, so downgrading while a sign-in is pending gives `recovery_required`. After sign-in the key stays in the record, so the same applies to any downgrade unless the key is dropped once the sign-in completes. Inferred from the code, not tested.
- **One extra protected commit per accepted START.** A commit failure fences the store, as for every other protected write.
- **Expiry.** A sent request still expires about 10 minutes after START, and a resumed expired request ends quietly as `signed_out`, as tested in the unit test. Not run on the device.

## 6. Item 5: does Chrome wait on "Preparing…", and does a link back to Obsidian help?

**Does Chrome wait? Yes.** After Approve, Chrome shows the "Approving…" button and the "Preparing…" status until the app attests. On Android that means until Obsidian is reopened, because Obsidian has no network while hidden.

- When Obsidian attests within 30 s, Chrome completes the approval **even while Chrome itself is in the background** (F1, F2, s1).
- Otherwise it times out and reverts to "Open mdbase for Obsidian" (Run A, Run B, l1).

**Return link: not possible within the current rule. This was inferred from these probes and the code; no link was tapped.**

- Obsidian Android registers only the `obsidian` scheme. `cmd package query-activities` resolves `obsidian://open` to `md.obsidian`, but finds **no activity** for `dev.mdbase.obsidian://return` or `dev.mdbase.obsidian.return://x`.
- The SDK rule in `application/return-url.ts`:
  - `return_url` must exactly equal a manifest `redirect_uris` entry;
  - it must be either https or loopback-http on the homepage origin, or a private-use scheme equal to or starting with `dev.mdbase.obsidian`.
- So no compliant URL can reach Obsidian.
- The spike's `http://localhost/auth/mdbase/callback` would open Chrome's own localhost, not Obsidian's WebView.
- The portal also shows a return link only after approval, refusal or cancel, never during "Preparing…", which is exactly when it would help.
- **What would be needed** (if wanted):
  - allow `obsidian://` (for example `obsidian://mdbase-return`, handled by a plugin protocol handler) as an explicit exception to the scheme rule for this app;
  - and a portal change to offer "Return to mdbase for Obsidian" during preparation.
- A `obsidian://` link in the existing post-approval state would bring the app forward, but only after the person has already succeeded or timed out.

## 7. Item 6: a local edit just before a five-minute background

**Result: the edit is sent after resume. PASS, with one caveat.**

Ready collection, `habits/walk.md` downloaded (revision `sha256:d92b630b…`, 71 bytes).

| Time (UTC) | Event |
|---|---|
| 03:21:09.70 (host) | Obsidian hidden |
| 03:21:20.96 | Edit control received |
| 03:21:21 (host) | `netpolicy` shows `blocked=APP_BACKGROUND` |

- **The edit:** the plugin appended a line to the vault file through `vault.process` and called `replace`, which submits with `SYNC_WRITE` and waits for confirmation. The network was already cut, so confirmation never came before the freeze at 03:22:09.79.
- **Reopen at 03:26:09.76 (host):**
  - the plugin's pending call surfaced as `control #67 edit failed: timeout replace` (its 180 s timer had been frozen);
  - Worker `bkqg` started, `start → unselected (signIn paired)` in 213 ms;
  - select took 306 ms, and the plugin was `ready` at 03:26:11.06.
- **Server state:** the `get` at 03:26:58.2 returned revision `sha256:a35db9c0…`, `confirmed`, `confirmedSeq 195`; the last confirmed seq before backgrounding was 194. The document ends with the line stamped 03:21:20.961Z, and its sha256 equals the revision and the vault file.
- **When it was uploaded:** between 03:26:09.6 and 03:26:58.2, by the new engine. Inferred: the network was cut from about 5 s after hiding, so it could not have been sent earlier. The sync transport is not instrumented, so there is no exact upload timestamp.
- **Caveat (host-level, P3):** the caller's `replace` promise dies with the old frame and Worker. The UI would report the edit as failed (timeout) even though it was durable and later confirmed. A real plugin has to reconcile through record state or the change stream after a restart, not through the original write promise.
- **Revert:** 03:29:34 `replace` back to the original → revision `sha256:d92b630b…`, confirmed at seq 196. The vault copy was also restored (sha256 `d92b630b…`).

## 8. Would a sleeping desktop laptop hit the same cause? (reasoning only, not tested)

**Layer 1 (a restart drops a sent request): only on a real restart.**

- On desktop, Electron's renderer does not get the Page Lifecycle `freeze` that Android's WebView sends to a hidden app, so `entry.pageHidden` should not abandon the Worker on lid-close.
- Sleep suspends the whole process, and on wake the same Worker continues with the pairing in memory.
- Layer 1 bites on desktop only when the engine restarts while a sign-in is pending: Obsidian is quit and relaunched, the plugin reloads, the window reloads, or the process crashes. The fix covers those too.

**Layer 2 (the 30 s window and the hung in-flight poll): yes, it applies.**

- If the person starts sign-in, closes the lid, and approves on another device (for example a phone), the portal times out because the laptop cannot attest, so a second Approve is needed after wake.
- An exchange in flight at sleep may hang until its 15 s abort fires after wake. Whether timers count sleep time depends on the OS clock source. Then the 5 s backoff applies. So the first poll after wake can be about 20 s late, the same as on Android.
- When approving in a browser on the same laptop, the laptop is awake, so the normal flow applies.

## 9. iOS unknowns (not tested)

- **Suspension timing.** iOS suspends a backgrounded app within seconds, with no 60 s grace. It may also terminate WKWebView's WebContent process under memory pressure, which reloads the page: layer 1. The ledger marker should cover that if WKWebView's IndexedDB record survives, which is unknown.
- **Lifecycle events.** WebKit does not implement Page Lifecycle `freeze`/`resume`. Which handlers fire (`pagehide`/`pageshow`/`visibilitychange`), and whether the SDK's `followPageLifecycle` abandons the Worker there, is unknown.
- **Safari in the background.** On Android, Chrome finished the Approve POST while backgrounded. iOS suspends Safari's page JavaScript quickly, so after the person switches to Obsidian, Safari's 30 s wait and final approve may not run until they return to Safari. This is a likely extra round trip and the biggest iOS question.
- **Return link.** Obsidian iOS registers `obsidian://`. As on Android, a compliant `dev.mdbase.obsidian…` scheme cannot reach it, and a plugin cannot use `ASWebAuthenticationSession` or universal links.
- **Network while suspended.** Whether in-flight `fetch` hangs or fails on resume, and how WKWebView's timers behave across suspension, is untested.
- **OPFS / quota.** OPFS and quota behaviour in WKWebView, including the side finding below, is unknown.

## 10. Other findings from this run

| Severity | Finding | Evidence |
|---|---|---|
| **P2 (provisional), cause unknown** | **Phantom 4 GiB `file_systems` quota usage.** The origin `http://localhost` (Obsidian's WebView, shared with Obsidian's own IndexedDB) reported `file_systems` usage of 4,291,207,168 bytes, about 3.6 MiB under 4 GiB, against a quota of 3,736,869,273, while the OPFS root (default bucket) listed **no entries**. Every IndexedDB write on the origin then failed with `QuotaExceededError`. That includes the SDK's installation store, so sign-in failed with `recovery_required` "app installation storage unavailable" at 03:35:11. It was first seen and cleared before B4 began (about 02:48). It came back between then and 03:34, after Runs A, B, F1, F2, item 6, s1 and l1, and it persisted across an Obsidian relaunch. Cleared again at 03:36:50 with `Storage.clearDataForOrigin(file_systems)` (OPFS was empty; signed out). Two targeted attempts did **not** reproduce it: a freeze/resume with an open replica (usage 13.7 MB afterwards), and sign-out after an abandoned Worker (0 afterwards). Needs its own investigation before release, because it can break Obsidian's own IndexedDB use. Only failing probe writes were observed; no Obsidian data loss was seen. | CDP `Storage.getUsageAndQuota` at 03:35–03:36; trace 03:35:11.82 `store.open.error {"step":"openDatabase"}`; probe `abort QuotaExceededError` |
| P3 | **Sign-out without network reports success but leaves the server installation.** At 03:13:40 a `signOut` sent while Obsidian was hidden got `TypeError` on `DELETE /v1/next/installation`, yet resolved `signed_out` (local erase only). The F1 installation stayed registered on LAB with its collection grant. | trace 03:13:40; desk Apps page "2 installations" |
| P3 | **The portal cannot remove one grantless installation without revoking the whole app.** After revoking the collection grant, the orphaned installation remains under "No collection access". The only control is "Revoke app", which would also revoke other installations. | desk 03:44 |
| P3 | **Write confirmation lost across a restart** (item 6 caveat). | §7 |
| obs. | **One-off `sync_stalled` opening the collection in the foreground.** Control (a), select op 36 at 03:37:49.3 settled after 20.9 s with `sync_stalled`. A retry (`start`) reached ready in 1.75 s. Not investigated; it might be LAB load (the collection advanced from 196 to 204 from other writers) or the earlier quota clear. | trace 03:38:10.24 |
| note | **LAB credential exposure (from the earlier part of this run).** A device snapshot of the LAB sign-in form exposed the `lab-next-acceptance` password in the agent transcript. It was never put in a file or report. Recommend rotating that password. | — |

## 11. Cleanup

- **Phone signed out.** Final `signOut` with Obsidian in the foreground at 03:43:16: `DELETE /v1/next/installation` 200, local erase, `file_systems` usage 0. Every sign-out in the foreground this run got a 200: 03:29:50, 03:31:10, 03:34:38, 03:43:16.
- **LAB installations from this run.**
  - All revoked server-side except one.
  - **Leftover:** the F1 installation (registered 03:12 UTC, orphaned by the offline sign-out) had its collection access revoked on the desk at 03:44 (`remove` 200). It is still listed as "mdbase for Obsidian → No collection access, 1 installation". Removing it needs "Revoke app", which would also revoke another lane's installation (`[test] agent-20261110T001033Z-sol-fuzz`, registered 11/10), so it was left. Its device credentials were erased on the phone.
  - "[test] mdbase Obsidian SDK spike" holds only October installations from earlier stages, and was not touched.
- **Test note.** LAB `habits/walk.md` was reverted to revision `d92b630b…` (seq 196). The vault copy `mdbase-spike-download/habits/walk.md` was restored to the same bytes. `pending-url.txt` was deleted from the plugin folder, and the local URL copy `b4/ca.url` was deleted.
- **Chrome on the emulator.** Signed out with "Sign out of this browser" at 03:47 and confirmed in the dialog ("Sign out of this browser?"). Other sessions were not touched. No password-save prompt appeared.
- **Desk.** `gcp/b4-ctl-a`: summary saved, then destroyed.
- **adb.** The `tcp:9333` (WebView DevTools) forward was removed.
- **Emulator.** Shut down with `device_close` (shutdown true) as the last step.
- **SDK worktree.** Left with the fix only (5 files), as instructed.
- **Remaining on the emulator image until it is wiped:**
  - the spike plugin `main.js` (instrumented + fix, `urlToFile` in the control config);
  - the trace log `mdbase-engine-trace.log` in the vault.

## 12. Files

All under `/home/calluma/worktrees/obsidian-mobile-spike/`:

**Patches:**
- `B4-sdk-fix.patch`: the fix only, `git diff` in the SDK worktree (Connect `746ecd49`).
- `B4-sdk-instrumentation.patch`: the instrumentation only, applied on top of the fix.
- `B4-sdk-fix-plus-instrumentation.patch`: the combined patch the device builds used, against HEAD. The `requestSent()` doc comment is in its earlier, misplaced position.

**Evidence in `b4/`:**
- traces: `trace-full-i6.log` (02:44–03:26: Runs A, B, F1, F2, item 6), `trace-s1.log`, `trace-l1.log`, `trace-ca.log`;
- timings: `*.times`, `f1.*`;
- screenshots: `shot-*.png`;
- item 6 records: `i6.*.json`.

**Scripts in `b4/scripts/`:** `do`, `deploy`, `approve-reopen`, `item6`, `cdp-*.mjs` (including `cdp-open-file.mjs`, which opens a URL from a file without printing it), and the instrument and fix scripts.

**Copies on the plugin branch `spike/mobile-sync-b4`:** `spike/REPORT-B4.md` and the three patches under `spike/b4/`.
