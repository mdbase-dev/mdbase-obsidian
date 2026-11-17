import { plural, t } from "@lingui/core/macro";
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


export function modeName(mode: string | undefined): string {
  return mode === "synced_e2e" ? t({ message: "Private", context: "collection mode" }) : mode === "synced" ? t`Cloud copy` : t`This computer only`;
}

/** Private works on the first computer only until the mdbase app can approve another one. */
export function PRIVATE_FIRST_COMPUTER(): string { return t`Private collections work on the first computer only for now, so this computer can't sync this one yet. Your notes here are untouched. Cloud copy collections have no such limit.`; }

/**
 * Why an unlock didn't work, by the sync engine's problem key. Anything else
 * falls back to the engine's own sentence.
 */
const UNLOCK_PROBLEMS = (): Record<string, string> => ({
  wrong_secret: t`That password or recovery key doesn't match. Check it and try again.`,
  invalid_recovery_key: t`That doesn't look like a recovery key. Check for missing or mistyped characters.`,
  rate_limited: t`Too many tries. Wait a few minutes, then try again.`,
  unavailable: t`Couldn't reach mdbase. Check your connection and try again.`,
  unlock_unavailable: t`This version of the plugin can't unlock Private collections. Update it, then try again.`,
  unlock_failed: t`That was right, but this collection didn't hand over its key. Try again. If it keeps happening, open the mdbase app on a computer that has this collection.`,
});
export function unlockProblemText(problem: unknown): string | null {
  if (!problem || typeof problem !== "object") return null;
  const p = problem as { key?: unknown; message?: unknown };
  return (typeof p.key === "string" && UNLOCK_PROBLEMS()[p.key]) || (typeof p.message === "string" && p.message) || t`Couldn't unlock this collection. Try again.`;
}

// No hint about Private collections before or after signing in. mdbase lists
// only the collections this device may open, so the plugin can't tell whether
// an account has Private ones it can't open; most accounts have none, and a
// note shown to everyone would only puzzle them. When the SDK reports such
// collections, say so then, with a count and a way to add the key.

/** After "Move to mdbase app": Obsidian stopped on purpose. Not an error. */
export function HANDED_OVER(): string { return t`Obsidian has stopped syncing this vault. To keep it syncing, add this folder in the mdbase app and pick the same collection.`; }

/** This vault's collection is waiting to be approved in mdbase again. */
export function NEEDS_APPROVAL(): string { return t`This vault's collection needs approving in mdbase before it can sync. Your notes here are untouched. Choose Request access again and approve it in your browser.`; }

/** A bound collection waiting for the person to approve it again in the browser. */
export function AWAITING_APPROVAL(): string { return t`Waiting for you to approve access in your browser. Your notes here are untouched.`; }

/** Sync has been starting for too long; Restart sync builds the sync host afresh. */
export function STARTING_STALLED(): string { return t`Sync hasn't started. Your notes here are untouched. Choose Restart sync to try again.`; }

/**
 * Sign-in broke before any collection was chosen. Restarting sync resumes the
 * same broken sign-in, so the way on is Start over.
 */
export function CHOOSE_AGAIN_HINT(): string { return t`Your notes stay in this vault. If the collection you choose already has notes, you're asked before they're combined.`; }

export function SIGN_OUT_DESC(): string { return t`Stop syncing this vault and sign this device out of mdbase. Your notes stay in this vault. To sync again, sign in and choose a collection.`; }

/** Sign-out result fields the SDK reports (AppWebSignOutResult). */
export interface SignOutResult { server?: string; local?: string }

/**
 * What to tell the person after signing out, beyond "signed out": the SDK
 * signs this device out even when mdbase can't be reached, and says so here.
 */
export function signOutText(result: SignOutResult | null | undefined): string | null {
  if (result?.server === "incomplete" && result?.local === "incomplete") return t`Signed out on this device. mdbase couldn't be reached, so this device is still listed under your account with access to the collection. Remove it under Apps on the mdbase website. Some sign-in data on this device couldn't be removed.`;
  if (result?.server === "incomplete") return t`Signed out on this device. mdbase couldn't be reached, so this device is still listed under your account with access to the collection. Remove it under Apps on the mdbase website.`;
  if (result?.local === "incomplete") return t`Signed out on this device. Some sign-in data on this device couldn't be removed.`;
  return null;
}

