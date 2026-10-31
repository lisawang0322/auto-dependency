#!/usr/bin/env -S npx tsx
/**
 * Stage C — read-jira. Reads the epic, one hop out, and a scoped search per matched project.
 *
 *   npx tsx skills/release-reader/scripts/read-jira.ts --plan plan-draft.json --target release-target.json \
 *     --source fixture --dir fixtures/ingest-142/jira/2026-11-13 [--label 2026-11-13] [--out release.json]
 *
 *   --source mcp --dir <cache-dir> [--cloud-id <id>]: same loop as Stage B (requests.json, exit 3, re-run).
 *   --source rest --dir <cache-dir>: same loop, run by the script over Jira Cloud REST (read-only) with
 *     JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN from the environment.
 *   --no-search TEAM: skip the scoped search for that team (also settable in release-target.json: "search": false).
 *   --read-at <ISO>: fix the timestamp (tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PlanDraft, ReleaseTarget, type Release } from "@rrr/schemas";
import { parseArgs } from "./lib/cli.js";
import { openSource, stopIfPending } from "./lib/jira-source.js";
import { JiraRest, credsFromEnv, runRestLoop } from "./lib/jira-rest.js";
import { readJira } from "./lib/read.js";

async function main() {
  const args = parseArgs(process.argv.slice(2), { lists: ["no-search"], flags: [] });
  if (!args.opts.plan || !args.opts.target || !args.opts.dir) {
    console.error("usage: read-jira.ts --plan plan-draft.json --target release-target.json --source fixture|mcp|rest --dir <dir> [--label L] [--cloud-id ID] [--no-search TEAM...] [--read-at ISO] [--out release.json]");
    process.exit(2);
  }
  const plan = PlanDraft.parse(JSON.parse(readFileSync(args.opts.plan, "utf8")));
  const target = ReleaseTarget.parse(JSON.parse(readFileSync(args.opts.target, "utf8")));
  const noSearch = new Set((args.lists["no-search"] ?? []).map((s) => s.toLowerCase()));
  for (const p of target.projects) if (noSearch.has(p.team.toLowerCase())) p.search = false;
  const source = args.opts.source ?? "fixture";
  const run = (src: Parameters<typeof readJira>[0]["source"]) => readJira({ plan, target, source: src, snapshotLabel: args.opts.label ?? src.label, readAt: args.opts["read-at"] });
  let release: Release | undefined;
  if (source === "rest") {
    const rest = new JiraRest(credsFromEnv());
    [release] = await runRestLoop(args.opts.dir, rest, run, { log: (l) => console.error("  jira: " + l) });
  } else {
    const src = openSource({ source, dir: args.opts.dir, cloudId: args.opts["cloud-id"] });
    release = run(src);
    if (!release) stopIfPending(src);
  }
  const json = JSON.stringify(release, null, 2) + "\n";
  if (args.opts.out) {
    writeFileSync(args.opts.out, json);
    const r = release!;
    console.error(`wrote ${args.opts.out}: ${r.stories.length} stories, ${r.links.length} links, ${r.related.length} related, ${r.search_candidates.length} search candidates, ${r.warnings.length} warnings`);
    for (const w of r.warnings) console.error("  warning: " + w);
  } else process.stdout.write(json);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
