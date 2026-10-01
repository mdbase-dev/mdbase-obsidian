import {
  App,
  normalizePath,
  parseYaml,
  type RequestUrlResponse,
  stringifyYaml,
  TFile,
  TFolder,
  Vault,
} from "obsidian";
import picomatch from "picomatch";
import type {
  AuthorityImportSnapshot,
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  DeleteFileReceipt,
  DeleteFileRequest,
  FileMediaClass,
  FileTransferSession,
  JsonObject,
  MoveFileReceipt,
  MoveFileRequest,
  OpenFileUploadRequest,
  PreparedFilePart,
  SelectiveSyncPolicy,
  SyncChangesPage,
  SyncFileSnapshotPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncSnapshotPage,
} from "@mdbase-dev/connect-protocol";
import {
  SyncError,
  type SyncTransport,
} from "@mdbase-dev/connect-sync";
import {
  AuthorityAdoptionClient,
  AuthorityAdoptionError,
  AuthorityAdoptionOutcomeUnknownError,
  buildPortableAuthoritySnapshot,
  portableRecordId,
  type AuthorityAdoptionRequester,
  type AuthorityAdoptionSession,
  type AuthorityAdoptionStatus,
  type AuthorityAdoptionVerification,
  type CompletedAuthorityAdoption,
} from "@mdbase-dev/connect-sync/adoption";
import {
  DirectoryMirror,
  type DirectoryMirrorOptions,
  type MirrorApplyResult,
  type MirrorBinaryInfo,
  type MirrorBlobStore,
  type MirrorFileSystem,
  type MirrorLease,
  type MirrorPlanAction,
  type MirrorProgress,
  type MirrorState,
  type MirrorTextReadResult,
  type MirrorStateStore,
  type MirrorStatus,
  WritableDirectoryMirror,
} from "@mdbase-dev/connect-sync/mirror";
import {
  MirrorEnrollmentClient,
  type MirrorEnrollment,
  type MirrorEnrollmentMode,
  type MirrorEnrollmentRequester,
  type MirrorEnrollmentStatus,
  type MirrorEnrollmentVerification,
} from "@mdbase-dev/connect-sync/enrollment";
import {
  isExcluded,
  loadMdbaseConfig,
  normalizeSafeRelativePath,
} from "./mdbaseCore";
import {
  type MdbaseSyncPreview,
  previewFromPlan,
} from "./syncPreview";
import type { FileTransferProgress } from "./syncUx";
import {
  HttpStatusError,
  type HttpSend,
  platformSend,
  reliableSend,
  retryAfterMilliseconds,
  transferTimeoutMs,
} from "./syncHttp";
import { ReceiptObservingStateStore, type SyncActionReceipt } from "./syncHistory";
import { mergeDocuments } from "./syncMerge";
import { findAdoptionPathConflicts, portablePathKey, proposeAdoptionRenames, type AdoptionRenamePlan } from "./adoptionPaths";
export { findAdoptionPathConflicts } from "./adoptionPaths";

export interface MirrorProfile {
  version: 1;
  syncUrl: string;
  controlUrl: string;
  collectionId: string;
  replicaId: string;
  mode: MirrorEnrollmentMode;
  name: string;
  enrollmentId: string;
  accessTokenExpiresAt: string;
  selectiveSync?: SelectiveSyncPolicy;
  /**
   * The vault-on-this-device that owns this enrollment. Plugin data travels with
   * the vault when another tool copies or syncs it; this tells the copy apart.
   */
  deviceId?: string;
}

export interface EnrollMirrorInput {
  controlUrl: string;
  mirrorName: string;
  mode: MirrorEnrollmentMode;
  collectionId?: string;
  selectiveSync?: SelectiveSyncPolicy;
}

export interface EnrollMirrorCallbacks {
  onVerification(verification: MirrorEnrollmentVerification): void | Promise<void>;
  onStatus?(status: MirrorEnrollmentStatus): void;
  signal?: AbortSignal;
}

export interface MirrorConflictSide {
  state: "absent" | "exact";
  path?: string;
  revision?: string;
  size?: number;
  modifiedAt?: string;
  document?: string;
  resourceUrl?: string;
}

export interface MirrorConflictComparison {
  entity: "record" | "file";
  objectId: string;
  decisionId: string;
  local: MirrorConflictSide;
  remote: MirrorConflictSide;
}

export interface AutoResolution {
  path: string;
  /**
   * merged: both edits combined. kept_both: this device's version saved as
   * copyPath, hosted version in place. restored: deleted here, edited
   * elsewhere, so the edited file came back. kept_local: edited here, deleted
   * elsewhere, so it was uploaded again. took_hosted: nothing local to keep.
   */
  outcome: "merged" | "kept_both" | "restored" | "kept_local" | "took_hosted" | "unresolved";
  copyPath?: string;
  reason?: string;
}

interface RemoteRecord {
  path: string;
  revision: string;
  document: string;
}

