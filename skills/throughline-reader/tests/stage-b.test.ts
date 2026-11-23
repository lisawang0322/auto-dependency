import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { runMcpLoop } from "./mcp-loop.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanDraft, ReleaseTarget } from "@throughline/schemas";
import { FixtureSource, McpCacheSource, searchFileName } from "../scripts/lib/jira-source.js";
import { resolveRelease } from "../scripts/lib/resolve.js";
import { matchTeam, nameCandidates } from "../scripts/lib/match.js";
import { parseJql, matchesJql, keywordsFor, scopedSearchJql } from "../scripts/lib/jql.js";

const FX = resolve(__dirname, "../../../fixtures/ingest-142");
const SNAP = join(FX, "jira/2026-11-13");
const load = (name: string) => PlanDraft.parse(JSON.parse(readFileSync(join(FX, name), "utf8")));
const DECOYS = ["SRETOOLS", "SECOPS"];

describe("Stage B: resolve-release", () => {
  it("with the team list, all 4 teams resolve as team_list", () => {
    const t = resolveRelease({ plan: load("plan-draft.json"), source: new FixtureSource(SNAP) })!;
    expect(ReleaseTarget.safeParse(t).success).toBe(true);
    expect(t.epic).toMatchObject({ key: "INGEST-142", fix_version: "1.0", release_date: "2026-11-20", created: "2026-09-15" });
    expect(t.projects.map((p) => [p.team, p.jira_project, p.match])).toEqual([
      ["Ingestion team", "INGEST", "team_list"], ["Data Platform", "DATA", "team_list"], ["Security", "SEC", "team_list"], ["SRE", "SRE", "team_list"],
    ]);
    expect(t.release_window).toEqual({ start: "2026-09-15", end: "2026-11-20" });
    expect(t.visible_projects.map((p) => p.key)).toEqual(["DATA", "DSGN", "INGEST", "SEC", "SECOPS", "SRE", "SRETOOLS"]);
    expect(t.warnings).toEqual([]);
  });

  it("without it, SEC is ambiguous between SEC and SECOPS and stays unresolved with both as candidates", () => {
    const t = resolveRelease({ plan: load("plan-draft.no-team-list.json"), source: new FixtureSource(SNAP) })!;
    const sec = t.projects.find((p) => p.team === "Security")!;
    expect(sec.match).toBe("unresolved");
    expect(sec.jira_project).toBeNull();
    expect(sec.candidates.map((c) => c.key).sort()).toEqual(["SEC", "SECOPS"]);
    expect(sec.candidates[0].key).toBe("SEC"); // the linked one is listed first
    expect(sec.candidates[0].evidence).toContain("SEC-881");
    expect(t.warnings.some((w) => w.startsWith("Security: unresolved"))).toBe(true);
    // the other three still resolve, and say how
    expect(t.projects.find((p) => p.team === "Ingestion team")).toMatchObject({ jira_project: "INGEST", match: "explicit" });
    expect(t.projects.find((p) => p.team === "Data Platform")).toMatchObject({ jira_project: "DATA", match: "linked" });
    expect(t.projects.find((p) => p.team === "SRE")).toMatchObject({ jira_project: "SRE", match: "linked" });
  });

  it("no team is ever silently matched to a decoy", () => {
    for (const plan of ["plan-draft.json", "plan-draft.no-team-list.json"]) {
      for (const snap of ["2026-11-10", "2026-11-13"]) {
        const t = resolveRelease({ plan: load(plan), source: new FixtureSource(join(FX, "jira", snap)) })!;
        for (const p of t.projects) expect(DECOYS).not.toContain(p.jira_project);
      }
    }
    // Even a team literally called "SRE Tooling" would only match the decoy by exact name, with evidence.
    const t = resolveRelease({ plan: load("plan-draft.no-team-list.json"), source: new FixtureSource(SNAP) })!;
    const projects = t.visible_projects;
    const sre = { name: "SRE", mentioned_in: [], jira_project_hint: null, owners: [], components: [], project_keys_mentioned: [] };
    expect(nameCandidates(sre, projects).map((c) => c.key)).toEqual(["SRE"]);
    const secOps = { ...sre, name: "Security Ops" };
    expect(nameCandidates(secOps, projects).map((c) => c.key)).toEqual([]); // "ops" is not in any field; no silent guess
  });

  it("uses the person's epic choice, warns on a non-epic, and flags a launch-date mismatch", () => {
    const plan = load("plan-draft.json");
    expect(() => resolveRelease({ plan, source: new FixtureSource(SNAP), epicKey: "INGEST-150" })).toThrow(/not an Epic/);
    const t = resolveRelease({ plan: { ...plan, launch_date: "2026-11-21" }, source: new FixtureSource(SNAP), epicKey: "INGEST-142" })!;
    expect(t.warnings.some((w) => /Launch date differs: the plan says 2026-11-21.*2026-11-20/.test(w))).toBe(true);
    expect(t.release_window.end).toBe("2026-11-21");
  });

  it("honours --no-search and a team-list key that is not visible", () => {
    const plan = load("plan-draft.json");
    plan.teams[2].jira_project_hint = "SECURITY";
    const t = resolveRelease({ plan, source: new FixtureSource(SNAP), noSearch: ["SRE"] })!;
    expect(t.projects.find((p) => p.team === "SRE")!.search).toBe(false);
    const sec = t.projects.find((p) => p.team === "Security")!;
    expect(sec.match).toBe("unresolved");
    expect(t.warnings.some((w) => w.includes("SECURITY, which is not visible"))).toBe(true);
  });

  it("matches by link when no project is named like the team but linked issues mention it", () => {
    const projects = [{ key: "PLT", name: "Platform", category: null, description: null, lead: null }, { key: "X", name: "Other", category: null, description: null, lead: null }];
    const team = { name: "Data Platform", mentioned_in: [], jira_project_hint: null, owners: [], components: [], project_keys_mentioned: [] };
    const linked = [{ key: "PLT", via: ["PLT-1 (is blocked by, from E-1)"], text: "Data platform quota for the launch" }];
    const m = matchTeam(team, projects, linked, []);
    expect(m).toMatchObject({ jira_project: "PLT", match: "linked" });
    const none = matchTeam(team, projects, [], []);
    expect(none).toMatchObject({ jira_project: null, match: "unresolved", candidates: [] });
  });

  it("MCP mode records the read calls it needs, then runs from the saved responses", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cache-"));
    const plan = load("plan-draft.json");
    const first = new McpCacheSource(dir, "cloud-1");
    expect(resolveRelease({ plan, source: first })).toBeUndefined();
    expect(first.pending().map((r) => r.tool)).toEqual(["getJiraIssue"]);
    expect(first.pending()[0].args).toMatchObject({ cloudId: "cloud-1", issueIdOrKey: "INGEST-142" });
    const [out, rounds] = runMcpLoop(dir, SNAP, (src) => resolveRelease({ plan, source: src }));
    expect(rounds).toBeLessThanOrEqual(4);
    expect(out).toEqual(resolveRelease({ plan, source: new FixtureSource(SNAP) }));
    expect(existsSync(join(dir, searchFileName("parent = INGEST-142")))).toBe(true);
  });

  it("is repeatable", () => {
    const a = JSON.stringify(resolveRelease({ plan: load("plan-draft.no-team-list.json"), source: new FixtureSource(SNAP) }));
    const b = JSON.stringify(resolveRelease({ plan: load("plan-draft.no-team-list.json"), source: new FixtureSource(SNAP) }));
    expect(a).toBe(b);
  });
});

