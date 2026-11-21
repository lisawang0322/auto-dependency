import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { PlanDraft, ReleaseTarget, Release, Findings } from "@throughline/schemas";
import { analyze, fridayBefore, isDone, isAbandoned } from "../scripts/lib/analyze.js";
import { keywordsFor, scoreText, termMatches } from "../scripts/lib/text.js";

const FX = resolve(__dirname, "../../../fixtures/ingest-142");
const SK = resolve(__dirname, "..");
const templates = YAML.parse(readFileSync(join(SK, "templates/next_actions.yaml"), "utf8"));
const phrases = YAML.parse(readFileSync(join(SK, "rules/phrases.yaml"), "utf8"));
const load = <T>(schema: { parse: (x: unknown) => T }, name: string) => schema.parse(JSON.parse(readFileSync(join(FX, name), "utf8")));

function run(snapshot = "2026-11-13", teamList = true) {
  const sfx = teamList ? "" : ".no-team-list";
  return analyze({
    plan: load(PlanDraft, `plan-draft${sfx}.json`),
    target: load(ReleaseTarget, `release-target${sfx}.json`),
    release: load(Release, `release.${snapshot}${sfx}.json`),
    templates, phrases, analyzedAt: `${snapshot}T09:05:00.000Z`,
  });
}

