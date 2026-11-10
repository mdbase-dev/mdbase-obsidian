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
const phrase = (message: string) => message === "shorter than 1 characters" ? "is empty" : message;
const FIXED = "Fix the note and it will sync.";
function invalidDetail(issues?: FailureIssue[] | null): string {
  const all = (issues ?? []).filter(i => i.message);
  const errors = all.filter(i => i.severity !== "warning");
  const shown = errors.length ? errors : all;
  const first = shown[0];
  if (!first?.message) return `Run Validate in the Issues tab to see why. ${FIXED}`;
  const more = shown.length - 1, name = field(first.location);
  if (name) return `${name}: ${phrase(first.message)}${more ? `, and ${more} more problem${more === 1 ? "" : "s"}` : ""}. ${FIXED}`;
  // JSON Schema messages (code schema_*) leave the field out; others name it.
  const text = first.code?.startsWith("schema_") ? `“${first.message}”` : first.message.charAt(0).toUpperCase() + first.message.slice(1);
  const lead = first.code?.startsWith("schema_") ? `${shown.length === 1 ? "One problem" : `${shown.length} problems`}, such as ${text}` : `${text}${more ? `, and ${more} more problem${more === 1 ? "" : "s"}` : ""}`;
  const hint = first.code?.startsWith("schema_") ? " Run Validate in the Issues tab to see which fields." : more ? " Run Validate in the Issues tab to see them all." : "";
  return `${lead}.${hint} ${FIXED}`;
}
const firstIssue = (issues?: FailureIssue[] | null) => {
  const i = issues?.find(x => x.severity !== "warning" && x.message) ?? issues?.find(x => x.message);
  if (!i?.message) return undefined;
  const name = field(i.location);
  return name ? `${name}: ${i.message}` : i.message.charAt(0).toUpperCase() + i.message.slice(1);
};

export function describeFailure(f: PathFailureInfo): FailureText {
  const issue = firstIssue(f.issues);
  switch (f.code) {
    case "invalid_record":
      return { title: "Doesn't match its type", detail: invalidDetail(f.issues) };
    case "conflict":
      if (f.reason === "definition_conflict") return {
        title: "Changed here and in the collection",
        detail: "This definition is different in this vault and in the collection. Choose which version to keep.",
        choose: true,
      };
      return { title: "Changed in two places", detail: "Try again to keep both versions as separate files." };
    case "too_large": return { title: "Too large to sync", detail: "This file is over the collection's size limit." };
    case "quota_exceeded": return { title: "Collection is full", detail: "Free up space in the collection, then try again." };
    case "unsupported_encoding": return { title: "Not plain text", detail: "This note isn't valid UTF-8, so it can't sync as a note. Your file is unchanged." };
    case "unreadable": case "EACCES": case "EPERM": case "EBUSY":
      return { title: "Couldn't read this file", detail: "Check that the file isn't locked or restricted, then try again." };
    case "forbidden": return { title: "Not allowed", detail: "Your access to this collection doesn't allow this change." };
    case "outcome_unknown": return { title: "Waiting to confirm", detail: "mdbase didn't confirm whether this change arrived. It will check again before resending." };
    case "invalid_request":
      if (f.reason === "not_a_record_path" || f.reason === "not_a_file_path")
        return { title: "Path not allowed", detail: "The collection's settings don't allow a note or file at this path." };
      if (f.reason === "invalid_frontmatter")
        return { title: "Properties can't be read", detail: "The YAML at the top of this note has a syntax error. Fix it and the note syncs." };
      if (f.reason === "record_too_large" || f.reason === "too_large")
        return { title: "Too large to sync", detail: "This note is over mdbase's size limit for a note. Split it, or move large content into an attachment." };
      if (f.reason === "excluded")
        return { title: "Left out by the collection", detail: "The collection's file settings don't sync this file." };
      return { title: "Couldn't sync", detail: issue ? `${issue}.` : "mdbase refused this change." };
    default:
      return { title: "Couldn't sync", detail: issue ? `${issue}.` : `Try again later${f.code ? ` (${f.code})` : ""}.` };
  }
}
