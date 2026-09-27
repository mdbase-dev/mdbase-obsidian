# Adoption preflight and feedback

After the fresh device authorization was approved, the registered test vault's
upload stopped with `authority_import_path_conflict`. Its visible collection has
8 groups of case-insensitive filename collisions. The previous UI still showed
"Move paused" and an approval link, obscuring both successful approval and the
actual blocker.

## Fix

- One shared source enumeration drives both preflight and snapshot capture.
- Metadata-only preflight detects duplicate paths across records, resources and
  selected attachments using the provider's NFC / per-character lowercase / NFC
  key. It does not read note bodies or attachment bytes.
- Check before requesting new approval, and again before each snapshot upload.
  Never automatically rename, exclude or merge files.
- Sync lists every conflicting path group, disables the ineffective Resume action,
  and provides Check files after the user corrects paths.
- Persist the received approval before snapshot preparation, so a failure there
  does not look like approval is still pending.
- Show distinct checking, uploading (note count), activating and connecting stages.
  This is stage feedback, not a per-record percentage or completed-byte claim.
- Show "Approval received. Upload stopped; this vault is not connected yet" for
  this failure and remove the obsolete approval link. Uncertain activation and
  completed activation have separate messages.

## Verification

125 tests pass; build, lint, mobile bundle/import and whitespace checks pass.
Regression tests cover case/Unicode/exact duplicates, resource/record collisions,
selected/excluded attachments, no body reads during preflight, refusal before a
new approval request, edits introduced during approval, successful synthetic
resume after correcting names, progress callbacks, and the actual failure UI.

Installed and reloaded in the registered test vault. Its live preflight counted
7,788 included records and 8 collision groups. Verified all eight groups are
shown, Resume is disabled, approval is no longer requested, the credential is
still available, and the unsaved Task draft survived reload.

No user files were renamed or excluded. No further upload was attempted. Sync
remains blocked until the filename collisions are resolved with user approval.
