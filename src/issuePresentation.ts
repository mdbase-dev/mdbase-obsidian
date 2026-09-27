import type { MdbaseIssue } from "./mdbaseCore";

const RULE_LABELS: Record<string, string> = {
  schema_required: "missing",
  missing_required: "missing",
  schema_additional_properties: "not declared",
  unknown_field: "not declared",
  schema_type: "wrong type",
  invalid_type: "wrong type",
  schema_enum: "not an allowed value",
  invalid_enum: "not an allowed value",
  schema_maximum: "above maximum",
  above_max: "above maximum",
  schema_minimum: "below minimum",
  below_min: "below minimum",
  schema_max_length: "too long",
  above_max_length: "too long",
  schema_min_length: "too short",
  below_min_length: "too short",
  schema_max_items: "too many items",
  schema_min_items: "too few items",
  schema_pattern: "pattern mismatch",
  pattern_mismatch: "pattern mismatch",
  format_invalid: "invalid format",
  duplicate_value: "duplicate value",
  duplicate_unique: "duplicate value",
  link_not_found: "missing link target",
  missing_link_target: "missing link target",
  link_wrong_type: "link to wrong type",
  no_matching_type: "no matching type",
  unknown_type: "unknown type",
  invalid_frontmatter: "invalid frontmatter",
};

export function ruleDescription(code: string): string {
  return RULE_LABELS[code] ?? code.replace(/^schema_/, "").replace(/_/g, " ");
}

/** Issues from the same rule share a key: same type, field, and check. */
export function issueRuleKey(issue: MdbaseIssue): string {
  return [issue.type ?? "", issue.field ?? "", issue.code].join("\u0000");
}

export function issueRuleLabel(issue: MdbaseIssue): string {
  return [issue.type, issue.field, ruleDescription(issue.code)].filter(Boolean).join(" · ");
}

/** Group issues by rule, most frequent first. */
export function groupIssuesByRule(issues: readonly MdbaseIssue[]): Array<{ key: string; label: string; issues: MdbaseIssue[] }> {
  const groups = new Map<string, { key: string; label: string; issues: MdbaseIssue[] }>();
  for (const issue of issues) {
    const key = issueRuleKey(issue);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: issueRuleLabel(issue), issues: [] };
      groups.set(key, group);
    }
    group.issues.push(issue);
  }
  return [...groups.values()].sort((a, b) => b.issues.length - a.issues.length || a.label.localeCompare(b.label));
}
