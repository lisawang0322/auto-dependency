/**
 * Rebuild the two sample runs, runs/INGEST-142/<snapshot>.json, from the fixture files:
 * plan/target/release from the reader, findings from the analyzer, teams from release-status
 * (the Nov 13 run is compared with Nov 10 for its change notes).
 *
 *   npx tsx scripts/build-runs.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { PlanDraft, ReleaseTarget, Release, Findings, Run, Status } from "@rrr/schemas";
import { computeStatus } from "../skills/release-status/scripts/lib/status.js";

const EPIC = "INGEST-142";
const FX = "fixtures/ingest-142";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const plan = PlanDraft.parse(read(`${FX}/plan-draft.json`));
const target = ReleaseTarget.parse(read(`${FX}/release-target.json`));
let previous: { release: Release; teams: Run["teams"]; snapshot_label: string } | null = null;
for (const snap of ["2026-11-10", "2026-11-13"]) {
  const release = Release.parse(read(`${FX}/release.${snap}.json`));
  const findings = Findings.parse(read(`${FX}/findings.${snap}.json`));
  const status = Status.parse(computeStatus({ plan, target, release, findings, previous }));
  const run = Run.parse({ plan, target, release, findings: findings.findings, linkage_gaps: findings.linkage_gaps, teams: status.teams });
  // Cross-checks: every id must exist in the reader output.
  const planIds = new Set(run.plan.items.map((i) => i.id));
  const known = new Set([run.release.epic.key, ...run.release.stories.map((s) => s.key), ...run.release.related.map((r) => r.key), ...run.release.search_candidates.map((c) => c.key)]);
  const fids = new Set(run.findings.map((f) => f.id));
  for (const f of run.findings) {
    if (!planIds.has(f.plan_item_id)) throw new Error(`${snap} ${f.id}: unknown plan item ${f.plan_item_id}`);
    for (const e of f.evidence) if (!known.has(e.key)) throw new Error(`${snap} ${f.id}: evidence key ${e.key} not in release.json`);
  }
  for (const g of run.linkage_gaps) if (!known.has(g.from) || !known.has(g.to) || (g.finding_id && !fids.has(g.finding_id))) throw new Error(`${snap} ${g.id}: dangling keys`);
  for (const t of run.teams) for (const it of t.items) if (it.finding_id && !fids.has(it.finding_id)) throw new Error(`${snap} ${t.team}: unknown finding ${it.finding_id}`);
  mkdirSync(`runs/${EPIC}/${snap}`, { recursive: true });
  writeFileSync(`runs/${EPIC}/${snap}/status.json`, JSON.stringify(status, null, 2) + "\n");
  writeFileSync(`runs/${EPIC}/${snap}/findings.json`, JSON.stringify(findings, null, 2) + "\n");
  writeFileSync(`runs/${EPIC}/${snap}.json`, JSON.stringify(run, null, 2) + "\n");
  console.log(`runs/${EPIC}/${snap}.json: ${run.findings.length} findings, ${run.linkage_gaps.length} linkage gaps, ${run.teams.map((t) => `${t.team} ${t.status}`).join(", ")}`);
  previous = { release, teams: status.teams, snapshot_label: snap };
}
