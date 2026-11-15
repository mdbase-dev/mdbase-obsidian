import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const baseline = JSON.parse(
  await readFile(new URL("./testvault-profile-baseline.json", import.meta.url), "utf8"),
);
const vault = process.env.OBSIDIAN_TEST_VAULT?.trim() || "test";
const expression = `(async()=>{
  const plugin=app.plugins.plugins['mdbase-sync'];
  if(!plugin)throw new Error('mdbase-sync is not loaded');
  const measure=async(operation)=>{const start=performance.now();const value=await operation();return{ms:performance.now()-start,value}};
  const heapBefore=performance.memory?.usedJSHeapSize??null;
  const schema=await measure(()=>plugin.loadWorkspaceSchema(true));
  const migration=schema.value?.config?.spec_version?.startsWith('0.2.')
    ?await measure(()=>plugin.analyzeMigration())
    :{ms:0,value:{operations:[]}};
  const validation=await measure(()=>plugin.validateCollection());
  const issuesRender=await measure(()=>plugin.openWorkspace('issues'));
  const heapAfter=performance.memory?.usedJSHeapSize??null;
  return JSON.stringify({
    markdown:app.vault.getMarkdownFiles().length,
    types:schema.value?.types?.size??0,
    schema_ms:+schema.ms.toFixed(2),
    migration_ms:+migration.ms.toFixed(2),
    migration_operations:migration.value.operations.length,
    validation_ms:+validation.ms.toFixed(2),
    issues:plugin.getIssues().length,
    issues_render_ms:+issuesRender.ms.toFixed(2),
    rendered_issue_rows:document.querySelectorAll('.mdbase-issues-document .mdbase-issue-row').length,
    heap_before:heapBefore,
    heap_after:heapAfter
  });
})()`;
const result = spawnSync("obsidian", [`vault=${vault}`, "eval", `code=${expression}`], {
  encoding: "utf8",
  timeout: 30_000,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || `Obsidian CLI exited ${result.status}.`);
}
const output = `${result.stdout}\n${result.stderr}`;
const match = output.match(/=>\s*(\{[^\n]+\})/);
if (!match) throw new Error(`Could not parse profile output:\n${output}`);
const profile = JSON.parse(match[1]);
const failures = [];
for (const [metric, limit] of Object.entries(baseline.maximums)) {
  if (typeof profile[metric] === "number" && profile[metric] > limit) {
    failures.push(`${metric}=${profile[metric]} exceeds ${limit}`);
  }
}
console.log(JSON.stringify({ vault, profile, baseline, passed: failures.length === 0 }, null, 2));
if (failures.length) throw new Error(`Performance regression: ${failures.join("; ")}`);
