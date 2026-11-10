# Vault sync ownership

Obsidian uses one Sync destination. On desktop, the folder's `.mdbase/host.json`
selects its owner:

- `host: "daemon"`: use the existing authenticated desktop connection, including
  editor fences and held-file decisions. An unreachable desktop or an old
  heartbeat never grants permission to start another replica.
- No marker: start the plugin's native SDK host and publish an Obsidian marker
  before mirroring. An existing Obsidian marker must match this vault's journal.
- Unreadable or unknown markers: stop and wait; never remove somebody else's
  marker automatically.

The plugin's private `sync-state.json` sits alongside its existing `data.json`
settings, not in the mirrored namespace. It stores a vault UUID, fixed loopback
port, collection binding, per-path identity/revision/hash, preservation journals
and upload identities. Copying that file to another vault or computer is refused.
SDK installation, locks, grants, Worker and OPFS use the stable vault namespace.
The SDK manifest declares a native application with a numeric IPv4 loopback
homepage and callback. The iframe gets a memory-only capability URL; unauthorised
HTML requests are refused. Only its owning window receives the private RPC port.

## Recovery and conflicts

Startup watches before scanning, then reconciles disk, saved baselines and the
current replica. An offline change is never replaced just because remote changed.
Both versions survive as ordinary `name (conflict YYYY-MM-DD HHMM device).md`
files. Preservation intent precedes local IO and remote publication, and recovery
reuses a confirmed copy rather than generating another one. The whole `.mdbase/`,
Obsidian configuration directory, `.trash/` and `.git/` are excluded.

Attachment uploads save exact recovery bytes and transfer/mutation identities
before sending. A 180-second RPC timeout retries with those same identities;
the iframe joins the existing operation rather than starting another write.
After restart, the journal resumes the same transfer before reconciling newer
local bytes. Unknown record-write outcomes without preservation proof stay
blocked rather than being blindly resubmitted.

Attachment downloads use one outstanding pull RPC, with at most 4 MiB of owned,
transferred bytes per reply. Provisional bytes go to a private staging file.
Successful SDK-verified EOF and the expected SHA-256 are both required before
atomic publication; failure removes staging and leaves the vault file untouched.

## Moving ownership

To continue in desktop, choose **Move to mdbase app** in Sync (under Advanced). Obsidian stops
admitting sends, finishes admitted work, scans once more, waits for confirmed
receipts with pending/holds/unresolved all zero, stops the SDK and only then
removes its own marker. If any step fails it retains ownership and recovery
state. Avoid editing during this transfer. Then add the existing folder to
mdbase using the **same collection**; ordinary enrollment/approval still applies.
Until then Sync and the status bar say **Moved to mdbase app**, in a neutral tone,
with that next step. When desktop publishes its marker, Obsidian connects to
desktop automatically.

After desktop gracefully stops/pause/removal and releases its marker and OS lock,
Obsidian resumes its SDK host and reconciles before sending. A leftover desktop
marker after a crash is deliberately not overridden. Copied/stale-marker takeover
needs explicit recovery, not a timeout. The inherited OS-lock probe currently
uses Linux `flock`; other systems fail closed if a desktop lock file exists.
Mobile and Android shared-localhost support are not part of this implementation.

## Signing in

**Sign in** opens the approval page in the system browser; the SDK runs with a
sign-in opener, so no browser user gesture is needed inside the iframe. When an
approval isn't finished (cancelled, closed, refused, say at a collection limit),
the SDK reports a problem with `action: "sign_in"` and Sync offers **Sign in
again**, which calls the same SDK `signIn()`. The SDK itself renews the expired
or refused approval window, keeping the original installation and account.

Because that renewal keeps the account first chosen, signing in again as a
different account can't continue. While no collection is bound and nothing is
waiting to be sent (no synced paths, cursor, uploads, pending paths or
preservation journals), Sync also offers **Start over**. It calls the SDK's
`signOut()` without `discard`, which erases only this vault's SDK sign-in data
(installation, keys) and refuses by itself if writes are unsent. The plugin's
journal and its own marker are kept; no other marker is ever removed. Once a
collection is bound, Start over is not offered.

