import { TFile, type Vault } from "obsidian";
import { normalizeSafeRelativePath } from "./mdbaseCore";

/** Structural subset of the shared runtime's SdkWriteClient; no unpublished dependency. */
export interface MdbaseWriteClient {
  collectionPath(vaultPath: string): string | null;
  isRecordPath(path: string): boolean;
  isResourcePath(path: string): boolean;
  find(path: string, options: { "document": boolean }): Promise<MdbaseRecord | null>;
  replaceDocument(record: MdbaseRecord, document: string): Promise<{ mutation: string }>;
  create(path: string, document: string): Promise<{ mutation: string }>;
  resources(ops: Array<{ kind: "put"; path: string; doc: string; base: string | null }>): Promise<{ mutation: string }>;
  settle(write: { mutation: string }, vaultPath: string): Promise<void>;
}

export interface MdbaseRecord {
  readonly id: string;
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly "document"?: string;
}

/**
 * Opt-in mutation seam for the next runtime. Successful writes mean published to
 * the vault (not merely accepted by a log). Rejection/holds propagate; NEVER
 * fall back to direct vault writes when attached. No plugin setting enables it.
 */
export class MdbaseMutationBackend {
  constructor(private readonly client: MdbaseWriteClient) {}

  private path(vaultPath: string, resource: boolean): string {
    const path = this.client.collectionPath(normalizeSafeRelativePath(vaultPath));
    if (path === null || !(resource ? this.client.isResourcePath(path) : this.client.isRecordPath(path))) {
      throw new Error(`Path is not a collection ${resource ? "resource" : "record"}: ${vaultPath}`);
    }
    return path;
  }

  async transform(vaultPath: string, transform: (document: string) => string): Promise<void> {
    const record = await this.client.find(this.path(vaultPath, false), { document: true });
    if (!record || record.document === undefined) throw new Error(`Record document unavailable: ${vaultPath}`);
    const next = transform(record.document);
    if (next === record.document) return;
    const write = await this.client.replaceDocument(record, next);
    await this.client.settle(write, vaultPath);
  }

  async create(vault: Vault, vaultPath: string, document: string): Promise<TFile> {
    const path = this.path(vaultPath, false);
    const write = await this.client.create(path, document);
    await this.client.settle(write, vaultPath);
    return this.file(vault, vaultPath);
  }

  async putResource(vault: Vault, vaultPath: string, document: string, base: string | null): Promise<TFile> {
    const path = this.path(vaultPath, true);
    // null means must_not_exist; an edit carries the revision of these exact bytes.
    const write = await this.client.resources([{ kind: "put", path, doc: document, base }]);
    await this.client.settle(write, vaultPath);
    return this.file(vault, vaultPath);
  }

  private file(vault: Vault, path: string): TFile {
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Published file not indexed: ${path}`);
    return file;
  }
}
