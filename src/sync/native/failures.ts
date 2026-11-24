import { plural, t } from "@lingui/core/macro";
// Plain-language reasons for a path that didn't sync. The Sync tab lists these;
// nothing here is logged (validation messages can quote frontmatter values).

export interface FailureIssue { code?: string; severity?: string; message?: string; location?: string }
export interface PathFailureInfo { code?: string; reason?: string; issues?: FailureIssue[] | null; kind?: string }
export interface FailureText {
  title: string;
  detail: string;
  /** A definition changed on both sides: offer "keep this vault's" / "keep the collection's". */
  choose?: boolean;
}

// Schema messages don't name the field ("shorter than 1 characters"). A
// location (a JSON pointer into the frontmatter, "/title") does when Connect
// sends one; write errors from the SDK currently don't, so then the Issues tab,
// which validates locally, is the place to see which fields.
const field = (location?: string) => location?.replace(/^\//, "").split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~")).join(".") || "";
const phrase = (message: string) => message === "shorter than 1 characters" ? t`is empty` : message;
function invalidDetail(issues?: FailureIssue[] | null): string {
  const all = (issues ?? []).filter(i => i.message);
  const errors = all.filter(i => i.severity !== "warning");
  const shown = errors.length ? errors : all;
  const first = shown[0];
  if (!first?.message) return t`Run Validate in the Issues tab to see why. Fix the note and it will sync.`;
  const more = shown.length - 1, name = field(first.location);
  const message = phrase(first.message);
  if (name) return more
    ? t`${name}: ${message}, and ${plural(more, { one: "# more problem", other: "# more problems" })}. Fix the note and it will sync.`
    : t`${name}: ${message}. Fix the note and it will sync.`;
  if (first.code?.startsWith("schema_")) {
    const text = `“${first.message}”`;
    const count = shown.length;
    return t`${plural(count, { one: "One problem", other: "# problems" })}, such as ${text}. Run Validate in the Issues tab to see which fields. Fix the note and it will sync.`;
  }
  const text = first.message.charAt(0).toUpperCase() + first.message.slice(1);
  return more
    ? t`${text}, and ${plural(more, { one: "# more problem", other: "# more problems" })}. Run Validate in the Issues tab to see them all. Fix the note and it will sync.`
    : t`${text}. Fix the note and it will sync.`;
}
const firstIssue = (issues?: FailureIssue[] | null) => {
  const i = issues?.find(x => x.severity !== "warning" && x.message) ?? issues?.find(x => x.message);
  if (!i?.message) return undefined;
  const name = field(i.location);
  return name ? `${name}: ${i.message}` : i.message.charAt(0).toUpperCase() + i.message.slice(1);
};

export function describeFailure(f: PathFailureInfo): FailureText {
  const issue = firstIssue(f.issues);
  const code = f.code;
  switch (f.code) {
    case "remote_move_blocked":
      return { title: t`Rename is waiting`, detail: f.reason === "identity_mismatch"
        ? issue ? t`${issue}. The moved item's identity or kind doesn't match. Local files are unchanged; check the paths before trying again.` : t`The moved item's identity or kind doesn't match. Local files are unchanged; check the paths before trying again.`
        : issue ? t`${issue}. Another local item still occupies the rename destination. Move it aside or resolve its sync problem, then try again. Both files are unchanged.` : t`Another local item still occupies the rename destination. Move it aside or resolve its sync problem, then try again. Both files are unchanged.` };
    case "vault_index_pending":
      return { title: t`Waiting for Obsidian`, detail: t`Obsidian hasn't indexed the file to rename yet. Local files are unchanged; sync will retry when the vault updates.` };
    case "invalid_record":
      return { title: t`Doesn't match its type`, detail: invalidDetail(f.issues) };
    case "conflict":
      if (f.reason === "definition_conflict") return {
        title: t`Changed here and in the collection`,
        detail: t`This definition is different in this vault and in the collection. Choose which version to keep.`,
        choose: true,
      };
      return { title: t`Changed in two places`, detail: t`Try again to keep both versions as separate files.` };
    case "too_large": return { title: t`Too large to sync`, detail: t`This file is over the collection's size limit.` };
    case "quota_exceeded": return { title: t`Collection is full`, detail: t`Free up space in the collection, then try again.` };
    case "unsupported_encoding": return { title: t`Not plain text`, detail: t`This note isn't valid UTF-8, so it can't sync as a note. Your file is unchanged.` };
    case "unreadable": case "EACCES": case "EPERM": case "EBUSY":
      return { title: t`Couldn't read this file`, detail: t`Check that the file isn't locked or restricted, then try again.` };
    case "forbidden": return { title: t`Not allowed`, detail: t`Your access to this collection doesn't allow this change.` };
    case "outcome_unknown": return { title: t`Waiting to confirm`, detail: t`mdbase didn't confirm whether this change arrived. It will check again before resending.` };
    case "unavailable": return { title: t`Temporarily unavailable`, detail: t`Couldn't reach mdbase to sync this file. Your file is unchanged; sync will try again.` };
    case "rate_limited": return { title: t`mdbase is busy`, detail: t`Too many requests right now. Your file is unchanged; sync will try again shortly.` };
    case "timeout": return { title: t`Timed out`, detail: t`mdbase took too long to answer. Your file is unchanged; sync will try again.` };
    case "invalid_request":
      if (f.reason === "not_a_record_path" || f.reason === "not_a_file_path")
        return { title: t`Path not allowed`, detail: t`The collection's settings don't allow a note or file at this path.` };
      if (f.reason === "invalid_frontmatter")
        return { title: t`Properties can't be read`, detail: t`The YAML at the top of this note has a syntax error. Fix it and the note syncs.` };
      if (f.reason === "record_too_large" || f.reason === "too_large")
        return { title: t`Too large to sync`, detail: t`This note is over mdbase's size limit for a note. Split it, or move large content into an attachment.` };
      if (f.reason === "excluded")
        return { title: t`Left out by the collection`, detail: t`The collection's file settings don't sync this file.` };
      return { title: t`Couldn't sync`, detail: issue ? `${issue}.` : t`mdbase refused this change.` };
    default:
      return { title: t`Couldn't sync`, detail: issue ? `${issue}.` : code ? t`Try again later (${code}).` : t`Try again later.` };
  }
}