While a vault that already has a collection waits for approval in the browser
(the SDK's `authorizing` phase with a bound collection), Sync and the status bar
say **Waiting for approval** and offer **Open approval page**, which calls
`signIn()` again. The SDK carries no refusal reason, so none is shown.

Other SDK problem actions: `approve` offers **Request access again** (for a
named collection); `retry`, `check_connection`, `wait`, `resolve_outcome` and
unknown actions offer **Try again**, which calls the SDK's `start()`. If the SDK
then reports the same stop, Sync says "Tried again, but sync still can't
continue." `choose_collection`, `set_up`, `update_app`, `free_space`,
`contact_support` and `none` offer no button, and the message says what to do.

## Restart sync

`reload`, and any problem whose code starts with `application_worker_`, offer
**Restart sync** instead. The SDK's application Worker quarantines itself on
those codes: it neither stops nor answers, every later call fails, and `stop()`
throws. A web app recovers by reloading the page; Restart sync does the same.
It unloads the SDK host without waiting for the SDK. Removing the iframe ends its
document, which runs the SDK's own pagehide path and releases its Worker, Web
Locks, BroadcastChannels and OPFS handles. Then it builds a new host.

Teardown runs every step even if an earlier one throws: timers, a final journal
write, the RPC port, the iframe, then the loopback server with all of its open
connections. Pending RPCs are rejected. After unload the old host never writes
`sync-state.json` again, and its late messages and status callbacks are
ignored. The new host starts only once the old server has closed (at most 5 s),
and it retries its saved port for up to 2 s, so it keeps the same origin and
SDK storage. The journal and the ownership marker are kept throughout, as across
a plugin reload. An unload while the host is still starting leaves no iframe or
listener behind.

When the Worker is gone, **Start over** first restarts sync, waits up to 60 s
for the new host, and then signs out there. A new host first resumes the sign-in
left waiting in the browser and may stop again a second or two later, so Start
over gives it up to 15 s to reach a state it can sign out from. If that can't
finish, Sync shows why.

A fresh host resumes an unfinished sign-in, so Restart sync alone does not get
past a sign-in that is itself broken: on production (SDK beta.173) it stopped
again each time until the approval page was cancelled or expired. While nothing
is bound and nothing has synced, Sync therefore says "Sign-in stopped working"
and makes Start over the primary button, with Restart sync beside it. Connect
PR 1412 fixes the two SDK faults behind that stop; this stays as the way out of
any later one.

If the SDK stays in `starting` for 30 s, Sync and the status bar say "Sync
hasn't started" and offer Restart sync.

## Private collections

The app declaration asks for the optional `offline.replica` capability. When the
server has Private app devices switched on, the sign-in page in mdbase offers,
per collection, to let this device keep that collection's key. A Private
collection is listed in the plugin only if that was allowed. The SDK doesn't say
whether the server offers this, so the plugin's hints are worded to hold either
way and don't send people looking for the choice.

- With its key, a Private collection syncs like any other.
- Without it, Sync shows **Locked** and an unlock form for the encryption
  password or recovery key.
- When access is removed in mdbase, sync stops and the notes stay as they are.
  **Request access again** reopens the approval page.

Needs SDK 0.1.0-beta.173 or later. On a server with the switch off, Private
collections are not offered and nothing else changes.

## Build

`npm run build` builds against the vendored production SDK. The native asset
packer refuses an SDK that is not packaged for the environment being built, and
checks every embedded SDK asset against the SDK's own pins. The SDK pins the
official OPFS proxy but never loads it, and the published package leaves it out;
the packer embeds it only when the supplied package has it.

To build against an authenticated LAB SDK package:

```sh
npm ci
node esbuild.config.mjs production --lab --native-sdk /absolute/path/to/sdk/package
```

Do not publish a LAB build.

Unit tests exercise real vault IO for concurrent edits, renames, deletes,
conflict-publication recovery, upload recovery, ownership transitions and fixed
ports. The 50 MiB download test transfers actual MessagePort replies and checks
one outstanding pull and 4 MiB maximum reply size. Verification-error and digest
mismatch tests prove the existing vault bytes remain unchanged.
