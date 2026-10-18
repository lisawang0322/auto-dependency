#!/usr/bin/env -S npx tsx
/**
 * Stage C — read-jira. Reads the epic, one hop out, and a scoped search per matched project.
 *
 *   npx tsx skills/release-reader/scripts/read-jira.ts --plan plan-draft.json --target release-target.json \
 *     --source fixture --dir fixtures/ingest-142/jira/2026-11-13 [--label 2026-11-13] [--out release.json]
 *
 *   --source mcp --dir <cache-dir> [--cloud-id <id>]: same loop as Stage B (requests.json, exit 3, re-run).
 *   --no-search TEAM: skip the scoped search for that team (also settable in release-target.json: "search": false).
 *   --read-at <ISO>: fix the timestamp (tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PlanDraft, ReleaseTarget } from "@rrr/schemas";
import { parseArgs } from "./lib/cli.js";
import { openSource, stopIfPending } from "./lib/jira-source.js";
import { readJira } from "./lib/read.js";

const args = parseArgs(process.argv.slice(2), { lists: ["no-search"], flags: [] });
if (!args.opts.plan || !args.opts.target || !args.opts.dir) {
  console.error("usage: read-jira.ts --plan plan-draft.json --target release-target.json --source fixture|mcp --dir <dir> [--label L] [--cloud-id ID] [--no-search TEAM...] [--read-at ISO] [--out release.json]");
  process.exit(2);
}
const plan = PlanDraft.parse(JSON.parse(readFileSync(args.opts.plan, "utf8")));
const target = ReleaseTarget.parse(JSON.parse(readFileSync(args.opts.target, "utf8")));
const noSearch = new Set((args.lists["no-search"] ?? []).map((s) => s.toLowerCase()));
for (const p of target.projects) if (noSearch.has(p.team.toLowerCase())) p.search = false;
const source = openSource({ source: args.opts.source ?? "fixture", dir: args.opts.dir, cloudId: args.opts["cloud-id"] });
const release = readJira({ plan, target, source, snapshotLabel: args.opts.label ?? source.label, readAt: args.opts["read-at"] });
if (!release) stopIfPending(source);
const json = JSON.stringify(release, null, 2) + "\n";
if (args.opts.out) {
  writeFileSync(args.opts.out, json);
  const r = release!;
  console.error(`wrote ${args.opts.out}: ${r.stories.length} stories, ${r.links.length} links, ${r.related.length} related, ${r.search_candidates.length} search candidates, ${r.warnings.length} warnings`);
  for (const w of r.warnings) console.error("  warning: " + w);
} else process.stdout.write(json);
