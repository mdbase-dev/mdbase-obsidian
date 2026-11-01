# Weekly SDK intake and plugin publication

The ops train dispatches `sdk-repin.yml` on main with one exact
`connect_release`. Intake compares it with ops main's production record and the
annotated Connect tag's peeled commit. For every npm package it cryptographically
verifies Sigstore provenance: GitHub OIDC issuer, repository, publisher workflow,
tag, source commit, package version and tarball digest. It refreshes the npm lock
and checks the exact version, registry URL and integrity. Peer ranges and
unrelated local packages remain unchanged. Missing versions or invalid provenance
fail before any manifest is written; there is no latest/LAB/registry fallback.

## One release PR, one publication

The **same** `automation/sdk-repin` PR contains the npm pins and plugin version
bump, using `version-bump.mjs` to update `manifest.json`, `versions.json`,
`package.json` and the root npm lock versions. The next patch is selected from
the existing plugin version, not the Connect version. An already bumped but
untagged version is reused, not incremented again. A stuck tag/draft blocks a
new bump. The release App requests squash auto-merge of this one PR through
required, up-to-date **Obsidian plugin** CI. There is no merge-time version PR,
second automatic bot branch or branch-protection bypass.

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
PR CI never runs the publisher. The SDK's existing vendor dependency remains in
this tooling PR: the actual repin PR performs the production dependency switch.

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

- Enable repository auto-merge and require up-to-date **Obsidian plugin** CI on
  main. Require PRs, zero human approvals for automatic repins, no App bypass.
- Install **mdbase release automation** on this repo (Contents write, Pull
  requests write, Actions write for ops dispatch), with read-only ops access.
  Provide `RELEASE_AUTOMATION_CLIENT_ID` and
  `RELEASE_AUTOMATION_APP_PRIVATE_KEY`. No workflow-token fallback or environment
  reviewer is used. Credential availability must be verified before adoption.
- Community-directory submission/approval is separate from GitHub prereleases.
- SDK-owned native sync PR 31 is a separate feature, not merely a package pin.
  Clearing its old missing-asset guard does not replace its native sync code or
  complete the outstanding LAB acceptance.

Run `npm run test:release` for fixture/provenance/byte-comparison/recovery/workflow
tests. A live intake dry run uses an isolated temporary source copy, runs the
real repin verifier and lock checks, and builds/tests there without pushing or
creating a PR, tag or release. Fixture success is not live SDK compatibility.

### November 2 beta.149 dry-run evidence

The real repin verifier accepted `v0.1.0-beta.149`, matching ops main and the
annotated tag at `4443fd15c4a591e46538eae24cf8425708e6a7f0`. Sigstore signature,
publisher identity, SLSA source and downloaded tarball verification passed. In an
isolated source copy, the exact npm lock verification, same-PR bump to `0.4.3`,
lint, 124 unit tests and mobile build all passed. SDK integrity was
`sha512-hoX+/4KYTbR+qN/gViUbvzX5s7f6lSOg9AOmQVE3USrtJ+9fpnb+4q8YBX9AWRcE43hkXysJH6gPqwgDfIE5Rg==`.
The beta.149 bundle was 691506 bytes raw / 213863 gzip. No PR, tag or release was
created by this dry run; this branch's production dependency is still unchanged.

The npm package is production-packaged and now includes
`dist/application/storage-scope.js` with `bundle-storage:` isolation. Thus it
clears PR 31's original guard. But testing the unchanged PR 31 head
`958863a4128652d090be9f7193fc753c4407b539` against that same verified SDK fails
the production build at `scripts/native-assets.mjs:31`: npm's
`dist/application/asset-pins.json` declares `sqlite.asyncProxy` (32505 bytes,
SHA-256 `9f1970e05ee07a79332498858740b705eeb1dcee03bc150f6f690bc0fb5f0a06`),
but `dist/native/sqlite3-opfs-async-proxy.js` is absent. Its 124 existing unit
tests and 69 native tests pass, but it is not build-qualified. PR 31 cannot be
closed in favour of a repin: its native sync implementation is not supplied by
changing the package pin, and missing-asset remediation plus LAB acceptance
remain separate. No PR 31 code or guards were changed.
