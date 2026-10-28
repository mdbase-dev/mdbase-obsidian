export interface UploadIdentity { transferId: string; mutationId: string }

/** An RPC deadline doesn't cancel the SDK operation. Join it, don't enqueue a
 * second write. Across restarts the durable identity resumes the same transfer. */
export class RetryUploads {
  private readonly running = new Map<string, Promise<unknown>>();
  run(identity: UploadIdentity | undefined, upload: () => Promise<unknown>): Promise<unknown> {
    if (!identity) return Promise.reject(new Error("Missing durable upload identity"));
    const prior = this.running.get(identity.transferId);
    if (prior) return prior;
    const result = upload().catch(error => { this.running.delete(identity.transferId); throw error; });
    this.running.set(identity.transferId, result);
    return result;
  }
  forget(id: string): void { this.running.delete(id); }
}

export async function retryUpload<T>(send: () => Promise<T>): Promise<T> {
  try { return await send(); }
  catch (error) {
    if ((error as { code?: string }).code !== "outcome_unknown") throw error;
    return send(); // same journal/transfer/mutation, never a new upload identity
  }
}
