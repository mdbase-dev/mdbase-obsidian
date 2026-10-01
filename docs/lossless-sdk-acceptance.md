# Lossless SDK consumer qualification

## Shipping versus candidate behavior

The tracked dependency pins are `connect-sync` / `connect-protocol`
`0.1.0-beta.120`. That release includes the lossless behavior first qualified
below as a candidate (Connect commit `87e28391233c`): readable malformed YAML is a
nonblocking structural diagnostic by default, with no option, protocol change, or
public TypeScript shape change. `npm test` now runs the strict lossless check
(`npm run test:lossless`) against the installed SDK, which passes on beta.120.

beta.120 also synchronizes Obsidian Bases (`.base`) as YAML document records. The
Obsidian adapter therefore lists `.md` and `.base` files as records and never as
binary files, matching the SDK's Node adapter.

The historical results below were recorded before the upgrade, against beta.91
and the unpublished candidate.

## Consumer changes

- Obsidian's binary-to-text adapter preserves UTF-8 BOMs, CRLF and final-newline
  choices. Invalid UTF-8 still fails safely.
- The reviewed plan remains the sole apply gate. Diagnostic count and issue code
  alone do not decide whether sync is paused.
- Nonblocking diagnostics say `review`, not mandatory `fix`; warning prose no
  longer promises that all synchronization is paused.
- Validation remains separate. A regression runs actual plugin schema validation
  (missing required title, wrong priority type, invalid enum), transfers the
  unchanged record through `MemoryAuthority` into a second mocked Vault, and
  verifies that the validation errors are still present afterward.

## Automated results

Node 24.19.0:

| Installed SDK | Unit tests | Build / mobile |
| --- | --- | --- |
| Released beta.91 | 96 passed | 687,949 raw / 195,842 gzip bytes |
| Candidate from `87e28391233c` | 96 passed | 689,242 raw / 196,214 gzip bytes |

Both build sizes satisfy the unchanged mobile budgets. Lint passes with the
released dependencies. No consumer TypeScript adjustment was needed for the
candidate. Both package manifests and the lockfile keep their released pins.

`npm run test:sdk-candidate` additionally passes ten exact round trips through
the real `ObsidianMirrorFileSystem` and portable sync engine, including malformed
YAML, duplicate keys, scalar/null/list frontmatter, BOM/CRLF, missing final
newline, BOM-prefixed valid mappings and body-only notes, and a valid sibling. It checks that the preview enables the transfers
and the receive-only mirror settles without attempting repeated repairs.

The released beta.91 control run failed this stricter command at the expected
assertion: seven blocking issues instead of zero. The candidate passed without
changing the test or adding a runtime option, as does released beta.120. To
qualify a future immutable candidate without changing tracked dependency pins:

```sh
npm ci --ignore-scripts
npm install --no-save --package-lock=false --ignore-scripts \
  /path/to/immutable-protocol.tgz /path/to/immutable-sync.tgz
npx patch-package   # the reliability patch is version-specific; rebase if needed
npm test
npm run check:mobile
# Restore released dependencies and the release-pinned generated bundle:
npm ci
npm run check:mobile
```

## Boundaries not qualified here

The Vault APIs and authority in these tests are in-memory fixtures. Schema
validation is real plugin code, but the lightweight Obsidian YAML mock uses
JSON-compatible YAML. These results are not live Obsidian or deployed-hosted
acceptance, and do not verify production or staging.

The prior LAB port-ownership failure and requirement for a clean disposable
Obsidian vault remain outstanding. No guards were bypassed, no existing vault
metadata was removed, and no LAB fixture, installed plugin, production, or
staging service was changed in this work.

The recovery workspace remains a separate draft PR; this branch does not merge
or replace it.
