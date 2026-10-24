/**
 * The mdbase desktop app's background service (the daemon), as this plugin
 * sees it: its command-line tool for setup and status, and its state files for
 * the localhost link. Desktop only: Node modules are loaded on first use, never
 * at plugin load, so the bundle stays safe on mobile.
 */

/** The daemon's `{error}` object (`code` is one of the API's codes, `reason` finer). */
export class MdbaseError extends Error {
  constructor(readonly code: string, message: string, readonly reason?: string) {
    super(message);
    this.name = "MdbaseError";
  }
}

export type CollectionMode = "local" | "synced" | "synced_e2e";
export type CollectionState = "paused" | "opening" | "ready" | "moving" | "unavailable" | "failed";

export interface DaemonNotice {
  code: string;
  message: string;
}

export interface SyncCounters {
  confirmed_through: number;
  head_known: number;
  pending: number;
  holds: number;
  unresolved: number;
  /** "online", "connecting" or "offline". */
  connection: string;
  last_error?: string;
  resyncing?: boolean;
  unsupported_entries?: number;
}

export interface CollectionStatus {
  id: string;
  name: string;
  root: string;
  mode: CollectionMode;
  state: CollectionState;
  reason?: string;
  log: "none" | "hosted";
  origin?: string;
  sync?: SyncCounters;
  other_devices_online?: number;
  notices: DaemonNotice[];
}

export interface AccountInfo {
  signed_in: boolean;
  online: boolean;
  pairing?: string;
  last_error?: string;
  account_id?: string;
  server?: string;
  computer_name?: string;
  environment?: string;
}

export interface DaemonStatus {
  account: AccountInfo;
  collections: CollectionStatus[];
  device?: { device_id: string; noise_pk: string };
}

export interface HoldSummary {
  id: string;
  path: string;
  reason: string;
  since: number;
  saves: number;
  has_theirs: boolean;
  binary?: boolean;
}

export interface PendingDevice {
  device: string;
  name?: string;
  kind?: string;
}

/** The localhost link files (`daemon.json` + `local-link.json`). */
export interface LinkFiles {
  port: number;
  token: string;
  device: string;
  noisePk: string;
}

interface NodeModules {
  childProcess: typeof import("child_process");
  fs: typeof import("fs");
  os: typeof import("os");
  path: typeof import("path");
}

let nodeModules: NodeModules | null = null;

/** Node built-ins through Obsidian desktop's `require`, loaded only when called. */
export function desktopModules(): NodeModules {
  if (nodeModules) return nodeModules;
  const load = (window as unknown as { require?: (id: string) => unknown }).require;
  if (typeof load !== "function") throw new MdbaseError("unavailable", "Sync needs Obsidian for desktop.", "mobile");
  nodeModules = {
    childProcess: load("child_process") as NodeModules["childProcess"],
    fs: load("fs") as NodeModules["fs"],
    os: load("os") as NodeModules["os"],
    path: load("path") as NodeModules["path"],
  };
  return nodeModules;
}

function platform(): NodeJS.Platform {
  return (window as unknown as { process?: { platform?: NodeJS.Platform } }).process?.platform ?? "linux";
}

function env(name: string): string | undefined {
  return (window as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

/** Where the desktop app installs its `mdbase` tool, most likely first. */
export function candidateBinaries(os: NodeJS.Platform, home: string, vars: (name: string) => string | undefined, listDir: (dir: string) => string[]): string[] {
  const out: string[] = [];
  const pathSep = os === "win32" ? ";" : ":";
  const exe = os === "win32" ? "mdbase.exe" : "mdbase";
  if (os === "darwin") {
    for (const apps of ["/Applications", `${home}/Applications`]) {
      out.push(`${apps}/mdbase connect.app/Contents/Resources/mdbase-next/mdbase`);
    }
    out.push("/opt/homebrew/bin/mdbase", "/usr/local/bin/mdbase");
  } else if (os === "win32") {
    const local = vars("LOCALAPPDATA");
    if (local) {
      const base = `${local}\\mdbase_connect`;
      const versions = listDir(base).filter((name) => /^app-\d/.test(name)).sort(compareAppVersions).reverse();
      for (const version of versions) out.push(`${base}\\${version}\\resources\\mdbase-next\\mdbase.exe`);
    }
  } else {
    out.push("/usr/bin/mdbase", "/usr/local/bin/mdbase", `${home}/.local/bin/mdbase`, "/usr/lib/mdbase-connect/resources/mdbase-next/mdbase");
  }
  for (const dir of (vars("PATH") ?? "").split(pathSep)) if (dir) out.push(os === "win32" ? `${dir}\\${exe}` : `${dir}/${exe}`);
  return [...new Set(out)];
}

function compareAppVersions(a: string, b: string): number {
  const parts = (value: string) => value.replace(/^app-/, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The first installed `mdbase` tool, or null. `override` is the settings path. */
export function findBinary(override: string): string | null {
  const { fs, os } = desktopModules();
  if (override.trim()) return fs.existsSync(override.trim()) ? override.trim() : null;
  const listDir = (dir: string) => {
    try { return fs.readdirSync(dir); } catch { return []; }
  };
  for (const candidate of candidateBinaries(platform(), os.homedir(), env, listDir)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not installed there.
    }
  }
  return null;
}

/** The daemon's state directory for this user (fixed per OS; see the daemon's `paths.rs`). */
export function stateDir(os: NodeJS.Platform, home: string, vars: (name: string) => string | undefined): string {
  if (os === "win32") return `${vars("LOCALAPPDATA") ?? `${home}\\AppData\\Local`}\\mdbase\\state`;
  if (os === "darwin") return `${home}/Library/Application Support/mdbase`;
  return `${home}/.local/state/mdbase`;
}

/** Read the link files. They change at every daemon start, so read them for each connection. */
export async function readLinkFiles(): Promise<LinkFiles> {
  const { fs, os, path } = desktopModules();
  const dir = stateDir(platform(), os.homedir(), env);
  const read = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(dir, name), "utf8")) as Record<string, unknown>;
    } catch {
      throw new MdbaseError("unavailable", "mdbase isn't running on this computer.", "daemon_not_running");
    }
  };
  const identity = await read("daemon.json");
  const link = await read("local-link.json");
  const hex64 = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (typeof identity.device !== "string" || !hex64(identity.noise_pk) || !Number.isInteger(link.port) || !hex64(link.token)) {
    throw new MdbaseError("internal", "mdbase's connection files on this computer are incomplete. Restart the mdbase app.");
  }
  return { port: link.port as number, token: link.token as string, device: identity.device, noisePk: identity.noise_pk as string };
}