export function SIGN_IN_STOPPED(): string { return t`Sign-in stopped working. Your notes here are untouched. Choose Start over to sign in again.`; }

/**
 * Why sync stopped, by the sync engine's problem key. Anything else uses the
 * engine's own title and message.
 */
const STOP_PROBLEMS = (): Record<string, string> => ({
  installation_scope_removed: t`Access to this collection was removed in mdbase. Your notes here are untouched. To sync again, choose Request access again and approve it in your browser.`,
  // The engine says "Reload"; in Obsidian that is Restart sync.
  application_failed: t`Something inside sync stopped working. Your notes here are untouched. Choose Restart sync to continue.`,
  recovery_required: t`It stopped to keep your data safe. Your notes here are untouched. Choose Restart sync to continue.`,
});
export function stoppedText(problem: unknown): string {
  const p = (problem && typeof problem === "object" ? problem : {}) as { key?: unknown; title?: unknown; message?: unknown; action?: unknown };
  const known = typeof p.key === "string" ? STOP_PROBLEMS()[p.key] : undefined;
  let words = known ?? [p.title, p.message].filter((x): x is string => typeof x === "string" && x.trim() !== "").map(sentence).join(" ");
  if (!known && p.action === "reload") words = words ? t`${words} Choose Restart sync to continue.` : t`Choose Restart sync to continue.`;
  // An unfinished sign-in didn't stop anything: say what happened, not "Sync stopped".
  if (p.action === "sign_in" && words) return words;
  return words ? t`Sync stopped. ${words}` : t`Sync stopped. Your files are kept on this device.`;
}

/** The status sentence for a stop the plugin itself noticed (not the sync engine). */
export function failedText(reason: string, alreadySentence = false): string {
  const detail = alreadySentence ? reason : sentence(reason);
  return t`Sync stopped. ${detail}`;
}

/** Plain words for incident and notice codes from mdbase. */
const INCIDENTS = (): Record<string, string> => ({
  // A second computer can't be approved yet, so don't promise an approval that never comes.
  waiting_for_key: PRIVATE_FIRST_COMPUTER(),
  foreign_sync_tool: t`Another sync tool is also changing these files. Use one sync tool per vault.`,
  quota_exceeded: t`Your mdbase storage is full. Changes stay on this computer until there's room.`,
  access_revoked: t`This computer no longer has access to the collection.`,
  read_only: t`You can read this collection but not change it.`,
  upgrade_required: t`Update the mdbase app to keep syncing.`,
  integrity: t`mdbase found a problem with the synced data and stopped to keep your notes safe.`,
  verification_mismatch: t`mdbase found a problem with the synced data and stopped to keep your notes safe.`,
  key_inconsistent: t`mdbase found a problem with this collection's keys and stopped to keep your notes safe.`,
  gone: t`This collection was deleted from your account.`,
  log_regressed: t`The synced history went backwards. mdbase stopped to keep your notes safe.`,
});

export function incidentText(kind: string): string {
  return INCIDENTS()[kind] ?? t`mdbase needs attention for this collection.`;
}

const STATE_REASONS = (): Record<string, string> => ({
  folder_missing: t`The vault folder moved or was renamed. Re-add it from Sync.`,
  runtime_pending: t`mdbase is still preparing this collection.`,
  sync_not_eligible: t`This computer's mdbase sign-in stopped working, so sync is stopped here. Your notes here are untouched.`,
});

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
  const pending = sync?.pending ?? 0;
  if (syncOffline(sync)) return pending
    ? t`Offline. Changes are saved here and sync when the connection returns. ${plural(pending, { one: "# change", other: "# changes" })} waiting to send.`
    : t`Offline. Changes are saved here and sync when the connection returns.`;
  if (sync?.state === "catching_up") return sync.installing ? t`Downloading the collection.` : t`Getting the latest changes from your other devices.`;
  if (sync?.health === "server_busy" || sync?.health === "rate_limited") return t`mdbase is busy. Sync carries on shortly.`;
  return pending ? t`${plural(pending, { one: "# change", other: "# changes" })} waiting to send.` : t`Everything is up to date.`;
}

