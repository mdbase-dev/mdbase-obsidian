# SDK intake and plugin publication

The ops [continuous SDK repin train](https://github.com/mdbase-dev/mdbase-cloud-ops/blob/main/docs/continuous-sdk-repins.md)
owns SDK intake for this plugin. It polls npm for the highest published
`@mdbase-dev/sdk`, whose version is independent of the Connect release. It
verifies Sigstore provenance and the signed source, vendors the exact archive and
its metadata under `vendor/`, refreshes the npm lock and checks the exact pin,
version and integrity. A trust rotation, invalid provenance or stuck plugin
release refuses before any PR. Ops holds the updater and its tests.

## One release PR, one publication

The **same** `automation/sdk-repin` PR contains the archive pin and plugin version
bump, using `version-bump.mjs` to update `manifest.json`, `versions.json`,
`package.json` and the root npm lock versions. The next patch is selected from
the existing plugin version, not the Connect version. An already bumped but
untagged version is reused, not incremented again. A stuck tag/draft blocks a
new bump. The train merges this one PR after a later poll sees required,
up-to-date **Obsidian plugin** CI pass on its reproduced bytes. There is no
merge-time version PR, second automatic bot branch or branch-protection bypass.

Ordinary human merges **do not release** when the manifest version already has
a published release. A human preparing a release runs, in their own PR:

```sh
node version-bump.mjs "$(node scripts/plugin-release.mjs next-version)"
```

Alternatively, manually dispatch `version-bump.yml` on main. It opens a normal
`release/<plugin-version>` PR with the same four version files, no force push and
**no auto-merge request**. A human reviews/merges it through normal CI. That
workflow never tags or publishes. Dispatching Build on main is a publication
retry, **not** a version bump or dry run.

After all main Build checks pass, publication:

1. Returns a successful no-op if the job is stale (main advanced) or the manifest
   version already has a published release. It never overwrites published assets.
2. Downloads the highest published numeric plugin release's three assets. It
   compares the actual CI-built `main.js` and `styles.css` byte-for-byte and the
   parsed manifest excluding **only** its `version`. A version-only/formatting
   change, docs-only edit or equivalent rebuilt bundle is a no-op. Source path
   lists do not decide publication. Missing baseline assets fail closed.
3. For changed assets under an unpublished version, creates its bare numeric
   tag (e.g. `0.4.3`, never `v0.4.3`) at the checked commit and a draft prerelease.
   It uploads `main.js`, `manifest.json` and `styles.css`, downloads all three and
   compares their SHA-256 hashes with the local validated files before publishing.
4. Publishes as a **prerelease**, with `latest=false`, preserving releases
   0.3.1–0.4.2's policy. Callum decides any stable/latest transition after listing.

The release job is main-only, serialized without cancellation, and SHA-pins all
actions. Only Contents write is needed for publication, not Pull requests write.
PR CI never runs the publisher.

## Stuck publication and recovery

A tag with no published assets, or a draft prerelease, is unfinished publication,
**not success**. It blocks later versions and new automatic version bumps. Watch
the main Build's **Publish plugin prerelease** job, not only PR CI. Fix failures
promptly so main is not left advertising an unavailable version.

- Rerun Build on current main while it still has the stuck version. The resolver
  selects the **original tag commit**, even if main has advanced at the same
  version. It checks ancestry and manifest version, checks out that commit and
  reruns install, lint, tests and mobile build before repairing the draft. An
  existing draft/tag is reused; the tag is never moved. Newer source changes are
  not substituted into an existing version and need the next version PR.
- If only a draft exists, its `target_commitish` must be an exact, reachable
  commit with the same manifest version. Recovery rebuilds that commit and
  restores the missing tag there. An ambiguous target (e.g. `main`) refuses.
- If main already has a later version, restore the stuck manifest/package/lock
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

- Require up-to-date **Obsidian plugin** CI on main. Require PRs, zero human approvals for automatic repins, no App bypass.
- Install **mdbase release automation** on this repo (Contents write, Pull
  requests write, Actions read).
  Provide `RELEASE_AUTOMATION_CLIENT_ID` and
  `RELEASE_AUTOMATION_APP_PRIVATE_KEY`. No workflow-token fallback or environment
  reviewer is used. Credential availability must be verified before adoption.
- Community-directory submission/approval is separate from GitHub prereleases.
- SDK-owned native sync is described in [sdk-sync.md](sdk-sync.md).

Run `npm run test:release` for fixture, byte-comparison, recovery and workflow
tests.
