# Spike: can mdbase sync run inside Obsidian on a phone?

**Answer: yes on Android, with plugin-side workarounds; LAB is proven end to end.** On Obsidian 1.15.0 for Android (emulator, Android 16, WebView 153), the unmodified LAB SDK (Connect 746ecd49) booted inside the plugin and signed in through the browser. It opened a collection (`ready`, "Synced through 182"), listed 75 records, downloaded a note into the vault with a matching sha256, and wrote an edit back that LAB confirmed by receipt. The edit was then reverted. No SDK or server change was needed on LAB. That required four plugin-side workarounds. One of them (hiding `window.history`) and one constraint (declaring the manifest without `platform: "native"`) are hacks against the SDK. The proper fixes are two small SDK options and one Connect decision about how a phone app's origin is identified. One real reliability bug remains. Android freezes Obsidian 60 s after it goes to the background, and a sign-in still pending at that point is lost. So today the user must approve in the browser and return within a minute. Hiding the freeze from the SDK did not fix it. Production would also need that decision: today the phone presents itself as an unverified development app "running on this computer". iOS was not tested and is the larger unknown (see below).

Run: `agent-20261112T021218Z-843251` · 2026-11-12 · environment **LAB only** (https://connect-lab.mdbase.dev, revision 569ad3ff) · branch `spike/mobile-sync` (not for release).

Legend: **[V]** = verified by a run in this spike; **[I]** = inferred from code or reasoning, not run.

---

## 1. Probe results (Stage 0)

Raw results: `spike/results/android-stage0-with-protocol.md`, `spike/results/android-stage0-run1.md`, `spike/results/desktop-linux-stage0.md` (the desktop run was on a GCP desk with Obsidian 1.15.0 AppImage, never Callum's app). The probe plugin (`spike/mobile-probe`) loaded without errors on both platforms **[V]**.

### Environment

| Item | Android (Obsidian 1.15.0, emulator) | Desktop (Obsidian 1.15.0 Linux) |
|---|---|---|
| `location.origin` | `http://localhost` (no port) | `app://obsidian.md` |
| `isSecureContext` | true | true |
| `crossOriginIsolated` | false | false |
| `SharedArrayBuffer` | **absent** (Atomics.wait present) | present (Electron) |
| CSP (main window) | meta `style-src 'unsafe-inline' 'self' https://fonts.googleapis.com`; no script-src, `eval` allowed | same meta |
| Engine | Android WebView / Chromium 153.0.8010.36 | Chrome 150.0.7871.250 / Electron 43.8.4 |
| `Platform` | isMobile, isMobileApp, isAndroidApp, isPhone, isLinux | isDesktop, isDesktopApp, isLinux |
| Node (`window.require`, `process`) | **absent** | present |
| Resource path shape | `http://localhost/_capacitor_file_/storage/emulated/0/Documents/<vault>/…` | `app://<hex>/<abs path>?<q>` |
| Headers on resource-path files | **`Content-Security-Policy: sandbox`** on html/js/wasm | none |
| Storage quota / persisted | ~6144 MB / not persisted | – |
| DecompressionStream | gzip, deflate, deflate-raw; **no brotli** | same |
| `crypto.subtle`, `randomUUID` | present (secure contexts) | present |

### Capabilities by hosting method

| Capability | (a) `getResourcePath` iframe | (b) `blob:` iframe | (b′) blob + `<base href=resource dir>` | (c) `srcdoc` (± base) | (d) no iframe (plugin window) |
|---|---|---|---|---|---|
| Script runs | **No** (Android: CSP sandbox; desktop: no message in 60 s) | yes | yes | yes | yes |
| Origin | – | `http://localhost` | `http://localhost` | reports `"null"` but uses the parent's storage | `http://localhost` |
| OPFS, `createSyncAccessHandle` (worker) | – | ok | ok | ok | ok |
| `navigator.locks`, BroadcastChannel, IndexedDB | – | ok | ok | ok | ok |
| Module scripts with relative imports | – | n/a | **ok** (engine boot imports `./app.js` → `./sdk/…`) | – | – |
| Blob classic/module Worker | – | ok, inherits `http://localhost`, OPFS+SAH ok | ok | ok | ok |
| **Worker by resource URL** | – | Android: runs but **not a secure context**: no OPFS, no locks, IndexedDB denied, no crypto.subtle, wasm fetch fails. Desktop: SecurityError (cross-origin) | same | same | same |
| `.wasm` fetch / `instantiateStreaming` by URL | – | ok (200 `application/wasm`) | ok | ok | ok |
| WASM from bytes | – | ok | ok | ok | ok |
| Storage shared with Obsidian's origin | – | **yes**: OPFS markers from every context visible in all others | yes | yes | yes |

**Consequence:** the engine must run in a blob iframe (or the plugin window), and its Worker must be created from a blob, not a resource URL. Storage is the single `http://localhost` origin shared by **every vault and every plugin** on the phone. Desktop's per-vault loopback port gives isolation; the phone does not. Separation relies only on the SDK `applicationNamespace` [V for sharing; I for consequences].

### Network to LAB from `http://localhost` (Android, `fetch` in WebView)

| Call | Result |
|---|---|
| CP `GET /health` | 200, `environment: lab`, `public_origin: https://connect-lab.mdbase.dev`, revision 569ad3ff **[V]** |
| CP `POST /v1/apps/register` `{}` | 400 `invalid_request` (body readable; CORS ok) **[V]** |
| CP `POST /v1/pairing-requests` `{installation:{}}` | 400 `invalid_request` **[V]** |
| Log `GET /health`, `GET /v1/nonce` | 200, 200 **[V]** |
| Log `POST /v1/rpc` (cbor + custom headers, bogus token) | 401 `unauthenticated (token)`; preflight passed **[V]** |
| Relay `wss://…/v1/next/relay/client` | opened, then closed 1005 (no auth, expected) **[V]** |
| Same via Obsidian `requestUrl` | works **[V]** |

CORS on LAB reflects `http://localhost`. Desktop results match.

### Sign-in return path

- `registerObsidianProtocolHandler("mdbase-probe")` **fires on Android** from a link tapped in Chrome, with no chooser. Params arrived intact **[V]**.
- No return URL is needed. The SDK completes sign-in by polling the pairing request, and `page.ts` passes no `returnUrl` **[V by Stage 2]**.
- The SDK would **refuse `obsidian://` as a return URL**: private-use schemes must start with the manifest id `dev.mdbase.obsidian` (`application/return-url.ts`) **[I]**. Not needed today.

---

## 2. Stages 1–3 (Android, LAB, unpatched LAB SDK package 746ecd49)

Code: `spike/mobile-engine/` (plugin `mdbase-mobile-engine`). Evidence: `spike/results/android-stage1-3-engine-status.md`.

How it was hosted: the SDK assets (`runtime.wasm`, `sqlite3.wasm`, `sqlite3.js`, `sdk.js`, `worker.js`, `app.js` = `src/sync/native/page.ts` with 3 small edits) are embedded gzip+base64 in `main.js` (3.3 MB). The plugin writes them to `<plugin>/engine/` with `adapter.writeBinary`, verifying each sha256 by read-back; this takes about 1.0 s. It then boots a **blob iframe with `<base href=engine dir>`** that imports `./app.js`.

| Step | Config | Result |
|---|---|---|
| 1 | manifest `platform: "native"` (as desktop) | **Refused in SDK** at `createMdbase`: `invalid_request` / `application_declaration`. `appOriginPlatform("http://localhost","native")` requires `^http://127\.0\.0\.1(:port)?$` (`app-host/app-origin.ts:25`, `application/declaration.ts:85-87`) **[V]** |
| 2 | `platform` omitted | Phase problem `application_selection_binding`. The SDK's URL-based selection reads `window.location.href` = `blob:http://localhost/…` and rejects it (`application/browser-selection.ts:59-60`, port at `:96-101`) **[V]** |
| 3 | + Worker created from a blob of `worker.js` with its 4 `import.meta.url` replaced by the real URL | still `application_selection_binding` **[V]** |
| 4 | + `window.history` hidden in the iframe (so `browserApplicationSelectionPort` returns null) without the Worker patch | `recovery_required`. Worker by URL threw at `worker.js:128` (no OPFS, not a secure context; see Stage 0) **[V]** |
| 5 | omit platform + Worker blob + history hidden | `start` → `signed_out` **[V]** |
| 6 | `signIn` → `window.open` → LAB in Chrome, account `lab-next-acceptance`, approve "[test] Agent sandbox TaskNotes" | **First attempt failed:** Obsidian stayed in the background ~4 min while I approved. On return the engine went `starting` → `signed_out` and the approval was lost (see blocker B4). **Second attempt (~47 s in background): `authorizing` → `opening` → `ready`, "Synced through 182", 0 pending, 0 conflicts** **[V]** |
| 7 | `list` (read-only) | **75 records**, paths/revisions/bytes returned **[V]** |
| 8 | `download habits/walk.md` → `mdbase-spike-download/habits/walk.md` via `vault.create` | remote sha256 = on-disk sha256 = pulled-copy sha256 `d92b630b…` **[V]** |
| 9 | `edit`: `vault.process` appends a line, then the SDK `replace(id, base, next, revision)` | revision `sha256:225916c3…`, `via: receipt`, `confirmed: true`, read-back equals the local file **[V]** |
| 10 | revert (`replace` back to the original text) | revision back to `sha256:d92b630b…` (original), `via: receipt` **[V]** |

- **SQLite VFS:** **opfs-sahpool** [V]. OPFS after opening contains `.<namespace>/.opaque/<random>` pool files (≈9.6 MB total), the sahpool layout. Code: `installOpfsSAHPoolVfs` (opfs and opfs-wl disabled).
- **SharedArrayBuffer:** not needed [V]. Android has none and everything above worked.
- **LAB server refusals:** none. `POST /v1/apps/register` and `POST /v1/pairing-requests` were accepted for origin `http://localhost` with the page-declared homepage `http://localhost/` [V]. Connect accepted it under the *development loopback* rule (`services/server/src/features/connectors/installation-pairing.ts:74-80`) [I from code; the request succeeded].
- **Approval page wording** (LAB, screenshot `results/screens/approval-page-android.png`): "an app running on this computer" / "App identity unverified. This app calls itself mdbase for Obsidian. Continue only if you started this connection intentionally." It also listed "Allow mdbase for Obsidian to create new collections" and "This device can keep notes… offline" [V].

---

## 3. Blockers and required changes

| # | Blocker | Where the fix belongs | Smallest change | Status |
|---|---|---|---|---|
| B1 | Desktop host uses Node (`http` loopback server, `fs`, `os.hostname`, `child_process`/flock, zlib brotli). None exists on mobile. | **Plugin** | A mobile host path in `src/sync/native/plugin.ts`: blob iframe instead of loopback server; adapter `writeBinary` instead of fs; gzip (DecompressionStream) instead of brotli for embedded assets; `crypto.subtle` for hashes; no hostname; no flock (one Obsidian process per vault on a phone). Vault binding by `app.appId`/vault path. | Proven by the spike [V] |
| B2 | SDK constructs its Worker as `new Worker(new URL("./worker.js", import.meta.url))`. On Android the resource URL gives a non-secure worker (no OPFS) → `recovery_required`. | **SDK** | An entry option for a host-supplied Worker factory/URL (e.g. `worker: () => new Worker(blobUrl, {type:"module"})`), and `worker.js` resolving its assets from a passed base instead of `import.meta.url` (4 uses). Spike workaround: rewrite `import.meta.url` in `worker.js` and subclass `window.Worker`. | Workaround proven [V]; SDK option reasoned [I] |
| B3 | SDK browser selection binds to `window.location`/`history`. A `blob:` document fails `application_selection_binding`. | **SDK** | An option to turn off URL selection (or pass a selection port), e.g. `selection: "none"` / `selectionPort`. Native/desktop already skips it because its iframe is a real http page. Spike workaround: hide `window.history`. | Workaround proven [V]; option reasoned [I] |
| B4 | **Sign-in lost when Obsidian is backgrounded long enough.** Approving in the browser backgrounds Obsidian. The SDK's page-lifecycle handling (`application/entry.ts:879-911`: `freeze`/`pagehide` → abandon the Worker; `resume`/`pageshow` → fresh `start()`) discards the pending pairing. | **SDK** (plus plugin) | Keep an in-flight pairing across freeze/resume, or let an embedding host opt out of page-lifecycle handling (the host already owns foreground via `followVisibility:false`). Users also need a clear "Continue in Obsidian" path. The protocol-handler return link works (Stage 0), and `dev.mdbase.obsidian://` would need registering as a return URL scheme. | Failure and cause (60 s `freeze`) proven [V]. Hiding `freeze` alone does **not** fix it [V]. SDK fix reasoned [I] |
| B5 | `platform: "native"` requires `http://127.0.0.1:<port>`. Phone origin is `http://localhost` (Android), and probably `capacitor://localhost` (iOS). | **Connect (protocol + server) and SDK**: needs a decision | Option A: declare the phone as `installation_origins.<env>.mobile` with the existing `mobile` kind. That kind accepts only `capacitor://` today (`packages/protocol/src/manifest.ts:318`), so it must be extended to Android's `http://localhost`, or the SDK must send `installationKind:"mobile"` (`application/declaration.ts:25-28` already says "Android Capacitor apps served from https set mobile explicitly"; Obsidian serves http). Option B: keep the phone as a "development loopback" web app (what LAB accepted). | Needs Callum; see §4 |
| B6 | Production identity/consent: the phone is presented as an unverified app "running on this computer". | **Connect** | Falls out of B5. A recognised mobile installation kind would get its own approval copy. | Observed on LAB [V]; production not tested |
| B7 | Shared origin: every vault and every plugin on the phone shares `http://localhost` storage (OPFS, IndexedDB, locks, BroadcastChannel). | **Plugin + SDK** (security review) | Use a per-vault `applicationNamespace` (done in the spike: `obsidian-vault-spike-<vault path>`). Accept that any other plugin can read the replica, or encrypt at rest. This is a product/security decision. | Sharing proven [V]; impact reasoned [I] |
| B8 | Asset size: the engine is ~3.3 MB of plugin `main.js` (gzip+base64). The desktop build ships brotli assets. | **Plugin** | Gzip instead of brotli for mobile (no brotli decoder). Size is acceptable for a community plugin [I]. | Proven [V] |

### 3a. B4 detail

- **First sign-in:** `authorizing` at 02:11:53. Obsidian was in the background until 02:15:56. Then `starting` → `signed_out`, and the browser stuck on "Preparing mdbase for Obsidian…".
- **Second sign-in:** in the background 47 s (no `freeze` event logged), then `ready`.
- **Five-minute background test of a ready collection** [V]: Obsidian went to the background at 02:21:37. Android sent `freeze` to the page at **02:22:37, exactly 60 s later**, and `resume` on return at 02:27:15. The SDK then threw away its Worker, started a new one, and went `opening` → `ready` ("Synced through 184") in ~1.2 s. **This explains both sign-ins:** the first exceeded 60 s and was lost; the second (47 s) finished before the freeze. While hidden, the SDK did not progress the pending sign-in in either case (the approval page showed "Preparing mdbase for Obsidian…" until Obsidian was opened). Background sync was not measured: the app is frozen after 60 s, so expect none.
- **Fix attempt: hide `freeze`/`resume`/`pagehide`/`pageshow` from the SDK** [V] (config `blockFreeze`, capture listener with `stopImmediatePropagation` in the iframe). Sign-in started 02:28:06, approved after 93 s in the background, frozen at 02:29:07, Obsidian reopened 02:30:25. The SDK no longer restarted, but the sign-in **still did not complete**: it stayed `authorizing` for over 2 minutes after resume. A `start()` nudge did nothing, and no console errors appeared. The Worker targets were still alive in DevTools. **Cause not found.** The likely suspect is an exchange request or timer in flight at the freeze that never settles [I]. So the B4 fix is not just "ignore freeze". The SDK has to restart its pending-approval poll on resume (`app-host/web-sign-in-session.ts:718-726` only reschedules while `this.timer === null`) [I].
- Practical mitigation for the product (not tested): tell the user to return to Obsidian within a minute. Better, have the approval page link back via the `obsidian://` protocol handler (works on Android, Stage 0), and make the SDK re-drive the pairing on resume.

---

## 4. Decisions needed from Callum

1. **How a phone identifies itself to Connect (B5/B6).** Options: extend the `mobile` installation kind to Android's `http://localhost` (and confirm iOS's `capacitor://localhost`), or a new kind for "embedded in a host app". Accepting the development-loopback framing for production is the third option. The fix touches the protocol, the server and the approval page copy, and the SDK declaration. It ships in a Connect release and then an SDK release on the train.
2. **Shared-origin data exposure (B7):** is a replica readable by any other Obsidian plugin acceptable on mobile, or is at-rest encryption required? It already is on desktop through the Node fs, so mobile is probably no worse [I].
3. **SDK API surface for embedding (B2, B3, B4):** Worker factory, selection off, lifecycle opt-out. These are small, but they are public SDK options.

---

## 5. iOS unknowns (not tested; no iOS Simulator available)

Do not read any of this as a result. All of it is inferred.

- Obsidian iOS is Capacitor on WKWebView. Its origin is most likely `capacitor://localhost`. That would fit the protocol's existing `mobile` kind, but `platform: "native"` would be refused as on Android.
- **OPFS `createSyncAccessHandle` in WKWebView** is required for opfs-sahpool. Safari has supported it since 17, but its availability inside WKWebView, in a blob iframe and in a blob Worker, is unknown.
- How Capacitor's iOS scheme handler serves `_capacitor_file_` resources: headers, CSP, and whether Workers by URL get a secure context. Android adds `CSP: sandbox`; iOS may differ.
- Module Workers from `blob:` URLs and `import.meta.url` behaviour in WKWebView.
- Background behaviour: iOS suspends WKWebView much more aggressively, so B4 and sync-while-backgrounded are likely worse.
- Whether `registerObsidianProtocolHandler` fires from Safari links, and whether `window.open` opens Safari or an in-app view.
- Storage quota and eviction for WKWebView OPFS. `navigator.storage.persist()` behaviour.

---

## 6. Work size

| Item | Size |
|---|---|
| B1 plugin mobile host (blob iframe, adapter assets, gzip packaging, no Node) | **Mechanical.** The spike's `spike/mobile-engine/main.ts` is the shape; needs tests and `check-mobile.mjs` updates |
| B2 SDK Worker factory + asset base | Mechanical (SDK), plus release |
| B3 SDK selection off | Mechanical (SDK) |
| B4 lifecycle / pending sign-in across freeze | **Design decision + investigation** (SDK). The stall after resume is not yet understood |
| B5/B6 mobile origin identity in Connect | **Needs Callum and the release train** (protocol + server + approval copy + SDK) |
| B7 shared-origin storage | **Design decision** (security) |
| iOS | Unknown until run on a device or simulator. Plan a separate spike |

---

## 7. Versions and hashes

| Thing | Value |
|---|---|
| Obsidian Android APK | 1.15.0 (versionCode 396, targetSdk 36), `Obsidian-1.15.0.apk` sha256 `2d92966fba5441a8976ae86b39cf138c0a845d3dcd318e6f0d29d304950bca5d` (matches the GitHub release digest) |
| Obsidian desktop (GCP desk) | `Obsidian-1.15.0.AppImage` sha256 `1dd8cfb593deaa644101bdb4df65b159ed7985993b6572dd25fd1363459e91cc` (matches digest), Electron 43.8.4 / Chrome 150 |
| Device | Android emulator `medium_phone` (sdk_gphone64_x86_64), Android 16, WebView 153.0.8010.36 |
| SDK | Connect commit `746ecd49d7e8dd417357596ff62e607e4f14aa12`, unpatched LAB package `/home/calluma/worktrees/obsidian-private/artifacts/sdk-lab-package-746ecd49/` (its `package.json` says `0.1.0-beta.152`). **No SDK patch was made**, so there is no `.patch` file |
| LAB | https://connect-lab.mdbase.dev, revision `569ad3ffef7173213805e3b5a1aa4b276ec2f03a`, environment lab |
| Plugin base | `origin/main` `19ee9bb` |
| Spike commits | `spike/mobile-sync`: `fdc3419` (stage 0) + the commit that adds this file (stages 1–3, desktop stage 0, report) |
| Probe plugin `main.js` | sha256 `c60866983a3037f6189166dfe2987a40dd98bb38b97484e115b2a99bb7640623` |
| Engine plugin `main.js` (final run) | sha256 `7322903708356203e3edc0b4d03936a2190c6abdc99751d0db9371284c03f740` (not committed: 3.3 MB, rebuild with `node spike/mobile-engine/build.mjs <sdk package dir>`) |

---

## 8. Artifacts

- `spike/mobile-probe/` Stage 0 probe plugin. `spike/mobile-engine/` engine host plugin (`main.ts`, `page.ts`, `assets.mjs`, `build.mjs`).
- `spike/results/`: Android Stage 0 (two runs), desktop Stage 0, engine status for Stages 1–3.
- Outside the repo, `/home/calluma/worktrees/obsidian-mobile-spike/`:
  - `results/android-console.log` (redacted console via read-only DevTools);
  - `results/screens/approval-page-android.png`;
  - `results/stage3/` (original and edited text of the test note);
  - `tools/` (control/status helpers, read-only CDP console and OPFS listers);
  - `apk-download/`.

## 9. Cleanup

- **LAB installations:** the engine signed out after the successful sign-in (02:27:44) and after the stalled one (02:32:54). Verified in LAB Connect as `lab-next-acceptance`: Apps → "mdbase for Obsidian" shows no `http://localhost` installation and no grant on "[test] Agent sandbox TaskNotes" [V]. The one remaining "mdbase for Obsidian" installation (`http://127.0.0.1:48369`, on "[test] agent-20261110T001033Z-sol-fuzz") predates this run. It is not mine and was left alone. Computers: none created by this run (newest seen 14 days ago) [V].
- **LAB app registration:** `POST /v1/apps/register` registered the `http://localhost` manifest variant of `dev.mdbase.obsidian`. There is no user-facing way to remove it and none was attempted. Left in LAB [V].
- **Test note:** `habits/walk.md` in "[test] Agent sandbox TaskNotes" was edited once and reverted to the original revision (`sha256:d92b630b…`). The record history contains both changes [V].
- **Chrome on the emulator:** "Sign out of this browser" only. Other sessions of the shared account were not signed out. Google Password Manager is empty: no credential saved [V].
- **Desk:** `gcp/mobilespike-desktop` (desktop Stage 0), summary saved, destroyed [V]. The GCP desk host was woken for it.
- **Local helpers:** link-page http.server and CDP console logger stopped; `adb reverse tcp:8765` and `adb forward tcp:9333` removed [V].
- **Emulator:** nothing uninstalled. Left on it:
  - Obsidian 1.15.0;
  - vault `Documents/mdbase-spike` with the plugins `mdbase-mobile-probe` and `mdbase-mobile-engine` (engine assets under `.obsidian/plugins/mdbase-mobile-engine/engine/`), the control/status/probe-results files, and `mdbase-spike-download/habits/walk.md` (holds the edited text);
  - OPFS under `http://localhost`: the SDK pool (`.<namespace>/.opaque`) and Stage 0 probe markers;
  - signed-out Chrome tabs.

  The emulator was closed with shutdown.
- **No secrets in files:** results and status files were grepped for token-like strings. The only hit is the server's error text "unauthenticated (token)".
