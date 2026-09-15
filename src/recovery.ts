export interface RecoveryStatus {
  state: "checking" | "blocked";
  code: string;
  summary: string;
  nextAction: string;
}

const problems: Record<string, Pick<RecoveryStatus, "summary" | "nextAction">> = {
  invalid_plugin_settings: {
    summary: "Plugin settings could not be read safely.",
    nextAction: "Back up the vault and restore a verified plugin data.json backup for this vault, then retry. Do not discard enrollment settings to bypass this check.",
  },
  invalid_authority_adoption_checkpoint: {
    summary: "The collection-adoption checkpoint is invalid or unreadable.",
    nextAction: "Back up the vault, then inspect .mdbase/authority-adoption.json. Restore a verified checkpoint if available. Do not delete it: hosted activation may already have started.",
  },
  authority_adoption_state_conflict: {
    summary: "The adoption checkpoint and mirror connection disagree.",
    nextAction: "Preserve both checkpoints and verify the collection's authority before changing either. Retry only after the conflicting state has been repaired.",
  },
  invalid_mirror_marker: {
    summary: "The mirror role marker is invalid or unreadable.",
    nextAction: "Back up the vault and inspect .mdbase/connect-role.json. Restore a matching verified marker before retrying.",
  },
  mirror_marker_missing: {
    summary: "The mirror connection has no matching role marker.",
    nextAction: "Preserve plugin settings and .mdbase metadata. Verify which collection this vault mirrors before restoring the matching role marker.",
  },
};

/** Never include arbitrary exception text: storage errors may contain private data. */
export function initializationProblem(error: unknown): RecoveryStatus {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof candidate === "string" && Object.prototype.hasOwnProperty.call(problems, candidate)
    ? candidate : "initialization_failed";
  return {
    state: "blocked",
    code,
    ...(problems[code] ?? {
      summary: "Initialization could not safely finish.",
      nextAction: "Keep the vault and its recovery metadata intact. Check storage availability and permissions, then retry. If this repeats, copy the diagnostic summary for support.",
    }),
  };
}

export function checkingRecovery(): RecoveryStatus {
  return {
    state: "checking", code: "initialization_pending",
    summary: "Checking collection recovery state.",
    nextAction: "Wait for initialization to finish. Plugin writes and synchronization remain blocked.",
  };
}

export function recoveryDiagnostic(status: RecoveryStatus): string {
  return JSON.stringify({
    format: "mdbase-obsidian-recovery/v1",
    state: status.state,
    code: status.code,
    authority: "unverified",
    plugin_writes: "blocked",
  }, null, 2);
}
