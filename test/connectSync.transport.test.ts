import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { CollectionFileDescriptor, SyncMutation } from "@mdbase-dev/connect-protocol";
import { MemoryAuthority } from "@mdbase-dev/connect-sync";
import { ObsidianSyncTransport } from "../src/connectSync";
import {
  abortableSleep,
  fetchSend,
  HttpStatusError,
  isTransientError,
  NetworkError,
  platformSend,
  reliableSend,
  requestUrlSend,
} from "../src/syncHttp";

const authorityId = "11111111-1111-4111-8111-111111111111";
const syncUrl = `https://connect.example/v1/authorities/${authorityId}/sync`;

function response(status: number, json: unknown = {}, bytes = new ArrayBuffer(0), headers: Record<string, string> = {}) {
  return { status, json, text: JSON.stringify(json), arrayBuffer: bytes, headers };
}

function descriptor(path: string, bytes: Uint8Array): CollectionFileDescriptor {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    path,
    revision: `file:${digest}`,
    content_digest: `sha256:${digest}`,
    size: bytes.byteLength,
    media_class: "image",
    media_type: "image/png",
    modified_at: "2026-08-05T00:00:00.000Z",
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: number[] = [];
  for await (const chunk of source) parts.push(...chunk);
  return Uint8Array.from(parts);
}

const noSleep = { attempts: 4, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined, random: () => 0 };

test("platform send uses the privileged desktop stack with that stack's own abort signals", async () => {
  let desktopCalls = 0;
  // Electron's remote net.fetch rejects renderer AbortSignals; the signal must
  // come from the stack's (main-process) AbortController.
  class StackAbortController extends AbortController {}
  const stackSignals = new WeakSet<AbortSignal>();
  class TrackingController extends StackAbortController {
    constructor() {
      super();
      stackSignals.add(this.signal);
    }
  }
  const send = platformSend({
    AbortController: TrackingController,
    headers: (headers) => Object.fromEntries(headers),
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      desktopCalls += 1;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer device-secret");
      assert.ok(init?.signal && stackSignals.has(init.signal), "the signal comes from the stack's controller");
      assert.equal(Object.getPrototypeOf(init?.headers), Object.prototype, "headers cross the bridge as a plain object");
      return new Response(JSON.stringify({ protocol_version: 1 }), { status: 200 });
    },
  });
  const result = await send({
    url: `${syncUrl}/sessions`,
    method: "POST",
    headers: { authorization: "Bearer device-secret" },
    throw: false,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { protocol_version: 1 });
  assert.equal(desktopCalls, 1);
});

