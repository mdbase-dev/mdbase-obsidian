import * as assert from "node:assert/strict";
import { test } from "node:test";
import { SYNC_TIMING, SyncScheduler, type SchedulerClock, type SyncSchedulerHost } from "../src/syncScheduler";
import type { SyncNowResult } from "../src/syncSession";
import type { SyncProblemKind } from "../src/syncUx";
import { NetworkError } from "../src/syncHttp";

/** A clock whose timers fire only when the test advances time. */
class FakeClock implements SchedulerClock {
  time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  random(): number {
    return 1;
  }

  /** Advance time, firing due timers in order and letting their async work settle. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    this.time = end;
  }
}

function harness(overrides: Partial<SyncSchedulerHost> = {}) {
  const clock = new FakeClock();
  const calls = { autoSync: 0, probe: 0, refresh: 0 };
  let remote = false;
  let result: SyncNowResult = "applied";
  let problem: SyncProblemKind | null = null;
  let retryAt: number | null = null;
  const host: SyncSchedulerHost = {
    connected: () => true,
    automatic: () => true,
    problemKind: () => problem,
    autoSync: async () => {
      calls.autoSync += 1;
      return result;
    },
    refreshStatus: async () => {
      calls.refresh += 1;
    },
    remoteChangesWaiting: async () => {
      calls.probe += 1;
      return remote;
    },
    reportProblem: () => undefined,
    setRetryAt: (at) => {
      retryAt = at;
    },
    ...overrides,
  };
  const scheduler = new SyncScheduler(host, clock);
  return {
    clock,
    calls,
    scheduler,
    setRemote: (value: boolean) => { remote = value; },
    setResult: (value: SyncNowResult) => { result = value; },
    setProblem: (value: SyncProblemKind | null) => { problem = value; },
    retryAt: () => retryAt,
  };
}

test("sync runs once at startup, then only when something changed", async () => {
  const h = harness();
  h.scheduler.start();
  await h.clock.advance(0);
  assert.equal(h.calls.autoSync, 1, "the first run catches up on whatever happened while closed");
  await h.clock.advance(SYNC_TIMING.probeVisibleMs * 3);
  assert.equal(h.calls.autoSync, 1);
  assert.equal(h.calls.probe, 3, "Connect is asked cheaply instead of syncing");
  h.setRemote(true);
  await h.clock.advance(SYNC_TIMING.probeVisibleMs);
  assert.equal(h.calls.autoSync, 2, "hosted changes are pulled as soon as the probe sees them");
});

test("a burst of edits syncs once it settles, and a long burst cannot hold sync back", async () => {
  const h = harness();
  h.scheduler.start();
  await h.clock.advance(0);
  const before = h.calls.autoSync;
  for (let i = 0; i < 5; i++) {
    h.scheduler.noteLocalChange();
    await h.clock.advance(1_000);
  }
  assert.equal(h.calls.autoSync, before, "still typing");
  await h.clock.advance(SYNC_TIMING.localQuietMs);
  assert.equal(h.calls.autoSync, before + 1);

  for (let i = 0; i < 30; i++) {
    h.scheduler.noteLocalChange();
    await h.clock.advance(1_000);
  }
  assert.ok(h.calls.autoSync >= before + 2, "continuous edits still sync within the max wait");
});

test("offline failures retry with growing backoff and reset when the network returns", async () => {
  const h = harness();
  h.setResult("failed");
  h.setProblem("offline");
  // Offline is not a problem that waits for a person, so retries continue.
  h.scheduler.start();
  await h.clock.advance(0);
  assert.equal(h.calls.autoSync, 1);
  const firstRetry = h.retryAt()!;
  assert.ok(firstRetry > 0);
  await h.clock.advance(firstRetry - h.clock.now());
  assert.equal(h.calls.autoSync, 2);
  const secondRetry = h.retryAt()!;
  assert.ok(secondRetry - h.clock.now() > firstRetry, "the second wait is longer");

  h.setResult("applied");
  h.setProblem(null);
  h.scheduler.noteOnline();
  await h.clock.advance(0);
  assert.equal(h.calls.autoSync, 3);
  assert.equal(h.retryAt(), null);
});

test("an unreachable probe counts as offline and is retried with backoff", async () => {
  const h = harness({
    remoteChangesWaiting: async () => {
      throw new NetworkError("network_unreachable", "offline");
    },
  });
  h.scheduler.start();
  await h.clock.advance(0);
  await h.clock.advance(SYNC_TIMING.probeVisibleMs);
  assert.ok(h.retryAt() !== null);
});

test("nothing polls Connect while only a person can fix the problem", async () => {
  const h = harness();
  h.setProblem("auth");
  h.scheduler.start();
  await h.clock.advance(SYNC_TIMING.probeVisibleMs * 4);
  assert.equal(h.calls.autoSync, 0);
  assert.equal(h.calls.probe, 0);
  h.setProblem(null);
  h.scheduler.requestSoon();
  await h.clock.advance(0);
  assert.equal(h.calls.autoSync, 1);
});

test("returning to the app checks at once; in the background it checks rarely", async () => {
  const h = harness();
  h.scheduler.start();
  await h.clock.advance(0);
  h.scheduler.noteVisibility(false);
  await h.clock.advance(SYNC_TIMING.probeVisibleMs);
  const hiddenProbes = h.calls.probe;
  await h.clock.advance(SYNC_TIMING.probeHiddenMs - SYNC_TIMING.probeVisibleMs * 2);
  assert.ok(h.calls.probe <= hiddenProbes + 1);
  h.scheduler.noteVisibility(true);
  await h.clock.advance(0);
  assert.ok(h.calls.probe > hiddenProbes, "coming back to the front checks immediately");
});

test("with automatic sync off, the scheduler only keeps status fresh", async () => {
  const h = harness({ automatic: () => false });
  h.scheduler.start();
  await h.clock.advance(0);
  assert.equal(h.calls.autoSync, 0);
  assert.equal(h.calls.refresh, 1);
  h.setRemote(true);
  await h.clock.advance(SYNC_TIMING.probeVisibleMs);
  assert.equal(h.calls.refresh, 2);
  assert.equal(h.calls.autoSync, 0);
});

test("a run that finds sync busy tries again shortly and keeps the pending edits", async () => {
  const h = harness();
  h.setResult("busy");
  h.scheduler.start();
  await h.clock.advance(0);
  h.setResult("applied");
  await h.clock.advance(2_000);
  assert.equal(h.calls.autoSync, 2);
});

test("a trigger that fires while a sync is running is not lost, and later syncs still happen", async () => {
  // Regression: a timer firing mid-run left a stale due time that made every
  // later schedule() think a timer was already pending, so sync stopped forever.
  let release!: () => void;
  let calls = 0;
  const h = harness({
    autoSync: async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
      return "applied";
    },
  });
  h.scheduler.start();
  await h.clock.advance(0);
  assert.equal(calls, 1, "first run in flight");
  h.scheduler.noteLocalChange();
  await h.clock.advance(SYNC_TIMING.localQuietMs);
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await h.clock.advance(0);
  assert.equal(calls, 2, "the edit made during the run is synced right after it");
  h.setRemote(true);
  await h.clock.advance(SYNC_TIMING.probeVisibleMs);
  assert.equal(calls, 3, "and the scheduler keeps running afterwards");
});
