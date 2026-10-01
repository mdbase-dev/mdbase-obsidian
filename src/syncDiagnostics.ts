import type { MirrorProfile } from "./connectSync";
import type { SyncHistoryRun } from "./syncHistory";
import type { SyncSessionState } from "./syncSession";

export interface SyncDiagnosticsInput {
  generatedAt: string;
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  profile: MirrorProfile | null;
  otherDevice: boolean;
  automatic: boolean;
  otherSyncServices: string[];
  state: Readonly<SyncSessionState>;
  checkpoint: { cursor: number; generation: number; batch: string | null; failure: string | null } | null;
  history: SyncHistoryRun[];
}

/**
 * A plain-text report for support. It names collection and replica IDs and may
 * name files in recent history; it never includes credentials or note text.
 */
export function syncDiagnostics(input: SyncDiagnosticsInput): string {
  const { profile, state } = input;
  const lines = [
    "mdbase sync diagnostics",
    `Generated: ${input.generatedAt}`,
    `Plugin ${input.pluginVersion} · Obsidian ${input.obsidianVersion} · ${input.platform}`,
    "",
    "Connection",
  ];
  if (!profile) {
    lines.push("  Not connected");
  } else {
    lines.push(
      `  Collection: ${profile.collectionId}`,
      `  Replica: ${profile.replicaId} (${profile.mode})`,
      `  Connect: ${hostOf(profile.controlUrl)} · sync ${hostOf(profile.syncUrl)}`,
      `  Access token expires: ${profile.accessTokenExpiresAt}`,
      `  Enrolled on this device: ${input.otherDevice ? "no — copied from another device or vault" : "yes"}`,
      `  File classes: ${profile.selectiveSync?.file_classes.join(", ") || "notes only"}`,
      `  Excluded folders: ${profile.selectiveSync?.excluded_folders.length ?? 0}`,
    );
  }
  lines.push(
    `  Automatic sync: ${input.automatic ? "on" : "off"}${state.paused ? " (paused)" : ""}`,
    `  Other sync services on this vault: ${input.otherSyncServices.join(", ") || "none detected"}`,
    "",
    "State",
    `  Engine state: ${state.status?.state ?? "unknown"} · pending ${state.status?.pending ?? "?"} · conflicts ${state.status?.conflicts.length ?? 0} · local issues ${state.status?.local_issues.length ?? 0}`,
    `  Last synced: ${state.status?.last_synced_at ?? "never"}`,
    `  Problem: ${state.problem ? `${state.problem.kind}/${state.problem.code} — ${state.problem.message}` : "none"}`,
    `  Next automatic attempt: ${state.retryAt ? new Date(state.retryAt).toISOString() : "not scheduled"}`,
    `  Plan on screen: ${state.preview ? `${state.preview.plan.kind}, ${state.preview.plan.actions.length} actions, ${state.preview.plan.summary.blocking_issues} blocking issues` : "none"}`,
    `  Checkpoint: ${input.checkpoint ? `cursor ${input.checkpoint.cursor}, generation ${input.checkpoint.generation}` : "none"}`,
    `  Interrupted batch: ${input.checkpoint?.batch ?? "none"}${input.checkpoint?.failure ? ` (${input.checkpoint.failure})` : ""}`,
    "",
    "Recent history (newest first)",
  );
  const recent = [...input.history].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 25);
  if (!recent.length) lines.push("  none");
  for (const run of recent) {
    const what = run.summary ?? `${run.files.length} ${run.files.length === 1 ? "file" : "files"}`;
    lines.push(`  ${run.finishedAt} · ${run.outcome}${run.tone ? `/${run.tone}` : ""} · ${what}${run.message ? ` — ${run.message}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid URL";
  }
}
