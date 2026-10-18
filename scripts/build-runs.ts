/**
 * Assemble runs/<epic>/<snapshot>.json = { plan, target, release, findings, linkage_gaps, teams }.
 * plan/target/release come from real release-reader output in fixtures/; findings, linkage_gaps and
 * teams come from the hand-written analysis files until the analyzer and status skills exist.
 *
 *   npx tsx scripts/build-runs.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Run } from "@rrr/schemas";

const EPIC = "INGEST-142";
const FX = "fixtures/ingest-142";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

for (const snap of ["2026-11-10", "2026-11-13"]) {
  const analysis = read(`runs/${EPIC}/analysis/${snap}.json`);
  const run = Run.parse({
    plan: read(`${FX}/plan-draft.json`),
    target: read(`${FX}/release-target.json`),
    release: read(`${FX}/release.${snap}.json`),
    findings: analysis.findings,
    linkage_gaps: analysis.linkage_gaps,
    teams: analysis.teams,
  });
  // Cross-checks: every id the hand-written parts refer to must exist in the reader output.
  const planIds = new Set(run.plan.items.map((i) => i.id));
  const known = new Set([run.release.epic.key, ...run.release.stories.map((s) => s.key), ...run.release.related.map((r) => r.key), ...run.release.search_candidates.map((c) => c.key)]);
  const fids = new Set(run.findings.map((f) => f.id));
  for (const f of run.findings) {
    if (!planIds.has(f.plan_item_id)) throw new Error(`${snap} ${f.id}: unknown plan item ${f.plan_item_id}`);
    for (const e of f.evidence) if (!known.has(e.key)) throw new Error(`${snap} ${f.id}: evidence key ${e.key} not in release.json`);
    if (f.linkage && !known.has(f.linkage.to)) throw new Error(`${snap} ${f.id}: linkage target ${f.linkage.to} not in release.json`);
  }
  for (const g of run.linkage_gaps) {
    if (!known.has(g.from) || !known.has(g.to)) throw new Error(`${snap} ${g.id}: keys not in release.json`);
    if (g.finding_id && !fids.has(g.finding_id)) throw new Error(`${snap} ${g.id}: unknown finding ${g.finding_id}`);
  }
  for (const t of run.teams) {
    if (!run.target.projects.some((p) => p.jira_project === t.project_key)) throw new Error(`${snap} ${t.team}: project ${t.project_key} not in release-target.json`);
    for (const it of t.items) {
      if (!planIds.has(it.plan_item_id)) throw new Error(`${snap} ${t.team}: unknown plan item ${it.plan_item_id}`);
      if (it.ticket && !known.has(it.ticket)) throw new Error(`${snap} ${t.team}: ticket ${it.ticket} not in release.json`);
      if (it.finding_id && !fids.has(it.finding_id)) throw new Error(`${snap} ${t.team}: unknown finding ${it.finding_id}`);
    }
  }
  writeFileSync(`runs/${EPIC}/${snap}.json`, JSON.stringify(run, null, 2) + "\n");
  console.log(`runs/${EPIC}/${snap}.json: ${run.findings.length} findings, ${run.linkage_gaps.length} linkage gaps, ${run.teams.length} teams`);
}
