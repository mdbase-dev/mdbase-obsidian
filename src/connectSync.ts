import {
  App,
  normalizePath,
  parseYaml,
  requestUrl,
  type RequestUrlParam,
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

export interface DisconnectMirrorResult {
  removed: string[];
  preserved: string[];
}

export interface AdoptLocalCollectionInput {
  controlUrl: string;
  mirrorName: string;
  selectiveSync?: SelectiveSyncPolicy;
}

export interface AdoptLocalCollectionCallbacks {
  onVerification(
    verification: AuthorityAdoptionVerification | MirrorEnrollmentVerification,
  ): void | Promise<void>;
  onStatus?(status: AuthorityAdoptionStatus): void;
  onFileProgress?(path: string, transferredBytes: number, totalBytes: number): void;
  signal?: AbortSignal;
}

export interface ConnectSyncSettingsHost {
  getMirrorProfile(): MirrorProfile | null;
  saveMirrorProfile(profile: MirrorProfile | null): Promise<void>;
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

function binaryPathSelected(policy: SelectiveSyncPolicy, path: string, mediaClass = classifyBinaryPath(path)): boolean {
  if (!policy.file_classes.includes(mediaClass)) return false;
  const normalized = normalizePath(path);
  return !policy.excluded_folders.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}

function assertVisibleBinaryPath(input: string, folder = false): string {
  const path = normalizeSafeRelativePath(input);
  const components = path.split("/");
  if (
    path.length > 1024
    || (!folder && /\.md$/i.test(path))
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

function retryAfterMilliseconds(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Obsidian desktop 1.13.7 can either fail its request bridge with
 * net::ERR_FAILED or attach a browser Origin that correctly invalidates mirror
 * credentials. Electron's main-process network stack is the privileged desktop
 * transport; requestUrl remains the mobile transport and web fetch is its
 * last-resort fallback.
 */
export async function resilientRequestUrl(
  request: RequestUrlParam,
  primary: (request: RequestUrlParam | string) => Promise<RequestUrlResponse> = (input) => requestUrl(input),
  fallback: typeof window.fetch = (input, init) => window.fetch(input, init),
  desktop: typeof window.fetch | null = privilegedDesktopFetch(),
): Promise<RequestUrlResponse> {
  if (desktop) {
    try {
      return await fetchRequestUrl(request, desktop);
    } catch {
      // Continue through Obsidian's cross-platform bridge below.
    }
  }
  try {
    return await primary(request);
  } catch (primaryError) {
    try {
      return await fetchRequestUrl(request, fallback);
    } catch {
      throw primaryError;
    }
  }
}

function privilegedDesktopFetch(): typeof window.fetch | null {
  try {
    if (typeof require !== "function") return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron is desktop-only and a static import breaks Obsidian mobile.
    const remoteNet = (require("electron") as {
      remote?: { net?: { fetch?: typeof window.fetch } };
    }).remote?.net;
    return remoteNet?.fetch ? remoteNet.fetch.bind(remoteNet) : null;
  } catch {
    return null;
  }
}

async function fetchRequestUrl(
  request: RequestUrlParam,
  send: typeof window.fetch,
): Promise<RequestUrlResponse> {
  const headers = new Headers(request.headers);
  if (request.contentType && !headers.has("content-type")) headers.set("content-type", request.contentType);
  const response = await send(request.url, {
    method: request.method,
    headers,
    body: request.body,
  });
  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  let json: unknown = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (request.throw !== false && response.status >= 400) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  return {
    status: response.status,
    headers: responseHeaders,
    arrayBuffer,
    json,
    text,
  };
}

export function createObsidianEnrollmentRequester(): MirrorEnrollmentRequester {
  return async (request) => {
    if (request.signal?.aborted) throw new DOMException("Enrollment cancelled.", "AbortError");
    const response = await resilientRequestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      contentType: request.body === undefined ? undefined : "application/json",
      throw: false,
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
    const response = await resilientRequestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
      contentType: body === undefined || request.rawBody ? undefined : "application/json",
      throw: false,
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
 * Sync transport backed by Obsidian's requestUrl. This keeps the portable SDK
 * usable on mobile and avoids browser CORS restrictions without importing the
 * SDK's Node entry point.
 */
export class ObsidianSyncTransport<Frontmatter extends JsonObject = JsonObject>
implements SyncTransport<Frontmatter> {
  private readonly syncUrl: string;
  private readonly filesUrl: string;

  constructor(
    syncUrl: string,
    private readonly accessToken: string,
    private readonly send: (request: RequestUrlParam) => Promise<RequestUrlResponse> = resilientRequestUrl,
    private readonly onFileProgress?: (progress: FileTransferProgress) => void,
  ) {
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
        const response = await this.send({
          url: `${this.filesUrl}/downloads/${encodeURIComponent(transferId)}/parts/${partIndex}`,
          method: "GET",
          headers: { authorization: `Bearer ${this.accessToken}` },
          throw: false,
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
      });
      if (response.status < 200 || response.status >= 300) {
        throw new SyncError("file_upload_failed", `Object storage returned HTTP ${response.status}.`);
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
    const response = await this.send({
      url: `${baseUrl}/${path}`,
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
      },
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

  private responseError(
    response: { status: number; text: string; json: unknown },
    fallbackCode: string,
  ): SyncError {
    const value = parseJsonResponse(response.text, response.json);
    const error = isRecord(value) && isRecord(value.error) ? value.error : {};
    return new SyncError(
      typeof error.code === "string" ? error.code : fallbackCode,
      typeof error.message === "string" ? error.message : `Sync request failed (${response.status}).`,
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
    for await (const chunk of source) {
      abortIfNeeded(signal);
      yield chunk;
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
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        kind: "invalid",
        code: "invalid_utf8",
        reason: "File is not valid UTF-8.",
        revision: (await binaryInfo(bytes)).content_digest,
      };
    }
  }

  async write(input: string, value: string): Promise<void> {
    const path = safeMirrorPath(this.vault, input);
    const slash = path.lastIndexOf("/");
    if (slash >= 0) await ensureFolder(this.vault, path.slice(0, slash));
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      throw new SyncError("mirror_path_collision", `A folder blocks the mirror file ${path}.`);
    }
    this.assertActive();
    if (existing instanceof TFile) {
      await this.vault.modify(existing, value);
    } else {
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
    await this.trashFile(existing);
  }

  async listMarkdown(excluded: ReadonlySet<string>): Promise<string[]> {
    return this.vault
      .getMarkdownFiles()
      .map((file) => normalizePath(file.path))
      .filter((path) => !excluded.has(path))
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

  async writeBinary(input: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const path = assertVisibleBinaryPath(input);
    const bytes = await collectBinary(source);
    const slash = path.lastIndexOf("/");
    if (slash >= 0) await ensureFolder(this.vault, path.slice(0, slash));
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new SyncError("mirror_path_collision", `A folder blocks the mirror file ${path}.`);
    this.assertActive();
    if (existing instanceof TFile) await this.vault.modifyBinary(existing, bytes);
    else await this.vault.createBinary(path, bytes);
  }

  async listBinary(excluded: ReadonlySet<string>): Promise<string[]> {
    return listFiles(this.vault)
      .map((file) => normalizePath(file.path))
      .filter((path) => !/\.md$/i.test(path) && !excluded.has(path))
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

  constructor(
    private readonly app: App,
    private readonly settingsHost: ConnectSyncSettingsHost,
    private readonly options: ConnectSyncControllerOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? new ObsidianMirrorFileSystem(
      app.vault,
      (file) => app.fileManager.trashFile(file),
      () => this.assertActive(),
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
    return this.withLifetime(callbacks.signal, (signal) => this.adoptLocalCollectionActive(input, { ...callbacks, signal }));
  }

  private async adoptLocalCollectionActive(
    input: AdoptLocalCollectionInput,
    callbacks: AdoptLocalCollectionCallbacks,
  ): Promise<MirrorProfile> {
    if (this.settingsHost.getMirrorProfile()) {
      throw new SyncError("mirror_already_configured", "This vault already mirrors a collection authority.");
    }
    if (this.adoptionMarker) return this.resumeAdoption(callbacks);
    const collection = await this.ensurePortableCollectionIdentity();
    const session = await this.adoptionClient.begin({
      controlUrl: input.controlUrl,
      collectionId: collection.collectionId,
      displayName: collection.displayName,
      sourceName: input.mirrorName,
      retainMirror: true,
      mirrorName: input.mirrorName,
    }, callbacks);
    await this.storeAdoptionSecret(session);
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
    return this.withLifetime(callbacks.signal, (signal) => this.runAdoptionWithRecovery(session, {
      ...callbacks,
      signal,
      onVerification: (verification) => callbacks.onVerification?.(verification),
    }));
  }

  async cancelAdoption(signal?: AbortSignal): Promise<void> {
    return this.withLifetime(signal, (activeSignal) => this.cancelAdoptionActive(activeSignal));
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

  async reconnect(): Promise<MirrorStatus> {
    const profile = this.requireProfile();
    const refreshCredential = this.app.secretStorage.getSecret(this.refreshSecretId(profile.collectionId));
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
      accessToken: this.app.secretStorage.getSecret(this.accessSecretId(profile.collectionId)) ?? "",
      refreshCredential,
      accessTokenExpiresAt: profile.accessTokenExpiresAt,
    });
    await this.persistEnrollment(renewed, profile.selectiveSync);
    const status = await this.status();
    if (!status) throw new SyncError("mirror_not_configured", "The renewed mirror profile could not be loaded.");
    return status;
  }

  async reauthorize(callbacks: EnrollMirrorCallbacks): Promise<MirrorStatus> {
    return this.withLifetime(callbacks.signal, (signal) => this.reauthorizeActive({ ...callbacks, signal }));
  }

  private async reauthorizeActive(callbacks: EnrollMirrorCallbacks): Promise<MirrorStatus> {
    const profile = this.requireProfile();
    const oldStore = this.stateStoreFor(profile);
    const oldState = await oldStore.read();
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
    if (enrollment.replicaId !== profile.replicaId && "clear" in oldStore && typeof oldStore.clear === "function") {
      await oldStore.clear();
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

  async preserveConflictCopy(pathInput: string): Promise<string> {
    const path = safeMirrorPath(this.app.vault, pathInput);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) throw new SyncError("mirror_conflict_copy_missing", `No local file exists at ${path}.`);
    const extension = existing.extension ? `.${existing.extension}` : "";
    const base = extension ? path.slice(0, -extension.length) : path;
    let target = `${base} (local conflict copy)${extension}`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(target) || await this.app.vault.adapter.exists(target)) {
      target = `${base} (local conflict copy ${suffix})${extension}`;
      suffix += 1;
    }
    await this.app.vault.adapter.copy(path, target);
    return target;
  }

  async disconnect(removeSyncedFiles: boolean): Promise<DisconnectMirrorResult> {
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
    this.app.secretStorage.setSecret(this.accessSecretId(profile.collectionId), "");
    this.app.secretStorage.setSecret(this.refreshSecretId(profile.collectionId), "");
    if ("clear" in stateStore && typeof stateStore.clear === "function") await stateStore.clear();
    await this.blobStoreFor(profile).prune(new Set());
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
        });
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
          await this.adoptionClient.uploadSnapshot(session, exchanged, snapshot, this.adoptionUploadOptions(session, callbacks));
        }
        await this.updateAdoptionPhase("activating", snapshot);
        completed = await this.adoptionClient.complete(session, snapshot, callbacks);
      }
    } else {
      const prepared = marker.phase === "waiting_for_approval"
        ? await this.adoptionClient.waitForApproval(session, callbacks)
        : await this.requirePreparedAdoption(session, callbacks);
      const warmSnapshot = await this.captureAuthoritySnapshot(session.requested.collectionId, callbacks.signal);
      await this.updateAdoptionPhase("uploading");
      await this.adoptionClient.uploadSnapshot(session, prepared, warmSnapshot, this.adoptionUploadOptions(session, callbacks));

      // From this point local plugin writes are stopped. Any external file edit is
      // a pending mirror write, not part of the authority snapshot being activated.
      const finalSnapshot = await this.captureAuthoritySnapshot(session.requested.collectionId, callbacks.signal);
      await this.writeAdoptionSnapshot(finalSnapshot);
      await this.updateAdoptionPhase("fenced", finalSnapshot);
      const finalPrepared = await this.requirePreparedAdoption(session, callbacks);
      await this.adoptionClient.uploadSnapshot(session, finalPrepared, finalSnapshot, this.adoptionUploadOptions(session, callbacks));
      await this.updateAdoptionPhase("activating", finalSnapshot);
      completed = await this.adoptionClient.complete(session, finalSnapshot, callbacks);
    }

    await this.updateAdoptionPhase("adopted");
    return this.finishRetainedMirror(session, completed, callbacks);
  }

  private async runAdoptionWithRecovery(
    session: AuthorityAdoptionSession,
    callbacks: AdoptLocalCollectionCallbacks,
  ): Promise<MirrorProfile> {
    try {
      return await this.runAdoption(session, callbacks);
    } catch (error) {
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

  private async captureAuthoritySnapshot(
    collectionId: string,
    signal?: AbortSignal,
  ): Promise<AuthorityImportSnapshot> {
    abortIfNeeded(signal);
    const config = await loadMdbaseConfig(this.app.vault);
    abortIfNeeded(signal);
    if (!config) {
      throw new SyncError("invalid_collection_configuration", "A valid mdbase.yaml is required.");
    }
    const configuration = await this.app.vault.adapter.read("mdbase.yaml");
    abortIfNeeded(signal);
    const rawConfiguration = parseYaml(configuration);
    const resources: Array<{ path: string; kind: "configuration" | "type" | "view"; document: string }> = [{
      path: "mdbase.yaml",
      kind: "configuration",
      document: configuration,
    }];
    const typesPrefix = `${normalizePath(config.settings.types_folder)}/`;
    const typeFiles = this.app.vault.getMarkdownFiles()
      .filter((file) => normalizePath(file.path).startsWith(typesPrefix))
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const typeFile of typeFiles) {
      abortIfNeeded(signal);
      resources.push({
        path: normalizePath(typeFile.path),
        kind: "type",
        document: await this.app.vault.cachedRead(typeFile),
      });
      abortIfNeeded(signal);
    }
    const viewPatterns = configuredBasePatterns(rawConfiguration);
    if (viewPatterns.length) {
      const matches = viewPatterns.map((pattern) => picomatch(pattern, { dot: true }));
      const baseFiles = listFiles(this.app.vault)
        .filter((file) => file.extension === "base")
        .filter((file) => matches.some((match) => match(normalizePath(file.path))))
        .sort((left, right) => left.path.localeCompare(right.path));
      for (const file of baseFiles) {
        abortIfNeeded(signal);
        resources.push({
          path: normalizePath(file.path),
          kind: "view",
          document: await this.app.vault.cachedRead(file),
        });
        abortIfNeeded(signal);
      }
    }
    const records = [];
    for (const file of this.app.vault.getMarkdownFiles().sort((left, right) => left.path.localeCompare(right.path))) {
      abortIfNeeded(signal);
      const path = normalizePath(file.path);
      if (isExcluded(path, config)) continue;
      const document = await this.app.vault.cachedRead(file);
      abortIfNeeded(signal);
      records.push({
        path,
        document,
      });
    }
    const files: CollectionFileDescriptor[] = [];
    const policy = normalizeSelectiveSync(this.adoptionMarker?.selective_sync);
    if (policy.file_classes.length) {
      const blobStore = this.adoptionBlobStore(collectionId);
      const binaryPaths = (await this.fileSystem.listBinary?.(new Set(resources.map((resource) => resource.path))) ?? [])
        .filter((path) => binaryPathSelected(policy, path))
        .filter((path) => !isExcluded(path, config));
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
    const accessToken = await this.freshAccessToken(profile);
    this.assertActive();
    const transport = this.options.transportFactory?.(profile, accessToken)
      ?? new ObsidianSyncTransport(profile.syncUrl, accessToken, resilientRequestUrl, onFileProgress);
    return abortableSyncTransport(transport, signal);
  }

  private async createMirror(
    onProgress?: (progress: MirrorProgress) => void,
    signal?: AbortSignal,
    onFileProgress?: (progress: FileTransferProgress) => void,
  ): Promise<DirectoryMirror<JsonObject>> {
    const profile = this.requireProfile();
    await this.assertMirror(profile.collectionId);
    const transport = await this.transportFor(profile, signal, onFileProgress);
    const mirrorOptions: DirectoryMirrorOptions = {
      stateStore: this.stateStoreFor(profile),
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

  private accessSecretId(collectionId: string): string {
    return `${ACCESS_SECRET_PREFIX}${collectionId.toLowerCase()}`;
  }

  private refreshSecretId(collectionId: string): string {
    return `${REFRESH_SECRET_PREFIX}${collectionId.toLowerCase()}`;
  }

  private adoptionSecretId(adoptionId: string): string {
    return `${ADOPTION_SECRET_PREFIX}${adoptionId.toLowerCase()}`;
  }

  private async storeAdoptionSecret(session: AuthorityAdoptionSession): Promise<void> {
    this.app.secretStorage.setSecret(this.adoptionSecretId(session.adoptionId), session.credential);
  }

  private async persistEnrollment(enrollment: MirrorEnrollment, selectiveSync?: SelectiveSyncPolicy): Promise<void> {
    this.assertActive();
    this.app.secretStorage.setSecret(this.accessSecretId(enrollment.collectionId), enrollment.accessToken);
    this.app.secretStorage.setSecret(this.refreshSecretId(enrollment.collectionId), enrollment.refreshCredential);
    await this.settingsHost.saveMirrorProfile(profileFromEnrollment(
      enrollment,
      selectiveSync ?? this.settingsHost.getMirrorProfile()?.selectiveSync,
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
    const accessSecretId = this.accessSecretId(profile.collectionId);
    const current = this.app.secretStorage.getSecret(accessSecretId);
    const expiresAt = Date.parse(profile.accessTokenExpiresAt);
    if (current && Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_RENEWAL_WINDOW_MS) {
      return current;
    }
    const refreshCredential = this.app.secretStorage.getSecret(this.refreshSecretId(profile.collectionId));
    if (!refreshCredential) {
      throw new SyncError("mirror_credentials_missing", "The mirror refresh credential is missing. Re-enroll this vault.");
    }
    const renewed = await this.enrollmentClient.renew({
      controlUrl: profile.controlUrl,
      syncUrl: profile.syncUrl,
      collectionId: profile.collectionId,
      replicaId: profile.replicaId,
      mode: profile.mode,
      name: profile.name,
      enrollmentId: profile.enrollmentId,
      accessToken: current ?? "",
      refreshCredential,
      accessTokenExpiresAt: profile.accessTokenExpiresAt,
    });
    await this.persistEnrollment(renewed, profile.selectiveSync);
    return renewed.accessToken;
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
  ): Promise<void> {
    if (!this.adoptionMarker) {
      throw new SyncError("authority_adoption_not_found", "Collection-adoption checkpoint is missing.");
    }
    await this.writeAdoptionMarker({
      ...this.adoptionMarker,
      phase,
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
    // Obsidian currently has no SecretStorage delete API. Emptying the value
    // makes the one-time adoption credential unusable without writing it to disk.
    this.app.secretStorage.setSecret(this.adoptionSecretId(adoptionId), "");
    this.adoptionMarker = null;
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
  };
}

async function documentHasRevision(document: string, revision?: string): Promise<boolean> {
  if (!revision?.startsWith("sha256:")) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(document)));
  const actual = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return actual === revision;
}