function validYamlMapping(yaml: string): boolean {
  try {
    const value: unknown = parseYaml(yaml);
    return value === null || (typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

export interface DisconnectMirrorResult {
  removed: string[];
  preserved: string[];
}

export interface AdoptLocalCollectionInput {
  controlUrl: string;
  mirrorName: string;
  selectiveSync?: SelectiveSyncPolicy;
}

export interface AdoptionPreview {
  records: number;
  resources: number;
  files: number;
  conflicts: string[][];
}

export interface AdoptLocalCollectionCallbacks {
  onVerification(
    verification: AuthorityAdoptionVerification | MirrorEnrollmentVerification,
  ): void | Promise<void>;
  onStatus?(status: AuthorityAdoptionStatus): void;
  onProgress?(progress: { stage: "checking" | "uploading" | "activating" | "connecting"; records?: number }): void;
  onFileProgress?(path: string, transferredBytes: number, totalBytes: number): void;
  signal?: AbortSignal;
}

export interface ConnectSyncSettingsHost {
  getMirrorProfile(): MirrorProfile | null;
  saveMirrorProfile(profile: MirrorProfile | null): Promise<void>;
  /** Stable for this vault on this device, and never copied with the vault's files. */
  deviceId?(): string;
}

const ROLE_MARKER_PATH = ".mdbase/connect-role.json";
const ADOPTION_MARKER_PATH = ".mdbase/authority-adoption.json";
const ADOPTION_SNAPSHOT_PATH = ".mdbase/authority-adoption-snapshot.json";
const STATE_DATABASE = "mdbase-obsidian-connect";
const STATE_STORE = "mirrors";
const BLOB_DATABASE = "mdbase-obsidian-connect-blobs";
const BLOB_MANIFEST_STORE = "manifests";
const BLOB_CHUNK_STORE = "chunks";
const BLOB_CHUNK_BYTES = 1024 * 1024;
// Vault APIs materialize whole files. Bound peak allocations on mobile as well as desktop.
export const MAX_BINARY_FILE_BYTES = 32 * 1024 * 1024;
/** How long after the mirror writes a path its vault event is still treated as an echo. */
const ENGINE_WRITE_ECHO_MS = 2_000;

function assertBinarySize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BINARY_FILE_BYTES) {
    throw new SyncError("file_too_large", "Binary sync supports files up to 32 MiB on this device. Exclude this file's folder to continue.");
  }
}
const ACCESS_SECRET_PREFIX = "mdbase-connect-access-";
const REFRESH_SECRET_PREFIX = "mdbase-connect-refresh-";
const ADOPTION_SECRET_PREFIX = "mdbase-connect-adoption-";
const TOKEN_RENEWAL_WINDOW_MS = 5 * 60 * 1_000;
const RESERVED_WRITE_FOLDERS = [".git", ".trash", ".mdbase"];
const RESERVED_BINARY_COMPONENTS = new Set([".git", ".mdbase", ".trash", "node_modules", "_contracts", "_schemas", "_types", "_views"]);
const FILE_CLASS_ORDER: FileMediaClass[] = ["image", "audio", "video", "pdf", "other"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MirrorMarker {
  version: 1;
  role: "mirror";
  collection_id: string;
}

interface AdoptionMarker {
  version: 1;
  phase: "waiting_for_approval" | "uploading" | "fenced" | "activating" | "adopted";
  session: Omit<AuthorityAdoptionSession, "credential">;
  selective_sync?: SelectiveSyncPolicy;
  manifest_digest: string | null;
  source_revision: string | null;
  source_head: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeSelectiveSync(input?: Partial<SelectiveSyncPolicy> | null): SelectiveSyncPolicy {
  const rawClasses = input?.file_classes ?? [];
  if (rawClasses.some((value) => !FILE_CLASS_ORDER.includes(value)) || new Set(rawClasses).size !== rawClasses.length) {
    throw new SyncError("invalid_file_materialization", "Selected file media classes must be valid and unique.");
  }
  const classes = [...rawClasses].sort((left, right) => FILE_CLASS_ORDER.indexOf(left) - FILE_CLASS_ORDER.indexOf(right));
  const rawFolders = input?.excluded_folders ?? [];
  if (rawFolders.some((value) => typeof value !== "string" || !value.trim())) {
    throw new SyncError("invalid_file_materialization", "Excluded folders cannot be empty.");
  }
  const folders = rawFolders
    .map((value) => normalizeSafeRelativePath(value.trim()))
    .sort((left, right) => left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase()));
  if (folders.length > 100) throw new SyncError("invalid_file_materialization", "File sync supports at most 100 excluded folders.");
  if (new Set(folders.map((folder) => folder.toLocaleLowerCase())).size !== folders.length) {
    throw new SyncError("invalid_file_materialization", "Excluded folders must be unique on portable filesystems.");
  }
  for (const folder of folders) assertVisibleBinaryPath(folder, true);
  return { file_classes: classes, excluded_folders: folders };
}

function classifyBinaryPath(path: string): FileMediaClass {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) return "image";
  if (["flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"].includes(extension)) return "audio";
  if (["3gp", "mkv", "mov", "mp4", "webm"].includes(extension)) return "video";
  return extension === "pdf" ? "pdf" : "other";
}

function assertAdoptionPaths(preview: AdoptionPreview): void {
  if (preview.conflicts.length) throw new SyncError("authority_import_path_conflict",
    `${preview.conflicts.length} filename conflicts prevent uploading. Review the paths in Sync and rename the conflicting files before retrying. Nothing was renamed or excluded.`);
}

function binaryPathSelected(policy: SelectiveSyncPolicy, path: string, mediaClass = classifyBinaryPath(path)): boolean {
  if (!policy.file_classes.includes(mediaClass)) return false;
  const normalized = normalizePath(path);
  return !policy.excluded_folders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}

// Record extensions fixed by the sync SDK (Markdown notes and Obsidian Bases as
// YAML document records). Matches its private `hasMirrorRecordExtension`:
// record enumeration is case-sensitive; binary exclusion ignores case.
const MIRROR_RECORD_PATH = /\.(?:md|base)$/;
const MIRROR_RECORD_PATH_ANY_CASE = /\.(?:md|base)$/i;

function assertVisibleBinaryPath(input: string, folder = false): string {
  const path = normalizeSafeRelativePath(input);
  const components = path.split("/");
  if (
    path.length > 1024
    || (!folder && MIRROR_RECORD_PATH_ANY_CASE.test(path))
    || components.some((component) => component.startsWith(".")
      || RESERVED_BINARY_COMPONENTS.has(component.toLowerCase())
      || /[<>"|?*]/u.test(component)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(component))
  ) {
    throw new SyncError("invalid_file_path", `Collection file path ${path} is hidden, reserved, or non-portable.`);
  }
  return path;
}

async function binaryInfo(bytes: ArrayBuffer): Promise<MirrorBinaryInfo> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    size: bytes.byteLength,
    content_digest: `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  };
}

async function collectBinary(source: AsyncIterable<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new SyncError("file_integrity_failed", "A binary stream returned an invalid chunk.");
    if (!chunk.byteLength) continue;
    size += chunk.byteLength;
    assertBinarySize(size);
    chunks.push(Uint8Array.from(chunk));
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

function mediaTypeForPath(path: string): string | undefined {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return ({
    avif: "image/avif", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png",
    svg: "image/svg+xml", webp: "image/webp", flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg",
    ogg: "audio/ogg", opus: "audio/opus", wav: "audio/wav", mov: "video/quicktime", mp4: "video/mp4",
    webm: "video/webm", pdf: "application/pdf",
  } as Record<string, string>)[extension];
}

async function adoptionRequestBody(value: unknown, raw: boolean | undefined): Promise<string | ArrayBuffer | undefined> {
  if (value === undefined) return undefined;
  if (!raw) return JSON.stringify(value);
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
  }
  if (value instanceof Blob) return value.arrayBuffer();
  throw new SyncError("invalid_file_upload", "The adoption upload body was not binary data.");
}

function parseJsonResponse(text: string, parsed: unknown): unknown {
  if (parsed !== undefined && parsed !== null) return parsed;
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Every Connect request goes through one platform stack with deadlines and transient retries. */
const connectSend: HttpSend = reliableSend(platformSend());

export function createObsidianEnrollmentRequester(): MirrorEnrollmentRequester {
  return async (request) => {
    if (request.signal?.aborted) throw new DOMException("Enrollment cancelled.", "AbortError");
    const response = await connectSend({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      contentType: request.body === undefined ? undefined : "application/json",
      throw: false,
      signal: request.signal,
    });
    if (request.signal?.aborted) throw new DOMException("Enrollment cancelled.", "AbortError");
    return {
      status: response.status,
      body: parseJsonResponse(response.text, response.json),
      retryAfterMs: retryAfterMilliseconds(response.headers),
    };
  };
}

export function createObsidianAdoptionRequester(): AuthorityAdoptionRequester {
  return async (request) => {
    if (request.signal?.aborted) throw new DOMException("Collection adoption cancelled.", "AbortError");
    const body = await adoptionRequestBody(request.body, request.rawBody);
    const response = await connectSend({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
      contentType: body === undefined || request.rawBody ? undefined : "application/json",
      throw: false,
      signal: request.signal,
    });
    if (request.signal?.aborted) throw new DOMException("Collection adoption cancelled.", "AbortError");
    return {
      status: response.status,
      body: parseJsonResponse(response.text, response.json),
      retryAfterMs: retryAfterMilliseconds(response.headers),
      headers: response.headers,
    };
  };
}

/**
 * The access token for a transport. `renew` is called once when Connect answers
 * 401 to a token that looked current (revoked early, or rotated by a renewal
 * elsewhere); the request is then repeated with the renewed token.
 */
export interface TransportCredentials {
  token(): Promise<string>;
  renew?(rejected: string): Promise<string>;
}

/**
 * Sync transport over the platform network stack. This keeps the portable SDK
 * usable on mobile and avoids browser CORS restrictions without importing the
 * SDK's Node entry point.
 */
export class ObsidianSyncTransport<Frontmatter extends JsonObject = JsonObject>
implements SyncTransport<Frontmatter> {
  private readonly syncUrl: string;
  private readonly filesUrl: string;
  private readonly credentials: TransportCredentials;

  constructor(
    syncUrl: string,
    credentials: TransportCredentials | string,
    private readonly send: HttpSend = connectSend,
    private readonly onFileProgress?: (progress: FileTransferProgress) => void,
    private readonly signal?: AbortSignal,
  ) {
    this.credentials = typeof credentials === "string"
      ? { token: () => Promise.resolve(credentials) }
      : credentials;
    let endpoint: URL;
    try {
      endpoint = new URL(syncUrl);
    } catch {
      throw new SyncError("invalid_sync_url", "Sync URL must be an absolute authority endpoint.");
    }
    if (
      !(
        endpoint.protocol === "https:"
        || (
          endpoint.protocol === "http:"
          && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname)
        )
      )
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
      || !/^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sync\/?$/i.test(endpoint.pathname)
    ) {
      throw new SyncError("invalid_sync_url", "Sync URL must identify one authority sync endpoint.");
    }
    this.syncUrl = endpoint.href.replace(/\/$/, "");
    this.filesUrl = this.syncUrl.replace(/\/sync$/u, "/files");
  }

  openSession(): Promise<SyncSession> {
    return this.request("POST", "sessions");
  }

  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>> {
    const query = new URLSearchParams({ snapshot_id: snapshotId });
    if (page) query.set("page", page);
    return this.request("GET", `snapshot?${query.toString()}`);
  }

  fileSnapshot(snapshotId: string, page?: string): Promise<SyncFileSnapshotPage> {
    const query = new URLSearchParams({ snapshot_id: snapshotId });
    if (page) query.set("page", page);
    return this.request("GET", `files/snapshot?${query.toString()}`);
  }

  async *downloadFile(file: CollectionFileDescriptor): AsyncGenerator<Uint8Array> {
    assertBinarySize(file.size);
    const transferId = crypto.randomUUID();
    try {
      let transferredBytes = 0;
      this.onFileProgress?.({ direction: "download", path: file.path, transferredBytes, totalBytes: file.size });
      const session = await this.fileRequest<FileTransferSession>("POST", "downloads", {
        protocol_version: 1,
        type: "open_file_download",
        transfer_id: transferId,
        file_id: file.file_id,
        revision: file.revision,
      });
      if (
        session.protocol_version !== 1
        || session.type !== "file_transfer"
        || session.transfer_id !== transferId
        || session.direction !== "download"
        || session.protection !== "transport_tls"
        || session.total_size !== file.size
        || session.strategy.kind !== "object_ranges"
        || !Number.isSafeInteger(session.strategy.part_size)
        || session.strategy.part_size <= 0
      ) {
        throw new SyncError("invalid_sync_response", "The authority returned an incompatible file download session.");
      }
      const partCount = Math.ceil(file.size / session.strategy.part_size);
      for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
        const expected = Math.min(session.strategy.part_size, file.size - partIndex * session.strategy.part_size);
        const response = await this.authorized({
          url: `${this.filesUrl}/downloads/${encodeURIComponent(transferId)}/parts/${partIndex}`,
          method: "GET",
          throw: false,
          timeoutMs: transferTimeoutMs(expected),
        });
        if (response.status < 200 || response.status >= 300) throw this.responseError(response, "file_download_failed");
        const declared = headerValue(response.headers, "content-length");
        if ((declared !== undefined && Number(declared) !== expected) || response.arrayBuffer.byteLength !== expected) {
          throw new SyncError("file_integrity_failed", "Hosted authority returned a file part with the wrong length.");
        }
        transferredBytes += expected;
        this.onFileProgress?.({ direction: "download", path: file.path, transferredBytes, totalBytes: file.size });
        if (expected) yield new Uint8Array(response.arrayBuffer);
      }
    } finally {
      await this.fileRequest("DELETE", `transfers/${encodeURIComponent(transferId)}`).catch(() => undefined);
    }
  }

  async uploadFile(
    request: OpenFileUploadRequest,
    source: AsyncIterable<Uint8Array>,
  ): Promise<CommitFileUploadReceipt> {
    assertBinarySize(request.size);
    const session = await this.fileRequest<FileTransferSession>("POST", "uploads", request);
    if (
      session.protocol_version !== 1
      || session.type !== "file_transfer"
      || session.transfer_id !== request.transfer_id
      || session.direction !== "upload"
      || session.protection !== "transport_tls"
      || session.total_size !== request.size
      || !["object_put", "object_multipart"].includes(session.strategy.kind)
    ) throw new SyncError("invalid_sync_response", "Authority returned an incompatible file upload session.");
    const partSize = session.strategy.kind === "object_multipart" ? session.strategy.part_size : Math.max(1, request.size);
    if (!Number.isSafeInteger(partSize) || partSize <= 0) {
      throw new SyncError("invalid_sync_response", "Authority returned an invalid upload part size.");
    }
    const reader = new BinaryPartReader(source);
    const count = Math.max(1, Math.ceil(request.size / partSize));
    if (
      session.received.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= count)
      || new Set(session.received).size !== session.received.length
    ) throw new SyncError("invalid_sync_response", "Authority returned invalid upload progress.");
    const uploadedParts = session.uploaded_parts ?? [];
    if (
      uploadedParts.some((part, index) => !Number.isSafeInteger(part.part_number)
        || part.part_number < 1
        || part.part_number > count
        || !part.etag
        || part.etag.length > 255
        || (index > 0 && uploadedParts[index - 1].part_number >= part.part_number))
      || (session.strategy.kind === "object_multipart"
        ? uploadedParts.length !== session.received.length
          || uploadedParts.some((part, index) => part.part_number - 1 !== session.received[index])
        : uploadedParts.length !== 0)
    ) throw new SyncError("invalid_sync_response", "Authority returned invalid uploaded part receipts.");
    let transferredBytes = session.received.reduce((total, index) => {
      const offset = index * partSize;
      return total + Math.min(partSize, Math.max(0, request.size - offset));
    }, 0);
    this.onFileProgress?.({ direction: "upload", path: request.path, transferredBytes, totalBytes: request.size });
    if (session.received.length === count) return this.commitUpload(request.transfer_id, uploadedParts);
    const received = new Set(session.received);
    const parts = Array.from({ length: count }, () => undefined as { part_number: number; etag: string } | undefined);
    for (const part of uploadedParts) parts[part.part_number - 1] = part;
    for (let index = 0; index < count; index += 1) {
      const offset = index * partSize;
      const length = Math.min(partSize, Math.max(0, request.size - offset));
      const bytes = await reader.read(length);
      if (received.has(index)) continue;
      const prepared = await this.fileRequest<PreparedFilePart>(
        "POST",
        `uploads/${encodeURIComponent(request.transfer_id)}/parts`,
        {
          protocol_version: 1,
          type: "prepare_file_upload_part",
          transfer_id: request.transfer_id,
          part_number: index + 1,
          content_length: length,
        },
      );
      validatePreparedUpload(prepared, request.transfer_id, index, offset, length);
      const response = await this.send({
        url: prepared.url,
        method: "PUT",
        headers: safeObjectHeaders(prepared.headers),
        body: bytes.buffer,
        throw: false,
        signal: this.signal,
        timeoutMs: transferTimeoutMs(length),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new HttpStatusError(
          response.status === 429 || response.status >= 500 ? "authority_unavailable" : "file_upload_failed",
          `Object storage returned HTTP ${response.status}.`,
          response.status,
        );
      }
      transferredBytes += length;
      this.onFileProgress?.({ direction: "upload", path: request.path, transferredBytes, totalBytes: request.size });
      if (session.strategy.kind === "object_multipart") {
        const etag = headerValue(response.headers, "etag");
        if (!etag) throw new SyncError("invalid_sync_response", "Object storage omitted a multipart ETag.");
        parts[index] = { part_number: index + 1, etag };
      }
    }
    await reader.expectEnd();
    return this.commitUpload(request.transfer_id, parts.filter((part): part is { part_number: number; etag: string } => part !== undefined));
  }

  private async commitUpload(
    transferId: string,
    parts: Array<{ part_number: number; etag: string }>,
  ): Promise<CommitFileUploadReceipt> {
    const receipt = await this.fileRequest<CommitFileUploadReceipt>(
      "POST",
      `uploads/${encodeURIComponent(transferId)}/commit`,
      { protocol_version: 1, type: "commit_file_upload", transfer_id: transferId, parts },
    );
    if (receipt.protocol_version !== 1 || receipt.type !== "file_upload_committed" || receipt.transfer_id !== transferId) {
      throw new SyncError("invalid_sync_response", "Authority returned an invalid file upload receipt.");
    }
    return receipt;
  }

  async moveFile(request: MoveFileRequest): Promise<MoveFileReceipt> {
    const receipt = await this.fileRequest<MoveFileReceipt>("POST", `${encodeURIComponent(request.file_id)}/move`, request);
    if (receipt.protocol_version !== 1 || receipt.type !== "file_moved" || receipt.mutation_id !== request.mutation_id) {
      throw new SyncError("invalid_sync_response", "Authority returned an invalid file move receipt.");
    }
    return receipt;
  }

  async deleteFile(request: DeleteFileRequest): Promise<DeleteFileReceipt> {
    const receipt = await this.fileRequest<DeleteFileReceipt>("POST", `${encodeURIComponent(request.file_id)}/delete`, request);
    if (
      receipt.protocol_version !== 1
      || receipt.type !== "file_deleted"
      || receipt.mutation_id !== request.mutation_id
      || receipt.file_id !== request.file_id
    ) throw new SyncError("invalid_sync_response", "Authority returned an invalid file delete receipt.");
    return receipt;
  }

  changes(after: number, limit = 200): Promise<SyncChangesPage<Frontmatter>> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.request("GET", `changes?${query.toString()}`);
  }

  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>> {
    return this.request("POST", "mutations", mutation);
  }

  private async request<Result>(method: "GET" | "POST", path: string, body?: unknown): Promise<Result> {
    return this.requestAt(this.syncUrl, method, path, body);
  }

  private async fileRequest<Result>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Result> {
    return this.requestAt(this.filesUrl, method, path, body);
  }

  private async requestAt<Result>(baseUrl: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Result> {
    const response = await this.authorized({
      url: `${baseUrl}/${path}`,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
      throw: false,
    });
    const value = parseJsonResponse(response.text, response.json);
    if (response.status < 200 || response.status >= 300) {
      throw this.responseError(response, "sync_failed");
    }
    return value as Result;
  }

  /** Sends with the current token, renewing once if Connect rejects it. */
  private async authorized(
    request: Omit<Parameters<HttpSend>[0], "headers" | "signal">,
  ): Promise<RequestUrlResponse> {
    const attempt = (token: string) => this.send({
      ...request,
      headers: { authorization: `Bearer ${token}` },
      signal: this.signal,
    });
    const token = await this.credentials.token();
    const response = await attempt(token);
    if (response.status !== 401 || !this.credentials.renew) return response;
    return attempt(await this.credentials.renew(token));
  }

  private responseError(
    response: { status: number; text: string; json: unknown; headers?: Record<string, string> },
    fallbackCode: string,
  ): SyncError {
    const value = parseJsonResponse(response.text, response.json);
    const error = isRecord(value) && isRecord(value.error) ? value.error : {};
    const code = typeof error.code === "string"
      ? error.code
      : response.status === 401
        ? "mirror_access_rejected"
        : response.status === 429 || response.status >= 500
          ? "authority_unavailable"
          : fallbackCode;
    return new HttpStatusError(
      code,
      typeof error.message === "string" ? error.message : `Sync request failed (${response.status}).`,
      response.status,
      retryAfterMilliseconds(response.headers),
    );
  }
}

class BinaryPartReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private remainder = new Uint8Array();

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(new ArrayBuffer(length));
    let offset = 0;
    while (offset < length) {
      if (!this.remainder.byteLength) {
        const next = await this.iterator.next();
        if (next.done || !(next.value instanceof Uint8Array)) {
          throw new SyncError("pending_file_snapshot_corrupt", "Pending file bytes ended early or were invalid.");
        }
        this.remainder = Uint8Array.from(next.value);
        if (!this.remainder.byteLength) continue;
      }
      const count = Math.min(length - offset, this.remainder.byteLength);
      output.set(this.remainder.subarray(0, count), offset);
      offset += count;
      this.remainder = this.remainder.slice(count);
    }
    return output;
  }

  async expectEnd(): Promise<void> {
    if (this.remainder.byteLength) throw new SyncError("pending_file_snapshot_corrupt", "Pending file bytes are oversized.");
    while (true) {
      const next = await this.iterator.next();
      if (next.done) return;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength) {
        throw new SyncError("pending_file_snapshot_corrupt", "Pending file bytes are oversized.");
      }
    }
  }
}

function validatePreparedUpload(
  part: PreparedFilePart,
  transferId: string,
  partIndex: number,
  offset: number,
  contentLength: number,
): void {
  let url: URL;
  try {
    url = new URL(part.url);
  } catch {
    throw new SyncError("invalid_sync_response", "Authority returned an invalid object URL.");
  }
  if (
    part.protocol_version !== 1
    || part.type !== "file_part"
    || part.transfer_id !== transferId
    || part.part_index !== partIndex
    || part.offset !== offset
    || part.content_length !== contentLength
    || part.method.toUpperCase() !== "PUT"
    || !secureHttpEndpoint(url)
    || url.username
    || url.password
    || !url.hostname
  ) throw new SyncError("invalid_sync_response", "Authority returned an invalid prepared upload part.");
}

function secureHttpEndpoint(url: URL): boolean {
  return url.protocol === "https:"
    || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname));
}

function safeObjectHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !["authorization", "cookie", "host", "proxy-authorization", "content-length"].includes(name.toLowerCase())));
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function reservedWriteFolders(vault: Vault): string[] {
  // eslint-disable-next-line obsidianmd/hardcoded-config-path -- Lightweight test/adapter Vault implementations predate Vault.configDir.
  const configDir = vault.configDir || ".obsidian";
  return [configDir, ...RESERVED_WRITE_FOLDERS].map((folder) => normalizePath(folder).replace(/\/+$/, ""));
}

function safeMirrorPath(vault: Vault, input: string): string {
  const path = normalizeSafeRelativePath(input);
  if (reservedWriteFolders(vault).some((folder) => path === folder || path.startsWith(`${folder}/`))) {
    throw new SyncError("unsafe_mirror_path", `The collection authority attempted to write a reserved path: ${path}`);
  }
  return path;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Synchronization cancelled.", "AbortError");
}

function indexedDbError(error: DOMException | null, operation: string): Error {
  return error ?? new Error(`IndexedDB ${operation} failed without an error detail.`);
}

function abortableSyncTransport(
  transport: SyncTransport<JsonObject>,
  signal?: AbortSignal,
): SyncTransport<JsonObject> {
  const run = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    abortIfNeeded(signal);
    const value = await operation();
    abortIfNeeded(signal);
    return value;
  };
  const stream = async function* (source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    abortIfNeeded(signal);
    for await (const chunk of source) {
      abortIfNeeded(signal);
      yield chunk;
      // Check before requesting the next part, not only after it arrives.
      abortIfNeeded(signal);
    }
    abortIfNeeded(signal);
  };
  const uploadFile = transport.uploadFile?.bind(transport);
  const moveFile = transport.moveFile?.bind(transport);
  const deleteFile = transport.deleteFile?.bind(transport);
  return {
    openSession: () => run(() => transport.openSession()),
    snapshot: (snapshotId, page) => run(() => transport.snapshot(snapshotId, page)),
    fileSnapshot: (snapshotId, page) => run(() => transport.fileSnapshot(snapshotId, page)),
    downloadFile: (file) => stream(transport.downloadFile(file)),
    ...(uploadFile ? {
      uploadFile: (request, source) => run(() => uploadFile(request, stream(source))),
    } : {}),
    ...(moveFile ? { moveFile: (request) => run(() => moveFile(request)) } : {}),
    ...(deleteFile ? { deleteFile: (request) => run(() => deleteFile(request)) } : {}),
    changes: (after, limit) => run(() => transport.changes(after, limit)),
    mutate: (mutation) => run(() => transport.mutate(mutation)),
  };
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const folder = normalizePath(path).replace(/\/+$/, "");
  if (!folder) return;
  let current = "";
  for (const segment of folder.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const existing = vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing) throw new SyncError("mirror_path_collision", `A file blocks the mirror folder ${current}.`);
    if (await vault.adapter.exists(current)) continue;
    await vault.createFolder(current);
  }
}

export class ObsidianMirrorFileSystem implements MirrorFileSystem {
  constructor(
    private readonly vault: Vault,
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Tests and standalone adapters lack an App; production injects FileManager.trashFile below.
    private readonly trashFile: (file: TFile) => Promise<void> = (file) => vault.delete(file, true),
    private readonly assertActive: () => void = () => undefined,
    /** Told about every path this adapter is about to change, so the host can tell its own writes from the user's. */
    private readonly observeWrite: (path: string) => void = () => undefined,
  ) {}

  async exists(input: string): Promise<boolean> {
    const path = safeMirrorPath(this.vault, input);
    return this.vault.getAbstractFileByPath(path) !== null || await this.vault.adapter.exists(path);
  }

  async read(input: string): Promise<string | null> {
    const result = await this.readText(input);
    if (result === null || typeof result === "string") return result;
    throw new SyncError(result.code, result.reason);
  }

  async readText(input: string): Promise<MirrorTextReadResult> {
    const path = safeMirrorPath(this.vault, input);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFolder) {
      throw new SyncError("mirror_path_collision", `Expected a file at ${path}.`);
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await this.vault.adapter.readBinary(path);
    } catch {
      try {
        if (!await this.vault.adapter.exists(path)) return null;
      } catch {
        // Report the original read failure when existence cannot be established.
      }
      throw new SyncError("file_read_failed", `Could not read ${path}.`);
    }
    try {
      // Preserve the BOM as a character instead of consuming its bytes.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return {
        kind: "invalid",
        code: "invalid_utf8",
        reason: "File is not valid UTF-8.",
        revision: (await binaryInfo(bytes)).content_digest,
      };
    }
  }

  async pathKind(input: string): Promise<"file" | "folder" | null> {
    const path = safeMirrorPath(this.vault, input);
    return (await this.vault.adapter.stat(path))?.type ?? null;
  }

  async write(input: string, value: string, expected?: string | null): Promise<void> {
    const path = safeMirrorPath(this.vault, input);
    // The SDK supplies its inspected text. Standalone callers still get a
    // conditional write rather than a read/modify race inside this adapter.
    // `undefined` after reading means the bytes are not text (a receive-only
    // repair replacing invalid UTF-8): there is no text to compare against.
    let before: string | null | undefined = expected;
    if (before === undefined) {
      const observed = await this.readText(path);
      before = typeof observed === "string" || observed === null ? observed : undefined;
    }
    const stale = () => new SyncError("sync_plan_stale", `${path} changed before it could be written. Review sync again.`);
    const slash = path.lastIndexOf("/");
    if (slash >= 0) await ensureFolder(this.vault, path.slice(0, slash));
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      throw new SyncError("mirror_path_collision", `A folder blocks the mirror file ${path}.`);
    }
    this.assertActive();
    this.observeWrite(path);
    if (existing instanceof TFile && before === undefined) {
      await this.vault.modify(existing, value);
    } else if (existing instanceof TFile) {
      await this.vault.process(existing, (current) => {
        this.assertActive();
        if (current !== before && current !== value) throw stale();
        return value;
      });
    } else {
      if (before !== null) throw stale();
      // Vault.create refuses an occupied destination, including one created
      // after the existence check. Never fall back to overwriting it.
      await this.vault.create(path, value);
    }
  }

  async move(sourceInput: string, targetInput: string): Promise<void> {
    const source = safeMirrorPath(this.vault, sourceInput);
    const target = safeMirrorPath(this.vault, targetInput);
    const file = this.vault.getAbstractFileByPath(source);
    if (!(file instanceof TFile)) {
      throw new SyncError("mirror_path_collision", `Expected a file at ${source}.`);
    }
    if (this.vault.getAbstractFileByPath(target) !== null || await this.vault.adapter.exists(target)) {
      throw new SyncError("mirror_path_collision", `A file or folder blocks the mirror path ${target}.`);
    }
    const slash = target.lastIndexOf("/");
    if (slash >= 0) await ensureFolder(this.vault, target.slice(0, slash));
    this.assertActive();
    this.observeWrite(source);
    this.observeWrite(target);
    await this.vault.rename(file, target);
  }

  async remove(input: string): Promise<void> {
    const path = safeMirrorPath(this.vault, input);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing == null) return;
    if (!(existing instanceof TFile)) {
      throw new SyncError("mirror_path_collision", `Expected a file at ${path}.`);
    }
    this.assertActive();
    this.observeWrite(path);
    await this.trashFile(existing);
  }

  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    return listFiles(this.vault)
      .map((file) => normalizePath(file.path))
      .filter((path) => MIRROR_RECORD_PATH.test(path) && !excluded.has(path))
      .filter((path) => !reservedWriteFolders(this.vault)
        .some((folder) => path === folder || path.startsWith(`${folder}/`)))
      .sort();
  }

  async inspectBinary(input: string): Promise<MirrorBinaryInfo | null> {
    const path = assertVisibleBinaryPath(input);
    const file = this.vault.getAbstractFileByPath(path);
    if (file == null) return null;
    if (!(file instanceof TFile)) throw new SyncError("mirror_path_collision", `Expected a file at ${path}.`);
    assertBinarySize(file.stat.size);
    const bytes = await this.vault.readBinary(file);
    assertBinarySize(bytes.byteLength);
    return binaryInfo(bytes);
  }

  async writeBinary(input: string, source: AsyncIterable<Uint8Array>, expected?: MirrorBinaryInfo | null): Promise<void> {
    const path = assertVisibleBinaryPath(input);
    // A stream can take seconds to consume. Remember its destination before
    // reading any bytes, then recheck it after staging and folder creation.
    const before = expected === undefined ? await this.inspectBinary(path) : expected;
    const bytes = await collectBinary(source);
    const slash = path.lastIndexOf("/");
    if (slash >= 0) await ensureFolder(this.vault, path.slice(0, slash));
    const current = await this.inspectBinary(path);
    if (current?.content_digest !== before?.content_digest || current?.size !== before?.size) {
      throw new SyncError("sync_plan_stale", `${path} changed before it could be written. Review sync again.`);
    }
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new SyncError("mirror_path_collision", `A folder blocks the mirror file ${path}.`);
    this.assertActive();
    this.observeWrite(path);
    if (existing instanceof TFile) await this.vault.modifyBinary(existing, bytes);
    else await this.vault.createBinary(path, bytes);
  }

  async listBinary(excluded: ReadonlySet<string>): Promise<string[]> {
    return listFiles(this.vault)
      .map((file) => normalizePath(file.path))
      .filter((path) => !MIRROR_RECORD_PATH_ANY_CASE.test(path) && !excluded.has(path))
      .filter((path) => {
        try {
          assertVisibleBinaryPath(path);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  }

  async readBinary(input: string): Promise<AsyncIterable<Uint8Array> | null> {
    const path = assertVisibleBinaryPath(input);
    const file = this.vault.getAbstractFileByPath(path);
    if (file == null) return null;
    if (!(file instanceof TFile)) throw new SyncError("mirror_path_collision", `Expected a file at ${path}.`);
    assertBinarySize(file.stat.size);
    const bytes = new Uint8Array(await this.vault.readBinary(file));
    assertBinarySize(bytes.byteLength);
    return (async function* (): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < bytes.byteLength; offset += BLOB_CHUNK_BYTES) {
        yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + BLOB_CHUNK_BYTES));
      }
    })();
  }
}

interface BlobManifest {
  stage: string;
  chunks: number;
  size: number;
}

export class IndexedDbMirrorBlobStore implements MirrorBlobStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly namespace: string) {}

  async has(contentDigest: `sha256:${string}`): Promise<boolean> {
    return (await this.manifest(contentDigest)) !== null;
  }

  async *read(contentDigest: `sha256:${string}`): AsyncGenerator<Uint8Array> {
    const manifest = await this.manifest(contentDigest);
    if (!manifest) throw new SyncError("file_blob_missing", "A staged binary snapshot is missing.");
    let size = 0;
    for (let index = 0; index < manifest.chunks; index += 1) {
      const chunk = await this.get<ArrayBuffer>(BLOB_CHUNK_STORE, this.chunkKey(manifest.stage, index));
      if (!(chunk instanceof ArrayBuffer)) throw new SyncError("file_blob_corrupt", "A staged binary snapshot is incomplete.");
      size += chunk.byteLength;
      yield new Uint8Array(chunk);
    }
    if (size !== manifest.size) throw new SyncError("file_blob_corrupt", "A staged binary snapshot has the wrong size.");
  }

  async write(contentDigest: `sha256:${string}`, source: AsyncIterable<Uint8Array>): Promise<void> {
    const previous = await this.manifest(contentDigest);
    const stage = crypto.randomUUID();
    let chunks = 0;
    let size = 0;
    try {
      for await (const sourceChunk of source) {
        if (!(sourceChunk instanceof Uint8Array)) throw new SyncError("file_blob_corrupt", "A staged binary chunk is invalid.");
        for (let offset = 0; offset < sourceChunk.byteLength; offset += BLOB_CHUNK_BYTES) {
          const chunk = Uint8Array.from(sourceChunk.subarray(offset, offset + BLOB_CHUNK_BYTES));
          size += chunk.byteLength;
          if (!Number.isSafeInteger(size)) throw new SyncError("file_too_large", "The binary file is too large for this device.");
          await this.put(BLOB_CHUNK_STORE, this.chunkKey(stage, chunks), chunk.buffer);
          chunks += 1;
        }
      }
      await this.put(BLOB_MANIFEST_STORE, this.manifestKey(contentDigest), { stage, chunks, size } satisfies BlobManifest);
    } catch (error) {
      await this.removeStage(stage, chunks).catch(() => undefined);
      throw error;
    }
    // Once published, the new stage is authoritative. Cleanup failure must not
    // delete it and leave the durable manifest pointing at missing chunks.
    if (previous && previous.stage !== stage) {
      await this.removeStage(previous.stage, previous.chunks).catch(() => undefined);
    }
  }

  async remove(contentDigest: `sha256:${string}`): Promise<void> {
    const manifest = await this.manifest(contentDigest);
    await this.delete(BLOB_MANIFEST_STORE, this.manifestKey(contentDigest));
    if (manifest) await this.removeStage(manifest.stage, manifest.chunks);
  }

  async prune(retained: ReadonlySet<`sha256:${string}`>): Promise<void> {
    const database = await this.open();
    const manifests = await new Promise<Array<[IDBValidKey, BlobManifest]>>((resolve, reject) => {
      const result: Array<[IDBValidKey, BlobManifest]> = [];
      const request = database.transaction(BLOB_MANIFEST_STORE, "readonly").objectStore(BLOB_MANIFEST_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(result);
        result.push([cursor.key, cursor.value as BlobManifest]);
        cursor.continue();
      };
      request.onerror = () => reject(indexedDbError(request.error, "manifest cursor"));
    });
    const retainedStages = new Set<string>();
    for (const [key, manifest] of manifests) {
      if (!Array.isArray(key) || key[0] !== this.namespace
        || (typeof key[1] === "string" && retained.has(key[1] as `sha256:${string}`))) continue;
      await this.delete(BLOB_MANIFEST_STORE, key);
      await this.removeStage(manifest.stage, manifest.chunks);
    }
    for (const [key, manifest] of manifests) {
      if (Array.isArray(key) && key[0] === this.namespace
        && typeof key[1] === "string" && retained.has(key[1] as `sha256:${string}`)) {
        retainedStages.add(manifest.stage);
      }
    }
    const orphanKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const result: IDBValidKey[] = [];
      const request = database.transaction(BLOB_CHUNK_STORE, "readonly").objectStore(BLOB_CHUNK_STORE).openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(result);
        const key = cursor.key;
        const stage = Array.isArray(key) && typeof key[1] === "string" ? key[1] : null;
        if (Array.isArray(key) && key[0] === this.namespace && (stage === null || !retainedStages.has(stage))) {
          result.push(key);
        }
        cursor.continue();
      };
      request.onerror = () => reject(indexedDbError(request.error, "chunk cursor"));
    });
    for (const key of orphanKeys) await this.delete(BLOB_CHUNK_STORE, key);
  }

  private manifest(contentDigest: `sha256:${string}`): Promise<BlobManifest | null> {
    return this.get<BlobManifest>(BLOB_MANIFEST_STORE, this.manifestKey(contentDigest));
  }

  private manifestKey(contentDigest: string): IDBValidKey {
    return [this.namespace, contentDigest];
  }

  private chunkKey(stage: string, index: number): IDBValidKey {
    return [this.namespace, stage, index];
  }

  private async removeStage(stage: string, chunks: number): Promise<void> {
    for (let index = 0; index < chunks; index += 1) await this.delete(BLOB_CHUNK_STORE, this.chunkKey(stage, index));
  }

  private async get<Value>(storeName: string, key: IDBValidKey): Promise<Value | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result as Value | undefined) ?? null);
      request.onerror = () => reject(indexedDbError(request.error, `read from ${storeName}`));
    });
  }

  private async put(storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(indexedDbError(transaction.error, `write to ${storeName}`));
      transaction.onabort = () => reject(indexedDbError(transaction.error, `write to ${storeName}`));
    });
  }

  private async delete(storeName: string, key: IDBValidKey): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(indexedDbError(transaction.error, `delete from ${storeName}`));
      transaction.onabort = () => reject(indexedDbError(transaction.error, `delete from ${storeName}`));
    });
  }

  close(): void {
    void this.database?.then((database) => database.close(), () => undefined);
    this.database = null;
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") throw new SyncError("storage_unavailable", "IndexedDB is required for binary file sync.");
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(BLOB_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(BLOB_MANIFEST_STORE)) request.result.createObjectStore(BLOB_MANIFEST_STORE);
        if (!request.result.objectStoreNames.contains(BLOB_CHUNK_STORE)) request.result.createObjectStore(BLOB_CHUNK_STORE);
      };
      request.onerror = () => reject(indexedDbError(request.error, "binary store open"));
      request.onsuccess = () => resolve(request.result);
    });
    return this.database;
  }
}

export class IndexedDbMirrorStateStore implements MirrorStateStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly key: string) {}

  async read(): Promise<MirrorState | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STATE_STORE, "readonly").objectStore(STATE_STORE).get(this.key);
      request.onsuccess = () => resolve((request.result as MirrorState | undefined) ?? null);
      request.onerror = () => reject(indexedDbError(request.error, "mirror state read"));
    });
  }

  async write(state: MirrorState): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STATE_STORE, "readwrite");
      transaction.objectStore(STATE_STORE).put(state, this.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(indexedDbError(transaction.error, "mirror state write"));
      transaction.onabort = () => reject(indexedDbError(transaction.error, "mirror state write"));
    });
  }

  async clear(): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STATE_STORE, "readwrite");
      transaction.objectStore(STATE_STORE).delete(this.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(indexedDbError(transaction.error, "mirror state clear"));
      transaction.onabort = () => reject(indexedDbError(transaction.error, "mirror state clear"));
    });
  }

  close(): void {
    void this.database?.then((database) => database.close(), () => undefined);
    this.database = null;
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new SyncError("storage_unavailable", "IndexedDB is required for persistent mirror state.");
    }
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(STATE_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STATE_STORE)) {
          request.result.createObjectStore(STATE_STORE);
        }
      };
      request.onerror = () => reject(indexedDbError(request.error, "mirror state store open"));
      request.onsuccess = () => resolve(request.result);
    });
    return this.database;
  }
}

export class DeviceMirrorLease implements MirrorLease {
  private static readonly active = new Set<string>();

  constructor(private readonly key: string) {}

  async runExclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (DeviceMirrorLease.active.has(this.key)) {
      throw new SyncError("mirror_busy", "A mirror operation is already running for this vault.");
    }
    DeviceMirrorLease.active.add(this.key);
    try {
      return await operation();
    } finally {
      DeviceMirrorLease.active.delete(this.key);
    }
  }
}

export interface ConnectSyncControllerOptions {
  stateStoreFactory?: (profile: MirrorProfile) => MirrorStateStore;
  blobStoreFactory?: (profile: MirrorProfile) => MirrorBlobStore;
  adoptionBlobStoreFactory?: (collectionId: string) => MirrorBlobStore;
  fileSystem?: MirrorFileSystem;
  leaseFactory?: (profile: MirrorProfile) => MirrorLease;
  enrollmentClient?: MirrorEnrollmentClient;
  adoptionClient?: AuthorityAdoptionClient;
  transportFactory?: (
    profile: MirrorProfile,
    accessToken: string,
  ) => SyncTransport<JsonObject>;
}

export class ConnectSyncController {
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly stateStores = new Map<string, IndexedDbMirrorStateStore>();
  private readonly blobStores = new Map<string, IndexedDbMirrorBlobStore>();

  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    this.cancelSync();
    for (const store of this.stateStores.values()) store.close();
    for (const store of this.blobStores.values()) store.close();
    this.stateStores.clear();
    this.blobStores.clear();
  }

  private async withLifetime<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive();
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      abortIfNeeded(controller.signal);
      return await operation(controller.signal);
    } finally {
      this.lifetime.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new DOMException("Plugin unloaded.", "AbortError");
  }
  private progress: MirrorProgress | null = null;
  private fileProgress: FileTransferProgress | null = null;
  private syncAbort: AbortController | null = null;
  private statusRequest: Promise<MirrorStatus | null> | null = null;
  private mirrorOperationTail: Promise<void> = Promise.resolve();
  private readonly fileSystem: MirrorFileSystem;
  private readonly enrollmentClient: MirrorEnrollmentClient;
  private readonly adoptionClient: AuthorityAdoptionClient;
  private adoptionMarker: AdoptionMarker | null = null;
  private adoptionBusy = false;

  private async withAdoptionOperation<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.adoptionBusy) throw new SyncError("authority_adoption_busy", "Stop the current move before changing its setup.");
    this.adoptionBusy = true;
    try {
      return await this.withLifetime(signal, operation);
    } finally {
      this.adoptionBusy = false;
    }
  }

  constructor(
    private readonly app: App,
    private readonly settingsHost: ConnectSyncSettingsHost,
    private readonly options: ConnectSyncControllerOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? new ObsidianMirrorFileSystem(
      app.vault,
      (file) => app.fileManager.trashFile(file),
      () => this.assertActive(),
      (path) => this.noteEngineWrite(path),
    );
    this.enrollmentClient = options.enrollmentClient ?? new MirrorEnrollmentClient({
      request: createObsidianEnrollmentRequester(),
    });
    this.adoptionClient = options.adoptionClient ?? new AuthorityAdoptionClient({
      request: createObsidianAdoptionRequester(),
    });
  }

  async initialize(): Promise<void> {
    this.adoptionMarker = await this.readAdoptionMarker();
    const profile = this.settingsHost.getMirrorProfile();
    if (this.adoptionMarker && profile) {
      if (this.adoptionMarker.phase === "adopted"
        && this.adoptionMarker.session.requested.collectionId === profile.collectionId) {
        await this.assertMirror(profile.collectionId);
        await this.clearAdoptionCheckpoint(this.adoptionMarker.session.adoptionId);
        return;
      }
      throw new SyncError(
        "authority_adoption_state_conflict",
        "This vault contains both an authority-adoption checkpoint and a mirror profile.",
      );
    }
  }

  getProgress(): MirrorProgress | null {
    return this.progress ? { ...this.progress } : null;
  }

  getFileProgress(): FileTransferProgress | null {
    return this.fileProgress ? { ...this.fileProgress } : null;
  }

  getAdoptionMarker(): Readonly<AdoptionMarker> | null {
    return this.adoptionMarker ? JSON.parse(JSON.stringify(this.adoptionMarker)) as AdoptionMarker : null;
  }

  getAdoptionRecovery(): { canReset: boolean; canReconnect: boolean } | null {
    const marker = this.adoptionMarker;
    if (!marker) return null;
    try {
      if (this.app.secretStorage.getSecret(this.adoptionSecretId(marker.session.adoptionId))) return null;
    } catch {
      // A locked/unavailable secret store is not a usable device credential.
    }
    const early = ["waiting_for_approval", "uploading"].includes(marker.phase);
    return {
      canReset: early && Date.parse(marker.session.expiresAt) <= Date.now(),
      canReconnect: !early,
    };
  }

  async resetExpiredAdoption(): Promise<void> {
    return this.withAdoptionOperation(undefined, async () => {
      const marker = await this.readAdoptionMarker();
      if (marker?.session.adoptionId !== this.adoptionMarker?.session.adoptionId) {
        throw new SyncError("authority_adoption_state_conflict", "Move setup changed. Reopen Sync before recovering it.");
      }
      this.adoptionMarker = marker;
      if (!marker || this.settingsHost.getMirrorProfile() || await this.app.vault.adapter.exists(ROLE_MARKER_PATH) || !this.getAdoptionRecovery()?.canReset) {
        throw new SyncError("authority_adoption_reset_unsafe", "Only an expired move that never froze this vault can be reset locally.");
      }
      // These phases never send activation, and do not fence local writes.
      // Leave all collection files/identity intact; expired server imports are
      // reclaimed by Connect. Never use this path for an uncertain activation.
      await this.clearAdoptionCheckpoint(marker.session.adoptionId);
    });
  }

  async reconnectAdoption(callbacks: AdoptLocalCollectionCallbacks): Promise<MirrorProfile> {
    return this.withAdoptionOperation(callbacks.signal, async (signal) => {
      const marker = this.adoptionMarker;
      if (!marker || !this.getAdoptionRecovery()?.canReconnect || this.settingsHost.getMirrorProfile()) {
        throw new SyncError("authority_adoption_reconnect_unsafe", "This move does not require hosted recovery.");
      }
      // Fresh browser approval, not a local reset. Connect grants this mirror
      // only for an accessible, active hosted authority. Keep the fence and
      // snapshot until that proof is obtained and credentials are saved.
      const enrollment = await this.enrollmentClient.enroll({
        controlUrl: marker.session.controlUrl,
        collectionId: marker.session.requested.collectionId,
        mirrorName: marker.session.requested.mirrorName ?? marker.session.requested.sourceName,
        mode: "read_write",
      }, { ...callbacks, signal });
      if (enrollment.collectionId !== marker.session.requested.collectionId || enrollment.mode !== "read_write") {
        throw new SyncError("authority_adoption_state_conflict", "Connect approved a different collection or access mode; this vault remains protected.");
      }
      abortIfNeeded(signal);
      await this.updateAdoptionPhase("adopted");
      return this.persistAdoptedMirror(marker.session, enrollment);
    });
  }

  getSelectiveSync(): SelectiveSyncPolicy {
    return normalizeSelectiveSync(
      this.settingsHost.getMirrorProfile()?.selectiveSync ?? this.adoptionMarker?.selective_sync,
    );
  }

  async configureSelectiveSync(policy: SelectiveSyncPolicy): Promise<void> {
    const profile = this.requireProfile();
    await this.settingsHost.saveMirrorProfile({ ...profile, selectiveSync: normalizeSelectiveSync(policy) });
  }

  assertLocalAuthorityWritable(): void {
    this.assertActive();
    if (this.adoptionMarker && ["fenced", "activating", "adopted"].includes(this.adoptionMarker.phase)) {
      throw new SyncError(
        "local_authority_fenced",
        this.adoptionMarker.phase === "adopted"
          ? "Hosted mdbase is now authoritative. Finish reconnecting this vault as its mirror before editing."
          : "This local authority is frozen while its exact snapshot is adopted by hosted mdbase.",
      );
    }
  }

  async adoptLocalCollection(input: AdoptLocalCollectionInput, callbacks: AdoptLocalCollectionCallbacks): Promise<MirrorProfile> {
    return this.withAdoptionOperation(callbacks.signal, (signal) => this.adoptLocalCollectionActive(input, { ...callbacks, signal }));
  }

  private async adoptLocalCollectionActive(
    input: AdoptLocalCollectionInput,
    callbacks: AdoptLocalCollectionCallbacks,
  ): Promise<MirrorProfile> {
    if (this.settingsHost.getMirrorProfile()) {
      throw new SyncError("mirror_already_configured", "This vault already mirrors a collection authority.");
    }
    if (this.adoptionMarker) return this.resumeAdoptionActive(callbacks);
    callbacks.onProgress?.({ stage: "checking" });
    assertAdoptionPaths(await this.previewAdoption(input.selectiveSync, callbacks.signal));
    const collection = await this.ensurePortableCollectionIdentity();
    const session = await this.adoptionClient.begin({
      controlUrl: input.controlUrl,
      collectionId: collection.collectionId,
      displayName: collection.displayName,
      sourceName: input.mirrorName,
      retainMirror: true,
      mirrorName: input.mirrorName,
    }, callbacks);
    try {
      await this.storeAdoptionSecret(session);
    } catch (error) {
      // No durable checkpoint or approval link exists yet. Best-effort retire
      // the unapproved request using the still-in-memory credential.
      await this.adoptionClient.cancel(session, callbacks).catch(() => undefined);
      throw error;
    }
    await this.writeAdoptionMarker({
      version: 1,
      phase: "waiting_for_approval",
      session: publicAdoptionSession(session),
      selective_sync: normalizeSelectiveSync(input.selectiveSync),
      manifest_digest: null,
      source_revision: null,
      source_head: null,
    });
    await callbacks.onVerification(publicAdoptionSession(session));
    return this.runAdoptionWithRecovery(session, callbacks);
  }

  async resumeAdoption(callbacks: Omit<AdoptLocalCollectionCallbacks, "onVerification"> & {
    onVerification?(
      verification: AuthorityAdoptionVerification | MirrorEnrollmentVerification,
    ): void | Promise<void>;
  } = {}): Promise<MirrorProfile> {
    return this.withAdoptionOperation(callbacks.signal, (signal) => this.resumeAdoptionActive({ ...callbacks, signal }));
  }

  private async resumeAdoptionActive(callbacks: Omit<AdoptLocalCollectionCallbacks, "onVerification"> & {
    onVerification?: AdoptLocalCollectionCallbacks["onVerification"];
  }): Promise<MirrorProfile> {
    const marker = this.adoptionMarker ?? await this.readAdoptionMarker();
    if (!marker) {
      throw new SyncError("authority_adoption_not_found", "This vault has no collection-adoption checkpoint.");
    }
    this.adoptionMarker = marker;
    const credential = this.app.secretStorage.getSecret(this.adoptionSecretId(marker.session.adoptionId));
    if (!credential) {
      throw new SyncError(
        "authority_adoption_credentials_missing",
        "The collection-adoption credential is missing from Obsidian's secret store.",
      );
    }
    const session: AuthorityAdoptionSession = { ...marker.session, credential };
    if (marker.phase === "waiting_for_approval") {
      await callbacks.onVerification?.(publicAdoptionSession(session));
    }
    return this.runAdoptionWithRecovery(session, {
      ...callbacks,
      onVerification: (verification) => callbacks.onVerification?.(verification),
    });
  }

  async cancelAdoption(signal?: AbortSignal): Promise<void> {
    return this.withAdoptionOperation(signal, (activeSignal) => this.cancelAdoptionActive(activeSignal));
  }

  private async cancelAdoptionActive(signal: AbortSignal): Promise<void> {
    const marker = this.adoptionMarker ?? await this.readAdoptionMarker();
    if (!marker) return;
    if (["activating", "adopted"].includes(marker.phase)) {
      throw new SyncError(
        "authority_adoption_activation_started",
        "Hosted activation has started and must be resumed; it can no longer be cancelled.",
      );
    }
    const credential = this.app.secretStorage.getSecret(this.adoptionSecretId(marker.session.adoptionId));
    if (!credential) {
      throw new SyncError(
        "authority_adoption_credentials_missing",
        "The collection-adoption credential is missing from Obsidian's secret store.",
      );
    }
    await this.adoptionClient.cancel({ ...marker.session, credential }, { signal });
    await this.clearAdoptionCheckpoint(marker.session.adoptionId);
  }

  async enroll(input: EnrollMirrorInput, callbacks: EnrollMirrorCallbacks): Promise<MirrorProfile> {
    return this.withLifetime(callbacks.signal, (signal) => this.enrollActive(input, { ...callbacks, signal }));
  }

  private async enrollActive(
    input: EnrollMirrorInput,
    callbacks: EnrollMirrorCallbacks,
  ): Promise<MirrorProfile> {
    const collectionId = await this.assertCanBecomeMirror(input.collectionId);
    const enrollment = await this.enrollmentClient.enroll({
      controlUrl: input.controlUrl,
      mirrorName: input.mirrorName,
      mode: input.mode,
      ...(collectionId ? { collectionId } : {}),
    }, callbacks);
    const markerCreated = await this.markMirror(enrollment.collectionId);
    try {
      await this.persistEnrollment(enrollment, input.selectiveSync);
    } catch (error) {
      if (markerCreated) {
        try {
          await this.app.vault.adapter.remove(ROLE_MARKER_PATH);
        } catch {
          throw new SyncError(
            "enrollment_recovery_required",
            `Enrollment settings could not be saved and the temporary role marker could not be removed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      throw error;
    }
    return this.requireProfile();
  }

  /** The plan and the status it implies, from a single inspection. */
  async inspect(): Promise<{ preview: MdbaseSyncPreview; status: MirrorStatus }> {
    return this.withMirrorOperation(async () => {
      const profile = this.requireProfile();
      await this.assertMirror(profile.collectionId);
      const mirror = await this.createMirror();
      const { plan, status } = await mirror.review();
      return { preview: previewFromPlan(plan), status };
    });
  }

  async preview(): Promise<MdbaseSyncPreview> {
    return this.withMirrorOperation(async () => {
      const profile = this.requireProfile();
      await this.assertMirror(profile.collectionId);
      const mirror = await this.createMirror();
      return previewFromPlan(await mirror.inspect());
    });
  }

  async status(): Promise<MirrorStatus | null> {
    if (this.statusRequest) return this.statusRequest;
    const request = this.readStatus();
    this.statusRequest = request;
    try {
      return await request;
    } finally {
      if (this.statusRequest === request) this.statusRequest = null;
    }
  }

  private async readStatus(): Promise<MirrorStatus | null> {
    return this.withMirrorOperation(async () => {
      const profile = this.settingsHost.getMirrorProfile();
      if (!profile) return null;
      await this.assertMirror(profile.collectionId);
      const mirror = await this.createMirror();
      return mirror.status();
    });
  }

  /**
   * Whether Connect has changes past this device's checkpoint. One small page of
   * the change feed, with no local scan, so it is cheap enough to poll often.
   * Changes this device uploaded itself also count: the next sync moves the
   * checkpoint past them.
   */
  async remoteChangesWaiting(): Promise<boolean> {
    const profile = this.requireProfile();
    const state = await this.stateStoreFor(profile).read();
    if (!state || state.batch) return true;
    const transport = await this.transportFor(profile);
    const page = await transport.changes(state.cursor, 1);
    return page.reset_required || page.scope_epoch !== state.scope_epoch || page.head > state.cursor;
  }

  /** The durable mirror checkpoint, for diagnostics. */
  async checkpointSummary(): Promise<{ cursor: number; generation: number; batch: string | null; failure: string | null } | null> {
    const profile = this.settingsHost.getMirrorProfile();
    if (!profile) return null;
    const state = await this.stateStoreFor(profile).read();
    if (!state) return null;
    return {
      cursor: state.cursor,
      generation: state.generation ?? 0,
      batch: state.batch ? `${state.batch.phase} at action ${state.batch.next_action}/${state.batch.plan.actions.length}` : null,
      failure: state.batch?.failure ? `${state.batch.failure.code}: ${state.batch.failure.message}` : null,
    };
  }

  async reconnect(): Promise<MirrorStatus> {
    const profile = this.requireProfile();
    // Renewing with a copied vault's credential would rotate the original vault's token.
    this.assertThisDevice(profile);
    await this.renewAccessToken(profile);
    const status = await this.status();
    if (!status) throw new SyncError("mirror_not_configured", "The renewed mirror profile could not be loaded.");
    return status;
  }

  async reauthorize(callbacks: EnrollMirrorCallbacks): Promise<MirrorStatus> {
    return this.withLifetime(callbacks.signal, (signal) => this.reauthorizeActive({ ...callbacks, signal }));
  }

  private async reauthorizeActive(callbacks: EnrollMirrorCallbacks): Promise<MirrorStatus> {
    const profile = this.requireProfile();
    // A copy of a vault starts its own replica from scratch: the checkpoint and
    // credentials on this device belong to the vault it was copied from.
    const copied = this.isOtherDevice(profile);
    const oldStore = this.stateStoreFor(profile);
    const oldState = copied ? null : await oldStore.read();
    if (oldState?.batch) {
      throw new SyncError(
        "mirror_recovery_required",
        "Resume the durable synchronization checkpoint before approving this vault again.",
      );
    }
    const enrollment = await this.enrollmentClient.enroll({
      controlUrl: profile.controlUrl,
      mirrorName: profile.name,
      mode: profile.mode,
      collectionId: profile.collectionId,
    }, callbacks);
    if (enrollment.collectionId !== profile.collectionId) {
      throw new SyncError("mirror_identity_conflict", "Connect approved a different collection. The existing mirror was not changed.");
    }
    const nextProfile = profileFromEnrollment(enrollment, profile.selectiveSync);
    if (oldState && enrollment.replicaId !== profile.replicaId) {
      await this.stateStoreFor(nextProfile).write({
        ...oldState,
        replica_id: enrollment.replicaId,
      });
    }
    await this.persistEnrollment(enrollment, profile.selectiveSync);
    if (!copied && enrollment.replicaId !== profile.replicaId) {
      this.clearCredentials(profile);
      if ("clear" in oldStore && typeof oldStore.clear === "function") await oldStore.clear();
    }
    const status = await this.status();
    if (!status) throw new SyncError("mirror_not_configured", "The reauthorized mirror profile could not be loaded.");
    return status;
  }

  async conflictComparison(
    conflict: MirrorStatus["conflicts"][number],
  ): Promise<MirrorConflictComparison> {
    const profile = this.requireProfile();
    const transport = await this.transportFor(profile);
    const session = await transport.openSession();
    let remote: MirrorConflictSide = { state: "absent" };
    if (conflict.entity === "record") {
      let page: string | undefined;
      do {
        const snapshot = await transport.snapshot(session.snapshot_id, page);
        const record = snapshot.records.find((candidate) => candidate.record_id === conflict.object_id);
        if (record) {
          remote = {
            state: "exact",
            path: record.path,
            revision: record.revision,
            size: new TextEncoder().encode(record.document).byteLength,
            document: record.document,
          };
          break;
        }
        page = snapshot.next_page;
      } while (page);
    } else {
      let page: string | undefined;
      do {
        const snapshot = await transport.fileSnapshot(session.snapshot_id, page);
        const file = snapshot.files.find((candidate) => candidate.file_id === conflict.object_id);
        if (file) {
          remote = {
            state: "exact",
            path: file.path,
            revision: file.content_digest,
            size: file.size,
            modifiedAt: file.modified_at,
          };
          break;
        }
        page = snapshot.next_page;
      } while (page);
    }
    const path = conflict.path ?? remote.path;
    let local: MirrorConflictSide = { state: "absent" };
    if (path) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        if (conflict.entity === "record") {
          const document = await this.app.vault.cachedRead(file);
          local = {
            state: "exact",
            path,
            size: new TextEncoder().encode(document).byteLength,
            modifiedAt: file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : undefined,
            document,
          };
        } else {
          const info = await this.fileSystem.inspectBinary(path);
          if (info) {
            local = {
              state: "exact",
              path,
              revision: info.content_digest,
              size: info.size,
              modifiedAt: file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : undefined,
              resourceUrl: this.app.vault.getResourcePath(file),
            };
          }
        }
      }
    }
    const current = await this.status();
    if (!current?.conflicts.some((candidate) => candidate.object_id === conflict.object_id && candidate.decision_id === conflict.decision_id)) {
      throw new SyncError("conflict_decision_stale", "This file changed again while its versions were loading.");
    }
    return {
      entity: conflict.entity,
      objectId: conflict.object_id,
      decisionId: conflict.decision_id,
      local,
      remote,
    };
  }

  /**
   * Local and hosted text of a record with a pending transfer, for review only.
   * The hosted side is the collection's current snapshot; nothing is written.
   */
  async recordComparison(recordId: string, localPath: string): Promise<MirrorConflictComparison> {
    const profile = this.requireProfile();
    const transport = await this.transportFor(profile);
    const session = await transport.openSession();
    let remote: MirrorConflictSide = { state: "absent" };
    let page: string | undefined;
    do {
      const snapshot = await transport.snapshot(session.snapshot_id, page);
      const record = snapshot.records.find((candidate) => candidate.record_id === recordId);
      if (record) {
        remote = {
          state: "exact",
          path: record.path,
          revision: record.revision,
          size: new TextEncoder().encode(record.document).byteLength,
          document: record.document,
        };
        break;
      }
      page = snapshot.next_page;
    } while (page);
    let local: MirrorConflictSide = { state: "absent" };
    const file = this.app.vault.getAbstractFileByPath(safeMirrorPath(this.app.vault, localPath));
    if (file instanceof TFile) {
      const document = await this.app.vault.cachedRead(file);
      local = {
        state: "exact",
        path: file.path,
        size: new TextEncoder().encode(document).byteLength,
        document,
      };
    }
    return { entity: "record", objectId: recordId, decisionId: "", local, remote };
  }

  /**
   * Settles every open conflict the way a person almost always would, so sync
   * never waits on one: edits beat deletions; text edits that touch different
   * fields or lines are merged; anything else keeps both versions, with this
   * device's version saved beside the hosted one. Nothing is discarded. A
   * conflict that changes again while this runs is left for the next sync.
   */
  async autoResolveConflicts(): Promise<AutoResolution[]> {
    const status = await this.status();
    if (!status?.conflicts.length || status.recovery_required) return [];
    const profile = this.requireProfile();
    const state = await this.stateStoreFor(profile).read();
    if (!state || state.batch) return [];
    const recordIds = status.conflicts
      .filter((conflict) => conflict.entity === "record" && state.planned_conflicts?.[conflict.object_id]?.conflict_kind === "both_changed")
      .map((conflict) => conflict.object_id);
    const remoteRecords = recordIds.length ? await this.remoteRecords(new Set(recordIds)) : new Map<string, RemoteRecord>();
    const resolutions: AutoResolution[] = [];
    for (const conflict of status.conflicts) {
      const planned = state.planned_conflicts?.[conflict.object_id];
      if (!planned) continue;
      try {
        resolutions.push(await this.autoResolve(conflict, planned, remoteRecords.get(conflict.object_id)));
      } catch (error) {
        if (error instanceof SyncError && ["conflict_decision_stale", "sync_plan_stale"].includes(error.code)) continue;
        resolutions.push({
          path: conflict.path ?? conflict.object_id,
          outcome: "unresolved",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return resolutions;
  }

  private async autoResolve(
    conflict: MirrorStatus["conflicts"][number],
    planned: NonNullable<MirrorState["planned_conflicts"]>[string],
    remote: RemoteRecord | undefined,
  ): Promise<AutoResolution> {
    const { object_id: id, decision_id: decision } = conflict;
    const localPath = planned.local.state === "exact" ? planned.local.object.path : null;
    const remotePath = planned.remote.state === "exact" ? planned.remote.object.path : null;
    const path = conflict.path ?? localPath ?? remotePath ?? id;
    // Connect refused this change (permissions or collection rules). Retrying
    // it under another name would only be refused again; a person must decide.
    if (planned.conflict_kind === "rejected") return { path, outcome: "unresolved", reason: conflict.message };
    if (localPath === null) {
      await this.resolveConflict(id, decision, "remote");
      return { path, outcome: remotePath ? "restored" : "took_hosted" };
    }
    if (remotePath === null) {
      await this.resolveConflict(id, decision, "local");
      return { path, outcome: "kept_local" };
    }
    if (
      conflict.entity === "record"
      && planned.conflict_kind === "both_changed"
      && remote
      && remote.path === localPath
      && planned.remote.state === "exact"
      && remote.revision === planned.remote.object.revision
    ) {
      // The engine rebases a recorded conflict onto the hosted version; the
      // last common version is kept on the conflict itself.
      const base = planned.ancestor_document;
      const local = await this.fileSystem.read(localPath);
      if (base !== undefined && local !== null) {
        const merged = mergeDocuments(base, local, remote.document, validYamlMapping);
        if (merged.clean) {
          await this.resolveConflict(id, decision, "local");
          try {
            await this.fileSystem.write(localPath, merged.text, local);
          } catch (error) {
            // The note changed between the check and the write. Keep the hosted
            // text beside it so the merge's other half is never lost.
            const copy = await this.writeConflictCopy(localPath, remote.document, "hosted conflict copy");
            return { path, outcome: "kept_both", copyPath: copy, reason: error instanceof Error ? error.message : String(error) };
          }
          return { path, outcome: "merged" };
        }
      }
    }
    const copyPath = await this.preserveConflictCopy(localPath);
    await this.resolveConflict(id, decision, "remote");
    return { path, outcome: "kept_both", copyPath };
  }

  /** Current hosted text for a set of records, from one snapshot pass. */
  private async remoteRecords(ids: ReadonlySet<string>): Promise<Map<string, RemoteRecord>> {
    const transport = await this.transportFor(this.requireProfile());
    const session = await transport.openSession();
    const found = new Map<string, RemoteRecord>();
    let page: string | undefined;
    do {
      const snapshot = await transport.snapshot(session.snapshot_id, page);
      for (const record of snapshot.records) {
        if (ids.has(record.record_id)) {
          found.set(record.record_id, { path: record.path, revision: record.revision, document: record.document });
        }
      }
      page = found.size === ids.size ? undefined : snapshot.next_page;
    } while (page);
    return found;
  }

  private async writeConflictCopy(pathInput: string, document: string, label: string): Promise<string> {
    const path = safeMirrorPath(this.app.vault, pathInput);
    const target = await this.conflictCopyPath(path, label);
    await this.app.vault.create(target, document);
    return target;
  }

  private async conflictCopyPath(path: string, label: string): Promise<string> {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const extension = dot > slash ? path.slice(dot) : "";
    const base = extension ? path.slice(0, -extension.length) : path;
    let target = `${base} (${label})${extension}`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(target) || await this.app.vault.adapter.exists(target)) {
      target = `${base} (${label} ${suffix})${extension}`;
      suffix += 1;
    }
    return target;
  }

  async preserveConflictCopy(pathInput: string): Promise<string> {
    const path = safeMirrorPath(this.app.vault, pathInput);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) throw new SyncError("mirror_conflict_copy_missing", `No local file exists at ${path}.`);
    const target = await this.conflictCopyPath(path, "local conflict copy");
    await this.app.vault.adapter.copy(path, target);
    return target;
  }

  async disconnect(removeSyncedFiles: boolean): Promise<DisconnectMirrorResult> {
    if (this.isSyncing()) throw new SyncError("mirror_busy", "Stop the current synchronization before disconnecting.");
    return this.withMirrorOperation(() => this.disconnectActive(removeSyncedFiles));
  }

  private async disconnectActive(removeSyncedFiles: boolean): Promise<DisconnectMirrorResult> {
    if (this.isSyncing()) throw new SyncError("mirror_busy", "Stop the current synchronization before disconnecting.");
    const profile = this.requireProfile();
    const stateStore = this.stateStoreFor(profile);
    const state = await stateStore.read();
    if (state?.batch) {
      throw new SyncError("mirror_recovery_required", "Resume the durable synchronization checkpoint before disconnecting.");
    }
    const result: DisconnectMirrorResult = { removed: [], preserved: [] };
    const marker = await this.readMarker();
    if (marker) await this.app.vault.adapter.remove(ROLE_MARKER_PATH);
    try {
      await this.settingsHost.saveMirrorProfile(null);
    } catch (error) {
      if (marker) await this.markMirror(profile.collectionId);
      throw error;
    }
    // A copied vault shares IndexedDB and secret storage with the vault it was
    // copied from; that state belongs to the original and must survive.
    if (!this.isOtherDevice(profile)) {
      this.clearCredentials(profile);
      if ("clear" in stateStore && typeof stateStore.clear === "function") await stateStore.clear();
      await this.blobStoreFor(profile).prune(new Set());
    }
    // Destructive file removal starts only after the authority connection is
    // durably gone, so a settings failure can never leave a live mirror with a
    // partially deleted local collection.
    if (removeSyncedFiles && state) await this.removeExactMirrorFiles(state, result);
    return result;
  }

  async sync(
    reviewed: MdbaseSyncPreview,
    onProgress?: (progress: MirrorProgress) => void,
    onFileProgress?: (progress: FileTransferProgress) => void,
    onReceipt?: (action: MirrorPlanAction, receipt: SyncActionReceipt) => void,
  ): Promise<MirrorApplyResult> {
    if (this.syncAbort) {
      throw new SyncError("mirror_busy", "Synchronization is already running for this vault.");
    }
    const abort = new AbortController();
    this.syncAbort = abort;
    try {
      return await this.withMirrorOperation(async () => {
        const mirror = await this.createMirror((next) => {
          abortIfNeeded(abort.signal);
          this.progress = next;
          onProgress?.({ ...next });
        }, abort.signal, (next) => {
          abortIfNeeded(abort.signal);
          this.fileProgress = next;
          onFileProgress?.({ ...next });
        }, onReceipt);
        const outcome = await mirror.apply(reviewed.plan, { signal: abort.signal });
        abortIfNeeded(abort.signal);
        return outcome;
      });
    } finally {
      this.progress = null;
      this.fileProgress = null;
      this.syncAbort = null;
    }
  }

  cancelSync(): void {
    this.syncAbort?.abort();
  }

  /** Vault events for these paths come from the mirror itself, not from the user. */
  private readonly engineWrites = new Map<string, number>();

  private noteEngineWrite(path: string): void {
    const now = Date.now();
    for (const [known, at] of this.engineWrites) {
      if (now - at > ENGINE_WRITE_ECHO_MS) this.engineWrites.delete(known);
    }
    this.engineWrites.set(normalizePath(path), now);
  }

  isEngineWrite(path: string): boolean {
    const at = this.engineWrites.get(normalizePath(path));
    return at !== undefined && Date.now() - at <= ENGINE_WRITE_ECHO_MS;
  }

  isSyncing(): boolean {
    return this.syncAbort !== null;
  }

  async resolveConflict(
    objectId: string,
    decisionId: string,
    resolution: "local" | "remote",
  ): Promise<MirrorStatus> {
    return this.withMirrorOperation(async () => {
      const mirror = await this.createMirror();
      await mirror.resolveConflict(objectId, decisionId, resolution);
      return mirror.status();
    });
  }

  private async withMirrorOperation<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.mirrorOperationTail;
    let release!: () => void;
    this.mirrorOperationTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      this.assertActive();
      return await operation();
    } finally {
      release();
    }
  }

  private async runAdoption(
    session: AuthorityAdoptionSession,
    callbacks: AdoptLocalCollectionCallbacks,
  ): Promise<MirrorProfile> {
    let marker = this.requireAdoptionMarker(session.adoptionId);
    let completed: CompletedAuthorityAdoption | null = null;

    if (marker.phase === "adopted") {
      const exchanged = await this.adoptionClient.exchange(session, callbacks);
      if (exchanged.status !== "completed") {
        throw new SyncError(
          "authority_adoption_state_conflict",
          "The local checkpoint says adoption completed, but Connect does not.",
        );
      }
      completed = exchanged;
    } else if (marker.phase === "activating") {
      callbacks.onProgress?.({ stage: "activating" });
      const snapshot = await this.readAdoptionSnapshot(marker);
      const exchanged = await this.adoptionClient.exchange(session, callbacks);
      completed = exchanged.status === "completed"
        ? exchanged
        : await this.adoptionClient.complete(session, snapshot, callbacks);
    } else if (marker.phase === "fenced") {
      const snapshot = await this.readAdoptionSnapshot(marker);
      const exchanged = await this.adoptionClient.exchange(session, callbacks);
      if (exchanged.status === "completed") {
        completed = exchanged;
      } else {
        if (exchanged.status === "ready") {
          callbacks.onProgress?.({ stage: "uploading", records: snapshot.records.length });
          await this.adoptionClient.uploadSnapshot(session, exchanged, snapshot, this.adoptionUploadOptions(session, callbacks));
        }
        await this.updateAdoptionPhase("activating", snapshot);
        callbacks.onProgress?.({ stage: "activating" });
        completed = await this.adoptionClient.complete(session, snapshot, callbacks);
      }
    } else {
      const prepared = marker.phase === "waiting_for_approval"
        ? await this.adoptionClient.waitForApproval(session, callbacks)
        : await this.requirePreparedAdoption(session, callbacks);
      await this.updateAdoptionPhase("uploading", undefined, prepared.adoption.expires_at);
      callbacks.onProgress?.({ stage: "checking" });
      const warmSnapshot = await this.captureAuthoritySnapshot(session.requested.collectionId, callbacks.signal);
      callbacks.onProgress?.({ stage: "uploading", records: warmSnapshot.records.length });
      await this.adoptionClient.uploadSnapshot(session, prepared, warmSnapshot, this.adoptionUploadOptions(session, callbacks));

      // From this point local plugin writes are stopped. Any external file edit is
      // a pending mirror write, not part of the authority snapshot being activated.
      callbacks.onProgress?.({ stage: "checking" });
      const finalSnapshot = await this.captureAuthoritySnapshot(session.requested.collectionId, callbacks.signal);
      await this.writeAdoptionSnapshot(finalSnapshot);
      await this.updateAdoptionPhase("fenced", finalSnapshot);
      const finalPrepared = await this.requirePreparedAdoption(session, callbacks);
      callbacks.onProgress?.({ stage: "uploading", records: finalSnapshot.records.length });
      await this.adoptionClient.uploadSnapshot(session, finalPrepared, finalSnapshot, this.adoptionUploadOptions(session, callbacks));
      await this.updateAdoptionPhase("activating", finalSnapshot);
      callbacks.onProgress?.({ stage: "activating" });
      completed = await this.adoptionClient.complete(session, finalSnapshot, callbacks);
    }

    await this.updateAdoptionPhase("adopted");
    callbacks.onProgress?.({ stage: "connecting" });
    return this.finishRetainedMirror(session, completed, callbacks);
  }

  private async runAdoptionWithRecovery(
    session: AuthorityAdoptionSession,
    callbacks: AdoptLocalCollectionCallbacks,
  ): Promise<MirrorProfile> {
    try {
      return await this.runAdoption(session, callbacks);
    } catch (error) {
      // The SDK uses authority_adoption_cancelled for both a stopped poll and
      // a terminal server cancellation. A locally aborted wait is only a pause:
      // retain the credential, marker and any fenced snapshot for Resume.
      if (callbacks.signal?.aborted) throw new DOMException("Adoption paused.", "AbortError");
      if (!isSafelyInactiveAdoption(error)) throw error;
      await this.adoptionClient.cancel(session, {
        signal: callbacks.signal,
      }).catch(() => undefined);
      await this.clearAdoptionCheckpoint(session.adoptionId);
      throw new SyncError(
        error.code,
        "This adoption ended before hosted activation. The vault remains the writable local authority; start a new adoption to try again.",
      );
    }
  }

  private async requirePreparedAdoption(
    session: AuthorityAdoptionSession,
    callbacks: Pick<AdoptLocalCollectionCallbacks, "signal">,
  ) {
    const exchanged = await this.adoptionClient.exchange(session, callbacks);
    if (exchanged.status === "ready") return exchanged;
    if (exchanged.status === "activating") {
      throw new AuthorityAdoptionOutcomeUnknownError(
        "Hosted authority activation has already started. Resume using the saved fenced snapshot.",
      );
    }
    throw new SyncError(
      "authority_adoption_already_completed",
      "Hosted authority has already adopted this collection.",
    );
  }

  private async finishRetainedMirror(
    session: AuthorityAdoptionSession,
    completed: CompletedAuthorityAdoption,
    callbacks: AdoptLocalCollectionCallbacks,
  ): Promise<MirrorProfile> {
    let enrollment: MirrorEnrollment;
    const retained = this.adoptionClient.mirrorEnrollmentSession(session, completed);
    if (!retained) {
      throw new SyncError(
        "authority_adoption_mirror_missing",
        "Hosted authority activated without retaining this vault as a mirror.",
      );
    }
    try {
      enrollment = await this.enrollmentClient.waitForApproval(retained, {
        signal: callbacks.signal,
        onStatus: (status) => callbacks.onStatus?.({
          ...status,
          state: status.state,
        }),
      });
    } catch (error) {
      if (callbacks.signal?.aborted) throw error;
      enrollment = await this.enrollmentClient.enroll({
        controlUrl: session.controlUrl,
        collectionId: session.requested.collectionId,
        mirrorName: session.requested.mirrorName ?? session.requested.sourceName,
        mode: "read_write",
      }, {
        signal: callbacks.signal,
        onVerification: (verification) => callbacks.onVerification(verification),
      });
    }
    return this.persistAdoptedMirror(session, enrollment);
  }

  private async persistAdoptedMirror(
    session: AuthorityAdoptionVerification,
    enrollment: MirrorEnrollment,
  ): Promise<MirrorProfile> {
    const markerCreated = await this.markMirror(enrollment.collectionId);
    try {
      await this.persistEnrollment(enrollment, this.adoptionMarker?.selective_sync);
    } catch (error) {
      if (markerCreated) await this.app.vault.adapter.remove(ROLE_MARKER_PATH);
      throw error;
    }
    await this.clearAdoptionCheckpoint(session.adoptionId);
    return this.requireProfile();
  }

  private async adoptionSources(policy: SelectiveSyncPolicy, signal?: AbortSignal) {
    abortIfNeeded(signal);
    const config = await loadMdbaseConfig(this.app.vault);
    abortIfNeeded(signal);
    if (!config) {
      throw new SyncError("invalid_collection_configuration", "A valid mdbase.yaml is required.");
    }
    const configuration = await this.app.vault.adapter.read("mdbase.yaml");
    abortIfNeeded(signal);
    const rawConfiguration = parseYaml(configuration);
    const typesPrefix = `${normalizePath(config.settings.types_folder)}/`;
    const typeFiles = this.app.vault.getMarkdownFiles()
      .filter((file) => normalizePath(file.path).startsWith(typesPrefix))
      .sort((left, right) => left.path.localeCompare(right.path));
    const matches = configuredBasePatterns(rawConfiguration).map(pattern => picomatch(pattern, { dot: true }));
    const baseFiles = listFiles(this.app.vault)
      .filter(file => file.extension === "base" && matches.some(match => match(normalizePath(file.path))))
      .sort((left, right) => left.path.localeCompare(right.path));
    const recordFiles = this.app.vault.getMarkdownFiles()
      .filter(file => !isExcluded(normalizePath(file.path), config))
      .sort((left, right) => left.path.localeCompare(right.path));
    const resourcePaths = ["mdbase.yaml", ...typeFiles.map(file => file.path), ...baseFiles.map(file => file.path)];
    const binaryPaths = policy.file_classes.length
      ? (await this.fileSystem.listBinary?.(new Set(resourcePaths)) ?? [])
        .filter(path => binaryPathSelected(policy, path) && !isExcluded(path, config))
      : [];
    abortIfNeeded(signal);
    const preview: AdoptionPreview = {
      records: recordFiles.length, resources: resourcePaths.length, files: binaryPaths.length,
      conflicts: findAdoptionPathConflicts([...resourcePaths, ...recordFiles.map(file => file.path), ...binaryPaths]),
    };
    return { config, configuration, typeFiles, baseFiles, recordFiles, binaryPaths, resourcePaths, preview };
  }

  private renameNamespace() {
    return this.app.vault.getAllLoadedFiles?.() ?? listFiles(this.app.vault);
  }

  async planAdoptionRenames(policy = this.getSelectiveSync()): Promise<AdoptionRenamePlan> {
    this.assertActive();
    const { preview, resourcePaths } = await this.adoptionSources(normalizeSelectiveSync(policy));
    const paths = this.renameNamespace().map(file => file.path).sort();
    const proposed = proposeAdoptionRenames(preview.conflicts, paths, new Set(resourcePaths));
    const sources = proposed.renames.map(({ from }) => {
      const file = this.app.vault.getAbstractFileByPath(from);
      return [from, file instanceof TFile ? file.stat : null];
    });
    const revision = (await binaryInfo(new TextEncoder().encode(JSON.stringify({ paths, sources, proposed, policy })).buffer)).content_digest;
    return { ...proposed, revision };
  }

  async applyAdoptionRenames(
    plan: AdoptionRenamePlan,
    policy = this.getSelectiveSync(),
    onProgress?: (completed: number, total: number) => void,
  ): Promise<number> {
    return this.withAdoptionOperation(undefined, async (signal) => {
      this.assertLocalAuthorityWritable();
      if (this.settingsHost.getMirrorProfile() || await this.app.vault.adapter.exists(ROLE_MARKER_PATH)) {
        throw new SyncError("adoption_rename_unsafe", "Automatic rename review is only available before this vault becomes a mirror.");
      }
      const current = await this.planAdoptionRenames(policy);
      if (JSON.stringify(current) !== JSON.stringify(plan)) {
        throw new SyncError("adoption_rename_stale", "Files changed since the rename review. Review the new suggestions before renaming.");
      }
      // Capture object identities once; never rename a replacement file that
      // happens to appear at a reviewed source path during this batch.
      const sources = plan.renames.map(change => this.app.vault.getAbstractFileByPath(change.from));
      let completed = 0;
      onProgress?.(0, plan.renames.length);
      for (const [index, change] of plan.renames.entries()) {
        const file = sources[index];
        try {
          abortIfNeeded(signal);
          this.assertLocalAuthorityWritable();
          if (!(file instanceof TFile) || file.path !== change.from
            || this.app.vault.getAbstractFileByPath(change.from) !== file) {
            throw new Error("The source file changed. Review again.");
          }
          if (this.renameNamespace().some(entry => portablePathKey(entry.path) === portablePathKey(change.to))
            || await this.app.vault.adapter.exists(change.to)) {
            throw new Error("The destination is now occupied. Review again.");
          }
          abortIfNeeded(signal);
          await this.app.fileManager.renameFile(file, change.to);
          completed++;
        } catch (error) {
          // FileManager may move the file and then fail while updating links.
          if (file?.path === change.to) completed++;
          throw new SyncError("adoption_rename_failed", `Rename stopped after ${completed} of ${plan.renames.length} files. Check filenames and links before retrying. ${error instanceof Error ? error.message : String(error)}`);
        }
        onProgress?.(completed, plan.renames.length);
      }
      return completed;
    });
  }

  async previewAdoption(policy = this.getSelectiveSync(), signal?: AbortSignal): Promise<AdoptionPreview> {
    this.assertActive();
    return (await this.adoptionSources(normalizeSelectiveSync(policy), signal)).preview;
  }

  private async captureAuthoritySnapshot(
    collectionId: string,
    signal?: AbortSignal,
  ): Promise<AuthorityImportSnapshot> {
    const { config, configuration, typeFiles, baseFiles, recordFiles, binaryPaths, preview } = await this.adoptionSources(this.getSelectiveSync(), signal);
    assertAdoptionPaths(preview);
    const resources: Array<{ path: string; kind: "configuration" | "type" | "view"; document: string }> = [
      { path: "mdbase.yaml", kind: "configuration", document: configuration },
    ];
    for (const [kind, entries] of [["type", typeFiles], ["view", baseFiles]] as const) {
      for (const file of entries) {
        abortIfNeeded(signal);
        resources.push({ path: normalizePath(file.path), kind, document: await this.app.vault.cachedRead(file) });
      }
    }
    const records = [];
    for (const file of recordFiles) {
      abortIfNeeded(signal);
      const path = normalizePath(file.path);
      const document = await this.app.vault.cachedRead(file);
      abortIfNeeded(signal);
      records.push({
        path,
        document,
      });
    }
    const files: CollectionFileDescriptor[] = [];
    if (binaryPaths.length) {
      const blobStore = this.adoptionBlobStore(collectionId);
      for (const path of binaryPaths) {
        abortIfNeeded(signal);
        const source = await this.fileSystem.readBinary?.(path);
        abortIfNeeded(signal);
        if (!source) continue;
        const bytes = await collectBinary(source);
        abortIfNeeded(signal);
        const info = await binaryInfo(bytes);
        abortIfNeeded(signal);
        await blobStore.write(info.content_digest, (async function* () { yield new Uint8Array(bytes); })());
        abortIfNeeded(signal);
        const file = this.app.vault.getAbstractFileByPath(path);
        files.push({
          file_id: portableRecordId(collectionId, `file:${path}`),
          path,
          revision: info.content_digest,
          ...info,
          ...(mediaTypeForPath(path) ? { media_type: mediaTypeForPath(path) } : {}),
          media_class: classifyBinaryPath(path),
          modified_at: new Date(file instanceof TFile && file.stat?.mtime ? file.stat.mtime : Date.now()).toISOString(),
        });
      }
    }
    abortIfNeeded(signal);
    return buildPortableAuthoritySnapshot({
      collectionId,
      sourceHead: 0,
      specVersion: config.spec_version,
      resources,
      records,
      files,
    });
  }

  private adoptionBlobStore(collectionId: string): MirrorBlobStore {
    return this.options.adoptionBlobStoreFactory?.(collectionId)
      ?? this.cachedBlobStore(`adoption:${collectionId}`);
  }

  private adoptionUploadOptions(
    session: AuthorityAdoptionSession,
    callbacks: AdoptLocalCollectionCallbacks,
  ) {
    const blobStore = this.adoptionBlobStore(session.requested.collectionId);
    return {
      signal: callbacks.signal,
      fileSource: async (file: CollectionFileDescriptor) => collectBinary(blobStore.read(file.content_digest)),
      onFileProgress: ({ file, transferredBytes, totalBytes }: {
        file: CollectionFileDescriptor;
        transferredBytes: number;
        totalBytes: number;
      }) => callbacks.onFileProgress?.(file.path, transferredBytes, totalBytes),
    };
  }

  private async ensurePortableCollectionIdentity(): Promise<{
    collectionId: string;
    displayName: string;
  }> {
    if (!(await this.app.vault.adapter.exists("mdbase.yaml"))) {
      throw new SyncError("collection_not_initialized", "Initialize an mdbase collection before hosting it.");
    }
    const source = await this.app.vault.adapter.read("mdbase.yaml");
    let parsed: unknown;
    try {
      parsed = parseYaml(source);
    } catch {
      throw new SyncError("invalid_collection_configuration", "mdbase.yaml must contain valid YAML.");
    }
    if (!isRecord(parsed)) {
      throw new SyncError("invalid_collection_configuration", "mdbase.yaml must contain a YAML mapping.");
    }
    const existing = isRecord(parsed["x-mdbase-connect"])
      ? parsed["x-mdbase-connect"].collection_id
      : undefined;
    let collectionId: string;
    if (existing === undefined) {
      collectionId = crypto.randomUUID();
      const extension = isRecord(parsed["x-mdbase-connect"])
        ? parsed["x-mdbase-connect"]
        : {};
      parsed["x-mdbase-connect"] = { ...extension, collection_id: collectionId };
      this.assertActive();
      await this.app.vault.adapter.write("mdbase.yaml", stringifyYaml(parsed));
    } else if (typeof existing === "string" && UUID_PATTERN.test(existing)) {
      collectionId = existing;
    } else {
      throw new SyncError(
        "invalid_collection_configuration",
        "x-mdbase-connect.collection_id must be a UUID string.",
      );
    }
    const displayName = typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : this.app.vault.getName();
    return { collectionId, displayName };
  }

  private stateStoreFor(profile: MirrorProfile): MirrorStateStore {
    this.assertActive();
    if (this.options.stateStoreFactory) return this.options.stateStoreFactory(profile);
    const key = `${profile.collectionId}:${profile.replicaId}`;
    let store = this.stateStores.get(key);
    if (!store) {
      store = new IndexedDbMirrorStateStore(key);
      this.stateStores.set(key, store);
    }
    return store;
  }

  private cachedBlobStore(key: string): IndexedDbMirrorBlobStore {
    this.assertActive();
    let store = this.blobStores.get(key);
    if (!store) {
      store = new IndexedDbMirrorBlobStore(key);
      this.blobStores.set(key, store);
    }
    return store;
  }

  private blobStoreFor(profile: MirrorProfile): MirrorBlobStore {
    return this.options.blobStoreFactory?.(profile)
      ?? this.cachedBlobStore(`${profile.collectionId}:${profile.replicaId}`);
  }

  private async transportFor(
    profile: MirrorProfile,
    signal?: AbortSignal,
    onFileProgress?: (progress: FileTransferProgress) => void,
  ): Promise<SyncTransport<JsonObject>> {
    this.assertActive();
    this.assertThisDevice(profile);
    await this.claimLegacyProfile(profile);
    const accessToken = await this.freshAccessToken(profile);
    this.assertActive();
    const transport = this.options.transportFactory?.(profile, accessToken)
      ?? new ObsidianSyncTransport(profile.syncUrl, this.transportCredentials(profile), connectSend, onFileProgress, signal);
    return abortableSyncTransport(transport, signal);
  }

  private async createMirror(
    onProgress?: (progress: MirrorProgress) => void,
    signal?: AbortSignal,
    onFileProgress?: (progress: FileTransferProgress) => void,
    onReceipt?: (action: MirrorPlanAction, receipt: SyncActionReceipt) => void,
  ): Promise<DirectoryMirror<JsonObject>> {
    const profile = this.requireProfile();
    await this.assertMirror(profile.collectionId);
    const transport = await this.transportFor(profile, signal, onFileProgress);
    const stateStore = this.stateStoreFor(profile);
    const mirrorOptions: DirectoryMirrorOptions = {
      stateStore: onReceipt ? new ReceiptObservingStateStore(stateStore, onReceipt) : stateStore,
      fileSystem: this.fileSystem,
      blobStore: this.blobStoreFor(profile),
      selectiveSync: normalizeSelectiveSync(profile.selectiveSync),
      lease: this.options.leaseFactory?.(profile)
        ?? new DeviceMirrorLease(`${profile.collectionId}:${profile.replicaId}`),
      onProgress,
    };
    return profile.mode === "read_write"
      ? new WritableDirectoryMirror(profile.replicaId, transport, mirrorOptions)
      : new DirectoryMirror(profile.replicaId, transport, mirrorOptions);
  }

  private requireProfile(): MirrorProfile {
    this.assertActive();
    const profile = this.settingsHost.getMirrorProfile();
    if (!profile) throw new SyncError("mirror_not_configured", "This vault is not connected to a collection authority.");
    return profile;
  }

  /**
   * Credentials are keyed by replica: two vaults on one device (a copied vault
   * set up again) must never overwrite each other's tokens. Replica IDs are
   * globally unique, and prefix plus UUID stays within Obsidian's 64-character
   * secret ID limit. Earlier versions keyed them by collection; those are read
   * once and copied forward.
   */
  private secretIds(kind: "access" | "refresh", profile: Pick<MirrorProfile, "collectionId" | "replicaId">): { current: string; legacy: string } {
    const prefix = kind === "access" ? ACCESS_SECRET_PREFIX : REFRESH_SECRET_PREFIX;
    return { current: `${prefix}${profile.replicaId.toLowerCase()}`, legacy: `${prefix}${profile.collectionId.toLowerCase()}` };
  }

  private readSecret(kind: "access" | "refresh", profile: Pick<MirrorProfile, "collectionId" | "replicaId">): string | null {
    const ids = this.secretIds(kind, profile);
    const current = this.app.secretStorage.getSecret(ids.current);
    if (current) return current;
    const legacy = this.app.secretStorage.getSecret(ids.legacy);
    if (!legacy) return null;
    try {
      this.app.secretStorage.setSecret(ids.current, legacy);
    } catch {
      // Reading still works from the legacy entry; the copy is retried next time.
    }
    return legacy;
  }

  private clearCredentials(profile: Pick<MirrorProfile, "collectionId" | "replicaId">): void {
    for (const kind of ["access", "refresh"] as const) {
      const ids = this.secretIds(kind, profile);
      const value = this.app.secretStorage.getSecret(ids.current);
      // The legacy entry is this replica's only when it holds the same credential.
      if (value && this.app.secretStorage.getSecret(ids.legacy) === value) this.app.secretStorage.setSecret(ids.legacy, "");
      this.app.secretStorage.setSecret(ids.current, "");
    }
  }

  private currentDeviceId(): string | undefined {
    return this.settingsHost.deviceId?.();
  }

  /** True when this profile was enrolled by another device or another copy of the vault. */
  isOtherDevice(profile: MirrorProfile | null = this.settingsHost.getMirrorProfile()): boolean {
    const device = this.currentDeviceId();
    return Boolean(profile?.deviceId && device && profile.deviceId !== device);
  }

  /** Profiles enrolled before device ownership was recorded belong to the first device that opens them. */
  private async claimLegacyProfile(profile: MirrorProfile): Promise<void> {
    const device = this.currentDeviceId();
    if (profile.deviceId || !device) return;
    await this.settingsHost.saveMirrorProfile({ ...profile, deviceId: device });
  }

  private assertThisDevice(profile: MirrorProfile): void {
    if (this.isOtherDevice(profile)) {
      throw new SyncError(
        "mirror_other_device",
        "This vault's sync settings were copied from another device or vault. Set up sync here to give this copy its own connection.",
      );
    }
  }

  private adoptionSecretId(adoptionId: string): string {
    return `${ADOPTION_SECRET_PREFIX}${adoptionId.toLowerCase()}`;
  }

  private async storeAdoptionSecret(session: AuthorityAdoptionSession): Promise<void> {
    try {
      const id = this.adoptionSecretId(session.adoptionId);
      this.app.secretStorage.setSecret(id, session.credential);
      if (this.app.secretStorage.getSecret(id) !== session.credential) throw new Error("Secret was not retained");
    } catch {
      throw new SyncError("authority_adoption_credentials_unavailable", "Obsidian could not save this device's authorization. Unlock or repair Obsidian's secret storage before starting the move. Nothing was uploaded.");
    }
  }

  private async persistEnrollment(enrollment: MirrorEnrollment, selectiveSync?: SelectiveSyncPolicy): Promise<void> {
    this.assertActive();
    try {
      const accessId = this.secretIds("access", enrollment).current;
      const refreshId = this.secretIds("refresh", enrollment).current;
      this.app.secretStorage.setSecret(accessId, enrollment.accessToken);
      this.app.secretStorage.setSecret(refreshId, enrollment.refreshCredential);
      if (this.app.secretStorage.getSecret(accessId) !== enrollment.accessToken
        || this.app.secretStorage.getSecret(refreshId) !== enrollment.refreshCredential) throw new Error("Secret was not retained");
    } catch {
      throw new SyncError("mirror_credentials_unavailable", "Obsidian could not save this device's authorization. Unlock or repair Obsidian's secret storage, then reconnect. Your files were not changed.");
    }
    await this.settingsHost.saveMirrorProfile(profileFromEnrollment(
      enrollment,
      selectiveSync ?? this.settingsHost.getMirrorProfile()?.selectiveSync,
      this.currentDeviceId(),
    ));
  }

  private async removeExactMirrorFiles(state: MirrorState, result: DisconnectMirrorResult): Promise<void> {
    const paths = new Map<string, { entity: "document" | "file"; document?: string; revision?: string; digest?: string; size?: number }>();
    for (const [identity, entry] of Object.entries(state.records)) {
      const path = state.local_bindings?.[identity]?.path ?? entry.path;
      paths.set(path, { entity: "document", document: entry.record?.document, revision: entry.revision });
    }
    for (const [identity, entry] of Object.entries(state.resources ?? {})) {
      const path = state.local_bindings?.[identity]?.path ?? entry.path;
      paths.set(path, { entity: "document", document: entry.record?.document, revision: entry.revision });
    }
    for (const [identity, entry] of Object.entries(state.files ?? {})) {
      const path = state.local_bindings?.[identity]?.path ?? entry.file.path;
      paths.set(path, {
        entity: "file",
        digest: entry.file.content_digest,
        size: entry.file.size,
      });
    }
    for (const [path, expected] of [...paths.entries()].sort(([left], [right]) => right.localeCompare(left))) {
      let exact = false;
      if (expected.entity === "document") {
        const current = await this.fileSystem.read(path);
        exact = current !== null && (expected.document !== undefined
          ? current === expected.document
          : await documentHasRevision(current, expected.revision));
      } else if (expected.entity === "file") {
        const current = await this.fileSystem.inspectBinary(path);
        exact = current !== null && current.content_digest === expected.digest && current.size === expected.size;
      }
      if (!exact) {
        if (await this.fileSystem.exists(path)) result.preserved.push(path);
        continue;
      }
      try {
        await this.fileSystem.remove(path);
        result.removed.push(path);
      } catch {
        // A file that Obsidian or the OS cannot remove remains local. The
        // connection is already gone, so it cannot be mistaken for a remote
        // deletion on a later sync.
        result.preserved.push(path);
      }
    }
  }

  private async freshAccessToken(profile: MirrorProfile): Promise<string> {
    if (this.renewal) return this.renewal;
    const current = this.readSecret("access", profile);
    const expiresAt = Date.parse(profile.accessTokenExpiresAt);
    if (current && Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_RENEWAL_WINDOW_MS) {
      return current;
    }
    return this.renewAccessToken(profile);
  }

  private renewal: Promise<string> | null = null;

  /**
   * Connect replaces the access token on every renewal, so two overlapping
   * renewals would leave whichever finished first holding a revoked token.
   * Status checks, syncs and Reconnect all share one renewal in flight.
   */
  private renewAccessToken(profile: MirrorProfile): Promise<string> {
    this.renewal ??= this.renewAccessTokenOnce(profile).finally(() => {
      this.renewal = null;
    });
    return this.renewal;
  }

  private async renewAccessTokenOnce(profile: MirrorProfile): Promise<string> {
    const refreshCredential = this.readSecret("refresh", profile);
    if (!refreshCredential) {
      throw new SyncError("mirror_credentials_missing", "The mirror refresh credential is missing. Approve this vault again.");
    }
    const renewed = await this.enrollmentClient.renew({
      controlUrl: profile.controlUrl,
      syncUrl: profile.syncUrl,
      collectionId: profile.collectionId,
      replicaId: profile.replicaId,
      mode: profile.mode,
      name: profile.name,
      enrollmentId: profile.enrollmentId,
      accessToken: this.readSecret("access", profile) ?? "",
      refreshCredential,
      accessTokenExpiresAt: profile.accessTokenExpiresAt,
    }, { signal: this.lifetime.signal });
    // Renewal may overlap a disconnect or a fresh browser enrollment. Never
    // recreate the retired connection (or replace the new one's credentials).
    const current = this.requireProfile();
    if (current.collectionId !== profile.collectionId || current.replicaId !== profile.replicaId
      || current.enrollmentId !== profile.enrollmentId) {
      throw new SyncError("mirror_identity_conflict", "The connection changed while credentials were renewing. Retry with the current connection.");
    }
    // Settings can change independently while the request is in flight.
    await this.persistEnrollment(renewed, current.selectiveSync);
    return renewed.accessToken;
  }

  private transportCredentials(profile: MirrorProfile): TransportCredentials {
    return {
      token: () => this.freshAccessToken(this.requireProfile()),
      renew: async (rejected) => {
        const stored = this.readSecret("access", profile);
        // Another operation already renewed; use its token instead of rotating again.
        if (stored && stored !== rejected) return stored;
        return this.renewAccessToken(this.requireProfile());
      },
    };
  }

  private async assertCanBecomeMirror(collectionId?: string): Promise<string | undefined> {
    const marker = await this.readMarker();
    const localCollectionId = await this.readPortableCollectionId();
    if (localCollectionId && !marker) {
      throw new SyncError(
        "local_authority_requires_transfer",
        "This vault has a local Connect identity. Transfer authority explicitly before using it as a mirror.",
      );
    }
    if (localCollectionId && marker?.collection_id !== localCollectionId) {
      throw new SyncError(
        "mirror_identity_conflict",
        "The vault identity and mirror role marker identify different collections.",
      );
    }
    const profile = this.settingsHost.getMirrorProfile();
    const expectedCollectionId = profile?.collectionId ?? collectionId;
    if (
      marker
      && expectedCollectionId
      && marker.collection_id !== expectedCollectionId
    ) {
      throw new SyncError(
        "mirror_identity_conflict",
        "This vault is already marked as a different mirror.",
      );
    }
    if (!marker && !profile && await this.app.vault.adapter.exists("mdbase.yaml")) {
      throw new SyncError(
        "existing_collection_requires_transfer",
        "This vault already contains an mdbase collection. Connect an empty vault, or transfer collection authority explicitly.",
      );
    }
    return expectedCollectionId ?? marker?.collection_id;
  }

  private async readPortableCollectionId(): Promise<string | null> {
    if (!(await this.app.vault.adapter.exists("mdbase.yaml"))) return null;
    let parsed: unknown;
    try {
      parsed = parseYaml(await this.app.vault.adapter.read("mdbase.yaml"));
    } catch {
      throw new SyncError(
        "invalid_collection_configuration",
        "mdbase.yaml must contain valid YAML.",
      );
    }
    if (!isRecord(parsed)) {
      throw new SyncError(
        "invalid_collection_configuration",
        "mdbase.yaml must contain a YAML mapping.",
      );
    }
    const extension = parsed["x-mdbase-connect"];
    if (extension === undefined) return null;
    if (!isRecord(extension)) {
      throw new SyncError(
        "invalid_collection_configuration",
        "x-mdbase-connect must be a YAML mapping.",
      );
    }
    const collectionId = extension.collection_id;
    if (collectionId === undefined) return null;
    if (typeof collectionId !== "string" || !UUID_PATTERN.test(collectionId)) {
      throw new SyncError(
        "invalid_collection_configuration",
        "x-mdbase-connect.collection_id must be a UUID string.",
      );
    }
    return collectionId;
  }

  private async markMirror(collectionId: string): Promise<boolean> {
    this.assertActive();
    const marker = await this.readMarker();
    if (marker) {
      if (marker.collection_id !== collectionId) {
        throw new SyncError("mirror_identity_conflict", "This vault already mirrors a different collection authority.");
      }
      return false;
    }
    await ensureFolder(this.app.vault, ".mdbase");
    this.assertActive();
    await this.app.vault.adapter.write(ROLE_MARKER_PATH, `${JSON.stringify({
      version: 1,
      role: "mirror",
      collection_id: collectionId,
    } satisfies MirrorMarker, null, 2)}\n`);
    return true;
  }

  private async assertMirror(collectionId: string): Promise<void> {
    const marker = await this.readMarker();
    if (!marker || marker.collection_id !== collectionId) {
      throw new SyncError(
        "mirror_marker_missing",
        "The vault's mirror role marker is missing or does not match this connection.",
      );
    }
  }

  private async readMarker(): Promise<MirrorMarker | null> {
    if (!(await this.app.vault.adapter.exists(ROLE_MARKER_PATH))) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.app.vault.adapter.read(ROLE_MARKER_PATH));
    } catch {
      throw new SyncError("invalid_mirror_marker", "The mirror role marker is corrupt.");
    }
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || parsed.role !== "mirror"
      || typeof parsed.collection_id !== "string"
      || !UUID_PATTERN.test(parsed.collection_id)
    ) {
      throw new SyncError("invalid_mirror_marker", "The mirror role marker is invalid.");
    }
    return parsed as unknown as MirrorMarker;
  }

  private requireAdoptionMarker(adoptionId: string): AdoptionMarker {
    if (!this.adoptionMarker || this.adoptionMarker.session.adoptionId !== adoptionId) {
      throw new SyncError(
        "authority_adoption_state_conflict",
        "The collection-adoption checkpoint does not match this approval.",
      );
    }
    return this.adoptionMarker;
  }

  private async updateAdoptionPhase(
    phase: AdoptionMarker["phase"],
    snapshot?: AuthorityImportSnapshot,
    expiresAt?: string,
  ): Promise<void> {
    if (!this.adoptionMarker) {
      throw new SyncError("authority_adoption_not_found", "Collection-adoption checkpoint is missing.");
    }
    await this.writeAdoptionMarker({
      ...this.adoptionMarker,
      phase,
      ...(expiresAt ? { session: { ...this.adoptionMarker.session, expiresAt } } : {}),
      ...(snapshot ? {
        manifest_digest: snapshot.manifest_digest,
        source_revision: snapshot.source_revision,
        source_head: snapshot.source_head,
      } : {}),
    });
  }

  private async writeAdoptionMarker(marker: AdoptionMarker): Promise<void> {
    await ensureFolder(this.app.vault, ".mdbase");
    this.assertActive();
    await this.app.vault.adapter.write(
      ADOPTION_MARKER_PATH,
      `${JSON.stringify(marker, null, 2)}\n`,
    );
    this.adoptionMarker = marker;
  }

  private async readAdoptionMarker(): Promise<AdoptionMarker | null> {
    if (!(await this.app.vault.adapter.exists(ADOPTION_MARKER_PATH))) return null;
    let value: unknown;
    try {
      value = JSON.parse(await this.app.vault.adapter.read(ADOPTION_MARKER_PATH));
    } catch {
      throw new SyncError(
        "invalid_authority_adoption_checkpoint",
        "The collection-adoption checkpoint is corrupt.",
      );
    }
    if (!validAdoptionMarker(value)) {
      throw new SyncError(
        "invalid_authority_adoption_checkpoint",
        "The collection-adoption checkpoint is invalid.",
      );
    }
    return value;
  }

  private async writeAdoptionSnapshot(snapshot: AuthorityImportSnapshot): Promise<void> {
    this.assertActive();
    await ensureFolder(this.app.vault, ".mdbase");
    this.assertActive();
    await this.app.vault.adapter.write(
      ADOPTION_SNAPSHOT_PATH,
      JSON.stringify(snapshot),
    );
  }

  private async readAdoptionSnapshot(marker: AdoptionMarker): Promise<AuthorityImportSnapshot> {
    if (!(await this.app.vault.adapter.exists(ADOPTION_SNAPSHOT_PATH))) {
      throw new SyncError(
        "authority_adoption_snapshot_missing",
        "The fenced authority snapshot is missing; hosted activation cannot be resumed safely.",
      );
    }
    let snapshot: AuthorityImportSnapshot;
    try {
      snapshot = JSON.parse(await this.app.vault.adapter.read(ADOPTION_SNAPSHOT_PATH)) as AuthorityImportSnapshot;
    } catch {
      throw new SyncError(
        "invalid_authority_adoption_snapshot",
        "The fenced authority snapshot is corrupt.",
      );
    }
    if (
      snapshot.collection_id !== marker.session.requested.collectionId
      || snapshot.manifest_digest !== marker.manifest_digest
      || snapshot.source_revision !== marker.source_revision
      || snapshot.source_head !== marker.source_head
    ) {
      throw new SyncError(
        "authority_adoption_snapshot_mismatch",
        "The fenced authority snapshot does not match its durable checkpoint.",
      );
    }
    return snapshot;
  }

  private async clearAdoptionCheckpoint(adoptionId: string): Promise<void> {
    const collectionId = this.adoptionMarker?.session.requested.collectionId;
    // Keep the recovery marker until ancillary cleanup succeeds, so a restart
    // can retry cleanup instead of silently forgetting the interrupted transition.
    if (await this.app.vault.adapter.exists(ADOPTION_SNAPSHOT_PATH)) {
      await this.app.vault.adapter.remove(ADOPTION_SNAPSHOT_PATH);
    }
    if (await this.app.vault.adapter.exists(ADOPTION_MARKER_PATH)) {
      await this.app.vault.adapter.remove(ADOPTION_MARKER_PATH);
    }
    this.adoptionMarker = null;
    // Cleanup of a retired credential must not strand a completed/reset move
    // when the secret store itself is unavailable. No secrets go into vault files.
    try {
      this.app.secretStorage.setSecret(this.adoptionSecretId(adoptionId), "");
    } catch {
      // The terminal/expired request cannot be restarted with this credential.
    }
    if (collectionId) {
      await this.adoptionBlobStore(collectionId).prune(new Set()).catch(() => undefined);
    }
  }
}

