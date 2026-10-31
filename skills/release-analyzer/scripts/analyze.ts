#!/usr/bin/env -S npx tsx
/**
 * release-analyzer. Reads the reader's three files, writes findings.json. Never calls Jira.
 *
 *   npx tsx skills/release-analyzer/scripts/analyze.ts --plan plan-draft.json --target release-target.json \
 *     --release release.json [--teams team-list.yaml] [--no-team-list] [--go-no-go YYYY-MM-DD] \
 *     [--templates templates/next_actions.yaml] [--phrases rules/phrases.yaml] [--analyzed-at ISO] --out findings.json
 *
 * --teams: a team list (yaml/json, same shape as the Stage A input) to add owners when the plan was extracted
 *   without one. --no-team-list: treat owners as inferred even if the plan has a team list (tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { PlanDraft, ReleaseTarget, Release } from "@rrr/schemas";
import { analyze } from "./lib/analyze.js";
import { loadTemplates, loadPhrases } from "./lib/config.js";

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {}; const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) flags.add(a.slice(2)); else { opts[a.slice(2)] = v; i++; }
  }
  return { opts, flags };
}

const { opts, flags } = parseArgs(process.argv.slice(2));
if (!opts.plan || !opts.target || !opts.release) {
  console.error("usage: analyze.ts --plan plan-draft.json --target release-target.json --release release.json [--teams team-list.yaml] [--no-team-list] [--go-no-go YYYY-MM-DD] [--templates file] [--phrases file] [--analyzed-at ISO] [--out findings.json]");
  process.exit(2);
}
const plan = PlanDraft.parse(JSON.parse(readFileSync(opts.plan, "utf8")));
const target = ReleaseTarget.parse(JSON.parse(readFileSync(opts.target, "utf8")));
const release = Release.parse(JSON.parse(readFileSync(opts.release, "utf8")));
let teamListGiven: boolean | undefined;
if (opts.teams) {
  const data = YAML.parse(readFileSync(opts.teams, "utf8"));
  for (const t of data?.teams ?? []) {
    const name = String(t.name ?? t.team ?? "");
    const pt = plan.teams.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const owners = Array.isArray(t.owners) ? t.owners.map(String) : [];
    if (pt) { if (!pt.owners.length) pt.owners = owners; }
    else plan.teams.push({ name, mentioned_in: [opts.teams], jira_project_hint: t.jira_project ?? null, owners, components: [], role: t.role ?? null, project_keys_mentioned: [] });
  }
  teamListGiven = true;
}
if (flags.has("no-team-list")) teamListGiven = false;
const out = analyze({
  plan, target, release,
  templates: loadTemplates(opts.templates), phrases: loadPhrases(opts.phrases),
  teamListGiven, goNoGo: opts["go-no-go"], analyzedAt: opts["analyzed-at"],
});
const json = JSON.stringify(out, null, 2) + "\n";
if (opts.out) {
  writeFileSync(opts.out, json);
  const shown = out.findings.filter((f) => f.shown).length;
  console.error(`wrote ${opts.out}: ${out.findings.length} findings (${shown} shown, ${out.findings.filter((f) => f.hidden_by_default).length} weak hidden), ${out.linkage_gaps.length} linkage gaps, ${out.warnings.length} warnings`);
  for (const f of out.findings) console.error(`  ${f.id} ${f.shown ? "shown " : "hidden"} ${f.gap_type.padEnd(15)} ${f.strength.padEnd(8)} ${f.plan_item_id.padEnd(3)} ${f.title}`);
  for (const g of out.linkage_gaps) console.error(`  ${g.id} ${g.from} → ${g.to} (${g.how}, ${g.suggested_type})${g.finding_id ? " on " + g.finding_id : " separate"}`);
  for (const w of out.warnings) console.error("  warning: " + w);
} else process.stdout.write(json);
