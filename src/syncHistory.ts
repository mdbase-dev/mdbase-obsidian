import type { MirrorPlanAction, MirrorState, MirrorStateStore } from "@mdbase-dev/connect-sync/mirror";
import { actionEntry, type SyncPreviewAction, type SyncPreviewDirection } from "./syncPreview";

type DurableBatch = NonNullable<MirrorState["batch"]>;
export type SyncActionReceipt = DurableBatch["receipts"][number];

export interface SyncHistoryFile {
  path: string;
  fromPath?: string;
  kind: "document" | "file";
  direction: SyncPreviewDirection;
  action: SyncPreviewAction;
  status: SyncActionReceipt["status"];
  at: string;
  message?: string;
}

export interface SyncHistoryRun {
  id: string;
  collectionId: string;
  startedAt: string;
  finishedAt: string;
  outcome: string;
  files: SyncHistoryFile[];
  message?: string;
}

export interface SyncHistoryLimits {
  maxAgeDays: number;
  maxFiles: number;
}

export const DEFAULT_HISTORY_LIMITS: SyncHistoryLimits = { maxAgeDays: 90, maxFiles: 5_000 };

/** Converts one durable engine receipt into a history row. Checkpoint actions have no file. */
export function historyFileFromReceipt(
  action: MirrorPlanAction,
  receipt: SyncActionReceipt,
  at: string,
): SyncHistoryFile | null {
  if (action.command === "advance_checkpoint") return null;
  const entry = actionEntry(action);
  const fromPath = action.command === "move_local" || action.command === "move_remote"
    ? action.source.path
    : undefined;
  return {
    path: entry.path,
    ...(fromPath && fromPath !== entry.path ? { fromPath } : {}),
    kind: entry.kind,
    direction: entry.direction,
    action: entry.action,
    status: receipt.status,
    at,
    ...(receipt.failure?.message ? { message: receipt.failure.message } : {}),
  };
}

/**
 * Observes the engine's durable batch journal. The executor records a receipt
 * for each action immediately after its effect, in plan order, so new receipts
 * are exactly the actions this run completed, including runs that stop early.
 * A resumed batch already carries earlier receipts; they are the baseline.
 */
export class ReceiptObservingStateStore implements MirrorStateStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly inner: MirrorStateStore,
    private readonly onReceipt: (action: MirrorPlanAction, receipt: SyncActionReceipt) => void,
  ) {}

  read(): Promise<MirrorState | null> {
    return this.inner.read();
  }

  async write(state: MirrorState): Promise<void> {
    await this.inner.write(state);
    const batch = state.batch;
    if (!batch) return;
    const fingerprint = batch.plan.fingerprint;
    const previous = this.seen.get(fingerprint);
    this.seen.set(fingerprint, batch.receipts.length);
    if (previous === undefined) return;
    for (const receipt of batch.receipts.slice(previous)) {
      const action = batch.plan.actions.find((candidate) => candidate.action_id === receipt.action_id);
      if (action) this.onReceipt(action, receipt);
    }
  }
}

export function summarizeRun(run: SyncHistoryRun): string {
  const count = (direction: SyncPreviewDirection) =>
    run.files.filter((file) => file.direction === direction && file.status === "completed").length;
  const parts = [
    [count("download"), "downloaded"],
    [count("upload"), "uploaded"],
    [run.files.filter((file) => file.direction === "attention" || file.status === "conflicted").length, "conflicts"],
    [run.files.filter((file) => file.status === "rejected").length, "rejected"],
  ] as const;
  const text = parts.filter(([value]) => value > 0).map(([value, label]) => `${value} ${label}`).join(" · ");
  return text || "No file changes";
}

/** Rows for one note, newest first. A rename matches both its old and new path. */
export function historyForPath(
  runs: readonly SyncHistoryRun[],
  path: string,
): Array<{ run: SyncHistoryRun; file: SyncHistoryFile }> {
  return runs
    .flatMap((run) => run.files
      .filter((file) => file.path === path || file.fromPath === path)
      .map((file) => ({ run, file })))
    .sort((a, b) => b.file.at.localeCompare(a.file.at));
}