export interface RunOptions {
  /** The person already confirmed in this plugin; skip the tool's own terminal prompt. */
  yes?: boolean;
  timeoutMs?: number;
}

/** Runs `mdbase --json …`. Errors come back as {@link MdbaseError}. */
export class MdbaseCli {
  constructor(private readonly binary: () => string | null) {}

  run<T>(args: string[], options: RunOptions = {}): Promise<T> {
    const binary = this.binary();
    if (!binary) return Promise.reject(new MdbaseError("not_found", "The mdbase app isn't installed on this computer.", "not_installed"));
    const { childProcess } = desktopModules();
    const argv = ["--json", ...(options.yes ? ["--yes"] : []), ...args];
    return new Promise<T>((resolve, reject) => {
      childProcess.execFile(binary, argv, { timeout: options.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const text = String(stdout).trim();
        let value: unknown = undefined;
        if (text) {
          try { value = JSON.parse(text); } catch { value = undefined; }
        }
        const failure = value && typeof value === "object" ? (value as { error?: { code?: string; message?: string; reason?: string } }).error : undefined;
        if (failure) {
          reject(new MdbaseError(failure.code ?? "internal", failure.message ?? "mdbase reported a problem.", failure.reason));
          return;
        }
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "EACCES") reject(new MdbaseError("not_found", "The mdbase app isn't installed on this computer.", "not_installed"));
          else if ((error as { killed?: boolean }).killed) reject(new MdbaseError("timeout", "mdbase took too long to answer."));
          else reject(new MdbaseError("internal", String(stderr).trim().replace(/^error:\s*/, "") || error.message));
          return;
        }
        resolve((value ?? {}) as T);
      });
    });
  }

  status(): Promise<DaemonStatus> {
    return this.run<DaemonStatus>(["status"], { timeoutMs: 15_000 });
  }
}

/** Normalized folder path for comparison. */
export function samePath(a: string, b: string, os: NodeJS.Platform = platform()): boolean {
  return normalizeFolder(a, os) === normalizeFolder(b, os);
}

function normalizeFolder(value: string, os: NodeJS.Platform): string {
  let out = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (os === "win32" || os === "darwin") out = out.toLowerCase();
  return out;
}

/**
 * This vault's collection: one whose folder is the vault, or else one inside it.
 * `prefix` is the collection folder relative to the vault ("" for the vault itself).
 */
export function vaultCollection(status: DaemonStatus, vaultPath: string, os: NodeJS.Platform = platform()): { collection: CollectionStatus; prefix: string } | null {
  const vault = normalizeFolder(vaultPath, os);
  const exact = status.collections.find((c) => normalizeFolder(c.root, os) === vault);
  if (exact) return { collection: exact, prefix: "" };
  const inner = status.collections.find((c) => normalizeFolder(c.root, os).startsWith(`${vault}/`));
  if (!inner) return null;
  const original = inner.root.replace(/\\/g, "/").replace(/\/+$/, "");
  return { collection: inner, prefix: original.slice(vaultPath.replace(/\\/g, "/").replace(/\/+$/, "").length + 1) };
}

/** A collection ID from what someone pasted: a bare ID or any link containing one. */
export function collectionIdFrom(text: string): string | null {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
  return match ? match[0].toLowerCase() : null;
}
