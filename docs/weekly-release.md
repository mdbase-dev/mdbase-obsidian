# Weekly SDK intake and plugin publication

The ops weekly train dispatches `sdk-repin.yml` on main with one exact
`connect_release`. The app compares it with ops main's production record and
the public annotated Connect tag's peeled commit. It verifies npm provenance
cryptographically with Sigstore, including the GitHub OIDC issuer, repository,
publisher workflow, tag, source commit, package version and tarball digest.
It then refreshes the npm lock and checks its exact version, registry URL and
integrity before pushing the single `automation/sdk-repin` PR. Peer ranges and
unrelated local packages are unchanged. The SDK's existing vendor dependency is
deliberately preserved in this tooling PR; only successful intake replaces it.

The first supported npm SDK is `0.1.0-beta.149`, after Connect beta.149 is
production-verified and published. Missing versions, missing/invalid provenance,
advanced production records and registry errors fail before any manifest is
written. There is no `npm latest`, alternate registry, LAB bundle, older version
or workflow-token fallback. Fixture tests do not claim SDK compatibility: the
actual repin PR must pass the full build, lint, unit and mobile checks.

## Protected release sequence

1. Required **Obsidian plugin** CI gates both automated PRs. The release App
   requests squash auto-merge; it does not bypass main protection.
2. After a successful main Build, the release job compares release-relevant
   source with the highest published numeric plugin tag, including historical
   prereleases. Docs-only changes and unchanged reruns do nothing. The baseline
   must be an ancestor; missing history or backwards versions fail closed.
3. If main still has the released version, the job runs
   `node version-bump.mjs NEXT_PATCH` and opens/updates the single
   `automation/plugin-release` PR. This updates `manifest.json`, `versions.json`,
   `package.json` and the root npm lock versions atomically in one commit. It
   uses the App token so its PR CI and subsequent main push CI actually run.
4. After the version PR merges and main CI passes, the job downloads only that
   build's asset artifact. It creates an annotated tag with the bare plugin
   version (for example `0.4.3`, never `v0.4.3`) at the checked commit and a draft
   GitHub release. It uploads `main.js`, `manifest.json` and `styles.css`, then
   downloads and verifies all three digests before making a non-prerelease,
   latest release visible to the community plugin updater.

Publication runs only for main push/manual Build events after all checks and
asset validation, never for PRs. Release jobs are serialized without cancellation;
stale main builds refuse to mutate tags or publish. A retry reuses a matching tag
and draft, repairing its assets before publication; it never moves a tag or
modifies an already published release. Rerun the original Build if a tag/draft was
created before interruption. If main has advanced, investigate the existing tag
and draft rather than deleting or force-moving them. Do not dispatch a Build as
a dry run: on main it can create PRs, tags and releases.

## Repository setup and remaining qualification

As of November 1, 2026, repository auto-merge is enabled and main protection
requires the GitHub Actions **Obsidian plugin** check on an up-to-date branch,
including for administrators. Pull requests are required with zero human
approvals. Repository and organization Actions variable/secret listings contain
neither release App credential, so unattended operation is still blocked on
their provisioning. This is not a successful production publication claim.

- Enable repository auto-merge and require **Obsidian plugin** on up-to-date
  branches targeting main, with no required human review or bypass for the App.
- Install **mdbase release automation** on this repository (Contents write,
  Pull requests write, Actions write for the ops dispatch). Its ops installation
  also needs read access to `mdbase-cloud-ops`.
- Provide `RELEASE_AUTOMATION_CLIENT_ID` as an Actions variable and
  `RELEASE_AUTOMATION_APP_PRIVATE_KEY` as an Actions secret, with visibility to
  this repository. Missing credentials fail rather than falling back to
  `GITHUB_TOKEN`. No environment approval gate is used.
- Obsidian community-directory approval is separate from publishing updater
  assets. If the plugin is not yet listed, Callum must submit/complete that
  review; the release workflow cannot approve its own listing.
- SDK-owned sync PR 31 is a separate draft feature, not superseded by this
  release tooling. Its October 28 Build deliberately refuses because the
  beta.141 vendor SDK lacks `dist/application/storage-scope.js`, the production
  native-platform/vault-isolation prerequisite. Do not bypass this production
  guard or substitute LAB assets. It still needs qualified production SDK intake,
  rebasing onto the npm release tooling and its outstanding LAB acceptance before
  being eligible to merge. This PR does not claim that feature is fixed.

Run `npm run test:release` for local, mocked registry/provenance and publication
tests. These never call production GitHub mutations or publish a package.
