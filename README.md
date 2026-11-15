# mdbase for Obsidian

Give your notes types, check them, and sync them with
[mdbase](https://mdbase.dev).

mdbase treats a folder of Markdown notes as a collection of typed records. A
*type* says what properties a kind of note has (a book has a title, an author
and a rating from 1 to 5, say). This plugin lets you:

- **design types** with a form, or in YAML if you prefer;
- **create notes from a type**, with a form that fills in the properties for you;
- **check notes against their types** as you open and save them, or check the
  whole vault at once, with one-click fixes for common problems;
- **sync the vault** with mdbase on desktop and Android, so it's available on
  your other devices and in mdbase web apps.

Types and checking work offline and without an account. Only sync needs an
mdbase account.

## Install

In Obsidian, open **Settings → Community plugins**, choose **Browse**, search
for **mdbase**, then choose **Install** and **Enable**.

New versions appear here as prereleases first, and reach the community plugin
list a few hours later. To get them straight away, install the
[BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, choose **Add beta
plugin**, and enter `mdbase-dev/mdbase-obsidian`.

## Get started

Click the mdbase icon in the left ribbon, or run **mdbase: Open workspace** from
the command palette. The workspace opens on **Sync**, which connects the vault
to mdbase. See [Sync](#sync).

To give your notes types, choose **Types**. The first time, **Start a
collection** makes this vault an mdbase collection. It adds an `mdbase.yaml`
file and a `_types/` folder, and offers ready-made type packs you can install.
It doesn't create a type you didn't ask for.

## Types

Open the workspace and choose **Types**.

- **Design** edits a type with a form: its name, which notes belong to it, where
  new ones go, and its fields, including lists, nested objects, choices and
  links.
- **YAML** shows the type definition itself.
- Unsaved changes survive reloads and restarts. Before saving, you see what
  changed and any problems with it. Changes that could affect existing notes
  ask you to review them first.
- **New note** opens a form for a note of that type, previews where it will be
  saved, and checks it before creating it.

On phones, the type list and the editor are separate screens with buttons big
enough to tap.

## Checking notes

With **Validate notes automatically** on (the default), notes are checked
against their types when you open and save them. **mdbase: Validate collection**
checks the whole vault, shows progress, and can be stopped. Many problems come
with a fix you can apply in one click; it changes only the property it names.

## Sync

Sync keeps the vault in step with an mdbase collection. It runs inside the
plugin on desktop and on Android, so a phone doesn't need anything else
installed.

1. Open the **Sync** tab in the workspace and choose **Sign in**. Your browser
   opens an mdbase page. Approve Obsidian there and pick the collection this
   vault should sync.
2. Go back to Obsidian. Sync starts on its own. If you have several
   collections, it may ask you to choose one.

There are two kinds of collection:

- **Cloud copy** keeps a copy online, so mdbase web apps and new devices get
  your notes straight away.
- **Private** collections are end-to-end encrypted. Obsidian asks for your
  encryption password to unlock one. They're only offered when mdbase lets this
  device keep the collection's key, which it doesn't do everywhere yet.

Once it's running:

- The status bar and the Sync tab say what sync is doing, in plain words, and
  what to do next if it needs you.
- Edits from other devices arrive in open notes without moving your cursor.
- Changes are sent and fetched on their own. **Sync now** checks straight
  away.
- If a note was changed on two devices at once, both versions are kept: the
  other one is saved as a conflict copy beside the original. The **Conflicts**
  list in the Sync tab shows these copies so you can open them, or choose
  **Keep both** to keep them as ordinary notes.

On phones, Android stops Obsidian soon after it goes into the background. Sync
picks up again when you reopen it. Approving a sign-in in the browser can take
two tries if you take a while to come back to Obsidian.

### The mdbase desktop app

If you use the [mdbase desktop app](https://mdbase.dev/downloads), it can sync
the vault instead, in the background, even when Obsidian is closed. A vault the
app already syncs keeps using the app, and the Sync tab shows its status. To
switch a vault from Obsidian to the app, use **Move to mdbase app** under
**Advanced** in the Sync tab.

## Upgrading older collections

Collections made with mdbase v0.2 open read-only. The workspace offers to
upgrade them to v0.3. Before anything is written, it shows every change it
plans, warns you about anything that can't be carried over exactly, and asks
you to agree. It backs up every file it changes (under `.mdbase/migrations/`)
and undoes everything if a step fails. It never rewrites your notes, only the
collection's settings and types.

## Commands

- **Open workspace**
- **Open sync**
- **Create type definition**
- **Edit type definition** (the current note's type, or pick one)
- **Create note from type**
- **Validate current note**
- **Validate collection**
- **Initialize collection** (only when the vault isn't a collection yet)

## Settings

- **Validate notes automatically:** check notes when they're opened or saved.
- **Show validation notices:** show a notice when you save a note with
  problems.
- **Allow plugin integrations:** let other plugins exchange mdbase events and
  actions in this vault. Off by default.
- **Sync:** status, and a shortcut to the Sync tab. When the desktop app syncs
  the vault, this also shows the account and collection, and where to find the
  app if Obsidian can't.

## Requirements

- Obsidian 1.11.4 or later.
- Types and checking work on desktop and mobile.
- Sync works on Windows, macOS and Linux, and on Android with Obsidian 1.12.3 or
  later. Android sync has been tested on an emulator, not yet on physical
  phones. Sync isn't available on iOS yet.
- Collections in mdbase v0.3. v0.2 collections open read-only until you
  upgrade them.

## Privacy and network use

- **Account:** sync needs an mdbase account. Everything else works without one.
- **Network:** with sync on, the plugin sends your notes to mdbase's servers
  (`connect.mdbase.dev` and `log.mdbase.dev`) and fetches changes from them.
  Private collections are encrypted on your device first. When you start a
  collection, the plugin fetches the list of ready-made type packs from
  `mdbase.dev`. If you use the mdbase desktop app, the plugin talks to it on
  your own computer.
- **No telemetry:** the plugin doesn't collect analytics or usage data.
- **Files outside your vault:** on desktop, if you use the mdbase desktop app,
  the plugin finds the app and runs its `mdbase` command-line tool to check
  sync status and set things up.
- **On phones:** the synced copy is kept in Obsidian's app storage, where other
  plugins you install can read it.

## For plugin developers

Other plugins can exchange events and actions with mdbase in the same vault,
once the user turns on **Allow plugin integrations**:

```ts
const host = app.plugins.getPlugin("mdbase-sync");
const client = host?.api.interop.connect(yourPlugin);
```

See [docs/development.md](docs/development.md) for how the bridge works, and
for building and testing the plugin.

## License

[MIT](LICENSE)
