import type { MdbaseSync } from "@mdbase-dev/sdk/thin-client";
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

/**
 * Why an unlock didn't work, by the sync engine's problem key. Anything else
 * falls back to the engine's own sentence.
 */
const UNLOCK_PROBLEMS: Record<string, string> = {
  wrong_secret: "That password or recovery key doesn't match. Check it and try again.",
  invalid_recovery_key: "That doesn't look like a recovery key. Check for missing or mistyped characters.",
  rate_limited: "Too many tries. Wait a few minutes, then try again.",
  unavailable: "Couldn't reach mdbase. Check your connection and try again.",
  unlock_unavailable: "This version of the plugin can't unlock Private collections. Update it, then try again.",
  unlock_failed: "That was right, but this collection didn't hand over its key. Try again. If it keeps happening, open the mdbase app on a computer that has this collection.",
};
export function unlockProblemText(problem: unknown): string | null {
  if (!problem || typeof problem !== "object") return null;
  const p = problem as { key?: unknown; message?: unknown };
  return (typeof p.key === "string" && UNLOCK_PROBLEMS[p.key]) || (typeof p.message === "string" && p.message) || "Couldn't unlock this collection. Try again.";
}

/**
 * Shown where collections are chosen. mdbase lists a Private collection only
 * when this device may hold its key, so the plugin can't know one is missing.
 * The SDK doesn't say whether the server offers that choice (production
 * doesn't yet), so the words must hold either way and promise no option.
 */
export const PRIVATE_COLLECTIONS_HINT = "Private collections are listed only if mdbase let this device keep their key when you signed in. mdbase doesn't offer that everywhere yet.";
/** The same, before signing in, where the collection is chosen in the browser. */
export const PRIVATE_SIGN_IN_HINT = "Private collections sync here only if mdbase offers to let this device keep their key when you sign in.";

/** After "Move to mdbase app": Obsidian stopped on purpose. Not an error. */
export const HANDED_OVER = "Obsidian has stopped syncing this vault. To keep it syncing, add this folder in the mdbase app and pick the same collection.";

/** This vault's collection is waiting to be approved in mdbase again. */
export const NEEDS_APPROVAL = "This vault's collection needs approving in mdbase before it can sync. Your notes here are untouched. Choose Request access again and approve it in your browser.";

/** A bound collection waiting for the person to approve it again in the browser. */
export const AWAITING_APPROVAL = "Waiting for you to approve access in your browser. Your notes here are untouched.";

/** Sync has been starting for too long; Restart sync builds the sync host afresh. */
export const STARTING_STALLED = "Sync hasn't started. Your notes here are untouched. Choose Restart sync to try again.";

/**
 * Sign-in broke before any collection was chosen. Restarting sync resumes the
 * same broken sign-in, so the way on is Start over.
 */
export const SIGN_IN_STOPPED = "Sign-in stopped working. Your notes here are untouched. Choose Start over to sign in again.";

/**
 * Why sync stopped, by the sync engine's problem key. Anything else uses the
 * engine's own title and message.
 */
const STOP_PROBLEMS: Record<string, string> = {
  installation_scope_removed: "Access to this collection was removed in mdbase. Your notes here are untouched. To sync again, choose Request access again and approve it in your browser.",
  // The engine says "Reload"; in Obsidian that is Restart sync.
  application_failed: "Something inside sync stopped working. Your notes here are untouched. Choose Restart sync to continue.",
  recovery_required: "It stopped to keep your data safe. Your notes here are untouched. Choose Restart sync to continue.",
};
export function stoppedText(problem: unknown): string {
  const p = (problem && typeof problem === "object" ? problem : {}) as { key?: unknown; title?: unknown; message?: unknown; action?: unknown };
  const known = typeof p.key === "string" ? STOP_PROBLEMS[p.key] : undefined;
  let words = known ?? [p.title, p.message].filter((x): x is string => typeof x === "string" && x.trim() !== "").map(sentence).join(" ");
  if (!known && p.action === "reload") words = `${words ? `${words} ` : ""}Choose Restart sync to continue.`;
  // An unfinished sign-in didn't stop anything: say what happened, not "Sync stopped".
  if (p.action === "sign_in" && words) return words;
  return `Sync stopped. ${words || "Your files are kept on this computer."}`;
}

/** The status sentence for a stop the plugin itself noticed (not the sync engine). */
export function failedText(reason: string): string {
  return `Sync stopped. ${sentence(reason)}`;
}

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

