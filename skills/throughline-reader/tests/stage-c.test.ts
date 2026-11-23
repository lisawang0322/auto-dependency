import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PlanDraft, ReleaseTarget, Release } from "@throughline/schemas";
import { FixtureSource } from "../scripts/lib/jira-source.js";
import { readJira } from "../scripts/lib/read.js";
import { runMcpLoop } from "./mcp-loop.js";

const FX = resolve(__dirname, "../../../fixtures/ingest-142");
const snap = (d: string) => join(FX, "jira", d);
const plan = () => PlanDraft.parse(JSON.parse(readFileSync(join(FX, "plan-draft.json"), "utf8")));
const target = () => ReleaseTarget.parse(JSON.parse(readFileSync(join(FX, "release-target.json"), "utf8")));
const read = (d = "2026-11-13", t = target()) => readJira({ plan: plan(), target: t, source: new FixtureSource(snap(d)), snapshotLabel: d, readAt: "2026-11-13T09:00:00.000Z" })!;

describe("Stage C: read-jira (Nov 13)", () => {
  it("reads the epic, its 25 stories with comments, and its 7 links", () => {
    const r = read();
    expect(Release.safeParse(r).success).toBe(true);
    expect(r.epic).toMatchObject({ key: "INGEST-142", status: "In Progress", fix_version: "1.0", release_date: "2026-11-20", due: "2026-11-18", components: ["ingestion-api", "ingestion-workers"] });
    expect(r.stories.length).toBe(25);
    expect(r.stories.filter((s) => s.status === "Done").length).toBe(21);
    expect(r.links.length).toBe(7);
    const s150 = r.stories.find((s) => s.key === "INGEST-150")!;
    expect(s150.comments.some((c) => c.mentioned_keys.includes("DATA-233"))).toBe(true);
    expect(r.links).toContainEqual({ from: "INGEST-142", to: "SEC-881", type: "is blocked by", direction: "inward" });
  });

  it("SRE-412 appears only in search_candidates, matched to the SRE item", () => {
    const r = read();
    expect(r.stories.map((s) => s.key)).not.toContain("SRE-412");
    expect(r.related.map((s) => s.key)).not.toContain("SRE-412");
    const c = r.search_candidates.filter((c) => c.key === "SRE-412");
    expect(c.length).toBe(1);
    const sreItem = plan().items.find((i) => i.owner_team === "SRE")!;
    expect(c[0]).toMatchObject({ matched_plan_item_id: sreItem.id, project: "SRE", status: "To Do", due: "2026-11-22", match_terms: ["capacity", "on-call"] });
    expect(c[0].jql).toBe('project = SRE AND updated >= 2026-09-15 AND text ~ "capacity on-call"');
  });

  it("DATA-233 appears in related via comment_mention from INGEST-150", () => {
    const r = read();
    const d = r.related.find((x) => x.key === "DATA-233")!;
    expect(d).toMatchObject({ reached_by: "comment_mention", status: "Done", due: "2026-11-12", via: { issue: "INGEST-150", link_type: null } });
    expect(d.via.comment_excerpt).toContain("DATA-233");
    expect(r.search_candidates.map((c) => c.key)).not.toContain("DATA-233"); // already reached, so dropped from search
  });

  it("SEC-881 appears in related via a link", () => {
    const r = read();
    const s = r.related.find((x) => x.key === "SEC-881")!;
    expect(s).toMatchObject({ reached_by: "link", status: "In Review", due: "2026-11-14", via: { issue: "INGEST-142", link_type: "is blocked by", comment_excerpt: null } });
    expect(r.related.map((x) => [x.key, x.reached_by])).toEqual([
      ["SEC-881", "link"], ["DATA-240", "link"], ["SRE-398", "link"], ["DSGN-31", "link"], ["DATA-221", "link"], ["SEC-890", "link"], ["DATA-233", "comment_mention"],
    ]);
  });

  it("with SRE marked \"don't search\", SRE-412 is missing", () => {
    const t = target();
    t.projects.find((p) => p.team === "SRE")!.search = false;
    const r = read("2026-11-13", t);
    expect(r.search_candidates.map((c) => c.key)).not.toContain("SRE-412");
    expect(r.projects_searched.map((p) => p.team)).toEqual(["Ingestion team", "Data Platform", "Security"]);
    expect(r.warnings).toContain('SRE: not searched (marked "don\'t search").');
  });

  it("skips unresolved teams with a warning instead of guessing", () => {
    const t = ReleaseTarget.parse(JSON.parse(readFileSync(join(FX, "release-target.no-team-list.json"), "utf8")));
    const r = read("2026-11-13", t);
    expect(r.projects_searched.map((p) => p.jira_project)).toEqual(["INGEST", "DATA", "SRE"]);
    expect(r.warnings.some((w) => w.startsWith("Security: no Jira project resolved"))).toBe(true);
  });

  it("the Nov 10 snapshot shows the earlier state", () => {
    const r = read("2026-11-10");
    expect(r.stories.filter((s) => s.status === "Done").length).toBe(18);
    expect(r.related.find((x) => x.key === "SEC-881")!.status).toBe("Open");
    expect(r.related.find((x) => x.key === "DATA-240")!.status).toBe("To Do");
    expect(r.related.find((x) => x.key === "DATA-233")!.status).toBe("In Progress");
    expect(r.search_candidates.find((c) => c.key === "SRE-412")!.due).toBe("2026-11-13");
    expect(r.stories.find((s) => s.key === "INGEST-163")!.comments.length).toBe(1); // "load test looks fine" is dated Nov 11
  });

  it("two runs on the same input give identical output apart from read_at", () => {
    const a = readJira({ plan: plan(), target: target(), source: new FixtureSource(snap("2026-11-13")), snapshotLabel: "x" })!;
    const b = readJira({ plan: plan(), target: target(), source: new FixtureSource(snap("2026-11-13")), snapshotLabel: "x" })!;
    expect({ ...a, read_at: null }).toEqual({ ...b, read_at: null });
  });

  it("MCP mode reaches the same result through the request loop", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cache-c-"));
    const [out, rounds] = runMcpLoop(dir, snap("2026-11-13"), (src) => readJira({ plan: plan(), target: target(), source: src, snapshotLabel: "2026-11-13", readAt: "2026-11-13T09:00:00.000Z" }));
    expect(rounds).toBeLessThanOrEqual(6);
    expect(out).toEqual(read());
  });

  it("a missing link target becomes a warning, not a crash", () => {
    const src = new FixtureSource(snap("2026-11-13"));
    const orig = src.getIssue.bind(src);
    src.getIssue = (k: string) => (k === "SEC-890" ? null : orig(k));
    const r = readJira({ plan: plan(), target: target(), source: src, snapshotLabel: "x" })!;
    expect(r.related.map((x) => x.key)).not.toContain("SEC-890");
    expect(r.warnings).toContain("SEC-890 (linked from INGEST-157, is blocked by) does not exist or is not visible.");
  });
});
