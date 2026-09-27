# Native workspace cleanup

The default surface is now a compact Obsidian workspace rather than a dashboard.
The earlier reliability fixes remain in place.

## Changes

- Removed the second brand header, sync route diagram, setup steppers, repeated
  headings, explanatory paragraphs, empty activity panels, and duplicate actions.
- Types prioritizes name, description, and a compact expandable field list.
  Matching, options, contracts, and change review use native disclosure rows.
- One Save/Discard bar, shown only for unsaved changes. Its validation state updates
  while typing without replacing the focused input. It clears the desktop status
  bar instead of allowing Obsidian to obscure Save.
- Sync starts with status and the next action. History and connection/file settings
  expand on demand. Review still lists paths, directions, destructive actions and
  blocking errors. Conflicts expose resolution choices after loading the versions.
- Setup defaults to device name and access. Server, collection ID, attachments and
  exclusions are advanced options. Upload and authority-transfer warnings remain
  explicit, as do schema-change and disconnect confirmations.
- Issues uses a single summary, compact rows, and no empty filters. Technical codes
  remain searchable and available as tooltips; diagnostic messages remain visible.
- Disclosures retain their state across renders. Icon controls have accessible
  labels, notices can be dismissed, and native colors/type/control styling follow
  Obsidian's theme. Expanded fields fit narrow panes without horizontal scrolling.

## Verification

- **106 tests passed**, including eight actual-renderer DOM tests covering compact
  defaults, disclosure state, safety warnings, one save location, live validation,
  conflict review, empty issues and dismissible notices.
- Clean `npm ci`, production build, lint, mobile import/bundle checks, and
  `git diff --check` passed. The pinned reliability SDK patch still applies.
- Real isolated Obsidian: screenshots of five states at 1120 px in light/dark and
  420 px in dark, plus expanded-field checks. Sidebars were collapsed for narrow
  captures. No horizontal overflow in the checked panes after transitions settled.
- Real local type Save and Discard, invalid-name correction, keyboard disclosure
  activation, and checkbox changes survived re-render. Saving the type left the
  synthetic record bytes unchanged.

Default rendered text on identical fixture data (desktop dark):

| Surface | Before | After |
| --- | ---: | ---: |
| Types | 128 words | 26 words |
| Enrollment | 118 | 37 |
| Connected sync | 153 | 17 |
| Transfer review | 211 | 34 |
| Issues | 63 | 48 |

Counts use the panel's `innerText`: scrollable content is included; closed
additional details are excluded. These are fixture comparisons, not a universal
percentage claim for every collection.

Local screenshots, scripts and measurements:

`~/.local/state/mdbase-obsidian/ui-review/20260922/`

Types, validation and saving used the real plugin and disposable local files.
Connected/transfer screenshots used presentation-only controller fixtures in the
actual renderer, not a live Connect account or network synchronization test. This
pass did not re-run backend acceptance or test on a physical mobile device.

No personal vault or installed personal plugin was changed. The isolated process
was stopped and its disposable application profile removed. No commits or release.
