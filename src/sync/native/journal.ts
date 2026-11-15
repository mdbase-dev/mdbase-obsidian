// sync-state.json: the durable three-way sync journal, and how it is read back.
import { errorInfo, isObject } from "./protocol";
import type { EngineHost } from "./host";
import type { UploadIdentity } from "./upload";
import type { Synced } from "./reconcile";
import type { DeviceFilter } from "./device";
import type { FailureIssue } from "./failures";

export interface SyncState {
  version: 1; vaultId: string; port?: number; collectionId?: string; markerSince?: number;
  // Prevent copied settings from opening another vault's writable replica.
  vaultLocation?: string;
  paths: Record<string, Synced>; cursor?: string;
  uploads?: Record<string, UploadIdentity & { hash: string; fileId?: string; revision?: string }>;
  // Absolute deadlines for unpaired deletes AND unknown creates. Paths retain
  // their synced identity until confirmation; startup reconciles even after crash.
  pendingPaths?: Record<string, number>;
  // Per-input failures do not block unrelated paths or endlessly resubmit a
  // rejected create. Changed inputs or explicit resync retry known outcomes.
  pathFailures?: Record<string, { signature: string; code?: string; reason?: string; unknown?: boolean; issues?: FailureIssue[] }>;
  // The collection the user agreed to combine this vault's existing notes with.
  mergeConfirmed?: string;
  // Intent is saved before writing the copy; handled only after confirmed upload.
  handledRejections?: Record<string, { path: string; hash: string; kind: "record" | "file"; copy?: string; handled?: boolean }>;
  // Retain copy identity until the original has been resolved, even for
  // snapshot conflicts without a rejected mutation ID.
  conflictCopies?: Record<string, { path: string; hash: string; copy: string; kind: "record" | "file" }>;
  // What this device leaves out. Never sent anywhere; skipped paths keep no
  // synced state here, so turning one back on compares both sides afresh.
  device?: DeviceFilter;
  // Note and definition text sent but not yet confirmed (content hash). If the
  // app quits or reloads mid-send, the server may have kept it; a remote copy
  // with exactly this text is then this device's own edit, not a conflict.
  sending?: Record<string, string>;
}

/** Read sync-state.json; a missing file starts a new journal, anything unreadable or invalid stops sync. */
export async function readSyncState(host: EngineHost, pluginDir: string, validPath: (p: string) => boolean): Promise<SyncState> {
  let saved: unknown;
  try { saved = JSON.parse(await host.readText(host.join(pluginDir, "sync-state.json"))); }
  catch (e: unknown) {
    if (errorInfo(e).code === "ENOENT") return { version: 1, vaultId: host.uuid(), paths: {} };
    throw new Error("Cannot read sync-state.json; sync stopped and original state retained. Restore a valid backup before reloading.");
  }
  const object = isObject;
  const valid = (saved: unknown): saved is SyncState => {
    if (!object(saved) || saved.version !== 1 || typeof saved.vaultId !== "string" || !saved.vaultId || !object(saved.paths)
      || Object.values(saved.paths).some((s) => !object(s) || (s.kind !== "record" && s.kind !== "file" && s.kind !== "resource") || ![s.id, s.revision, s.hash].every(v => typeof v === "string" && !!v))
      || (saved.uploads !== undefined && (!object(saved.uploads) || Object.entries(saved.uploads).some(([p, u]) => !validPath(p) || !object(u) || ![u.transferId, u.mutationId].every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)) || typeof u.hash !== "string")))
      || (saved.pendingPaths !== undefined && (!object(saved.pendingPaths) || Object.values(saved.pendingPaths).some(v => typeof v !== "number" || !Number.isFinite(v))))
      || (saved.pathFailures !== undefined && (!object(saved.pathFailures) || Object.values(saved.pathFailures).some((h) => !object(h) || typeof h.signature !== "string" || (h.unknown !== undefined && typeof h.unknown !== "boolean"))))
      || (saved.conflictCopies !== undefined && (!object(saved.conflictCopies) || Object.values(saved.conflictCopies).some((h) => !object(h) || ![h.path, h.hash, h.copy].every(v => typeof v === "string" && !!v) || (h.kind !== "record" && h.kind !== "file"))))
      || (saved.sending !== undefined && (!object(saved.sending) || Object.values(saved.sending).some(v => typeof v !== "string")))
      || (saved.handledRejections !== undefined && (!object(saved.handledRejections) || Object.values(saved.handledRejections).some((h) => !object(h) || typeof h.path !== "string" || typeof h.hash !== "string" || (h.kind !== "record" && h.kind !== "file")))))
      return false;
    return true;
  };
  if (!valid(saved)) throw new Error("Invalid sync-state.json; sync stopped and original state retained. Restore a valid backup before reloading.");
  return saved;
}
