# mdbase for Obsidian — Design Direction

## Character

The plugin should feel like an Obsidian core plugin: quiet lists, compact controls, native typography, and the user's theme. Do not add an application-style brand header, dashboard, diagram, or onboarding stepper inside the workspace tab.

## Surface model

Use one first-class workspace view with three destinations:

- Types — searchable type list and editor.
- Sync — local or hosted collection status and actions.
- Issues — validation, migration, and synchronization problems.

Destinations use standard tab-like controls or compact navigation. They are not dashboard cards.

On wide screens, Types uses a list-and-document split:

- A narrow searchable list of type definitions.
- A flexible editor document with a restrained header, Design/YAML switch, and review/save actions.

On mobile, the list and editor become separate navigation states. Controls remain at least 44px high where practical, and primary actions stay reachable without horizontal scrolling.

## Information and copy

- Types opens with name, description, and fields. Matching, options, application contracts, and detailed change review expand in place.
- Sync opens with connection status and one primary action. Settings and history are secondary disclosures. Keep transfer paths, directions, destructive actions, conflicts, and blocking errors visible when relevant.
- Issues has one count and one validation action. Do not show empty filters, repeated summaries, or a second empty-state panel.
- Prefer labels to explanations. Remove sentences that merely describe the adjacent control or promise implementation details such as checkpoint precision.
- Keep concise, explicit warnings at upload, authority-transfer, schema-change, and deletion boundaries. Fewer words must not mean less informed consent.
- Use one Save/Discard location. Avoid duplicate actions, status badges, and explanatory banners. Notices are dismissible.
- Preserve disclosure state and keyboard focus across renders. Icon actions need accessible names and tooltips; nothing essential is hover-only.

## Visual language

- Use Obsidian CSS variables for canvas, text, borders, interactive states, and typography.
- Use `--interactive-accent` for selected or primary states. Do not introduce a competing palette.
- A subtle mdbase blue-black may be used for the plugin mark or quiet identity detail only when it remains theme-compatible.
- Prefer flat sections separated by 1px rules and whitespace.
- Avoid nested cards, large bordered containers, gradients, glass effects, dramatic shadows, and decorative side stripes.
- Use sentence case throughout.
- Use familiar Obsidian icons and text labels; do not invent symbolic controls.

## Type workbench

The editor is a document, not a form dump.

1. Header: type name, source path, spec status, and dirty state.
2. Mode switch: Design and YAML.
3. Design sections:
   - Identity
   - Membership
   - Fields
   - Lifecycle and links when present
   - Extensions
4. Review area: validation errors, compatibility risks, and a concise description of pending changes.
5. Sticky or consistently placed Save action.

Field rows show name, data shape, required state, and a compact summary. Editing a nested object may expand inline or use a focused sub-editor, but should preserve the user's place.

The YAML mode uses an ordinary textarea/editor surface with monospace text, clear validation feedback, and no hidden normalization on failed parse.

## Synchronization

The Sync destination answers four questions in order:

1. What role is this vault in?
2. Is it connected and safe to sync?
3. What happened last time?
4. What action is available now?

Progress is expressed with concise text and a standard progress indicator. Conflicts appear as a list of paths and reasons with explicit resolution actions. Error messages state what was left unchanged.

Enrollment is an inline setup flow in the Sync destination. Enrollment codes and credentials are treated as secrets and disappear from the surface after use.

## Migration

For v0.2 collections, Types remains browsable but editing controls are disabled with a clear explanation. A migration review shows:

- Source and target specification versions.
- Configuration and type files that will change.
- Warnings and lossy diagnostics.
- Backup/recovery location.
- The fact that records will not be rewritten.

Migration apply is a deliberate action after review. Completion links the user back to the type workbench and reports verification results.

## Interaction and accessibility

- Visible keyboard focus on every interactive element.
- Native buttons, inputs, and labels wherever possible.
- Status is communicated with text as well as color.
- Motion is limited to purposeful 150–250ms transitions and respects reduced motion.
- Loading, empty, error, read-only, dirty, and conflict states are all designed explicitly.
- Do not put essential actions behind hover.

## Responsive behavior

- Desktop: split list/editor, compact three-destination navigation.
- Narrow desktop/tablet: narrower list, document remains primary.
- Mobile: destination bar and list/detail navigation; no permanent split pane.
- All scrolling is local and predictable. Avoid nested horizontal scroll containers.

