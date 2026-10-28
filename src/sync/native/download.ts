import { nativeModule } from "./node";
const { createHash, randomUUID } = nativeModule<typeof import("node:crypto")>("crypto");
const fs = nativeModule<typeof import("node:fs/promises")>("fs/promises");
const path = nativeModule<typeof import("node:path")>("path");

import { BRIDGE_CHUNK_BYTES } from "./downloadPull";

/** Keep provisional bytes private. Never expose them to Obsidian before EOF. */
export async function stageDownload(options: {
  directory: string;
  digest: string;
  next(): Promise<{ done: boolean; bytes?: Uint8Array }>;
  publish(staged: string): Promise<void>;
  close(): Promise<void>;
}): Promise<void> {
  await fs.mkdir(options.directory, { recursive: true });
  const staged = path.join(options.directory, `${randomUUID()}.tmp`);
  const file = await fs.open(staged, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const reply = await options.next();
      if (reply.done) break;
      const bytes = reply.bytes;
      if (!bytes || bytes.length > BRIDGE_CHUNK_BYTES) throw new Error("Invalid download chunk");
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw new Error("Download staging write made no progress");
        offset += bytesWritten;
      }
    }
    if (`sha256:${hash.digest("hex")}` !== options.digest) throw new Error("Downloaded file digest mismatch");
    await file.sync(); await file.close();
    await options.publish(staged);
  } finally {
    await file.close().catch(() => {});
    await fs.unlink(staged).catch(error => { if (error.code !== "ENOENT") throw error; });
    await options.close();
  }
}