function publicAdoptionSession(
  session: AuthorityAdoptionSession,
): AuthorityAdoptionVerification {
  const { credential: _credential, ...verification } = session;
  return verification;
}

function isSafelyInactiveAdoption(
  error: unknown,
): error is AuthorityAdoptionError {
  return (
    error instanceof AuthorityAdoptionError &&
    ["authority_adoption_expired", "authority_adoption_cancelled"].includes(
      error.code,
    )
  );
}

function configuredBasePatterns(configuration: unknown): string[] {
  if (!isRecord(configuration)) return [];
  const obsidian = configuration["x-obsidian"];
  if (!isRecord(obsidian) || !isRecord(obsidian.bases) || !Array.isArray(obsidian.bases.include)) {
    return [];
  }
  return obsidian.bases.include.filter((value): value is string => typeof value === "string");
}

function listFiles(vault: Vault): TFile[] {
  const files = (vault as Vault & { getFiles?: () => TFile[] }).getFiles?.();
  if (files) return files;
  const result: TFile[] = [];
  const visit = (folder: TFolder): void => {
    for (const child of folder.children) {
      if (child instanceof TFile) result.push(child);
      else if (child instanceof TFolder) visit(child);
    }
  };
  visit(vault.getRoot());
  return result;
}

function validAdoptionMarker(value: unknown): value is AdoptionMarker {
  if (
    !isRecord(value)
    || value.version !== 1
    || !["waiting_for_approval", "uploading", "fenced", "activating", "adopted"].includes(String(value.phase))
    || !isRecord(value.session)
  ) return false;
  const session = value.session;
  return typeof session.controlUrl === "string"
    && typeof session.adoptionId === "string"
    && UUID_PATTERN.test(session.adoptionId)
    && typeof session.verificationUri === "string"
    && typeof session.expiresAt === "string"
    && isRecord(session.requested)
    && typeof session.requested.collectionId === "string"
    && UUID_PATTERN.test(session.requested.collectionId)
    && typeof session.requested.displayName === "string"
    && typeof session.requested.sourceName === "string"
    && session.requested.retainMirror === true
    && (value.selective_sync === undefined || validSelectiveSync(value.selective_sync))
    && (value.manifest_digest === null || typeof value.manifest_digest === "string")
    && (value.source_revision === null || typeof value.source_revision === "string")
    && (value.source_head === null || Number.isSafeInteger(value.source_head));
}

