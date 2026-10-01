import type { SyncNowResult } from "./syncSession";
import type { SyncProblemKind } from "./syncUx";
import { backoffDelay, isTransientError } from "./syncHttp";

export interface SyncSchedulerHost {
  /** A collection is connected on this device. */
  connected(): boolean;
  /** Automatic sync is on. When off, the scheduler only keeps status fresh. */
  automatic(): boolean;
  /** The kind of problem currently shown, if any. */
  problemKind(): SyncProblemKind | null;
  autoSync(): Promise<SyncNowResult>;
  refreshStatus(): Promise<unknown>;
  remoteChangesWaiting(): Promise<boolean>;
  reportProblem(error: unknown): void;
  setRetryAt(at: number | null): void;
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
  random(): number;
}

export const SYNC_TIMING = {
  /** Edits arrive in bursts; wait for a pause before syncing. */
  localQuietMs: 3_000,
  /** But never hold a continuous stream of edits back longer than this. */
  localMaxWaitMs: 20_000,
  /** How often to ask Connect for hosted changes while the app is in front. */
  probeVisibleMs: 30_000,
  probeHiddenMs: 5 * 60_000,
  /** A full sync now and then catches anything events and probes missed. */
  safetyNetMs: 15 * 60_000,
  retryBaseMs: 5_000,
  /** Offline retries settle at this interval. */
  retryMaxMs: 5 * 60_000,
  /** Unexpected failures back off further so a defect does not hammer Connect. */
  unexpectedRetryMaxMs: 30 * 60_000,
} as const;

/** Problems only a person can clear; polling Connect while they stand is pointless. */
const WAITING_FOR_PERSON: ReadonlySet<SyncProblemKind> = new Set(["auth", "device", "paused"]);

/**
 * Decides when sync runs, the way a desktop sync client does: shortly after
 * local edits settle, as soon as Connect has hosted changes, when the app
 * comes back to the front or the network returns, and with backoff after a
 * failure. Only one run is ever in flight; triggers during a run coalesce
 * into one follow-up.
 */
export class SyncScheduler {
  private timer: number | null = null;
  private dueAt: number | null = null;
  private dueIsDebounce = false;
  private firstLocalChangeAt: number | null = null;
  /** Local edits since the last run started; a run that stopped for review waits for new ones. */
  private changed = true;
  private failures = 0;
  private running = false;
  private rerun = false;
  private visible = true;
  private lastSyncAt: number;
  private stopped = true;

  constructor(
    private readonly host: SyncSchedulerHost,
    private readonly clock: SchedulerClock = browserClock,
    private readonly timing: typeof SYNC_TIMING = SYNC_TIMING,
  ) {
    this.lastSyncAt = clock.now();
  }

  start(): void {
    this.stopped = false;
    this.schedule(this.clock.now());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = null;
  }

  /** The person edited, renamed or deleted something in the mirrored folder. */
  noteLocalChange(): void {
    const now = this.clock.now();
    this.firstLocalChangeAt ??= now;
    this.changed = true;
    this.schedule(Math.min(now + this.timing.localQuietMs, this.firstLocalChangeAt + this.timing.localMaxWaitMs), true);
  }

  noteVisibility(visible: boolean): void {
    const wasVisible = this.visible;
    this.visible = visible;
    if (visible && !wasVisible) this.schedule(this.clock.now());
  }

  /** The network came back: forget the backoff and try at once. */
  noteOnline(): void {
    // Whatever the failed runs were trying to sync is still waiting.
    if (this.failures > 0) this.changed = true;
    this.failures = 0;
    this.host.setRetryAt(null);
    this.schedule(this.clock.now());
  }

  /** Something outside the scheduler (settings, a manual sync) changed what is due. */
  requestSoon(): void {
    this.schedule(this.clock.now());
  }

  /** Run one decision now. Exposed for tests; normally driven by timers. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.dueAt = null;
    let retryIn: number | null = null;
    try {
      retryIn = await this.decide();
    } catch (error) {
      // A host operation may reject before returning a SyncNowResult. Keep
      // that failure inside the scheduler's retry boundary, not an unhandled
      // timer rejection that forgets the local changes this attempt consumed.
      this.host.reportProblem(error);
      const kind = this.host.problemKind();
      retryIn = kind && WAITING_FOR_PERSON.has(kind) ? this.settled() : this.failed(isTransientError(error));
    } finally {
      this.running = false;
      const now = this.clock.now();
      if (this.rerun) {
        this.rerun = false;
        this.schedule(now);
      } else if (retryIn !== null) {
        // A routine probe must not preempt the advertised failure backoff.
        // Explicit edits, online and foreground events can still request sooner.
        this.schedule(now + retryIn);
      } else {
        this.schedule(now + (this.visible ? this.timing.probeVisibleMs : this.timing.probeHiddenMs));
      }
    }
  }

  /** Returns a retry delay after a failure, otherwise null. */
  private async decide(): Promise<number | null> {
    if (!this.host.connected()) return null;
    const problem = this.host.problemKind();
    if (problem && WAITING_FOR_PERSON.has(problem)) return null;
    const now = this.clock.now();
    const local = this.changed;
    this.changed = false;
    this.firstLocalChangeAt = null;
    if (!this.host.automatic()) {
      if (local || await this.probe() === true) await this.host.refreshStatus();
      return null;
    }
    let due = local || this.failures > 0 || now - this.lastSyncAt >= this.timing.safetyNetMs;
    if (!due) {
      const remote = await this.probe();
      if (remote === null) return this.failed(true);
      due = remote;
    }
    if (!due) return null;
    this.lastSyncAt = now;
    const result = await this.host.autoSync();
    if (result === "busy" || result === "pending") {
      this.changed ||= local || result === "pending";
      return 2_000;
    }
    if (result === "failed") {
      this.changed ||= local;
      const kind = this.host.problemKind();
      if (kind && WAITING_FOR_PERSON.has(kind)) return this.settled();
      return this.failed(kind === "offline");
    }
    return this.settled();
  }

  /** True or false from Connect's change feed; null when Connect could not be asked. */
  private async probe(): Promise<boolean | null> {
    try {
      return await this.host.remoteChangesWaiting();
    } catch (error) {
      this.host.reportProblem(error);
      if (isTransientError(error)) return null;
      // A non-network failure here will also stop the sync itself; let it report fully.
      return true;
    }
  }

  private failed(transient: boolean): number {
    const delay = backoffDelay(this.failures, {
      baseDelayMs: this.timing.retryBaseMs,
      maxDelayMs: transient ? this.timing.retryMaxMs : this.timing.unexpectedRetryMaxMs,
      random: () => this.clock.random(),
    });
    this.failures += 1;
    this.host.setRetryAt(this.clock.now() + delay);
    return delay;
  }

  private settled(): null {
    this.failures = 0;
    this.host.setRetryAt(null);
    return null;
  }

  /**
   * Keep the earliest due time, except that a newer edit may push back a
   * pending edit-debounce (never past the max wait noteLocalChange enforces).
   */
  private schedule(at: number, debounce = false): void {
    if (this.stopped) return;
    // A due time only counts while its timer is pending; a fired timer whose
    // tick was deferred into a rerun must not block later scheduling.
    const pendingAt = this.timer === null ? null : this.dueAt;
    if (pendingAt !== null && pendingAt <= at && !(debounce && this.dueIsDebounce)) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.dueAt = at;
    this.dueIsDebounce = debounce;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.dueAt = null;
      void this.tick();
    }, Math.max(0, at - this.clock.now()));
  }
}

const browserClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  random: () => Math.random(),
};
