# SDK intake and plugin publication

The ops [continuous SDK repin train](https://github.com/mdbase-dev/mdbase-cloud-ops/blob/main/docs/continuous-sdk-repins.md)
owns SDK intake for this plugin. It polls npm for the highest published
`@mdbase-dev/sdk`, whose version is independent of the Connect release. It
verifies Sigstore provenance and the signed source, vendors the exact archive and
its metadata under `vendor/`, refreshes the npm lock and checks the exact pin,
version and integrity. A trust rotation or invalid provenance refuses before
any PR. Ops holds the updater and its tests.

## Two versions on main

- `package.json` (with `package-lock.json` and a `versions.json` entry) holds
  the version being built and prereleased. Release PRs bump it.
- `manifest.json` holds the version Obsidian's community list serves: the newest
  full release. Obsidian reads it from main and installs that tag, ignoring
  prereleases, so a manifest naming a prerelease gets the plugin dropped from the
  list until it is fixed. That happened on 2026-11-17, when main named 0.4.37
  while 0.4.35 was the newest full release. Only promotion moves it (below).
- Published assets carry `manifest.json` stamped with the `package.json`
  version, so BRAT and Obsidian see the right version once installed.
  `copy-files.mjs` stamps local dev copies the same way.

Don't edit the version in `manifest.json` by hand. Its other fields are edited
on main as usual and ship with the next release.

## Quiet prereleases

Merges to main, SDK repins included, do not publish by themselves. A repin PR
carries only the archive pin and lock; it does not bump the plugin version.

`prerelease.yml` runs every 20 minutes (and on manual dispatch). Once no commit
has landed on main for three hours, it compares main with the newest published
release. A diff touching only Markdown, `docs/`, `test/` or `.github/` is a
no-op. Otherwise it builds main and compares the bytes as publication does
(below). If they differ, it runs `version-bump.mjs` with the next patch version,
opens a `release/<plugin-version>` PR with the three build-version files
(`package.json`, `package-lock.json`, `versions.json`) and asks it to merge itself when required CI passes. Merging that PR publishes the prerelease.
A burst of merges therefore ships once, about three hours after the last one.

- An open release PR is moved along only while main is quiet: brought up to
  date if it is behind, and asked to merge itself if it isn't already.
- To hold a release, close its PR and keep the `release/<version>` branch.
  Deleting the branch lets the job open it again.
- A bumped but unpublished version, or a tag or draft without a published
  release, stops the job until publication finishes (see recovery below).

To publish sooner, manually dispatch `version-bump.yml` on main. It opens the
same kind of `release/<plugin-version>` PR without asking it to merge itself.
Merge it once CI passes (or let the next quiet run do so). That workflow never
tags or publishes. Dispatching Build on main is a publication retry, **not** a
version bump or dry run.

After all main Build checks pass, publication:

1. Returns a successful no-op if the job is stale (main advanced) or the
   `package.json` version already has a published release. It refuses if
   `manifest.json` is not behind that version. It never overwrites published assets.
2. Downloads the highest published numeric plugin release's three assets. It
   compares the actual CI-built `main.js` and `styles.css` byte-for-byte and the
   parsed manifest excluding **only** its `version`. A version-only/formatting
   change, docs-only edit or equivalent rebuilt bundle is a no-op. Source path
   lists do not decide publication. Missing baseline assets fail closed.
3. For changed assets under an unpublished version, creates its bare numeric
   tag (e.g. `0.4.3`, never `v0.4.3`) at the checked commit and a draft prerelease.
   It uploads `main.js`, `manifest.json` (stamped with the build version) and
   `styles.css`, downloads all three and compares their SHA-256 hashes with the
   files it uploaded before publishing.
4. Publishes as a **prerelease**, with `latest=false`.

## Full releases are promoted by hand

Obsidian's community directory ignores prereleases, so a prerelease reaches
directory users only once it is promoted. Nothing promotes automatically. To
ship the newest prerelease to everyone, dispatch `promote.yml` (**Promote plugin
release**) on main from the Actions tab. It makes the newest published
prerelease the full release marked **Latest**, and does nothing while a draft or
a tag without a published release exists. Then it opens a `listing/<version>`
PR that changes only the version in `manifest.json` to that release, and asks
it to merge itself when required CI passes. The release turns full first, so the
manifest never names a prerelease. Merging the PR publishes nothing. Rerunning
`promote.yml` finishes a listing PR that didn't open or merge. To hold the
listing, close its PR and keep the branch.

By hand: `gh release edit <version> --prerelease=false --latest`, then run
`promote.yml` (it skips promotion and opens the listing PR), or change the
`manifest.json` version in a PR yourself.

The release job is main-only, serialized without cancellation, and SHA-pins all
actions. Only Contents write is needed for publication, not Pull requests write; the
quiet prerelease and promotion jobs also need Pull requests write to open their PRs. PR CI never
runs the publisher.

## Stuck publication and recovery

A tag with no published assets, or a draft prerelease, is unfinished publication,
**not success**. It blocks later versions and new automatic version bumps. Watch
the main Build's **Publish plugin prerelease** job, not only PR CI. Fix failures
promptly so main is not left advertising an unavailable version.

- Rerun Build on current main while it still has the stuck version. The resolver
  selects the **original tag commit**, even if main has advanced at the same
  version. It checks ancestry and the `package.json` version, checks out that commit and
  reruns install, lint, tests and mobile build before repairing the draft. An
  existing draft/tag is reused; the tag is never moved. Newer source changes are
  not substituted into an existing version and need the next version PR.
- If only a draft exists, its `target_commitish` must be an exact, reachable
  commit with the same `package.json` version. Recovery rebuilds that commit and
  restores the missing tag there. An ambiguous target (e.g. `main`) refuses.
- If main already has a later version, restore the stuck package/lock
  version in a normal PR (with its `versions.json` entry), merge through CI and
  complete that original publication first. Then restore/bump the later version
  through another PR. Do not retry an old stale workflow expecting publication:
  it intentionally exits successfully without mutation.
- If rebuild/provenance, asset download, credentials or permissions fail, repair
  the underlying problem and retry. Do not force-move a tag, delete a published
  release, manually mark a partial draft public or substitute another build. If
  an unused version-only draft/tag cannot be completed because its bytes are
  unchanged, stop and ask Callum to authorize reconciliation of that unpublished
  state; the automation does not delete it or silently skip to a later version.

If a stale check fires after a tag/upload was already accepted, the job stops
successfully and leaves the same observable unfinished state for the next current
Build to resume. Completion is a published prerelease with all three matching
assets, not an accepted command or a green stale no-op.

## Setup and qualification

- Require up-to-date **Obsidian plugin** CI on main. Require PRs, zero human approvals for automatic repin and release PRs, no App bypass.
- Install **mdbase release automation** on this repo (Contents write, Pull
  requests write, Actions read).
  Provide `RELEASE_AUTOMATION_CLIENT_ID` and
  `RELEASE_AUTOMATION_APP_PRIVATE_KEY`. No workflow-token fallback or environment
  reviewer is used. Credential availability must be verified before adoption.
- Community-directory submission/approval is separate from GitHub prereleases.
- SDK-owned native sync is described in [sdk-sync.md](sdk-sync.md).

Run `npm run test:release` for fixture, byte-comparison, recovery and workflow
tests.