function validSelectiveSync(value: unknown): value is SelectiveSyncPolicy {
  if (!isRecord(value) || !Array.isArray(value.file_classes) || !Array.isArray(value.excluded_folders)) return false;
  try {
    const normalized = normalizeSelectiveSync(value);
    return normalized.file_classes.length === value.file_classes.length
      && normalized.excluded_folders.length === value.excluded_folders.length;
  } catch {
    return false;
  }
}

function profileFromEnrollment(
  enrollment: MirrorEnrollment,
  selectiveSync?: SelectiveSyncPolicy,
  deviceId?: string,
): MirrorProfile {
  return {
    version: 1,
    syncUrl: enrollment.syncUrl,
    controlUrl: enrollment.controlUrl,
    collectionId: enrollment.collectionId,
    replicaId: enrollment.replicaId,
    mode: enrollment.mode,
    name: enrollment.name,
    enrollmentId: enrollment.enrollmentId,
    accessTokenExpiresAt: enrollment.accessTokenExpiresAt,
    selectiveSync: normalizeSelectiveSync(selectiveSync),
    ...(deviceId ? { deviceId } : {}),
  };
}

async function documentHasRevision(document: string, revision?: string): Promise<boolean> {
  if (!revision?.startsWith("sha256:")) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(document)));
  const actual = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return actual === revision;
}
