import {
  getTypesForFile,
  v03TypeDefFromFrontmatter,
  validateRecordAgainstType,
  type CollectionRecord,
  type MdbaseConfig,
  type MdbaseIssue,
  type MdbaseTypeDef,
} from "./mdbaseCore";
import { frontmatterFromTypeModel } from "./typeModel";
import type { TypeEditorModel } from "./typeEditorTypes";

export interface TypeStats {
  notes: number;
  issues: number;
}

export interface FailingRecord {
  path: string;
  issues: MdbaseIssue[];
  /** True when the record is valid (or not a member) under the saved type. */
  isNew: boolean;
}

export interface TypeImpact {
  /** Every record matching the draft, in collection order. */
  matched: string[];
  /** Records that match the draft but not the saved type. */
  added: string[];
  /** Records that match the saved type but not the draft. */
  removed: string[];
  failing: FailingRecord[];
  /** Records that fail the saved type and pass the draft. */
  fixed: number;
}

export type TypeImpactResult = { impact: TypeImpact } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Path → resolved type names, using the same membership rules as validation. */
export function indexRecordTypes(
  records: readonly CollectionRecord[],
  config: MdbaseConfig,
  types: Map<string, MdbaseTypeDef>,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const record of records) {
    const names = getTypesForFile(record.path, record.frontmatter, config, types);
    if (names.length) index.set(record.path, names);
  }
  return index;
}

/** Notes per type, and validation issues attributed to each type. */
export function typeStats(
  recordTypes: Map<string, string[]>,
  issues: readonly MdbaseIssue[],
): Map<string, TypeStats> {
  const stats = new Map<string, TypeStats>();
  const entry = (name: string): TypeStats => {
    let current = stats.get(name);
    if (!current) {
      current = { notes: 0, issues: 0 };
      stats.set(name, current);
    }
    return current;
  };
  for (const names of recordTypes.values()) for (const name of names) entry(name).notes += 1;
  for (const issue of issues) {
    for (const name of issueTypeNames(issue, recordTypes)) entry(name).issues += 1;
  }
  return stats;
}

/** The type(s) an issue belongs to: its own type when known, otherwise the record's types. */
export function issueTypeNames(issue: MdbaseIssue, recordTypes: Map<string, string[]>): string[] {
  if (issue.type) return [issue.type];
  return recordTypes.get(issue.path) ?? [];
}

/** A validator for the unsaved draft. Throws when the draft cannot be serialized. */
export function typeDefFromDraft(model: TypeEditorModel, filePath: string | null): MdbaseTypeDef {
  const frontmatter = frontmatterFromTypeModel(model);
  const wrapper = isRecord(frontmatter.schema) ? frontmatter.schema : {};
  const schema = isRecord(wrapper.value) ? wrapper.value : {};
  return v03TypeDefFromFrontmatter(frontmatter, filePath ?? `${model.name || "new"}.md`, schema);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/**
 * Compare the saved type with the draft across every record: which notes the
 * draft matches, which it gains or loses, and which would fail validation.
 * Work is chunked so large vaults stay responsive; `isCurrent` cancels stale runs.
 */
export async function analyzeTypeImpact(input: {
  records: readonly CollectionRecord[];
  config: MdbaseConfig;
  types: Map<string, MdbaseTypeDef>;
  draft: TypeEditorModel;
  savedName: string | null;
  filePath: string | null;
  isCurrent?: () => boolean;
}): Promise<TypeImpactResult | null> {
  let draftDef: MdbaseTypeDef;
  try {
    draftDef = typeDefFromDraft(input.draft, input.filePath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const savedDef = input.savedName ? input.types.get(input.savedName) ?? null : null;
  const draftTypes = new Map(input.types);
  if (input.savedName) draftTypes.delete(input.savedName);
  draftTypes.set(draftDef.name, draftDef);

  const impact: TypeImpact = { matched: [], added: [], removed: [], failing: [], fixed: 0 };
  for (const [index, record] of input.records.entries()) {
    if (index > 0 && index % 400 === 0) {
      await yieldToUi();
      if (input.isCurrent && !input.isCurrent()) return null;
    }
    const wasMember = savedDef !== null
      && getTypesForFile(record.path, record.frontmatter, input.config, input.types).includes(savedDef.name);
    const isMember = getTypesForFile(record.path, record.frontmatter, input.config, draftTypes).includes(draftDef.name);
    if (isMember) impact.matched.push(record.path);
    if (isMember && !wasMember) impact.added.push(record.path);
    if (wasMember && !isMember) impact.removed.push(record.path);
    if (!isMember && !wasMember) continue;
    const before = wasMember && savedDef
      ? validateRecordAgainstType(record.path, record.frontmatter, savedDef).length
      : 0;
    const after = isMember ? validateRecordAgainstType(record.path, record.frontmatter, draftDef) : [];
    if (after.length) impact.failing.push({ path: record.path, issues: after, isNew: before === 0 });
    else if (before > 0 && isMember) impact.fixed += 1;
  }
  return { impact };
}
