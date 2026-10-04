# Shared-runtime mutation seam (inactive)

The plugin still uses today's Connect implementation. No setting, command, saved
profile or startup path installs the new backend in this change.

`MdbaseMutationBackend` accepts the structural interface of the shared runtime's
`SdkWriteClient`. Its successful calls must mean **durably published to the vault**,
not simply submitted or accepted by the log. Rejected or held writes propagate
without direct-vault fallback. Creates additionally wait for Obsidian's index.

The internal `setMdbaseMutationBackend` hook routes these plugin-owned writes:

- typed-note creates;
- single/bulk quick fixes, transformed against the replica's document view;
- type creates (`must_not_exist`) and same-path edits (exact-content base revision).

Existing mirror/adoption profiles and in-flight Connect operations prevent
attachment. Attached backends block subsequent old Connect operations. Pack
installation, collection initialization, v0.2 migration and type rename are not
ported yet and explicitly refuse to write while attached. Type rename must use
the runtime's rename planner rather than file-manager rename and rollback.

## Activation remains a separate change

Do not expose the attachment hook as an end-user feature yet. The full port must:

1. attach to the process-wide shared registry and handle rehome/lost events;
2. wire the real WASM Worker, sqlite index, dual journal and editor fence;
3. use the SDK transport's `wait: published` and resource `mustNotExist` support;
4. replace the old sync/adoption/recovery UI and finish packs/initialization/rename;
5. migrate existing profiles safely and validate collection-path classification;
6. test both plugins loaded together and runtime shutdown/detachment during writes.

The existing controller is not replaced here. This is a tested write-path seam,
not a working new sync engine, release or migration.
