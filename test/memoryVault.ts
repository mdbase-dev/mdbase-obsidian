import { normalizePath, TFile, TFolder } from "obsidian";

/** An in-memory Vault with the subset of Obsidian's API the mirror adapter uses. */
export interface StoredFile {
  file: TFile;
  content: string;
}

export const TestFile = TFile as unknown as { new (path: string): TFile };
export const TestFolder = TFolder as unknown as { new (path: string): TFolder };

export class MemoryVault {
  readonly files = new Map<string, StoredFile>();
  readonly binaryFiles = new Map<string, { file: TFile; content: ArrayBuffer }>();
  readonly folders = new Map<string, TFolder>();
  failTargetPath: string | null = null;
  failCreatePath: string | null = null;
  failReadPath: string | null = null;
  corruptTargetPath: string | null = null;
  targetWrites = 0;

  adapter = {
    stat: async (path: string) => {
      const entry = this.getAbstractFileByPath(path);
      return entry ? { type: entry instanceof TFolder ? "folder" as const : "file" as const } : null;
    },
    exists: async (path: string): Promise<boolean> => {
      const normalized = normalizePath(path);
      return this.files.has(normalized) || this.binaryFiles.has(normalized) || this.folders.has(normalized);
    },
    read: async (path: string): Promise<string> => {
      const entry = this.files.get(normalizePath(path));
      if (!entry) throw new Error(`missing ${path}`);
      return entry.content;
    },
    readBinary: async (path: string): Promise<ArrayBuffer> => {
      const normalized = normalizePath(path);
      if (normalized === this.failReadPath) throw new Error(`unreadable ${path}`);
      const text = this.files.get(normalized);
      if (text) return new TextEncoder().encode(text.content).buffer;
      const binary = this.binaryFiles.get(normalized);
      if (binary) return binary.content.slice(0);
      throw new Error(`missing ${path}`);
    },
    write: async (path: string, content: string): Promise<void> => {
      const normalized = normalizePath(path);
      const existing = this.files.get(normalized)?.file ?? new TestFile(normalized);
      this.files.set(normalized, { file: existing, content });
    },
    remove: async (path: string): Promise<void> => {
      const normalized = normalizePath(path);
      this.files.delete(normalized);
      this.binaryFiles.delete(normalized);
    },
    copy: async (source: string, target: string): Promise<void> => {
      const sourcePath = normalizePath(source);
      const targetPath = normalizePath(target);
      const text = this.files.get(sourcePath);
      if (text) {
        const file = new TestFile(targetPath);
        this.files.set(targetPath, { file, content: text.content });
        return;
      }
      const binary = this.binaryFiles.get(sourcePath);
      if (binary) {
        const file = new TestFile(targetPath);
        this.binaryFiles.set(targetPath, { file, content: binary.content.slice(0) });
        return;
      }
      throw new Error(`missing ${source}`);
    },
  };

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const normalized = normalizePath(path);
    return this.files.get(normalized)?.file ?? this.binaryFiles.get(normalized)?.file ?? this.folders.get(normalized) ?? null;
  }

  getMarkdownFiles(): TFile[] {
    return [
      ...[...this.files.values()].map((entry) => entry.file),
      ...[...this.binaryFiles.values()].map((entry) => entry.file),
    ].filter((file) => file.extension === "md");
  }

  getFiles(): TFile[] {
    return [
      ...[...this.files.values()].map((entry) => entry.file),
      ...[...this.binaryFiles.values()].map((entry) => entry.file),
    ];
  }

  async cachedRead(file: TFile): Promise<string> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing ${file.path}`);
    return entry.content;
  }

  async create(path: string, content: string): Promise<TFile> {
    const normalized = normalizePath(path);
    if (normalized === this.failCreatePath) throw new Error("injected adapter create failure");
    if (this.files.has(normalized) || this.folders.has(normalized)) throw new Error(`exists ${normalized}`);
    const file = new TestFile(normalized);
    this.files.set(normalized, { file, content });
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    if (
      file.path === this.failTargetPath
      && (content.includes("kind: mdbase.type") || content.includes('"kind": "mdbase.type"'))
    ) {
      this.targetWrites += 1;
      throw new Error("injected migration target write failure");
    }
    if (
      file.path === this.corruptTargetPath
      && (content.includes("kind: mdbase.type") || content.includes('"kind": "mdbase.type"'))
    ) {
      this.files.set(file.path, { file, content: `${content}# injected corruption\n` });
      return;
    }
    this.files.set(file.path, { file, content });
  }

  async process(file: TFile, transform: (current: string) => string): Promise<string> {
    const current = this.read(file.path);
    if (current === null) throw new Error(`missing ${file.path}`);
    const next = transform(current);
    this.files.set(file.path, { file, content: next });
    return next;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const entry = this.binaryFiles.get(file.path);
    if (!entry) throw new Error(`missing binary ${file.path}`);
    return entry.content.slice(0);
  }

  async createBinary(path: string, content: ArrayBuffer): Promise<TFile> {
    const normalized = normalizePath(path);
    if (this.files.has(normalized) || this.binaryFiles.has(normalized) || this.folders.has(normalized)) throw new Error(`exists ${normalized}`);
    const file = new TestFile(normalized);
    this.binaryFiles.set(normalized, { file, content: content.slice(0) });
    return file;
  }

  async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
    this.binaryFiles.set(file.path, { file, content: content.slice(0) });
  }

  async createFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!this.folders.has(normalized)) this.folders.set(normalized, new TestFolder(normalized));
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
    this.binaryFiles.delete(file.path);
  }

  async rename(file: TFile, target: string): Promise<void> {
    const normalized = normalizePath(target);
    if (this.getAbstractFileByPath(normalized)) throw new Error(`exists ${normalized}`);
    const text = this.files.get(file.path);
    const binary = this.binaryFiles.get(file.path);
    if (text) {
      this.files.delete(file.path);
      const renamed = new TestFile(normalized);
      this.files.set(normalized, { file: renamed, content: text.content });
      return;
    }
    if (binary) {
      this.binaryFiles.delete(file.path);
      const renamed = new TestFile(normalized);
      this.binaryFiles.set(normalized, { file: renamed, content: binary.content });
      return;
    }
    throw new Error(`missing ${file.path}`);
  }

  read(path: string): string | null {
    return this.files.get(normalizePath(path))?.content ?? null;
  }

  readBytes(path: string): Uint8Array | null {
    const content = this.binaryFiles.get(normalizePath(path))?.content;
    return content ? new Uint8Array(content.slice(0)) : null;
  }
}

