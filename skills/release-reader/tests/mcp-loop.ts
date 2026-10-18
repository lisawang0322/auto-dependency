/** Test helper: play the agent's role in MCP mode by serving requests from a fixture snapshot. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FixtureSource, McpCacheSource } from "../scripts/lib/jira-source.js";

export function serveRequests(cacheDir: string, snapDir: string, src: McpCacheSource): number {
  const fx = new FixtureSource(snapDir);
  const reqs = src.pending();
  for (const r of reqs) {
    const out = join(cacheDir, r.save_as);
    mkdirSync(join(cacheDir, "searches"), { recursive: true });
    if (r.tool === "getVisibleJiraProjects") copyFileSync(join(snapDir, "projects.json"), out);
    else if (r.tool === "getJiraIssue") {
      const f = join(snapDir, "issues", `${r.args.issueIdOrKey}.json`);
      if (existsSync(f)) copyFileSync(f, out);
      else writeFileSync(out, JSON.stringify({ error: "Issue does not exist or you do not have permission to see it." }));
    } else writeFileSync(out, JSON.stringify({ issues: fx.search(String(r.args.jql), Number(r.args.maxResults)) }));
  }
  return reqs.length;
}

/** Run `step` until it returns a value, serving MCP requests between rounds. Returns [result, rounds]. */
export function runMcpLoop<T>(cacheDir: string, snapDir: string, step: (src: McpCacheSource) => T | undefined, maxRounds = 10): [T, number] {
  let rounds = 0;
  while (rounds < maxRounds) {
    const src = new McpCacheSource(cacheDir, "cloud-1");
    const out = step(src);
    rounds++;
    if (out !== undefined) return [out, rounds];
    if (!serveRequests(cacheDir, snapDir, src)) throw new Error("stuck: nothing pending but no result");
  }
  throw new Error("too many rounds");
}
