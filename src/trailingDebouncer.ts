export type DebouncedTask<Value> = (
  value: Value,
  isCurrent: () => boolean,
) => void | Promise<void>;

interface PendingEntry<Value> {
  value: Value;
  revision: number;
  timer: number | null;
  ready: boolean;
  running: boolean;
}

/**
 * A keyed trailing-edge debouncer for asynchronous background work.
 *
 * Each key runs at most one task at a time. If another update arrives while a
 * task is running, the latest value is run once its own quiet period has
 * elapsed. Tasks can use `isCurrent` to avoid publishing stale results.
 */
export class KeyedTrailingDebouncer<Key, Value> {
  private readonly entries = new Map<Key, PendingEntry<Value>>();

  constructor(
    private readonly delayMs: number,
    private readonly task: DebouncedTask<Value>,
  ) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error("Debounce delay must be a non-negative finite number.");
    }
  }

  has(key: Key): boolean {
    return this.entries.has(key);
  }

  schedule(key: Key, value: Value): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        value,
        revision: 0,
        timer: null,
        ready: false,
        running: false,
      };
      this.entries.set(key, entry);
    }

    entry.value = value;
    entry.revision += 1;
    entry.ready = false;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      if (this.entries.get(key) !== entry) return;
      entry.timer = null;
      entry.ready = true;
      void this.drain(key, entry);
    }, this.delayMs);
  }

  cancel(key: Key): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) window.clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private async drain(key: Key, entry: PendingEntry<Value>): Promise<void> {
    if (this.entries.get(key) !== entry || entry.running || !entry.ready) return;

    entry.ready = false;
    entry.running = true;
    const revision = entry.revision;
    const value = entry.value;
    const isCurrent = (): boolean =>
      this.entries.get(key) === entry && entry.revision === revision;

    try {
      await this.task(value, isCurrent);
    } finally {
      entry.running = false;
      if (this.entries.get(key) === entry) {
        if (entry.ready) {
          void this.drain(key, entry);
        } else if (entry.timer === null && entry.revision === revision) {
          this.entries.delete(key);
        }
      }
    }
  }
}
