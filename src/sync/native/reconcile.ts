// Hashes describe the exact local bytes last synced. Revision describes the
// remote record revision (or file digest). Missing is distinct from unchanged.
export interface DiskIdentity { dev: number; ino: number; birthtimeMs?: number }
export interface Synced {
  id: string;
  kind: "record" | "file";
  revision: string;
  hash: string;
  disk?: DiskIdentity;
}
export interface RemoteVersion { id: string; kind: "record" | "file"; revision: string; hash?: string }
export type Decision = "none" | "remember" | "push" | "pull" | "deleteRemote" | "deleteLocal" | "forget" | "conflict";
export function reconcileDecision(known: Synced | undefined, localHash: string | undefined, remote: RemoteVersion | undefined): Decision {
  if (!known) {
    if (localHash === undefined) return remote ? "pull" : "none";
    if (!remote) return "push";
    return remote.hash === localHash ? "remember" : "conflict";
  }
  if (localHash === undefined && !remote) return "forget";
  const localChanged = localHash !== known.hash;
  const remoteChanged = !remote || remote.id !== known.id || remote.kind !== known.kind || remote.revision !== known.revision;
  if (localHash === undefined) return remoteChanged ? "pull" : "deleteRemote";
  if (!remote) return localChanged ? "conflict" : "deleteLocal";
  if (!localChanged && !remoteChanged) return "none";
  if (remote.hash === localHash) return "remember";
  if (!localChanged) return "pull";
  if (!remoteChanged) return "push";
  return "conflict";
}

// Identity, not path, joins snapshots across a remote move. Rename before the
// path-based pass, which can then reconcile content changes independently.
export function remoteMoveDecision(known: Synced, localHash: string | undefined, remote: RemoteVersion, occupied: boolean): "rename" | "restore" | "blocked" {
  if (known.id !== remote.id || known.kind !== remote.kind || occupied) return "blocked";
  return localHash === undefined ? "restore" : "rename";
}

// Inputs are limited to missing known paths and new, unoccupied mirror paths.
// Inode wins over hash, but both joins must be one-to-one (hardlinks can repeat).
// Count hash ambiguity BEFORE filtering remote changes or consuming inode pairs.
export function localMovePairs(
  missing: { path: string; known: Synced; remote?: RemoteVersion }[],
  added: { path: string; kind: Synced["kind"]; hash: string; disk?: DiskIdentity }[],
): { from: string; to: string; via: "inode" | "hash" }[] {
  const pairs: { from: string; to: string; via: "inode" | "hash" }[] = [];
  const used = new Set<string>();
  const unchanged = (a: typeof missing[number]) => !!a.remote && a.remote.id === a.known.id && a.remote.kind === a.known.kind && a.remote.revision === a.known.revision;
  const sameDisk = (a?: DiskIdentity, b?: DiskIdentity) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
  for (const a of missing) {
    if (!unchanged(a)) continue;
    const bs = added.filter(b => b.kind === a.known.kind && sameDisk(a.known.disk, b.disk));
    if (bs.length !== 1 || missing.filter(m => m.known.kind === a.known.kind && sameDisk(m.known.disk, bs[0].disk)).length !== 1) continue;
    // Inodes can be reused immediately after unlink. Birth time distinguishes
    // a new object from a move+edit. Legacy/unsupported stat needs equal bytes.
    const before = a.known.disk?.birthtimeMs, after = bs[0].disk?.birthtimeMs;
    const hasBirth = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
    if (hasBirth(before) && hasBirth(after) ? before !== after : a.known.hash !== bs[0].hash) continue;
    pairs.push({ from: a.path, to: bs[0].path, via: "inode" }); used.add(bs[0].path);
  }
  for (const a of missing) {
    if (!unchanged(a) || pairs.some(p => p.from === a.path)) continue;
    const bs = added.filter(b => b.kind === a.known.kind && b.hash === a.known.hash);
    if (bs.length !== 1 || used.has(bs[0].path) || missing.filter(m => m.known.kind === a.known.kind && m.known.hash === a.known.hash).length !== 1) continue;
    pairs.push({ from: a.path, to: bs[0].path, via: "hash" }); used.add(bs[0].path);
  }
  return pairs;
}

export function conflictPath(p: string, date = new Date(), suffix = "") {
  const n = (x: number) => String(x).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${n(date.getMonth() + 1)}-${n(date.getDate())} ${n(date.getHours())}${n(date.getMinutes())}`;
  const slash = p.lastIndexOf("/"), dot = p.lastIndexOf(".");
  const ext = dot > slash + 1 ? p.slice(dot) : "";
  return `${ext ? p.slice(0, dot) : p} (conflict ${stamp}${suffix}).${ext.slice(1)}`.replace(/\.$/, "");
}