export function filterRuns(runs: readonly SyncHistoryRun[], query: string): SyncHistoryRun[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...runs];
  return runs.flatMap((run) => {
    const files = run.files.filter((file) =>
      file.path.toLowerCase().includes(needle) || file.fromPath?.toLowerCase().includes(needle));
    return files.length ? [{ ...run, files }] : [];
  });
}

/** Drops runs older than the age limit, then the oldest runs until the file limit fits. */
export function pruneRuns(
  runs: readonly SyncHistoryRun[],
  limits: SyncHistoryLimits = DEFAULT_HISTORY_LIMITS,
  now = Date.now(),
): SyncHistoryRun[] {
  const cutoff = now - limits.maxAgeDays * 86_400_000;
  const kept = runs.filter((run) => Date.parse(run.finishedAt) >= cutoff);
  let files = kept.reduce((total, run) => total + run.files.length, 0);
  let start = 0;
  while (files > limits.maxFiles && start < kept.length - 1) {
    files -= kept[start].files.length;
    start += 1;
  }
  return kept.slice(start);
}

export function parseHistory(source: string): SyncHistoryRun[] {
  const runs: SyncHistoryRun[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRun(value)) runs.push(value);
    } catch {
      // A torn final line from an interrupted append is skipped, not fatal.
    }
  }
  return runs.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

function isRun(value: unknown): value is SyncHistoryRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<SyncHistoryRun>;
  return typeof run.id === "string"
    && typeof run.collectionId === "string"
    && typeof run.startedAt === "string"
    && typeof run.finishedAt === "string"
    && typeof run.outcome === "string"
    && Array.isArray(run.files)
    && run.files.every((file) => !!file && typeof file.path === "string" && typeof file.at === "string");
}

export interface HistoryAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
}

/**
 * Device-local JSON Lines log kept in the plugin folder. The config folder is
 * never mirrored, so the log cannot sync itself.
 */
export class SyncHistoryStore {
  private runs: SyncHistoryRun[] = [];
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: HistoryAdapter,
    private readonly path: string,
    private readonly limits: SyncHistoryLimits = DEFAULT_HISTORY_LIMITS,
  ) {}

  async load(): Promise<void> {
    const loaded = await this.adapter.exists(this.path)
      ? parseHistory(await this.adapter.read(this.path))
      : [];
    this.runs = pruneRuns(loaded, this.limits);
    if (this.runs.length !== loaded.length) await this.rewrite();
  }

  list(collectionId?: string): SyncHistoryRun[] {
    return this.runs.filter((run) => collectionId === undefined || run.collectionId === collectionId);
  }

  append(run: SyncHistoryRun): Promise<void> {
    const before = this.runs.length + 1;
    this.runs = pruneRuns([...this.runs, run], this.limits);
    const pruned = this.runs.length !== before;
    return this.enqueue(async () => {
      if (pruned || !await this.adapter.exists(this.path)) await this.rewrite();
      else await this.adapter.append(this.path, `${JSON.stringify(run)}\n`);
    });
  }

  clear(): Promise<void> {
    this.runs = [];
    return this.enqueue(() => this.rewrite());
  }

  private rewrite(): Promise<void> {
    return this.adapter.write(this.path, this.runs.map((run) => `${JSON.stringify(run)}\n`).join(""));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.writes = this.writes.then(operation, operation);
    return this.writes;
  }
}

const PAST_TENSE: Record<SyncPreviewAction, string> = {
  create: "created",
  update: "updated",
  rename: "renamed",
  delete: "deleted",
  replace: "replaced",
  fix: "conflict",
};

/** "Download · updated", "Upload · renamed", "Conflict recorded". */
export function describeHistoryFile(file: SyncHistoryFile): string {
  const base = file.direction === "attention"
    ? "Conflict recorded"
    : `${file.direction === "download" ? "Download" : "Upload"} · ${PAST_TENSE[file.action]}`;
  return file.status === "completed" ? base : `${base} · ${file.status}`;
}

export function formatHistoryTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (input: Date) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const day = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day} ${time}`;
}
