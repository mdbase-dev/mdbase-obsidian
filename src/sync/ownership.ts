export type FolderHost = "desktop" | "plugin" | "wait";
export function folderHost(marker: unknown): FolderHost {
  if (marker === null) return "plugin";
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return "wait";
  const host = (marker as { host?: unknown }).host;
  return host === "daemon" ? "desktop" : host === "obsidian" ? "plugin" : "wait";
}
export function validVaultPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
