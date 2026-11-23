import { describe, it, expect } from "vitest";
import { Starter, fromStarter, decide } from "@throughline/schemas";
import buildingJson from "../../../fixtures/ingest-142/starter/building.2026-11-13.json";
import { teamReadiness, overall } from "./readiness";

const B = Starter.parse(buildingJson);
const byTeam = (list: ReturnType<typeof teamReadiness>) => Object.fromEntries(list.map((t) => [t.team, t]));

describe("launch readiness from the commitments and Jira", () => {
  it("reads each team from its coverage and the sign-offs it owes", () => {
    const r = byTeam(teamReadiness(B, {}));
    expect(r["Data Platform"]).toEqual({ team: "Data Platform", state: "ready", reasons: ["On the work"] });
    expect(r.SRE.state).toBe("ready");
    expect(r.Security).toEqual({ team: "Security", state: "at_risk", reasons: ["Security review in progress (SEC-881)"] });
    expect(r.QA).toEqual({ team: "QA", state: "blocking", reasons: ["Nobody on the work", "QA sign-off has no owner (INGEST-170)"] });
    expect(r.Privacy.reasons).toEqual(["Nobody on the work", "Privacy review not started"]);
    expect(overall(Object.values(r))).toEqual({ state: "blocking", counts: { blocking: 6, at_risk: 1, unknown: 0, ready: 2 } });
  });

  it("leaves out what the PM dropped, and what an unticked signal implied", () => {
    const list = fromStarter([], B, {}).list;
    const legal = list.find((c) => c.kind === "team" && c.team === "Legal")!;
    const qaSignoff = list.find((c) => c.kind === "approval" && c.team === "QA")!;
    const after = decide(decide(list, legal.id, "dropped", "No new contract terms", "building", "2026-11-13"), qaSignoff.id, "dropped", "Covered by SRE", "building", "2026-11-13");
    const r = byTeam(teamReadiness(B, {}, after));
    expect(r.Legal).toBeUndefined();
    expect(r.QA.reasons).toEqual(["Nobody on the work"]);
    const sec = B.coverage.find((c) => c.team === "Security")!.signal_ids;
    const off = Object.fromEntries([...sec, ...B.approval_status.find((a) => a.team === "Security")!.signal_ids].map((id) => [id, true]));
    expect(byTeam(teamReadiness(B, off)).Security).toBeUndefined();
  });

  it("is ready only when every team is", () => {
    const st: Starter = { ...B, coverage: B.coverage.filter((c) => c.state === "covered"), approval_status: B.approval_status.map((a) => ({ ...a, state: "done" as const })).filter((a) => a.team === "Security") };
    expect(overall(teamReadiness(st, {}))).toEqual({ state: "ready", counts: { blocking: 0, at_risk: 0, unknown: 0, ready: 3 } });
    expect(byTeam(teamReadiness(st, {})).Security.reasons).toEqual(["On the work", "Security review done"]);
  });
});
