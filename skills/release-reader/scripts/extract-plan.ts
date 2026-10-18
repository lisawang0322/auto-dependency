#!/usr/bin/env -S npx tsx
/**
 * Stage A — extract-plan. Reads plan files into plan-draft.json. No Jira needed.
 *
 *   npx tsx skills/release-reader/scripts/extract-plan.ts \
 *     --files fixtures/ingest-142/docs/*.md fixtures/ingest-142/docs/*.csv fixtures/ingest-142/docs/*.yaml \
 *     [--read-as launch-checklist.csv=launch_checks] [--launch-date 2026-11-20] \
 *     [--agent-items items.json] [--out plan-draft.json]
 *
 * --agent-items: items the agent extracted from unstructured documents (see SKILL.md).
 *   Each needs a source quote that appears in one of --files, or it is dropped with a warning.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadFile } from "./lib/files.js";
import { extractPlan, type AgentItem } from "./lib/plan-extract.js";
import { ReadAs } from "@rrr/schemas";
import { parseArgs } from "./lib/cli.js";

async function main() {
  const args = parseArgs(process.argv.slice(2), { lists: ["files"], flags: [] });
  const paths = args.lists.files ?? [];
  if (!paths.length) {
    console.error("usage: extract-plan.ts --files <plan files...> [--read-as name=kind[,kind]] [--launch-date YYYY-MM-DD] [--agent-items items.json] [--out plan-draft.json]");
    process.exit(2);
  }
  const files = [];
  for (const p of paths) files.push(await loadFile(p));
  const readAs: Record<string, ReadAs[]> = {};
  for (const spec of args.multi["read-as"] ?? []) {
    const [name, kinds] = spec.split("=");
    readAs[name] = kinds.split(",").map((k) => ReadAs.parse(k.trim()));
  }
  let agentItems: AgentItem[] | undefined;
  if (args.opts["agent-items"]) agentItems = JSON.parse(readFileSync(args.opts["agent-items"], "utf8"));
  const draft = extractPlan({ files, readAs, launchDate: args.opts["launch-date"] ?? null, agentItems });
  const json = JSON.stringify(draft, null, 2) + "\n";
  if (args.opts.out) {
    writeFileSync(args.opts.out, json);
    console.error(`wrote ${args.opts.out}: ${draft.items.length} items, ${draft.teams.length} teams, ${draft.warnings.length} warnings`);
    for (const w of draft.warnings) console.error("  warning: " + w);
  } else process.stdout.write(json);
}
main().catch((e) => { console.error(e); process.exit(1); });
