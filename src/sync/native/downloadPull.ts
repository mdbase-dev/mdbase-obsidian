export const BRIDGE_CHUNK_BYTES = 4 * 1024 * 1024;

/** Each reply is bounded; successful done is possible only after verified EOF. */
export class DownloadPull {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunk?: Uint8Array;
  private offset = 0;
  constructor(stream: AsyncIterable<Uint8Array>) { this.iterator = stream[Symbol.asyncIterator](); }
  async next(): Promise<{ done: boolean; bytes?: Uint8Array }> {
    if (!this.chunk || this.offset === this.chunk.length) {
      const next = await this.iterator.next(); // verification errors propagate, never done
      if (next.done) return { done: true };
      this.chunk = next.value; this.offset = 0;
    }
    // Own the bounded backing buffer: structured clone must not copy a larger SDK chunk.
    const bytes = this.chunk.slice(this.offset, this.offset + BRIDGE_CHUNK_BYTES);
    this.offset += bytes.length;
    return { done: false, bytes };
  }
  async close(): Promise<void> { await this.iterator.return?.(); this.chunk = undefined; }
}

