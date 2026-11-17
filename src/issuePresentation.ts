import { t } from "@lingui/core/macro";
import type { MdbaseIssue } from "./mdbaseCore";

function ruleLabels(): Record<string, string> {
  return {
  schema_required: t`missing`,
  missing_required: t`missing`,
  schema_additional_properties: t`not declared`,
  unknown_field: t`not declared`,
  schema_type: t`wrong type`,
  invalid_type: t`wrong type`,
  schema_enum: t`not an allowed value`,
  invalid_enum: t`not an allowed value`,
  schema_maximum: t`above maximum`,
  above_max: t`above maximum`,
  schema_minimum: t`below minimum`,
  below_min: t`below minimum`,
  schema_max_length: t`too long`,
  above_max_length: t`too long`,
  schema_min_length: t`too short`,
  below_min_length: t`too short`,
  schema_max_items: t`too many items`,
  schema_min_items: t`too few items`,
  schema_pattern: t`pattern mismatch`,
  pattern_mismatch: t`pattern mismatch`,
  format_invalid: t`invalid format`,
  duplicate_value: t`duplicate value`,
  duplicate_unique: t`duplicate value`,
  link_not_found: t`missing link target`,
  missing_link_target: t`missing link target`,
  link_wrong_type: t`link to wrong type`,
  no_matching_type: t`no matching type`,
  unknown_type: t`unknown type`,
  invalid_frontmatter: t`invalid frontmatter`,
  };
}

export function ruleDescription(code: string): string {
  return ruleLabels()[code] ?? code.replace(/^schema_/, "").replace(/_/g, " ");
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