export function summarize(s: SyncSnapshot): SyncSummary {
  const off = (label: string, detail: string, tone: Tone = "quiet"): SyncSummary => ({ label, detail, tone, syncing: false });
  if (s.direct) {
    const { text, phase } = s.direct;
    const ready = phase.kind === "ready";
    if (s.direct.merge) {
      const name = s.direct.merge.name;
      return { label: t`Waiting for you`, detail: t`This vault and “${name}” both have notes. Open Sync to choose what happens.`, tone: "attention", syncing: false };
    }
    // Moved to the mdbase app on purpose: say what happened and what's next, calmly.
    if (phase.kind === "handed_over") return { label: t`Moved to mdbase app`, detail: HANDED_OVER(), tone: "quiet", syncing: true };
    // Sign-in that wasn't approved: one step for the person, not a fault.
    if (phase.kind === "problem" && (phase.problem as { action?: unknown } | null | undefined)?.action === "sign_in") {
      return { label: t`Sign in again`, detail: text, tone: "attention", syncing: true };
    }
    // Waiting for approval is a vault that syncs here and has stopped: show it.
    if (phase.kind === "needs_approval") return { label: t`Needs approval`, detail: text, tone: "attention", syncing: true };
    // Request access again was chosen: the vault still syncs here, once approved.
    if (phase.kind === "authorizing" && s.direct.bound) return { label: t`Waiting for approval`, detail: text, tone: "attention", syncing: true };
    // A sign-in waiting in the browser is the person's next step: show it.
    if (phase.kind === "authorizing") return { label: t`Finish sign-in`, detail: text, tone: "attention", syncing: true };
    // Another app holds the folder. Not set up here (a fresh install, say): calm,
    // like sync being off. Set up here: sync has stopped, so it needs attention.
    if (phase.kind === "blocked" && phase.owner) {
      if (!s.direct.bound) return off(phase.takeover ? t`Sync off` : phase.owner === "unreadable" ? t`Sync waiting` : t`Synced by another app`, text);
      return { label: t`Sync paused`, detail: text, tone: "attention", syncing: true };
    }
    if (phase.kind === "unsupported") return off(t`Sync off`, text);
    // Starting that never finishes must not look like nothing is wrong.
    if (phase.kind === "starting" && phase.stalled) return { label: t`Sync not starting`, detail: text, tone: "attention", syncing: true };
    const problem = phase.kind === "problem" || phase.kind === "blocked" || phase.kind === "closed" || s.direct.statusKind === "problem";
    // Locked and stopped are states of a vault that syncs here: the status bar
    // must say so rather than hide, or it would keep its last words ("Synced").
    if (phase.kind === "needs_unlock" && !problem) {
      return phase.unlock?.unlocking
        ? { label: t`Unlocking`, detail: text, tone: "busy", syncing: true }
        : { label: t`Locked`, detail: text, tone: "attention", syncing: true };
    }
    const failed = s.direct.failures?.length ?? 0;
    if (ready && !problem && failed) {
      return { label: t`${plural(failed, { one: "# file", other: "# files" })} not synced`, detail: t`Everything else is in sync.`, tone: "attention", syncing: true };
    }
    // Offline outranks progress text: an upload that can't reach mdbase isn't
    // progressing, and the offline notice alone disappears (QA-3).
    const offline = ready && !problem && syncOffline(phase.sync);
    if (offline) return { label: t`Offline`, detail: readyText(phase.sync), tone: "attention", syncing: true };
    const checking = s.direct.statusKind === "busy";
    const label = problem ? t`Sync needs attention` : checking ? t`Syncing` : ready ? (syncOffline(phase.sync) ? t`Offline` : phase.sync?.pending ? t`Syncing` : t`Synced`) : phase.kind === "signed_out" ? t`Sync off` : phase.kind === "choosing" ? t`Choose collection` : phase.kind === "authorizing" ? t`Finish sign-in` : t`Starting sync`;
    const detail = ready && !problem && !checking ? readyText(phase.sync) : text;
    return { label, detail, tone: problem ? "problem" : checking ? "busy" : ready ? "ok" : "quiet", syncing: ready || problem };
  }
  if (s.daemon === "checking") return off(t`Checking sync`, t`Checking mdbase on this computer.`);
  if (s.daemon === "not_installed") return off(t`Sync off`, t`Install the mdbase app to sync this vault.`);
  const wasSyncing = Boolean(s.collection && s.collection.mode !== "local");
  if (s.daemon === "not_running") {
    return { label: t`mdbase stopped`, detail: wasSyncing ? t`The mdbase app isn't running. Changes are saved here and sync when it starts.` : t`The mdbase app isn't running.`, tone: "attention", syncing: wasSyncing };
  }
  if (s.daemon === "error") return { label: t`Sync problem`, detail: s.error ? errorText(s.error) : t`mdbase didn't answer.`, tone: "problem", syncing: wasSyncing };
  const c = s.collection;
  if (!c) return off(t`Sync off`, t`This vault isn't synced.`);
  if (c.mode === "local") return off(t`Sync off`, t`This vault is an mdbase collection on this computer only.`);
  const on = (label: string, detail: string, tone: Tone): SyncSummary => ({ label, detail, tone, syncing: true });
  if (!s.status?.account.signed_in) return on(t`Signed out`, t`Sign in to keep syncing. Changes are saved on this computer meanwhile.`, "attention");
  if (c.state === "paused") return on(t`Sync paused`, t`Sync is paused. Changes are saved on this computer.`, "attention");
  if (c.state === "failed" || c.state === "unavailable") {
    return on(t`Sync stopped`, STATE_REASONS()[c.reason ?? ""] ?? t`mdbase stopped syncing this vault. Your files are untouched.`, "problem");
  }
  if (c.sync?.last_error === "waiting_for_key" || s.live?.incidents.some((i) => i.kind === "waiting_for_key")) {
    return on(t`Private: first computer only`, PRIVATE_FIRST_COMPUTER(), "attention");
  }
  if (c.state === "opening") return on(t`Starting sync`, t`mdbase is getting this vault ready.`, "busy");
  if (c.state === "moving") return on(t`Setting up sync`, t`mdbase is uploading this vault for the first time.`, "busy");
  const incident = s.live?.incidents[0]?.kind;
  if (incident) return on(t`Sync needs attention`, incidentText(incident), "problem");
  const holds = s.holds.length || (s.live?.holds ?? c.sync?.holds ?? 0);
  if (holds) return on(plural(holds, { one: "# file needs you", other: "# files need you" }), plural(holds, { one: "# file was changed in two places. Choose which version to keep.", other: "# files were changed in two places. Choose which version to keep." }), "attention");
  const unresolved = s.live?.unresolved ?? c.sync?.unresolved ?? 0;
  const pending = s.live?.pending ?? c.sync?.pending ?? 0;
  let connection = s.live?.connection ?? c.sync?.connection ?? "offline";
  // While the server can't be reached the link keeps "connecting"; the account knows it's offline.
  if (connection !== "online" && s.status?.account.online === false) connection = "offline";
  const confirmed = s.live?.confirmedThrough ?? c.sync?.confirmed_through ?? 0;
  const head = s.live?.headKnown ?? c.sync?.head_known ?? 0;
  if (connection === "offline") {
    return on(t`Offline`, pending ? plural(pending, { one: "Offline. # change is saved here and will sync when you're back online.", other: "Offline. # changes are saved here and will sync when you're back online." }) : t`Offline. Changes are saved here and sync when you're back online.`, "quiet");
  }
  if (connection === "connecting") {
    return on(t`Connecting`, pending ? plural(pending, { one: "Connecting to mdbase. # change is saved here meanwhile.", other: "Connecting to mdbase. # changes are saved here meanwhile." }) : t`Connecting to mdbase.`, "busy");
  }
  if (pending) return on(t`Syncing`, t`Sending ${plural(pending, { one: "# change", other: "# changes" })}.`, "busy");
  if (confirmed < head) return on(t`Updating`, t`Getting changes from your other devices.`, "busy");
  if (unresolved) return on(t`Synced`, plural(unresolved, { one: "Synced. # edit made on two devices at once is worth a look.", other: "Synced. # edits made on two devices at once are worth a look." }), "ok");
  return on(t`Synced`, t`Synced. Changes save here and reach your other devices.`, "ok");
}

