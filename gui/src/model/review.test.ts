import { describe, it, expect } from "vitest";
import type { Finding, Team, TeamProject } from "@rrr/schemas";
import { rollup, teamStatus, releaseStatus, visibleFindings, allTeamsResolved, applyChoices, hiddenWeakCount, openFindingCount } from "./review";

const item = (id: string, result: Team["items"][number]["result"], finding_id: string | null = null): Team["items"][number] =>
  ({ plan_item_id: id, text: id, ticket: null, ticket_status: "", plan_due: "2026-11-13", jira_due: null, result, note: result, finding_id });
const team = (name: string, items: Team["items"]): Team => ({ team: name, project_key: "X", role: "", status: "on_track", items, change_note: "" });
const finding = (id: string, strength: Finding["strength"]): Finding =>
  ({ id, title: id, gap_type: "process", strength, owner: "T", owner_source: "team_list", plan_item_id: "p1", evidence: [], why: "" });

describe("status roll-up", () => {
  it("late beats at risk beats on track", () => {
    expect(teamStatus([{ effective: "ok" }, { effective: "gap" }, { effective: "late" }])).toBe("late");
    expect(teamStatus([{ effective: "ok" }, { effective: "gap" }])).toBe("at_risk");
    expect(teamStatus([{ effective: "ok" }, { effective: "weak" }])).toBe("on_track");
    expect(teamStatus([])).toBe("on_track");
  });
  it("a dismissed finding no longer counts against its team", () => {
    const teams = [team("SRE", [item("p4", "late", "f3")]), team("Sec", [item("p3", "gap", "f1")])];
    const before = rollup(teams, {}, null);
    expect(before.map((t) => t.status)).toEqual(["late", "at_risk"]);
    expect(releaseStatus(before)).toBe("Amber");
    const after = rollup(teams, { f3: { kind: "dismissed", reason: "n/a", at: "" }, f1: { kind: "dismissed", reason: "n/a", at: "" } }, null);
    expect(after.map((t) => t.status)).toEqual(["on_track", "on_track"]);
    expect(after[0].items[0]).toMatchObject({ effective: "dismissed", note_effective: "Dismissed — n/a" });
    expect(releaseStatus(after)).toBe("Green");
    // keeping does not change status
    const kept = rollup(teams, { f3: { kind: "kept", reason: "", at: "" } }, null);
    expect(kept[0].status).toBe("late");
  });
  it("hides items whose plan item was not confirmed, and uses edited plan dates", () => {
    const teams = [team("Ingest", [item("p1", "ok"), item("p7", "gap", "f4")])];
    const r = rollup(teams, {}, new Set(["p1"]), { p1: "2026-11-19" });
    expect(r[0].items.map((i) => i.plan_item_id)).toEqual(["p1"]);
    expect(r[0].items[0].plan_due_effective).toBe("2026-11-19");
    expect(r[0].status).toBe("on_track");
  });
});

describe("weak filter and cap", () => {
  const fs = [finding("w1", "weak"), finding("m1", "moderate"), finding("s1", "strong"), finding("m2", "moderate")];
  it("hides weak by default and orders strongest first, keeping input order within a strength", () => {
    expect(visibleFindings(fs, false).map((f) => f.id)).toEqual(["s1", "m1", "m2"]);
    expect(visibleFindings(fs, true).map((f) => f.id)).toEqual(["s1", "m1", "m2", "w1"]);
    expect(hiddenWeakCount(fs, false)).toBe(1);
    expect(hiddenWeakCount(fs, true)).toBe(0);
  });
  it("shows at most 10 findings", () => {
    const many = Array.from({ length: 14 }, (_, i) => finding(`f${i}`, i < 3 ? "weak" : i < 8 ? "moderate" : "strong"));
    const shown = visibleFindings(many, true);
    expect(shown.length).toBe(10);
    expect(shown.slice(0, 6).every((f) => f.strength === "strong")).toBe(true);
    expect(shown.some((f) => f.strength === "weak")).toBe(false); // weak ones fall off the end first
    expect(visibleFindings(many, false).length).toBe(10);
  });
  it("counts open findings without weak ones", () => {
    expect(openFindingCount(fs, {})).toBe(3);
    expect(openFindingCount(fs, { s1: { kind: "kept", reason: "", at: "" } })).toBe(2);
  });
});

describe("all teams resolved gate", () => {
  const p = (team: string, match: TeamProject["match"], jira_project: string | null): TeamProject =>
    ({ team, jira_project, match, evidence: "", candidates: [], search: true });
  const projects = [p("Ingestion team", "explicit", "INGEST"), p("Security", "unresolved", null), p("SRE", "linked", "SRE")];
  it("is closed while an unresolved team has no choice", () => {
    expect(allTeamsResolved(projects, {})).toBe(false);
  });
  it("opens when the person picks a project or says don't search", () => {
    expect(allTeamsResolved(projects, { Security: "SEC" })).toBe(true);
    expect(allTeamsResolved(projects, { Security: "skip" })).toBe(true);
    expect(allTeamsResolved(projects, { SRE: "skip" })).toBe(false);
  });
  it("applies choices the way Stage C expects them", () => {
    const out = applyChoices(projects, { Security: "SEC", SRE: "skip", "Ingestion team": "INGEST" });
    expect(out[1]).toMatchObject({ jira_project: "SEC", match: "name", evidence: "Chosen by you" });
    expect(out[2]).toMatchObject({ jira_project: "SRE", search: false });
    expect(out[0]).toMatchObject({ jira_project: "INGEST", match: "explicit" });
  });
});

describe("next actions (R16)", () => {
  it("lists every shown finding that is open or kept, with what / who / when / why, and drops dismissed ones", async () => {
    const { nextActions } = await import("./review");
    const withAction = (id: string): Finding => ({ ...finding(id, "strong"), ask: `Ask ${id}`, next_action: { action: `Ask ${id} now`, who: "SRE · Sam", by_when: "2026-11-13", why: `why ${id}` } });
    const shown = [withAction("f1"), finding("f2", "moderate"), withAction("f3")];
    const rows = nextActions(shown, { f1: { kind: "kept", reason: "", at: "" }, f3: { kind: "dismissed", reason: "n/a", at: "" } });
    expect(rows.map((r) => r.id)).toEqual(["f1", "f2"]);
    expect(rows[0]).toMatchObject({ text: "Ask f1 now", who: "SRE · Sam", when: "2026-11-13", why: "why f1", kept: true });
    // A finding without a next_action still yields one: its title, owner and a default deadline.
    expect(rows[1]).toMatchObject({ text: "f2", who: "T", when: "before go/no-go", kept: false });
  });
});
