// What this device leaves out of sync, and what sync has done here.
//
// Device choices never reach the collection or other devices (like Connect's
// device materialization, replica-client-api.md §10.3). A skipped path is
// invisible to this vault's sync in both directions: nothing is uploaded,
// downloaded or deleted for it. Records and definitions follow folder choices
// only; file-type choices apply to attachments.

import type { PathKind } from "./classify";

export const MEDIA_CLASSES = ["image", "audio", "video", "pdf", "other"] as const;
export type MediaClass = (typeof MEDIA_CLASSES)[number];

export interface DeviceFilter {
  /** Attachment kinds this device doesn't sync. */
  skip: MediaClass[];
  /** Folders (collection paths, no trailing slash) this device doesn't sync. */
  folders: string[];
}

export const NO_FILTER: DeviceFilter = { skip: [], folders: [] };

const MEDIA: Record<string, MediaClass> = {};
for (const e of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tif", "tiff"]) MEDIA[e] = "image";
for (const e of ["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus", "webm_audio"]) MEDIA[e] = "audio";
for (const e of ["mp4", "mov", "mkv", "webm", "avi", "m4v", "ogv"]) MEDIA[e] = "video";
MEDIA.pdf = "pdf";

/** The media class of a path, by extension, as Connect classifies it (core plan/resources.rs). */
export function mediaClass(p: string): MediaClass {
  const dot = p.lastIndexOf(".");
  return (dot >= 0 && MEDIA[p.slice(dot + 1).toLowerCase()]) || "other";
}

const key = (p: string) => p.normalize("NFC").toLowerCase();

export function normalizeFolder(folder: string): string {
  return folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

/** Whether this device leaves the path out. Definitions are never left out. */
export function skippedHere(p: string, kind: PathKind, filter: DeviceFilter | undefined): boolean {
  if (!filter || kind === "resource" || kind === "excluded") return false;
  if (kind === "file" && filter.skip.includes(mediaClass(p))) return true;
  const k = key(p);
  return filter.folders.some((f) => f && k.startsWith(`${key(f)}/`));
}

/** The collection's own file policy (Connect `sync_settings`), for every device. */
export interface CollectionInclusion {
  /** Attachment kinds the collection syncs. */
  include: MediaClass[];
  /** Folders whose files the collection doesn't sync. */
  exclude?: string[];
  /** Largest attachment the collection accepts, in bytes. */
  maxSize?: number;
}

/**
 * Whether the collection's policy leaves this file out, as Connect decides it
 * (core plan/resources.rs `excluded`). Notes and definitions are never affected.
 * Size is checked only when known.
 */
export function collectionExcludes(p: string, kind: PathKind, inclusion: CollectionInclusion | null | undefined, size?: number): boolean {
  if (!inclusion || kind !== "file") return false;
  if (!inclusion.include.includes(mediaClass(p))) return true;
  if (typeof inclusion.maxSize === "number" && typeof size === "number" && size > inclusion.maxSize) return true;
  const k = key(p);
  return (inclusion.exclude ?? []).some((f) => { const n = normalizeFolder(f); return !!n && k.startsWith(`${key(n)}/`); });
}

export function validInclusion(v: unknown): v is CollectionInclusion {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const i = v as Record<string, unknown>;
  return Array.isArray(i.include) && i.include.every((s) => typeof s === "string")
    && (i.exclude === undefined || (Array.isArray(i.exclude) && i.exclude.every((s) => typeof s === "string")))
    && (i.maxSize === undefined || i.maxSize === null || (typeof i.maxSize === "number" && i.maxSize >= 0));
}

export function validFilter(v: unknown): v is DeviceFilter {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const f = v as Record<string, unknown>;
  return Array.isArray(f.skip) && f.skip.every((s) => (MEDIA_CLASSES as readonly unknown[]).includes(s))
    && Array.isArray(f.folders) && f.folders.every((s) => typeof s === "string");
}

// ---- activity -------------------------------------------------------------

export type ActivityKind = "uploaded" | "downloaded" | "deleted_here" | "deleted_remote" | "moved" | "conflict" | "not_synced";

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  path: string;
  /** The new path, for a move. */
  to?: string;
  /** Moves and deletes made on this device versus arriving from elsewhere. */
  from?: "here" | "remote";
}

export const ACTIVITY_LIMIT = 500;

/** Most recent first, capped. */
export function recordActivity(log: ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  const next = [entry, ...log];
  if (next.length > ACTIVITY_LIMIT) next.length = ACTIVITY_LIMIT;
  return next;
}

export function validActivity(v: unknown): v is ActivityEntry[] {
  return Array.isArray(v) && v.every((e) => e && typeof e === "object" && typeof e.at === "number" && typeof e.kind === "string" && typeof e.path === "string");
}