type ReadySync = Pick<MdbaseSync, "state" | "connection" | "pending" | "health"> & { installing?: boolean };

/**
 * Sync can't reach mdbase from here: no network, or the service did not answer.
 * A busy or rate-limited service, or a replica still connecting, is not offline.
 */
export function syncOffline(sync: ReadySync | null | undefined): boolean {
  return sync?.connection === "offline" || sync?.health === "unreachable";
}

/** The ready state in words. */
export function readyText(sync: ReadySync | null | undefined): string {
  const waiting = sync?.pending ? `${sync.pending === 1 ? "1 change" : `${sync.pending.toLocaleString()} changes`} waiting to send.` : "";
  if (syncOffline(sync)) return `Offline. Changes are saved here and sync when the connection returns.${waiting ? ` ${waiting}` : ""}`;
  if (sync?.state === "catching_up") return sync.installing ? "Downloading the collection." : "Getting the latest changes from your other devices.";
  if (sync?.health === "server_busy" || sync?.health === "rate_limited") return "mdbase is busy. Sync carries on shortly.";
  return waiting || "Everything is up to date.";
}

export function summarize(s: SyncSnapshot): SyncSummary {
  const off = (label: string, detail: string, tone: Tone = "quiet"): SyncSummary => ({ label, detail, tone, syncing: false });
  if (s.direct) {
    const { text, phase } = s.direct;
    const ready = phase.kind === "ready";
    if (s.direct.merge) return { label: "Waiting for you", detail: `This vault and “${s.direct.merge.name}” both have notes. Open Sync to choose what happens.`, tone: "attention", syncing: false };
    // Moved to the mdbase app on purpose: say what happened and what's next, calmly.
    if (phase.kind === "handed_over") return { label: "Moved to mdbase app", detail: HANDED_OVER, tone: "quiet", syncing: true };
    // Sign-in that wasn't approved: one step for the person, not a fault.
    if (phase.kind === "problem" && (phase.problem as { action?: unknown } | null | undefined)?.action === "sign_in") {
      return { label: "Sign in again", detail: text, tone: "attention", syncing: true };
    }
    // Waiting for approval is a vault that syncs here and has stopped: show it.
    if (phase.kind === "needs_approval") return { label: "Needs approval", detail: text, tone: "attention", syncing: true };
    // Request access again was chosen: the vault still syncs here, once approved.
    if (phase.kind === "authorizing" && s.direct.bound) return { label: "Waiting for approval", detail: text, tone: "attention", syncing: true };
    // Starting that never finishes must not look like nothing is wrong.
    if (phase.kind === "starting" && phase.stalled) return { label: "Sync not starting", detail: text, tone: "attention", syncing: true };
    const problem = phase.kind === "problem" || phase.kind === "blocked" || /blocked|failed|stopped|ownership/i.test(text);
    // Locked and stopped are states of a vault that syncs here: the status bar
    // must say so rather than hide, or it would keep its last words ("Synced").
    if (phase.kind === "needs_unlock" && !problem) {
      return phase.unlock?.unlocking
        ? { label: "Unlocking", detail: text, tone: "busy", syncing: true }
        : { label: "Locked", detail: text, tone: "attention", syncing: true };
    }
    const failed = s.direct.failures?.length ?? 0;
    if (ready && !problem && failed) {
      const files = failed === 1 ? "1 file" : `${failed} files`;
      return { label: `${files} not synced`, detail: "Everything else is in sync.", tone: "attention", syncing: true };
    }
    // Offline outranks progress text: an upload that can't reach mdbase isn't
    // progressing, and the offline notice alone disappears (QA-3).
    const offline = ready && !problem && syncOffline(phase.sync);
    if (offline) return { label: "Offline", detail: readyText(phase.sync), tone: "attention", syncing: true };
    const checking = /checking your files|uploading|downloading/i.test(text);
    const label = problem ? "Sync needs attention" : checking ? "Syncing" : ready ? (syncOffline(phase.sync) ? "Offline" : phase.sync?.pending ? "Syncing" : "Synced") : phase.kind === "signed_out" ? "Sync off" : phase.kind === "choosing" ? "Choose collection" : phase.kind === "authorizing" ? "Finish sign-in" : "Starting sync";
    const detail = ready && !problem && !checking ? readyText(phase.sync) : text;
    return { label, detail, tone: problem ? "problem" : checking ? "busy" : ready ? "ok" : "quiet", syncing: ready || problem };
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
