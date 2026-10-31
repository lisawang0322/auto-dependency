#!/usr/bin/env -S npx tsx
/**
 * release-status. Rolls the analyzer's findings up per team and writes status.json. Never calls Jira.
 *
 *   npx tsx skills/release-status/scripts/status.ts --plan plan-draft.json --target release-target.json \
 *     --release release.json --findings findings.json [--previous runs/<epic>/<earlier>.json] --out status.json
 *
 * --previous: an earlier saved run (or an earlier status.json next to its release.json via --previous-release)
 *   for the per-team change notes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PlanDraft, ReleaseTarget, Release, Findings, Run, Status } from "@rrr/schemas";
import { computeStatus } from "./lib/status.js";

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
  return opts;
}
const opts = parseArgs(process.argv.slice(2));
if (!opts.plan || !opts.target || !opts.release || !opts.findings) {
  console.error("usage: status.ts --plan plan-draft.json --target release-target.json --release release.json --findings findings.json [--previous run.json] [--out status.json]");
  process.exit(2);
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
let previous: { release: Release; teams: Status["teams"]; snapshot_label: string } | null = null;
if (opts.previous) {
  const prev = Run.parse(read(opts.previous));
  previous = { release: prev.release, teams: prev.teams, snapshot_label: prev.release.snapshot_label };
}
const out = Status.parse(computeStatus({
  plan: PlanDraft.parse(read(opts.plan)), target: ReleaseTarget.parse(read(opts.target)),
  release: Release.parse(read(opts.release)), findings: Findings.parse(read(opts.findings)), previous,
}));
const json = JSON.stringify(out, null, 2) + "\n";
if (opts.out) {
  writeFileSync(opts.out, json);
  console.error(`wrote ${opts.out}: ${out.teams.length} teams${out.compared_with ? `, compared with ${out.compared_with}` : ""}`);
  for (const t of out.teams) console.error(`  ${t.team.padEnd(16)} ${t.project_key.padEnd(7)} ${t.status.padEnd(9)} ${t.items.map((i) => `${i.plan_item_id}:${i.result}`).join(" ")}${t.change_note ? "  · " + t.change_note : ""}`);
  for (const w of out.warnings) console.error("  warning: " + w);
} else process.stdout.write(json);
