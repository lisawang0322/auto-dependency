#!/usr/bin/env -S npx tsx
/**
 * throughline-starter: the early stages.
 *
 *   npm run starter -- --stage starting --files fixtures/ingest-142/docs/ingestion-service-PRD.md fixtures/ingest-142/docs/directory.yaml
 *   npm run starter -- --stage building --files <prd> [<directory>] --epic INGEST-142 \
 *       --source fixture --dir fixtures/ingest-142/jira/2026-11-13 [--label 2026-11-13]
 *   npm run starter -- --stage building --files <prd> <directory> --epic PROJ-123 --source rest
 *
 * Options: --exclude g1,g2 (signals the person unticked)  --rules <signals.yaml>  --directory <file>...
 *          --agent-signals signals.json (sentences the agent found by reading the PRD, each with its rule ids; see SKILL.md)
 *          --label YYYY-MM-DD  --runs-dir runs  --cache-dir <dir>
 * Writes runs/<epic or project>/<label>.<stage>.json and prints its path. Jira is only read.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "../../throughline-reader/scripts/lib/cli.js";
import type { AgentSignal } from "./lib/signals.js";
import { credsFromEnv } from "../../throughline-reader/scripts/lib/jira-rest.js";
import { runStarter, todayLabel, type SourceSpec } from "../../../scripts/lib/pipeline.js";

async function main() {
  const args = parseArgs(process.argv.slice(2), { lists: ["files", "directory"], flags: [] });
  const stage = args.opts.stage;
  const files = args.lists.files ?? [];
  if ((stage !== "starting" && stage !== "building") || !files.length) {
    console.error("usage: starter.ts --stage starting|building --files <prd> [<directory>] [--epic KEY --source fixture --dir <snapshot> | --source rest] [--exclude g1,g2] [--agent-signals signals.json] [--rules <file>] [--label YYYY-MM-DD]");
    process.exit(2);
  }
  const label = args.opts.label ?? todayLabel();
  let agentSignals: AgentSignal[] | undefined;
  if (args.opts["agent-signals"]) agentSignals = JSON.parse(readFileSync(args.opts["agent-signals"], "utf8"));
  let source: SourceSpec | undefined;
  if (stage === "building") {
    if (!args.opts.epic) { console.error("--stage building needs --epic KEY"); process.exit(2); }
    const kind = args.opts.source ?? "fixture";
    if (kind === "fixture") {
      if (!args.opts.dir) { console.error("--source fixture needs --dir <snapshot dir>"); process.exit(2); }
      source = { kind: "fixture", dir: args.opts.dir };
    } else if (kind === "rest") {
      source = { kind: "rest", creds: credsFromEnv(), cacheDir: args.opts["cache-dir"] ?? `out/jira-cache/${args.opts.epic}/${label}`, log: (l) => console.error("  jira: " + l) };
    } else { console.error("--source must be fixture or rest"); process.exit(2); }
  }
  const out = await runStarter({
    stage, files, directoryFiles: args.lists.directory ?? [], rulesPath: args.opts.rules,
    agentSignals, excludeSignals: (args.opts.exclude ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    epicKey: args.opts.epic ?? null, source, label, runsRoot: args.opts["runs-dir"] ?? "runs",
    onStage: (s, d) => console.error(`${s.padEnd(9)} ${d}`),
  });
  const st = out.starter;
  if (stage === "starting") {
    for (const t of st.teams) console.error(`  ${t.role.padEnd(8)} ${t.team.padEnd(14)} ${t.when.padEnd(34)} ${t.contact ?? "(no contact: connect a directory)"}`);
    for (const a of st.approvals) console.error(`  approval ${a.name.padEnd(16)} start ${a.start}`);
  } else {
    for (const c of st.coverage) console.error(`  ${c.state.padEnd(8)} ${c.team.padEnd(14)} ${c.found}`);
    for (const a of st.approval_status) console.error(`  ${a.state.padEnd(12)} ${a.name.padEnd(16)} ${a.detail}`);
  }
  for (const a of st.next_actions) console.error(`  action: ${a.text} — ${a.who}, ${a.when}`);
  for (const w of st.warnings) console.error("  warning: " + w);
  console.log(out.file);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
