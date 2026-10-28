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

To continue in desktop, choose **Finish and stop** in Sync. Obsidian stops
admitting sends, finishes admitted work, scans once more, waits for confirmed
receipts with pending/holds/unresolved all zero, stops the SDK and only then
removes its own marker. If any step fails it retains ownership and recovery
state. Avoid editing during this transfer. Then add the existing folder to
mdbase using the **same collection**; ordinary enrollment/approval still applies.
When desktop publishes its marker, Obsidian connects to desktop automatically.

After desktop gracefully stops/pause/removal and releases its marker and OS lock,
Obsidian resumes its SDK host and reconciles before sending. A leftover desktop
marker after a crash is deliberately not overridden. Copied/stale-marker takeover
needs explicit recovery, not a timeout. The inherited OS-lock probe currently
uses Linux `flock`; other systems fail closed if a desktop lock file exists.
Mobile and Android shared-localhost support are not part of this implementation.

## Build and acceptance status

The production dependency must be replaced with an authenticated production SDK
bundle containing native-platform and complete vault-namespace support. The
currently pinned beta.141-era SDK does not contain the namespace implementation;
production builds intentionally refuse rather than silently omitting safety or
retargeting a LAB trust bundle. This integration is not release-ready until that
intake and live acceptance are complete.

For development against an already authenticated LAB SDK package:

```sh
npm ci
npm test
npm run lint
node esbuild.config.mjs production --lab --native-sdk /absolute/path/to/sdk/package
node scripts/check-mobile.mjs
```

Do not publish that LAB build. Ordinary production build remains `npm run build`.
The native asset packer checks SDK asset hashes and sizes and preserves SDK-owned
Worker/WASM URL relationships; it includes the official OPFS proxy when pinned
by the supplied SDK.

Unit tests exercise real vault IO for concurrent edits, renames, deletes,
conflict-publication recovery, upload recovery, ownership transitions and fixed
ports. The 50 MiB download test transfers actual MessagePort replies and checks
one outstanding pull and 4 MiB maximum reply size. Verification-error and digest
mismatch tests prove the existing vault bytes remain unchanged.
