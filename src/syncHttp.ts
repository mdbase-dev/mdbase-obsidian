import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { SyncError } from "@mdbase-dev/connect-sync";

/** A request plus the deadline and cancellation the network layer enforces. */
export interface HttpRequest extends RequestUrlParam {
  signal?: AbortSignal;
  /** Abandon the attempt after this long. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export type HttpSend = (request: HttpRequest) => Promise<RequestUrlResponse>;

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Object parts get the base deadline plus time for a slow (64 KB/s) link. */
export const SLOW_LINK_BYTES_PER_SECOND = 64 * 1024;

export function transferTimeoutMs(bytes: number): number {
  return DEFAULT_TIMEOUT_MS + Math.ceil(bytes / SLOW_LINK_BYTES_PER_SECOND) * 1_000;
}

/** The request never produced an HTTP response: offline, DNS, TLS, reset or timeout. */
export class NetworkError extends SyncError {
  constructor(code: "network_unreachable" | "network_timeout", message: string) {
    super(code, message);
    this.name = "NetworkError";
  }
}

/** An HTTP response outside 2xx, with the authority's error code when it sent one. */
export class HttpStatusError extends SyncError {
  constructor(code: string, message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(code, message);
    this.name = "HttpStatusError";
  }
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "network_unreachable",
  "network_timeout",
  "authority_unavailable",
  "mirror_enrollment_unreachable",
  "authority_adoption_unreachable",
]);

/** Failures that clear up by themselves; retrying them is always safe and expected. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof HttpStatusError) return TRANSIENT_STATUSES.has(error.status);
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && TRANSIENT_STATUSES.has(status)) return true;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  }
  return false;
}

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

export interface RetryPolicy {
  /** Total attempts, including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  sleep: abortableSleep,
  random: Math.random,
};

/** Full-jitter exponential backoff, honouring a server's Retry-After when it is longer. */
export function backoffDelay(attempt: number, policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "random">, retryAfterMs?: number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const jittered = Math.round(ceiling / 2 + policy.random() * ceiling / 2);
  return retryAfterMs === undefined ? jittered : Math.min(Math.max(jittered, retryAfterMs), 60_000);
}

/**
 * Sends with a deadline and retries transient failures. Every Connect request
 * the mirror makes is safe to repeat: reads are pure, mutations and file moves
 * carry idempotency keys, uploads resume from the parts the authority already
 * received, and a token renewal simply rotates again.
 */
export function reliableSend(send: HttpSend, policy: RetryPolicy = DEFAULT_RETRY): HttpSend {
  return async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(request.signal);
      let retryAfterMs: number | undefined;
      try {
        const response = await send(request);
        if (!isTransientStatus(response.status) || attempt + 1 >= policy.attempts) return response;
        retryAfterMs = retryAfterMilliseconds(response.headers);
      } catch (error) {
        if (isAbort(error) && request.signal?.aborted) throw error;
        if (!isTransientError(error) || attempt + 1 >= policy.attempts) throw error;
      }
      await policy.sleep(backoffDelay(attempt, policy, retryAfterMs), request.signal);
    }
  };
}

/**
 * One network stack per platform. Obsidian desktop's requestUrl bridge can fail
 * with net::ERR_FAILED or attach a browser Origin that Connect rightly rejects
 * for mirror credentials, so desktop uses Electron's main-process stack. Mobile
 * uses requestUrl. There is deliberately no cross-stack fallback: a request
 * that reached the server but lost its response must not be sent again by a
 * second stack outside the retry policy.
 */
export function platformSend(desktop: typeof window.fetch | null = privilegedDesktopFetch()): HttpSend {
  return desktop
    ? (request) => fetchSend(request, desktop)
    : (request) => requestUrlSend(request);
}

export function privilegedDesktopFetch(): typeof window.fetch | null {
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

/** fetch-compatible stacks support real cancellation of the in-flight request. */
export async function fetchSend(request: HttpRequest, send: typeof window.fetch): Promise<RequestUrlResponse> {
  const { signal, dispose } = deadline(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers = new Headers(request.headers);
    if (request.contentType && !headers.has("content-type")) headers.set("content-type", request.contentType);
    let response: Response;
    let arrayBuffer: ArrayBuffer;
    try {
      response = await send(request.url, { method: request.method, headers, body: request.body, signal });
      arrayBuffer = await response.arrayBuffer();
    } catch (error) {
      throw networkFailure(error, request.signal, signal);
    }
    const text = new TextDecoder().decode(arrayBuffer);
    if (request.throw !== false && response.status >= 400) {
      throw new HttpStatusError(`http_${response.status}`, `Request failed with status ${response.status}`, response.status);
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return { status: response.status, headers: responseHeaders, arrayBuffer, json: parseJson(text), text };
  } finally {
    dispose();
  }
}

/**
 * requestUrl cannot be cancelled, so a timeout or abort abandons the attempt;
 * the retry policy treats it exactly like a lost response.
 */
export async function requestUrlSend(
  request: HttpRequest,
  send: (request: RequestUrlParam) => Promise<RequestUrlResponse> = (input) => requestUrl(input),
): Promise<RequestUrlResponse> {
  const { signal, timeoutMs, ...param } = request;
  const { signal: limit, dispose } = deadline(signal, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await new Promise<RequestUrlResponse>((resolve, reject) => {
      const onAbort = () => reject(networkFailure(limit.reason, signal, limit));
      if (limit.aborted) return onAbort();
      limit.addEventListener("abort", onAbort, { once: true });
      send(param).then(resolve, (error: unknown) => reject(networkFailure(error, signal, limit)))
        .finally(() => limit.removeEventListener("abort", onAbort));
    });
  } finally {
    dispose();
  }
}

export function retryAfterMilliseconds(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("Synchronization stopped.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Combines the caller's cancellation with a per-attempt deadline. */
function deadline(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortError());
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new NetworkError("network_timeout", "Connect did not respond in time.")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      window.clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function networkFailure(error: unknown, caller: AbortSignal | undefined, limit: AbortSignal): Error {
  if (caller?.aborted) return abortError();
  if (limit.aborted) return limit.reason instanceof NetworkError
    ? limit.reason
    : new NetworkError("network_timeout", "Connect did not respond in time.");
  if (error instanceof SyncError) return error;
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  if (typeof status === "number") return new HttpStatusError(`http_${status}`, `Request failed with status ${status}`, status);
  const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
  return new NetworkError("network_unreachable", `Connect could not be reached${detail}.`);
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
