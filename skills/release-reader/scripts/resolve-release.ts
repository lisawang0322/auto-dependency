#!/usr/bin/env -S npx tsx
/**
 * Stage B — resolve-release. Finds the epic, its fix version and each team's Jira project.
 *
 *   npx tsx skills/release-reader/scripts/resolve-release.ts --plan plan-draft.json \
 *     --source fixture --dir fixtures/ingest-142/jira/2026-11-13 [--epic INGEST-142] \
 *     [--no-search SRE] [--out release-target.json]
 *
 *   --source mcp --dir <cache-dir> [--cloud-id <id>]: reads raw Atlassian MCP responses from <cache-dir>.
 *     When responses are missing it writes <cache-dir>/requests.json and exits 3; run those read-only
 *     calls, save the responses, and re-run. See SKILL.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PlanDraft } from "@rrr/schemas";
import { parseArgs } from "./lib/cli.js";
import { openSource, stopIfPending } from "./lib/jira-source.js";
import { resolveRelease } from "./lib/resolve.js";

const args = parseArgs(process.argv.slice(2), { lists: ["no-search"], flags: [] });
if (!args.opts.plan || !args.opts.dir) {
  console.error("usage: resolve-release.ts --plan plan-draft.json --source fixture|mcp --dir <snapshot or cache dir> [--epic KEY] [--cloud-id ID] [--no-search TEAM...] [--out release-target.json]");
  process.exit(2);
}
const plan = PlanDraft.parse(JSON.parse(readFileSync(args.opts.plan, "utf8")));
const source = openSource({ source: args.opts.source ?? "fixture", dir: args.opts.dir, cloudId: args.opts["cloud-id"] });
const target = resolveRelease({ plan, source, epicKey: args.opts.epic ?? null, noSearch: args.lists["no-search"] ?? [] });
if (!target) stopIfPending(source);
const json = JSON.stringify(target, null, 2) + "\n";
if (args.opts.out) {
  writeFileSync(args.opts.out, json);
  console.error(`wrote ${args.opts.out}: epic ${target!.epic.key}, ${target!.projects.filter((p) => p.match !== "unresolved").length}/${target!.projects.length} teams resolved, ${target!.warnings.length} warnings`);
  for (const w of target!.warnings) console.error("  warning: " + w);
} else process.stdout.write(json);