test("desktop response headers are serialized in their owning process before returning", async () => {
  // Electron remote callbacks and iterators do not synchronously enumerate in
  // the renderer. In particular, missing ETag breaks every multipart upload.
  const remoteHeaders = {
    forEach: (callback: (value: string, name: string) => void) => {
      setTimeout(() => callback('"part-etag"', "etag"), 0);
    },
    [Symbol.iterator]: function* () {},
  };
  const send = platformSend({
    AbortController,
    fetch: async () => ({
      status: 200,
      headers: remoteHeaders,
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as unknown as Response,
    headers: (headers: Headers) => {
      assert.equal(headers, remoteHeaders);
      return { etag: '"part-etag"', "retry-after": "7", "content-length": "0" };
    },
  });
  const result = await send({ url: "https://objects.example/part", method: "PUT", throw: false });
  assert.deepEqual(result.headers, { etag: '"part-etag"', "retry-after": "7", "content-length": "0" });
});

test("a desktop request that never answers times out instead of hanging sync", async () => {
  const hung = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  await assert.rejects(
    fetchSend({ url: "https://connect.example/probe", timeoutMs: 5, throw: false }, hung as typeof fetch),
    (error: unknown) => error instanceof NetworkError && error.code === "network_timeout",
  );
});

test("a mobile request that never answers is abandoned at its deadline", async () => {
  await assert.rejects(
    requestUrlSend({ url: "https://connect.example/probe", timeoutMs: 5, throw: false }, () => new Promise(() => undefined)),
    (error: unknown) => error instanceof NetworkError && error.code === "network_timeout",
  );
});

test("a mobile response queued during suspension cannot bypass its expired deadline", async () => {
  const now = Date.now;
  let time = 0;
  Date.now = () => time;
  let finish!: (value: ReturnType<typeof response>) => void;
  const native = new Promise<ReturnType<typeof response>>((resolve) => { finish = resolve; });
  try {
    const pending = requestUrlSend({ url: "https://connect.example/probe", timeoutMs: 30_000, throw: false }, () => native);
    // Simulate an hour of JS suspension: wall time advances, but neither timeout
    // callback nor response continuation has been allowed to run yet.
    time += 60 * 60_000;
    finish(response(200));
    await assert.rejects(pending, (error: unknown) => error instanceof NetworkError && error.code === "network_timeout");
  } finally {
    Date.now = now;
  }
});

test("fetch also checks elapsed deadline when a queued response beats the resumed timer", async () => {
  const now = Date.now;
  let time = 0;
  Date.now = () => time;
  try {
    await assert.rejects(fetchSend({ url: "https://connect.example/probe", timeoutMs: 30_000 }, async () => {
      time += 60 * 60_000;
      return new Response("{}", { status: 200 });
    }), (error: unknown) => error instanceof NetworkError && error.code === "network_timeout");
  } finally {
    Date.now = now;
  }
});

test("cancelling sync aborts the request in flight, not after it", async () => {
  const abort = new AbortController();
  const hung = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const pending = fetchSend({ url: "https://connect.example/probe", signal: abort.signal, throw: false }, hung as typeof fetch);
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

test("an abandoned mobile mutation arriving after its retry has one authority effect", async () => {
  const hosted = new MemoryAuthority({ id: authorityId });
  const replicaId = hosted.registerReplica({ name: "Mobile simulation", mode: "read_write" });
  const authority = hosted.transport(replicaId);
  const bodies: string[] = [];
  let deliverLate!: () => Promise<void>;
  const native = async (request: { body?: string | ArrayBuffer }) => {
    bodies.push(String(request.body));
    const mutation = JSON.parse(String(request.body)) as SyncMutation;
    if (bodies.length === 1) return new Promise<ReturnType<typeof response>>((resolve) => {
      deliverLate = async () => { resolve(response(200, await authority.mutate(mutation))); };
    });
    return response(200, await authority.mutate(mutation));
  };
  const send = reliableSend((request) => requestUrlSend({ ...request, timeoutMs: bodies.length === 0 ? 5 : 30_000 }, native),
    { ...noSleep, attempts: 2 });
  const transport = new ObsidianSyncTransport(syncUrl, "test-token", send);
  const receipt = await transport.mutate({ mutation_id: crypto.randomUUID(), replica_id: replicaId, scope_epoch: 1,
    record_id: crypto.randomUUID(), created_at: "2026-10-01T00:00:00.000Z", operation: "put", path: "mobile.md", document: "exact mobile edit\n" });
  assert.equal(receipt.status, "applied");
  await deliverLate();
  await Promise.resolve();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], "retry preserves the mutation ID and exact document");
  assert.equal(hosted.serialize().head, 1, "late native request does not apply a second write");
  assert.equal(hosted.serialize().records[0]?.document, "exact mobile edit\n");
  assert.equal(receipt.status, "applied", "the late receipt cannot replace the accepted retry receipt");
});

test("an aborted mobile request ignores its eventual native response", async () => {
  const abort = new AbortController();
  let finish!: (value: ReturnType<typeof response>) => void;
  const native = new Promise<ReturnType<typeof response>>((resolve) => { finish = resolve; });
  const pending = requestUrlSend({ url: "https://connect.example/probe", signal: abort.signal }, () => native);
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  finish(response(200));
  await Promise.resolve();
});

test("transient failures retry with backoff; client errors do not", async () => {
  const statuses = [503, 502, 200];
  let calls = 0;
  const send = reliableSend(async () => response(statuses[calls++]) as never, noSleep);
  assert.equal((await send({ url: "https://connect.example/x", throw: false })).status, 200);
  assert.equal(calls, 3);

  calls = 0;
  const unreachable = reliableSend(async () => {
    calls += 1;
    if (calls < 3) throw new NetworkError("network_unreachable", "offline");
    return response(200) as never;
  }, noSleep);
  assert.equal((await unreachable({ url: "https://connect.example/x", throw: false })).status, 200);

  calls = 0;
  const rejected = reliableSend(async () => {
    calls += 1;
    return response(409, { error: { code: "conflict" } }) as never;
  }, noSleep);
  assert.equal((await rejected({ url: "https://connect.example/x", throw: false })).status, 409);
  assert.equal(calls, 1);

  calls = 0;
  const down = reliableSend(async () => {
    calls += 1;
    return response(503) as never;
  }, noSleep);
  assert.equal((await down({ url: "https://connect.example/x", throw: false })).status, 503, "the last response is returned after the final attempt");
  assert.equal(calls, 4);
});

test("retries honour Retry-After and stop when sync is cancelled", async () => {
  const delays: number[] = [];
  let calls = 0;
  const send = reliableSend(async () => (calls++ === 0 ? response(429, {}, new ArrayBuffer(0), { "Retry-After": "7" }) : response(200)) as never, {
    ...noSleep,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  });
  await send({ url: "https://connect.example/x", throw: false });
  assert.deepEqual(delays, [7_000]);

  const abort = new AbortController();
  const cancelled = reliableSend(async () => {
    abort.abort();
    return response(503) as never;
  }, { ...noSleep, sleep: abortableSleep });
  await assert.rejects(cancelled({ url: "https://connect.example/x", signal: abort.signal, throw: false }));
});

test("a rejected access token is renewed once and the request repeated", async () => {
  const tokens: string[] = [];
  let renewals = 0;
  const send = async (request: { headers?: Record<string, string> }) => {
    tokens.push(request.headers?.authorization ?? "");
    return request.headers?.authorization === "Bearer fresh"
      ? response(200, { protocol_version: 1, snapshot_id: "s" })
      : response(401, { error: { code: "invalid_token" } });
  };
  const transport = new ObsidianSyncTransport(syncUrl, {
    token: async () => "stale",
    renew: async (rejected) => {
      renewals += 1;
      assert.equal(rejected, "stale");
      return "fresh";
    },
  }, send as never);
  await transport.openSession();
  assert.deepEqual(tokens, ["Bearer stale", "Bearer fresh"]);
  assert.equal(renewals, 1);

  const refused = new ObsidianSyncTransport(syncUrl, { token: async () => "a", renew: async () => "b" }, (async () =>
    response(401, {})) as never);
  await assert.rejects(refused.openSession(), (error: unknown) =>
    error instanceof HttpStatusError && error.code === "mirror_access_rejected" && error.status === 401);
});

test("server errors are classified as transient, with their HTTP status", async () => {
  const transport = new ObsidianSyncTransport(syncUrl, "t", (async () => response(503, {})) as never);
  await assert.rejects(transport.openSession(), (error: unknown) =>
    error instanceof HttpStatusError && error.code === "authority_unavailable" && isTransientError(error));
});

test("Obsidian HTTP transport downloads bounded binary parts and cleans up the transfer", async () => {
  const bytes = Uint8Array.of(0, 1, 2, 3, 254, 255);
  const file = descriptor("Media/download.png", bytes);
  let transferId = "";
  let cleaned = false;
  const progress: Array<{ transferredBytes: number; totalBytes: number; path: string }> = [];
  const send = async (request: { url: string; method?: string; body?: string | ArrayBuffer; headers?: Record<string, string> }) => {
    if (request.url.endsWith("/files/downloads")) {
      transferId = JSON.parse(String(request.body)).transfer_id as string;
      return response(200, {
        protocol_version: 1,
        type: "file_transfer",
        transfer_id: transferId,
        direction: "download",
        protection: "transport_tls",
        strategy: { kind: "object_ranges", part_size: 4 },
        total_size: bytes.byteLength,
        expires_at: "2026-08-05T01:00:00.000Z",
        received: [],
      });
    }
    if (request.url.endsWith(`/downloads/${transferId}/parts/0`)) {
      return response(200, undefined, bytes.slice(0, 4).buffer, { "Content-Length": "4" });
    }
    if (request.url.endsWith(`/downloads/${transferId}/parts/1`)) {
      return response(200, undefined, bytes.slice(4).buffer, { "content-length": "2" });
    }
    if (request.url.endsWith(`/transfers/${transferId}`) && request.method === "DELETE") {
      cleaned = true;
      return response(204);
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  const transport = new ObsidianSyncTransport(syncUrl, "secret-token", send as never, (event) => progress.push(event));
  assert.deepEqual(await collect(transport.downloadFile(file)), bytes);
  assert.equal(cleaned, true);
  assert.deepEqual(progress.map(({ transferredBytes, totalBytes, path }) => ({ transferredBytes, totalBytes, path })), [
    { transferredBytes: 0, totalBytes: 6, path: "Media/download.png" },
    { transferredBytes: 4, totalBytes: 6, path: "Media/download.png" },
    { transferredBytes: 6, totalBytes: 6, path: "Media/download.png" },
  ]);
});

test("multipart uploads do not repeatedly copy the whole unconsumed source tail", async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(7);
  const file = descriptor("Media/large.png", bytes);
  const transferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const partSize = 512 * 1024;
  let uploadedBytes = 0;
  const send = async (request: { url: string; body?: string | ArrayBuffer }) => {
    if (request.url.endsWith("/uploads")) return response(200, {
      protocol_version: 1, type: "file_transfer", transfer_id: transferId,
      direction: "upload", protection: "transport_tls", total_size: bytes.length,
      strategy: { kind: "object_multipart", part_size: partSize }, received: [], uploaded_parts: [],
    });
    if (request.url.endsWith("/parts")) {
      const part = JSON.parse(String(request.body)) as { part_number: number; content_length: number };
      return response(200, { protocol_version: 1, type: "file_part", transfer_id: transferId,
        part_index: part.part_number - 1, offset: (part.part_number - 1) * partSize,
        content_length: part.content_length, method: "PUT", url: `https://objects.example/${part.part_number}`,
        headers: {}, expires_at: "2099-01-01T00:00:00.000Z" });
    }
    if (request.url.startsWith("https://objects.example/")) {
      const part = new Uint8Array(request.body as ArrayBuffer);
      assert.equal(part.length, partSize);
      assert.ok(part.every((byte) => byte === 7));
      uploadedBytes += part.length;
      return response(200, {}, new ArrayBuffer(0), { etag: `part-${uploadedBytes}` });
    }
    if (request.url.endsWith("/commit")) return response(200, {
      protocol_version: 1, type: "file_upload_committed", transfer_id: transferId, file,
    });
    throw new Error("unexpected test request");
  };
  const transport = new ObsidianSyncTransport(syncUrl, "test-token", send as never);
  const slice = Uint8Array.prototype.slice;
  let slicedBytes = 0;
  Uint8Array.prototype.slice = function (...args: Parameters<typeof slice>) {
    const copy = slice.apply(this, args);
    slicedBytes += copy.byteLength;
    return copy;
  };
  try {
    await transport.uploadFile({ protocol_version: 1, type: "open_file_upload", transfer_id: transferId,
      path: file.path, size: file.size, content_digest: file.content_digest, media_type: file.media_type },
    (async function* () { yield bytes; })());
  } finally {
    Uint8Array.prototype.slice = slice;
  }
  assert.equal(uploadedBytes, bytes.length);
  assert.ok(slicedBytes <= bytes.length, `an 8 MB source caused ${slicedBytes / 1024 / 1024} MB of tail copies`);
});

test("multipart reads do not copy the entire remaining source chunk for every part", async () => {
  const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
  const expected = Uint8Array.from(bytes);
  const file = descriptor("Media/large.png", bytes);
  const partSize = 4 * 1024;
  const transferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const uploaded = new Uint8Array(bytes.length);
  let parts = 0;
  const send = async (request: { url: string; body?: string | ArrayBuffer }) => {
    if (request.url.endsWith("/files/uploads")) return response(200, {
      protocol_version: 1, type: "file_transfer", transfer_id: transferId, direction: "upload",
      protection: "transport_tls", strategy: { kind: "object_multipart", part_size: partSize },
      total_size: file.size, expires_at: "2099-01-01T00:00:00.000Z", received: [], uploaded_parts: [],
    });
    if (request.url.endsWith(`/uploads/${transferId}/parts`)) {
      const part = JSON.parse(String(request.body)) as { part_number: number; content_length: number };
      const index = part.part_number - 1;
      return response(200, {
        protocol_version: 1, type: "file_part", transfer_id: transferId, part_index: index,
        offset: index * partSize, content_length: part.content_length, method: "PUT",
        url: `https://objects.example/part/${index}`, headers: {}, expires_at: "2099-01-01T00:00:00.000Z",
      });
    }
    if (request.url.startsWith("https://objects.example/part/")) {
      uploaded.set(new Uint8Array(request.body as ArrayBuffer), parts * partSize);
      return response(200, {}, new ArrayBuffer(0), { etag: `part-${++parts}` });
    }
    return response(200, { protocol_version: 1, type: "file_upload_committed", transfer_id: transferId, file });
  };
  const transport = new ObsidianSyncTransport(syncUrl, "fixture-token", send as never);
  const slice = Uint8Array.prototype.slice;
  let copiedBytes = 0;
  Uint8Array.prototype.slice = function (...args: Parameters<typeof slice>) {
    const result = slice.apply(this, args);
    copiedBytes += result.byteLength;
    return result;
  };
  try {
    await transport.uploadFile({
      protocol_version: 1, type: "open_file_upload", transfer_id: transferId, path: file.path,
      size: file.size, content_digest: file.content_digest, media_type: file.media_type,
    }, (async function* () { yield bytes; bytes.fill(0); })());
  } finally {
    Uint8Array.prototype.slice = slice;
  }
  assert.deepEqual(uploaded, expected, "source reuse must not mutate queued upload bytes");
  assert.equal(parts, file.size / partSize);
  assert.ok(copiedBytes <= file.size, `Expected bounded copies, not ${copiedBytes} bytes of sliced tails`);
});

test("Obsidian HTTP transport uploads exact multipart bytes without forwarding credentials", async () => {
  const bytes = Uint8Array.of(9, 8, 7, 6, 5);
  const file = descriptor("Media/upload.png", bytes);
  const transferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const uploaded: Uint8Array[] = [];
  const objectHeaders: Record<string, string>[] = [];
  const progress: Array<{ transferredBytes: number; totalBytes: number; path: string }> = [];
  const send = async (request: { url: string; method?: string; body?: string | ArrayBuffer; headers?: Record<string, string> }) => {
    if (request.url.endsWith("/files/uploads")) {
      return response(200, {
        protocol_version: 1,
        type: "file_transfer",
        transfer_id: transferId,
        direction: "upload",
        protection: "transport_tls",
        strategy: { kind: "object_multipart", part_size: 3 },
        total_size: bytes.byteLength,
        expires_at: "2026-08-05T01:00:00.000Z",
        received: [],
        uploaded_parts: [],
      });
    }
    if (request.url.endsWith(`/uploads/${transferId}/parts`)) {
      const part = JSON.parse(String(request.body)) as { part_number: number; content_length: number };
      const index = part.part_number - 1;
      return response(200, {
        protocol_version: 1,
        type: "file_part",
        transfer_id: transferId,
        part_index: index,
        offset: index * 3,
        content_length: part.content_length,
        method: "PUT",
        url: `https://objects.example/part/${index}`,
        headers: {
          authorization: "must-not-forward",
          cookie: "must-not-forward",
          host: "must-not-forward",
          "x-object-token": `part-${index}`,
        },
        expires_at: "2026-08-05T01:00:00.000Z",
      });
    }
    if (request.url.startsWith("https://objects.example/part/")) {
      uploaded.push(new Uint8Array(request.body as ArrayBuffer));
      objectHeaders.push(request.headers ?? {});
      return response(200, {}, new ArrayBuffer(0), { etag: `etag-${uploaded.length}` });
    }
    if (request.url.endsWith(`/uploads/${transferId}/commit`)) {
      const body = JSON.parse(String(request.body)) as { parts: Array<{ part_number: number; etag: string }> };
      assert.deepEqual(body.parts, [
        { part_number: 1, etag: "etag-1" },
        { part_number: 2, etag: "etag-2" },
      ]);
      return response(200, {
        protocol_version: 1,
        type: "file_upload_committed",
        transfer_id: transferId,
        file,
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  const transport = new ObsidianSyncTransport(syncUrl, "secret-token", send as never, (event) => progress.push(event));
  const receipt = await transport.uploadFile({
    protocol_version: 1,
    type: "open_file_upload",
    transfer_id: transferId,
    path: file.path,
    size: file.size,
    content_digest: file.content_digest,
    media_type: file.media_type,
  }, (async function* () {
    yield bytes.subarray(0, 1);
    yield bytes.subarray(1, 4);
    yield bytes.subarray(4);
  })());
  assert.equal(receipt.file.path, file.path);
  assert.deepEqual(Uint8Array.from(uploaded.flatMap((part) => [...part])), bytes);
  assert.deepEqual(objectHeaders, [
    { "x-object-token": "part-0" },
    { "x-object-token": "part-1" },
  ]);
  assert.deepEqual(progress.map(({ transferredBytes, totalBytes, path }) => ({ transferredBytes, totalBytes, path })), [
    { transferredBytes: 0, totalBytes: 5, path: "Media/upload.png" },
    { transferredBytes: 3, totalBytes: 5, path: "Media/upload.png" },
    { transferredBytes: 5, totalBytes: 5, path: "Media/upload.png" },
  ]);
});