describe("JQL", () => {
  it("builds scoped searches with 2–4 keywords, excluding the team's own words", () => {
    expect(keywordsFor("SRE capacity and on-call in place", "SRE")).toEqual(["capacity", "on-call"]);
    expect(keywordsFor("Production DB permissions reviewed", "Data Platform")).toEqual(["production", "db", "permissions"]);
    expect(keywordsFor("Cluster quota raised for ingestion load", "Data Platform")).toEqual(["cluster", "quota", "ingestion", "load"]);
    expect(keywordsFor("Ingestion service live in production", "Ingestion team")).toEqual(["service", "production"]);
    expect(scopedSearchJql("SRE", "2026-09-15", ["capacity", "on-call"])).toBe('project = SRE AND updated >= 2026-09-15 AND text ~ "capacity on-call"');
  });
  it("evaluates the supported forms over fixture issues", () => {
    const fx = new FixtureSource(SNAP);
    expect(fx.search("parent = INGEST-142", 500)!.length).toBe(25);
    expect(fx.search('project = SRE AND updated >= 2026-09-15 AND text ~ "capacity on-call"', 20)!.map((i) => i.key)).toEqual(["SRE-412"]);
    expect(fx.search('project = SRE AND updated >= 2026-11-13 AND text ~ "capacity"', 20)!.length).toBe(0);
    expect(fx.search("key in (SEC-881, DATA-233, NOPE-1)", 20)!.map((i) => i.key)).toEqual(["DATA-233", "SEC-881"]);
    expect(() => parseJql("project = A OR project = B")).toThrow(/OR/);
    expect(matchesJql(fx.getIssue("INGEST-150")!, parseJql('text ~ "DATA-233"'))).toBe(true);
  });
});
