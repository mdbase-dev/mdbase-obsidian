# Recovery from missing collection-move credentials

## Observed failure

The registered `test` vault had a v1 adoption checkpoint in `uploading`, with
an authorization expiry of 2026-07-31, no mirror profile, and no usable adoption
credential in Obsidian's secret store. Resume and Cancel both required that
credential. Browser sign-in could not restore this device-specific secret.
The original cause of the credential's absence is not established; this is not
proof of a Google OAuth failure.

## Changes

- Sync detects unavailable authorization before offering Resume/Cancel, including
  a secret store that throws rather than returning a missing value.
- **Reset setup** is available only for an expired, credential-less request still
  in `waiting_for_approval` or `uploading`. It rereads the durable phase, refuses
  a mirror profile/role marker, and preserves collection identity and files.
  These phases never freeze the local collection or send activation. This is
  local retirement, not a claim that an authenticated remote cancellation ran.
  Connect reclaims expired inactive imports through its existing expiry handling.
- Frozen/activating/completed checkpoints cannot be reset this way. **Reconnect
  collection** uses fresh browser-approved mirror enrollment for the exact same
  collection with read-write access. The server's mirror policy requires an
  active accessible hosted authority. No activation request is sent by recovery.
  Failures, mismatched approval, cancellation and storage failure preserve the
  checkpoint/write protection. Files are not overwritten during reconnection.
- Adoption operations are mutually exclusive. A concurrent reset/cancel/resume
  cannot race an in-flight move or recovery.
- Adoption and mirror credentials are read back immediately after storage, before
  publishing a checkpoint/connection. An unapproved adoption request is cancelled
  best-effort if storage fails. This detects immediate failures, not proof of
  OS-level persistence across an application/process crash.
- Failure to clear an already retired secret does not leave a ghost checkpoint in
  memory after successful metadata cleanup. No secret is copied into vault files.
- Old approval links and impossible Resume/Cancel actions are hidden in recovery.
  For a still-live early request, the UI gives the reset eligibility time and a
  Check again action rather than pretending the lost credential can be resumed.

## Boundaries

An inaccessible hosted authority that has not completed activation cannot be
recovered by pretending it is active. A frozen checkpoint whose credential is
permanently lost and whose remote import is inactive still needs authenticated
server-side reconciliation; this patch deliberately does not unlock it locally.
No backend/production deployment or OAuth configuration change was made.

## Verification

120 tests pass. Coverage includes missing and throwing secret stores, early-phase
reset, live/usable-credential refusal, stale durable state, late-phase reconnect,
wrong-collection approval, abort, concurrent operations, cleanup failure, silent
credential-write failure, and rendered recovery controls. Build, lint, mobile
bundle/import checks and diff whitespace checks pass.

In the real registered test vault:

- Reloaded the build while preserving the unsaved Task type draft.
- Observed the new Reset setup action and invoked its ordinary UI handler.
- Verified all **9,294 Markdown files plus mdbase.yaml** remained byte-for-byte
  unchanged across recovery.
- Started a fresh move through Host collection. Production returned a new
  `waiting_for_approval` session; the plugin verified its credential was available
  and displayed a fresh approval link. Opened that link for the user.
- Final connection/upload remains dependent on fresh human browser approval.
  No success or production sync acceptance is claimed before that completes.

The late-phase paths were verified with deterministic tests and the server's
existing authorization contract, not destructive trials against production data.
