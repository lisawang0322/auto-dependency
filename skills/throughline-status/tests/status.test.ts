import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PlanDraft, ReleaseTarget, Release, Findings, Status } from "@throughline/schemas";
import { computeStatus } from "../scripts/lib/status.js";

const FX = "fixtures/ingest-142";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const plan = PlanDraft.parse(read(`${FX}/plan-draft.json`));
const target = ReleaseTarget.parse(read(`${FX}/release-target.json`));
const load = (snap: string) => ({ release: Release.parse(read(`${FX}/release.${snap}.json`)), findings: Findings.parse(read(`${FX}/findings.${snap}.json`)) });

const nov10 = computeStatus({ plan, target, ...load("2026-11-10") });
const nov13 = computeStatus({ plan, target, ...load("2026-11-13"), previous: { release: load("2026-11-10").release, teams: nov10.teams, snapshot_label: "2026-11-10" } });

const row = (s: Status, team: string) => s.teams.find((t) => t.team === team)!;
const item = (s: Status, team: string, id: string) => row(s, team).items.find((i) => i.plan_item_id === id)!;

describe("throughline-status", () => {
  it("validates and lists one row per resolved team, in target order", () => {
    Status.parse(nov13);
    expect(nov13.teams.map((t) => [t.team, t.project_key, t.role])).toEqual([
      ["Ingestion team", "INGEST", "Service team"], ["Data Platform", "DATA", "Shared platform"], ["Security", "SEC", "Approver"], ["SRE", "SRE", "Capacity and on-call"],
    ]);
    expect(nov13.compared_with).toBe("2026-11-10");
    expect(nov10.compared_with).toBeNull();
  });

  it("Nov 13: statuses follow the findings", () => {
    expect(nov13.teams.map((t) => [t.team, t.status])).toEqual([["Ingestion team", "at_risk"], ["Data Platform", "at_risk"], ["Security", "at_risk"], ["SRE", "late"]]);
    expect(row(nov13, "Ingestion team").items.map((i) => [i.plan_item_id, i.result, i.ticket, i.finding_id])).toEqual([["p1", "ok", "INGEST-142", null], ["p5", "weak", "INGEST-163", "f5"], ["p7", "gap", null, "f4"]]);
    expect(item(nov13, "Ingestion team", "p1").ticket_status).toBe("In Progress · 21 of 25 stories done");
    expect(item(nov13, "Ingestion team", "p7").ticket_status).toBe("No ticket found");
    expect(item(nov13, "Ingestion team", "p7").note).toBe("No ticket");
    expect(item(nov13, "Ingestion team", "p5").ticket_status).toBe("In Progress · comment only");
    expect(item(nov13, "Security", "p3")).toMatchObject({ result: "gap", ticket: "SEC-881", ticket_status: "In Review · linked", note: "Approval still open", finding_id: "f1", plan_due: "2026-11-14", jira_due: "2026-11-14" });
    expect(item(nov13, "SRE", "p4")).toMatchObject({ result: "late", ticket: "SRE-412", ticket_status: "To Do · not linked to epic", note: "Due 2 days after launch", jira_due: "2026-11-22" });
    expect(item(nov13, "Data Platform", "p2")).toMatchObject({ result: "ok", ticket: "DATA-233", ticket_status: "Done · not linked to epic", note: "Done · linkage gap" });
    expect(item(nov13, "Data Platform", "p6")).toMatchObject({ result: "gap", ticket: null, ticket_status: "Promised in a comment on INGEST-157", note: "No ticket", finding_id: "f3" });
  });

  it("Nov 10: SRE and Data Platform are on track; no change notes on a first run", () => {
    expect(nov10.teams.map((t) => [t.team, t.status])).toEqual([["Ingestion team", "at_risk"], ["Data Platform", "on_track"], ["Security", "at_risk"], ["SRE", "on_track"]]);
    expect(nov10.teams.every((t) => t.change_note === "")).toBe(true);
    expect(item(nov10, "Data Platform", "p6")).toMatchObject({ result: "ok", ticket: "DATA-240", note: "On track" });
  });

  it("change notes name what moved since the previous run", () => {
    expect(row(nov13, "Security").change_note).toBe("SEC-881 moved to In Review");
    expect(row(nov13, "SRE").change_note).toBe("SRE-412 due date moved Nov 13 → Nov 22");
    expect(row(nov13, "Data Platform").change_note).toBe('DATA-233 moved to Done; DATA-240 moved to Closed (Duplicate); DATA-240 no longer counts for "Production DB permissions reviewed"; promised in a comment on INGEST-157');
    expect(row(nov13, "Ingestion team").change_note).toBe("");
  });

  it("is repeatable", () => {
    expect(computeStatus({ plan, target, ...load("2026-11-13"), previous: { release: load("2026-11-10").release, teams: nov10.teams, snapshot_label: "2026-11-10" } })).toEqual(nov13);
  });
});
