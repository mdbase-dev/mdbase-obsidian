import type { SyncSnapshot } from "./controller";

export type Tone = "ok" | "busy" | "quiet" | "attention" | "problem";

/** What the status bar, ribbon and Sync heading say about this vault. */
export interface SyncSummary {
  /** Short, for the status bar. */
  label: string;
  /** One sentence. */
  detail: string;
  tone: Tone;
  /** True once this vault syncs (or should be syncing). */
  syncing: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function modeName(mode: string | undefined): string {
  return mode === "synced_e2e" ? "Private" : mode === "synced" ? "Cloud copy" : "This computer only";
}

/** Private works on the first computer only until the mdbase app can approve another one. */
export const PRIVATE_FIRST_COMPUTER = "Private collections work on the first computer only for now, so this computer can't sync this one yet. Your notes here are untouched. Cloud copy collections have no such limit.";

/** Plain words for incident and notice codes from mdbase. */
const INCIDENTS: Record<string, string> = {
  // A second computer can't be approved yet, so don't promise an approval that never comes.
  waiting_for_key: PRIVATE_FIRST_COMPUTER,
  foreign_sync_tool: "Another sync tool is also changing these files. Use one sync tool per vault.",
  quota_exceeded: "Your mdbase storage is full. Changes stay on this computer until there's room.",
  access_revoked: "This computer no longer has access to the collection.",
  read_only: "You can read this collection but not change it.",
  upgrade_required: "Update the mdbase app to keep syncing.",
  integrity: "mdbase found a problem with the synced data and stopped to keep your notes safe.",
  verification_mismatch: "mdbase found a problem with the synced data and stopped to keep your notes safe.",
  key_inconsistent: "mdbase found a problem with this collection's keys and stopped to keep your notes safe.",
  gone: "This collection was deleted from your account.",
  log_regressed: "The synced history went backwards. mdbase stopped to keep your notes safe.",
};

export function incidentText(kind: string): string {
  return INCIDENTS[kind] ?? "mdbase needs attention for this collection.";
}

const STATE_REASONS: Record<string, string> = {
  folder_missing: "The vault folder moved or was renamed. Re-add it from Sync.",
  runtime_pending: "mdbase is still preparing this collection.",
  sync_not_eligible: "This computer's mdbase sign-in stopped working, so sync is stopped here. Your notes here are untouched.",
};

export function summarize(s: SyncSnapshot): SyncSummary {
  const off = (label: string, detail: string, tone: Tone = "quiet"): SyncSummary => ({ label, detail, tone, syncing: false });
  if (s.direct) {
    const { text, phase } = s.direct;
    const ready = phase.kind === "ready";
    const problem = phase.kind === "problem" || phase.kind === "blocked" || /blocked|failed|stopped|ownership/i.test(text);
    const checking = /checking your files|uploading|downloading/i.test(text);
    const label = problem ? "Sync needs attention" : checking ? "Syncing" : ready ? (phase.sync?.kind === "offline" ? "Offline" : phase.sync?.pending ? "Syncing" : "Synced") : phase.kind === "signed_out" ? "Sync off" : phase.kind === "choosing" ? "Choose collection" : phase.kind === "authorizing" ? "Finish sign-in" : "Starting sync";
    return { label, detail: text, tone: problem ? "problem" : checking ? "busy" : ready ? "ok" : "quiet", syncing: ready };
  }
  if (s.daemon === "mobile") return off("Sync on desktop", "Sync isn't available on phones and tablets yet.");
  if (s.daemon === "checking") return off("Checking sync", "Checking mdbase on this computer.");
  if (s.daemon === "not_installed") return off("Sync off", "Install the mdbase app to sync this vault.");
  const wasSyncing = Boolean(s.collection && s.collection.mode !== "local");
  if (s.daemon === "not_running") {
    return { label: "mdbase stopped", detail: wasSyncing ? "The mdbase app isn't running. Changes are saved here and sync when it starts." : "The mdbase app isn't running.", tone: "attention", syncing: wasSyncing };
  }
  if (s.daemon === "error") return { label: "Sync problem", detail: s.error ? errorText(s.error) : "mdbase didn't answer.", tone: "problem", syncing: wasSyncing };
  const c = s.collection;
  if (!c) return off("Sync off", "This vault isn't synced.");
  if (c.mode === "local") return off("Sync off", "This vault is an mdbase collection on this computer only.");
  const on = (label: string, detail: string, tone: Tone): SyncSummary => ({ label, detail, tone, syncing: true });
  if (!s.status?.account.signed_in) return on("Signed out", "Sign in to keep syncing. Changes are saved on this computer meanwhile.", "attention");
  if (c.state === "paused") return on("Sync paused", "Sync is paused. Changes are saved on this computer.", "attention");
  if (c.state === "failed" || c.state === "unavailable") {
    return on("Sync stopped", STATE_REASONS[c.reason ?? ""] ?? "mdbase stopped syncing this vault. Your files are untouched.", "problem");
  }
  if (c.sync?.last_error === "waiting_for_key" || s.live?.incidents.some((i) => i.kind === "waiting_for_key")) {
    return on("Private: first computer only", PRIVATE_FIRST_COMPUTER, "attention");
  }
  if (c.state === "opening") return on("Starting sync", "mdbase is getting this vault ready.", "busy");
  if (c.state === "moving") return on("Setting up sync", "mdbase is uploading this vault for the first time.", "busy");
  const incident = s.live?.incidents[0]?.kind;
  if (incident) return on("Sync needs attention", incidentText(incident), "problem");
  const holds = s.holds.length || (s.live?.holds ?? c.sync?.holds ?? 0);
  if (holds) return on(plural(holds, "file needs you", "files need you"), `${plural(holds, "file was", "files were")} changed in two places. Choose which version to keep.`, "attention");
  const unresolved = s.live?.unresolved ?? c.sync?.unresolved ?? 0;
  const pending = s.live?.pending ?? c.sync?.pending ?? 0;
  let connection = s.live?.connection ?? c.sync?.connection ?? "offline";
  // While the server can't be reached the link keeps "connecting"; the account knows it's offline.
  if (connection !== "online" && s.status?.account.online === false) connection = "offline";
  const confirmed = s.live?.confirmedThrough ?? c.sync?.confirmed_through ?? 0;
  const head = s.live?.headKnown ?? c.sync?.head_known ?? 0;
  if (connection === "offline") {
    return on("Offline", pending ? `Offline. ${plural(pending, "change is", "changes are")} saved here and will sync when you're back online.` : "Offline. Changes are saved here and sync when you're back online.", "quiet");
  }
  if (connection === "connecting") {
    return on("Connecting", pending ? `Connecting to mdbase. ${plural(pending, "change is", "changes are")} saved here meanwhile.` : "Connecting to mdbase.", "busy");
  }
  if (pending) return on("Syncing", `Sending ${plural(pending, "change", "changes")}.`, "busy");
  if (confirmed < head) return on("Updating", "Getting changes from your other devices.", "busy");
  if (unresolved) return on("Synced", `Synced. ${plural(unresolved, "edit", "edits")} made on two devices at once ${unresolved === 1 ? "is" : "are"} worth a look.`, "ok");
  return on("Synced", "Synced. Changes save here and reach your other devices.", "ok");
}

/** Human wording for an error from mdbase, by code and reason. */
export function errorText(error: { code: string; reason?: string; message: string }): string {
  if (/credential store|keychain|keyring/i.test(error.message)) return errorText({ ...error, message: "", reason: "keychain_unavailable" });
  // The server answers a join for a collection it doesn't know (or that isn't this kind) with not_current_*.
  if (/not_current_(cloud_copy|private)/.test(error.message)) return "mdbase couldn't find that collection in your account. Check the link and the account you're signed in to.";
  switch (error.reason) {
    case "not_installed": return "The mdbase app isn't installed on this computer.";
    case "daemon_not_running": return "The mdbase app isn't running.";
    case "daemon_unreachable": return "Obsidian couldn't reach the mdbase app. Restart it, then try again.";
    case "folder_not_empty": return "That folder already has files. Choose a new folder name.";
    case "already_registered": return "This collection is already on this computer.";
    case "bad_id": return "That doesn't look like a collection link or ID.";
    case "sync_refused": return "mdbase's server didn't allow that. Try again later.";
    case "link_not_approved": return "Obsidian wasn't allowed to use mdbase. Choose Allow when mdbase asks.";
    case "keychain_unavailable":
    case "credential_store_unavailable": return "mdbase can't reach this computer's password store. Unlock it, or sign in to your desktop session again.";
    case "not_signed_in":
    case "registration_mismatch": return "This computer's mdbase sign-in stopped working, so sync is stopped here. Your notes here are untouched.";
    case "account_changed": return "You signed in to a different account. Try again.";
    case "sign_in_failed": return `Sign-in didn't finish: ${error.message}`;
    case "overlapping_state_dir": return "This folder can't be synced.";
    default: break;
  }
  switch (error.code) {
    case "unauthenticated": return "Sign in to mdbase first.";
    case "forbidden": return "Your account doesn't allow that.";
    case "rate_limited": return "Too many attempts. Wait a few minutes, then try again.";
    case "quota_exceeded": return "Your mdbase storage is full.";
    case "upgrade_required": return "Update the mdbase app, then try again.";
    case "not_found": return error.reason === "not_installed" ? "The mdbase app isn't installed on this computer." : "mdbase couldn't find that collection in your account.";
    case "timeout": return "mdbase took too long to answer. Try again.";
    case "unavailable": return "mdbase can't reach the server right now. Check your connection and try again.";
    default: return error.message ? sentence(error.message) : "Something went wrong in mdbase.";
  }
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** Plain words for why a file was held. */
export function holdReasonText(reason: string): string {
  switch (reason) {
    case "conflict": return "Changed here and on another device";
    case "deleted_elsewhere": return "Deleted on another device, changed here";
    case "editor_busy": return "Open with unsaved changes";
    case "read_only": return "You can't change this collection";
    case "suspect_write": return "Changed by another program";
    case "unknown_provenance": return "Changed while mdbase wasn't watching";
    default: return "Waiting for your choice";
  }
}
