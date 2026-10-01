# Sync UI acceptance in isolated Obsidian

`test/workspaceView.test.ts` and `test/settingsTab.test.ts` exercise the real renderers and handlers in jsdom. Run `npm test` and `npm run lint`.

For visual checks, `scripts/test-sync-layout.cjs` drives an **isolated, disposable** Obsidian instance over Playwright CDP. Never attach it to a personal vault. It stops background sync and injects presentation state; it does not enroll or call a live Connect service.

## Prepare

1. Build the plugin and copy `main.js`, `manifest.json`, and `styles.css` into a disposable vault's `.obsidian/plugins/mdbase-obsidian/`. Enable the plugin in that vault.
2. Use a separate Obsidian app copy and profile. The profile's `obsidian.json` should list only the disposable vault, with `open: true`. Launch with `--no-sandbox --ozone-platform=wayland --user-data-dir=<profile> --password-store=basic --remote-debugging-port=<port>`.
3. Create the opt-in marker `.obsidian/mdbase-ux-disposable` in the disposable vault. The script refuses unmarked vaults and checks the attached vault's exact path before injecting state.
4. Make that isolated window visible so Wayland can paint screenshots. Do not drive another agent's window.

## Run

```sh
MDBASE_UX_CDP_URL=http://127.0.0.1:42001 \
MDBASE_UX_VAULT=/absolute/path/to/disposable-vault \
MDBASE_UX_SHOTS=/absolute/path/to/screenshots \
MDBASE_UX_PLAYWRIGHT=/absolute/path/to/node_modules/@playwright/test \
node scripts/test-sync-layout.cjs after-layout
```

`MDBASE_UX_PLAYWRIGHT` can be omitted if Playwright is already resolvable. It is not a plugin runtime dependency.

The audit captures 16 states at 1100px and 390px, in dark and light themes: healthy, offline, sign-in, copied device, paused, unexpected failure, progress, first-sync review, deletion-burst review, rebuild, unresolved conflict (both versions present, local absent, or hosted absent), pinned conflict history, enrollment, and local upload. Desktop sidebars are collapsed for realistic narrow panes. Assertions reject horizontal overflow and primary/dismiss targets below 44px in narrow panes. Long, unbroken paths are intentional. `*-checks.json` records the measured bounds; the command exits nonzero on a regression.

Review the PNGs as well as the assertions. Diff panels may scroll horizontally within their own surface; the workspace itself must not. Stop the isolated instance after testing and discard its app/profile/vault. Injected profile state is ephemeral and must never be saved as real credentials.
