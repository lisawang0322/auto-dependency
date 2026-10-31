#!/usr/bin/env -S npx tsx
/**
 * One command for the whole review: reader → analyzer → status → runs/<epic>/<label>.json.
 *
 *   npm run review -- --files fixtures/ingest-142/docs/Ingestion-service-POR-v3.md fixtures/ingest-142/docs/launch-checklist.csv \
 *       fixtures/ingest-142/docs/team-list.yaml --epic INGEST-142 \
 *       --source fixture --dir fixtures/ingest-142/jira/2026-11-13 --label 2026-11-13
 *
 *   npm run review -- --files <your plan files...> --epic PROJ-123 --source rest
 *       (reads Jira Cloud with JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN; read-only; raw responses cached in
 *        out/jira-cache/<epic>/<label>/ so a re-run on the same day makes no calls)
 *
 * Options: --read-as name=plan_items|launch_checks|teams_and_owners  --launch-date YYYY-MM-DD  --go-no-go YYYY-MM-DD
 *          --agent-items items.json (items the agent extracted by reading the plan files; each must quote its file, see
 *          skills/release-reader/SKILL.md; recomputes Stage A, so use it without --resume)
 *          --no-search TEAM...  --label YYYY-MM-DD (default today)  --runs-dir runs  --cache-dir <dir>
 *
 * Checkpoints (the PRD's confirm-before-Jira rule), for an agent or a person at the terminal:
 *   --stop-after plan     write runs/<epic>/<label>/plan-draft.json and stop; show it, let the person fix it
 *   --stop-after target   same for release-target.json (needs Jira)
 *   --resume              reuse those files as confirmed instead of recomputing them
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "../skills/release-reader/scripts/lib/cli.js";
import type { AgentItem } from "../skills/release-reader/scripts/lib/plan-extract.js";
import { credsFromEnv } from "../skills/release-reader/scripts/lib/jira-rest.js";
import { ReadAs } from "@rrr/schemas";
import { runReview, todayLabel, type SourceSpec } from "./lib/pipeline.js";

async function main() {
  const args = parseArgs(process.argv.slice(2), { lists: ["files", "no-search"], flags: ["resume"] });
  const files = args.lists.files ?? [];
  const resume = args.flags.has("resume");
  if ((!files.length && !resume) || !args.opts.epic) {
    console.error("usage: review.ts --files <plan files...> --epic KEY --source fixture --dir <snapshot> | --source rest [--label YYYY-MM-DD] [--read-as name=kind] [--agent-items items.json] [--launch-date D] [--go-no-go D] [--no-search TEAM...] [--runs-dir runs] [--stop-after plan|target] [--resume]");
    process.exit(2);
  }
  const stopAfter = args.opts["stop-after"] as "plan" | "target" | undefined;
  if (stopAfter && stopAfter !== "plan" && stopAfter !== "target") { console.error("--stop-after must be plan or target"); process.exit(2); }
  const label = args.opts.label ?? todayLabel();
  const readAs: Record<string, ReadAs[]> = {};
  for (const spec of args.multi["read-as"] ?? []) { const [name, kinds] = spec.split("="); readAs[name] = kinds.split(",").map((k) => ReadAs.parse(k.trim())); }
  let agentItems: AgentItem[] | undefined;
  if (args.opts["agent-items"]) agentItems = JSON.parse(readFileSync(args.opts["agent-items"], "utf8"));
  let source: SourceSpec;
  const kind = args.opts.source ?? "fixture";
  if (kind === "fixture") {
    if (!args.opts.dir) { console.error("--source fixture needs --dir <snapshot dir>"); process.exit(2); }
    source = { kind: "fixture", dir: args.opts.dir };
  } else if (kind === "rest") {
    source = { kind: "rest", creds: credsFromEnv(), cacheDir: args.opts["cache-dir"] ?? `out/jira-cache/${args.opts.epic}/${label}`, log: (l) => console.error("  jira: " + l) };
  } else { console.error(`--source must be fixture or rest here (mcp mode runs stage by stage, see skills/release-reader/SKILL.md)`); process.exit(2); }

  const t0 = Date.now();
  const out = await runReview({
    files, readAs, agentItems, launchDate: args.opts["launch-date"] ?? null, epicKey: args.opts.epic, source, label,
    noSearch: args.lists["no-search"] ?? [], goNoGo: args.opts["go-no-go"] ?? null, runsRoot: args.opts["runs-dir"] ?? "runs",
    stopAfter: stopAfter ?? null, resume,
    onStage: (stage, detail) => console.error(`${stage.padEnd(9)} ${detail}`),
  });
  if (out.stopped === "plan") {
    console.error(`stopped after Stage A. Confirm or edit ${out.file}, then re-run with --resume. (? = inferred date, ~ = quote not checked by the command)`);
    for (const i of out.plan.items) console.error(`  ${i.id.padEnd(4)} ${i.kind.padEnd(12)} ${(i.owner_team ?? "—").padEnd(16)} ${(i.due ?? "—").padEnd(10)}${i.due_is_inferred ? "?" : " "}${i.source.quote_verified === false ? "~" : " "}${i.text}`);
    for (const w of out.plan.warnings) console.error("  warning: " + w);
    console.log(out.file);
    return;
  }
  if (out.stopped === "target") {
    console.error(`stopped after Stage B. Confirm or edit ${out.file}, then re-run with --resume.`);
    for (const p of out.target.projects) console.error(`  ${p.team.padEnd(16)} ${(p.jira_project ?? "—").padEnd(8)} ${p.match.padEnd(10)} ${p.evidence}`);
    for (const w of out.target.warnings) console.error("  warning: " + w);
    console.log(out.file);
    return;
  }
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const f of out.findings.findings.filter((f) => f.shown)) console.error(`  ${f.id} [${f.gap_type} ${f.strength}] ${f.title}`);
  console.log(out.runFile);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
