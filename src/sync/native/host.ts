import type { Synced } from "./reconcile";

export type HostResult<T> = T | Promise<T>;
export function vaultNamespace(vaultId: string): string {
  if (!vaultId || !/^[a-zA-Z0-9-]+$/.test(vaultId)) throw new Error("Invalid vault namespace");
  return `obsidian-vault-${vaultId}`;
}
export interface HostEntry { name: string; directory: boolean; file: boolean }
export interface EngineOptions {
  data: { vaultId: string; port?: number; collectionId?: string };
  capability: string;
  stopped(): boolean;
  save(): Promise<void>;
  log(text: string): void;
}
export interface DownloadOptions {
  directory: string;
  digest: string;
  next(): Promise<{ done: boolean; bytes?: Uint8Array }>;
  publish(staged: string): Promise<void>;
  close(): Promise<void>;
}
export interface EngineHost {
  readonly root: string;
  readonly pluginDir: string;
  readonly processId?: number;
  location(): string;
  join(...parts: string[]): string;
  dirname(file: string): string;
  uuid(): string;
  openExternal(url: string): Promise<void>;
  assertPath(file: string): void;
  readText(file: string): HostResult<string>;
  readBytes(file: string): HostResult<Uint8Array>;
  writeAtomic(file: string, text: string, exclusiveTemporary?: boolean): HostResult<void>;
  writeBytes(file: string, bytes: Uint8Array, exclusive?: boolean): HostResult<void>;
  mkdir(directory: string): HostResult<void>;
  exists(file: string): HostResult<boolean>;
  remove(file: string): HostResult<void>;
  rename(from: string, to: string): HostResult<void>;
  list(directory: string): HostResult<HostEntry[]>;
  identity(file: string): Synced["disk"];
  checkLock(): HostResult<void>;
  checkOwnership(validate: (marker: string | null) => void): HostResult<void>;
  hash(bytes: Uint8Array): HostResult<string>;
  publish(staged: string, target: string, expectedHash: string | undefined, guard: () => HostResult<void>, active?: () => void): Promise<void>;
  stageDownload(options: DownloadOptions): Promise<void>;
  open(options: EngineOptions): Promise<{ origin: string; url: string }>;
  close(): Promise<void>;
}