describe("throughline-analyzer on the Nov 13 snapshot", () => {
  const out = run();
  const shown = out.findings.filter((f) => f.shown);

  it("validates and shows exactly the 4 expected findings, with these types and strengths", () => {
    expect(Findings.safeParse(out).success).toBe(true);
    expect(shown.map((f) => [f.plan_item_id, f.gap_type, f.strength])).toEqual([
      ["p3", "process", "strong"],          // Security approval open
      ["p4", "cross_team_date", "moderate"], // SRE capacity due Nov 22
      ["p6", "commitment", "moderate"],      // DB permissions review promised in a comment, no ticket
      ["p7", "process", "moderate"],         // No rollback plan, none found
    ]);
  });

  it("Security approval open: strong, matched to the linked SEC-881", () => {
    const f = shown[0];
    expect(f.match_way).toBe("linked_keywords");
    expect(f.evidence[0]).toMatchObject({ key: "SEC-881", text: "Security review: ingestion service" });
    expect(f.evidence[0].meta).toContain("In Review");
    expect(f.evidence[0].meta).toContain("linked to INGEST-142 (is blocked by)");
    expect(f.owner).toBe("Security");
    expect(f.owner_source).toBe("team_list");
  });

  it("SRE capacity: cross_team_date, moderate (search), with the linkage gap INGEST-142 → SRE-412 attached", () => {
    const f = shown[1];
    expect(f.match_way).toBe("search");
    expect(f.evidence[0]).toMatchObject({ key: "SRE-412" });
    expect(f.evidence[0].meta).toContain("due 2026-11-22");
    expect(f.linkage).toEqual({ from: "INGEST-142", to: "SRE-412", suggested_type: "is blocked by" });
    const g = out.linkage_gaps.find((g) => g.to === "SRE-412")!;
    expect(g).toMatchObject({ from: "INGEST-142", how: "search_match", suggested_type: "is blocked by", finding_id: f.id });
  });

  it("DB permissions review: commitment, moderate, promise comment plus the duplicate-closed ticket as evidence, none found in DATA", () => {
    const f = shown[2];
    expect(f.match_way).toBe("comment");
    expect(f.evidence.map((e) => e.key)).toEqual(["INGEST-157", "DATA-240"]);
    expect(f.evidence[0].text).toContain("DBA will review prod permissions before launch");
    expect(f.evidence[1].meta).toContain("Closed (Duplicate)");
    expect(f.none_found).toEqual({ projects: ["DATA"], jql: ['project = DATA AND updated >= 2026-09-15 AND text ~ "production db permissions"'] });
    // the decoy DATA-251 was rejected, and says why
    expect(out.warnings.some((w) => w.includes("DATA-251") && w.includes("lead term missing"))).toBe(true);
  });

  it("No rollback plan: process, moderate, explicit none found with projects and JQL", () => {
    const f = shown[3];
    expect(f.match_way).toBe("none");
    expect(f.evidence).toEqual([]);
    expect(f.none_found).toEqual({ projects: ["INGEST"], jql: ['project = INGEST AND updated >= 2026-09-15 AND text ~ "rollback plan"'] });
  });

  it("one weak finding (load test, comment only), hidden by default", () => {
    const weak = out.findings.filter((f) => f.strength === "weak");
    expect(weak.length).toBe(1);
    expect(weak[0]).toMatchObject({ plan_item_id: "p5", gap_type: "commitment", shown: false, hidden_by_default: true, match_way: "linked_keywords" });
    expect(weak[0].evidence[0].text).toContain("load test looks fine");
    expect(out.findings.length).toBe(5);
    expect(out.findings.every((f) => f.strength === "weak" || f.shown)).toBe(true);
  });

  it("one separate linkage gap: INGEST-150 mentions DATA-233", () => {
    const separate = out.linkage_gaps.filter((g) => g.finding_id === null);
    expect(separate).toEqual([{ id: "lg2", from: "INGEST-150", to: "DATA-233", to_summary: "Raise ingestion cluster quota", how: "comment_mention", suggested_type: "is blocked by", finding_id: null }]);
    expect(out.linkage_gaps.length).toBe(2);
  });

  it("every finding has a non-empty next_action with action, who, by_when and why; why is the title", () => {
    for (const f of out.findings) {
      expect(f.next_action!.action.length).toBeGreaterThan(20);
      expect(f.next_action!.who).toContain(f.owner);
      expect(f.next_action!.by_when.length).toBeGreaterThan(0);
      expect(f.next_action!.why).toBe(f.title);
      expect(f.ask).toBe(f.next_action!.action);
      expect(f.plan_quote).toBe(f.plan_source!.quote);
    }
    expect(shown[3].next_action!.by_when).toBe("before go/no-go (2026-11-13)"); // plan date Nov 16 is after go/no-go
    expect(shown[0].next_action!.by_when).toBe("before go/no-go (2026-11-13)"); // Nov 14 is after go/no-go too
    expect(shown[1].next_action!.by_when).toBe("2026-11-13");
    expect(shown[2].next_action!.who).toBe("Data Platform · Wei Zhang (eng lead)");
  });

  it("sorts by strength then plan date, and records how every plan item matched", () => {
    expect(out.findings.map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(out.matches.map((m) => [m.plan_item_id, m.way, m.key])).toEqual([
      ["p1", "linked_keywords", "INGEST-142"], ["p2", "comment", "DATA-233"], ["p3", "linked_keywords", "SEC-881"], ["p4", "search", "SRE-412"],
      ["p5", "linked_keywords", "INGEST-163"], ["p6", "comment", null], ["p7", "none", null],
    ]);
    expect(out.service_team).toBe("Ingestion team");
    expect(out.go_no_go).toBe("2026-11-13");
  });

  it("is repeatable", () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("other snapshots and inputs", () => {
  it("on the Nov 10 snapshot the SRE finding is absent; the approval and rollback findings remain", () => {
    const out = run("2026-11-10");
    expect(out.findings.map((f) => [f.plan_item_id, f.gap_type, f.strength])).toEqual([["p3", "process", "strong"], ["p7", "process", "moderate"]]);
    expect(out.findings[0].evidence[0].meta).toContain("Open");
    // SRE-412 is still unlinked, so its linkage gap is listed separately now
    expect(out.linkage_gaps.map((g) => [g.to, g.finding_id])).toEqual([["SRE-412", null], ["DATA-233", null]]);
  });

  it("without the team list, owners say inferred and no strong finding loses its strength", () => {
    const withList = run();
    const out = run("2026-11-13", false);
    expect(out.team_list_given).toBe(false);
    expect(out.findings.every((f) => f.owner_source === "jira_inferred")).toBe(true);
    expect(out.findings.every((f) => f.next_action!.who.endsWith("(owner inferred)"))).toBe(true);
    expect(out.findings.map((f) => [f.plan_item_id, f.gap_type, f.strength])).toEqual(withList.findings.map((f) => [f.plan_item_id, f.gap_type, f.strength]));
    expect(out.findings.filter((f) => f.strength === "strong").length).toBe(withList.findings.filter((f) => f.strength === "strong").length);
  });

  it("the cap marks only the first 10 non-weak findings as shown", () => {
    const out = analyze({ plan: load(PlanDraft, "plan-draft.json"), target: load(ReleaseTarget, "release-target.json"), release: load(Release, "release.2026-11-13.json"), templates, phrases, cap: 2, analyzedAt: "2026-11-13T09:05:00.000Z" });
    expect(out.findings.map((f) => f.shown)).toEqual([true, true, false, false, false]);
  });
});

describe("rules", () => {
  it("keywords, prefix matching and the lead-term rule", () => {
    expect(keywordsFor("SRE capacity and on-call in place", "SRE")).toEqual(["capacity", "on-call"]);
    expect(keywordsFor("Production DB permissions reviewed", "Data Platform")).toEqual(["production", "db", "permissions"]);
    expect(termMatches("production", "prod")).toBe(true);
    expect(termMatches("db", "dba")).toBe(true);
    expect(termMatches("security", "secrets")).toBe(false);
    expect(scoreText(["production", "db", "permissions"], "DBA will review prod permissions before launch")).toMatchObject({ score: 1, accepted: true });
    expect(scoreText(["rollback", "plan"], "Cut-over plan from batch importer")).toMatchObject({ score: 0.5, lead: false, accepted: false });
    expect(scoreText(["capacity", "on-call"], "Capacity for ingestion service")).toMatchObject({ score: 0.5, lead: true, accepted: true });
  });
  it("status rules and the go/no-go date", () => {
    expect(isDone({ status: "Done", resolution: "Done" })).toBe(true);
    expect(isDone({ status: "Closed", resolution: "Duplicate" })).toBe(false);
    expect(isAbandoned({ status: "Closed", resolution: "Won't Do" })).toBe(true);
    expect(isDone({ status: "In Review", resolution: null })).toBe(false);
    expect(fridayBefore("2026-11-20")).toBe("2026-11-13"); // launch on a Friday → the previous Friday
    expect(fridayBefore("2026-11-18")).toBe("2026-11-13");
    expect(fridayBefore("2026-11-21")).toBe("2026-11-20");
  });
});
