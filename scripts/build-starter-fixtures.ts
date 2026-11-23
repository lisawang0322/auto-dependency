/**
 * Build the early-stage sample outputs the GUI's sample mode loads, from the sample PRD, directory and
 * Jira snapshot, with the real throughline-starter code (so sample output = real output):
 *   fixtures/ingest-142/starter/starting.json             just starting, PRD + directory
 *   fixtures/ingest-142/starter/starting.no-directory.json just starting, PRD only
 *   fixtures/ingest-142/starter/building.2026-11-13.json  building, PRD + directory + INGEST-142 on the Nov 13 snapshot
 *   fixtures/ingest-142/starter/plan-draft.json, release-target.json   what steps 2 and 3 show in sample mode
 *
 *   npx tsx scripts/build-starter-fixtures.ts
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStarter, readStarterInputs, starterSignals, starterPlan, stageB } from "./lib/pipeline.js";
import { loadRules } from "../skills/throughline-starter/scripts/lib/config.js";

const DOCS = "fixtures/ingest-142/docs";
const OUT = "fixtures/ingest-142/starter";
const PRD = `${DOCS}/ingestion-service-PRD.md`, DIR = `${DOCS}/directory.yaml`;
const AT = "2026-11-13T09:10:00.000Z";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "rrr-starter-fixtures-"));
  mkdirSync(OUT, { recursive: true });
  try {
    const say = (s: string, d: string) => console.error(`  ${s.padEnd(9)} ${d}`);
    const a = await runStarter({ stage: "starting", files: [PRD, DIR], label: "2026-11-13", runsRoot: tmp, analyzedAt: AT, onStage: say });
    writeFileSync(`${OUT}/starting.json`, JSON.stringify(a.starter, null, 2) + "\n");
    const b = await runStarter({ stage: "starting", files: [PRD], label: "2026-11-13", runsRoot: tmp, analyzedAt: AT, onStage: say });
    writeFileSync(`${OUT}/starting.no-directory.json`, JSON.stringify(b.starter, null, 2) + "\n");
    const c = await runStarter({ stage: "building", files: [PRD, DIR], epicKey: "INGEST-142", source: { kind: "fixture", dir: "fixtures/ingest-142/jira/2026-11-13" }, label: "2026-11-13", runsRoot: tmp, analyzedAt: AT, readAt: "2026-11-13T09:00:00.000Z", onStage: say });
    writeFileSync(`${OUT}/building.2026-11-13.json`, JSON.stringify(c.starter, null, 2) + "\n");
    // The plan and target the GUI's sample mode shows on steps 2 and 3 for the early stages (same code as the server).
    const inputs = await readStarterInputs([PRD, DIR]);
    const sig = starterSignals(inputs, loadRules());
    const plan = await starterPlan(inputs, sig, [PRD, DIR]);
    writeFileSync(`${OUT}/plan-draft.json`, JSON.stringify(plan, null, 2) + "\n");
    const target = await stageB({ plan, epicKey: "INGEST-142", source: { kind: "fixture", dir: "fixtures/ingest-142/jira/2026-11-13" } });
    writeFileSync(`${OUT}/release-target.json`, JSON.stringify(target, null, 2) + "\n");
    console.log(`${OUT}: starting ${a.starter.teams.length} teams / ${a.starter.approvals.length} approvals; building ${c.starter.coverage.filter((x) => x.state === "covered").length}/${c.starter.coverage.length} covered, ${c.starter.next_actions.length} actions`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e.stack ?? e); process.exit(1); });