/** Human wording for an error from mdbase, by code and reason. */
export function errorText(error: { code: string; reason?: string; message: string; authored?: boolean }): string {
  if (!error.authored && /credential store|keychain|keyring/i.test(error.message)) return errorText({ ...error, message: "", reason: "keychain_unavailable" });
  // The server answers a join for a collection it doesn't know (or that isn't this kind) with not_current_*.
  if (!error.authored && /not_current_(cloud_copy|private)/.test(error.message)) return t`mdbase couldn't find that collection in your account. Check the link and the account you're signed in to.`;
  switch (error.reason) {
    case "not_installed": return t`The mdbase app isn't installed on this computer.`;
    case "daemon_not_running": return t`The mdbase app isn't running.`;
    case "daemon_unreachable": return t`Obsidian couldn't reach the mdbase app. Restart it, then try again.`;
    case "folder_not_empty": return t`That folder already has files. Choose a new folder name.`;
    case "already_registered": return t`This collection is already on this computer.`;
    case "bad_id": return t`That doesn't look like a collection link or ID.`;
    case "sync_refused": return t`mdbase's server didn't allow that. Try again later.`;
    case "link_not_approved": return t`Obsidian wasn't allowed to use mdbase. Choose Allow when mdbase asks.`;
    case "keychain_unavailable":
    case "credential_store_unavailable": return t`mdbase can't reach this computer's password store. Unlock it, or sign in to your desktop session again.`;
    case "not_signed_in":
    case "registration_mismatch": return t`This computer's mdbase sign-in stopped working, so sync is stopped here. Your notes here are untouched.`;
    case "account_changed": return t`You signed in to a different account. Try again.`;
    case "sign_in_failed": { const message = error.message; return t`Sign-in didn't finish: ${message}`; }
    case "sign_out_pending_writes": return t`Some changes haven't reached mdbase yet, so you're still signed in. Wait until Sync says Synced, then sign out.`;
    case "overlapping_state_dir": return t`This folder can't be synced.`;
    default: break;
  }
  switch (error.code) {
    case "unauthenticated": return t`Sign in to mdbase first.`;
    case "forbidden": return t`Your account doesn't allow that.`;
    case "rate_limited": return t`Too many attempts. Wait a few minutes, then try again.`;
    case "quota_exceeded": return t`Your mdbase storage is full.`;
    case "upgrade_required": return t`Update the mdbase app, then try again.`;
    case "not_found": return error.reason === "not_installed" ? t`The mdbase app isn't installed on this computer.` : t`mdbase couldn't find that collection in your account.`;
    case "timeout": return t`mdbase took too long to answer. Try again.`;
    case "unavailable": return t`mdbase can't reach the server right now. Check your connection and try again.`;
    default: return error.message ? error.authored ? error.message : sentence(error.message) : t`Something went wrong in mdbase.`;
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
    case "conflict": return t`Changed here and on another device`;
    case "deleted_elsewhere": return t`Deleted on another device, changed here`;
    case "editor_busy": return t`Open with unsaved changes`;
    case "read_only": return t`You can't change this collection`;
    case "suspect_write": return t`Changed by another program`;
    case "unknown_provenance": return t`Changed while mdbase wasn't watching`;
    default: return t`Waiting for your choice`;
  }
}
