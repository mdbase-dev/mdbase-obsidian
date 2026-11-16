import type { methods, phaseSummary } from "./page";

export type NativeMethods = typeof methods;
export type NativeMethod = keyof NativeMethods;
export type NativeResult<Method extends NativeMethod> = Awaited<ReturnType<NativeMethods[Method]>>;
export interface CallMessage { type: "call"; id: number; method: NativeMethod; args?: unknown[] }
export type NativePhase = Partial<Omit<ReturnType<typeof phaseSummary>, "kind">> & {
  kind: string; stalled?: boolean;
  /** `blocked`: who holds this folder, and whether Set up sync here is offered. */
  owner?: "desktop" | "obsidian" | "unknown" | "unreadable"; takeover?: boolean;
};
export type PageMessage =
  | { type: "hello"; origin: string; opfs: boolean; isSecureContext: boolean }
  | { type: "phase"; phase: NativePhase }
  | { type: "open-url"; url: string }
  | { type: "changes"; batch: { cursor: string; reset?: boolean; changes: { id: string; path?: string; kind: string; entity: string | null }[] } }
  | { type: "transfer"; direction: string; done: number; total: number }
  | { type: "log"; text: string }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: { message: string; code?: string; reason?: string } };

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorInfo(value: unknown) {
  const object = isObject(value) ? value : {};
  const text = (key: string) => typeof object[key] === "string" ? object[key] : undefined;
  return {
    code: text("code"), reason: text("reason"), message: text("message"),
    mutationId: text("mutationId"), severity: text("severity"), location: text("location"),
    issues: Array.isArray(object.issues) ? object.issues.map((issue: unknown) => {
      const fields = isObject(issue) ? issue : {};
      return {
        code: typeof fields.code === "string" ? fields.code : undefined,
        severity: typeof fields.severity === "string" ? fields.severity : undefined,
        message: typeof fields.message === "string" ? fields.message : undefined,
        location: typeof fields.location === "string" ? fields.location : undefined,
      };
    }) : undefined,
  };
}
