import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Starter, Commitment, fromStarter, fromLaunch, linkFindings, decide, counts, firstSeenLabel, NOT_IN_PLAN, type Run } from "./index.js";

const ROOT = join(__dirname, "../../..");
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const starting = Starter.parse(json("fixtures/ingest-142/starter/starting.json"));
const building = Starter.parse(json("fixtures/ingest-142/starter/building.2026-11-13.json"));
const launch = json("runs/INGEST-142/2026-11-13.json") as Run;
const security = (l: Commitment[]) => l.find((c) => c.kind === "approval" && c.team === "Security")!;

describe("commitments carried across the ingestion sample's stages", () => {
  const s = fromStarter([], starting, {}, "2026-10-02T10:00:00Z");
  const b = fromStarter(s.list, building, {}, "2026-10-20T10:00:00Z");
  const l = fromLaunch(b.list, launch, "2026-11-13T10:00:00Z");

  it("starting proposes the PRD's teams and approvals, with their sources", () => {
    expect(s.added).toBe(starting.teams.length + starting.approvals.length);
    const c = security(s.list);
    expect(c.what).toBe("Security review");
    expect(c.state).toBe("open");
    expect(c.first_seen).toEqual({ stage: "starting", at: "2026-10-02", file: "ingestion-service-PRD.md", locator: "§2 Scope" });
    expect(c.sources[0].quote).toMatch(/new public API/);
    expect(new Set(s.list.map((x) => x.id)).size).toBe(s.list.length);
  });

  it("building adds nothing new and records Jira: SEC-881 tracks the Security review, missing teams are flagged", () => {
    expect(b.added).toBe(0);
    const c = security(b.list);
    expect(c.ticket).toEqual({ key: "SEC-881", how: "found by search" });
    expect(c.state).toBe("tracked");
    expect(b.list.find((x) => x.kind === "approval" && x.team === "QA")!.flags).toEqual(["no owner"]);
    expect(b.list.find((x) => x.kind === "team" && x.team === "UX")!.flags).toEqual(["not on the Jira work yet"]);
    expect(b.list.find((x) => x.kind === "team" && x.team === "Security")!.state).toBe("tracked");
  });

  it("launch matches the POR's 'Security review approved' to the PRD's item and links its finding", () => {
    const c = security(l.list);
    expect(l.list.filter((x) => x.kind === "approval" && x.team === "Security")).toHaveLength(1);
    expect(c.first_seen.stage).toBe("starting");
    expect(c.sources.map((x) => x.file)).toEqual(["ingestion-service-PRD.md", "Ingestion-service-POR-v3.md"]);
    expect(l.byFinding.f1).toBe(c.id);
    expect(c.flags[0]).toMatch(/^Approval still open: Security review approved/);
    expect(firstSeenLabel(c)).toBe("Starting · ingestion-service-PRD.md §2 Scope · 2026-10-02");
    expect(linkFindings(l.list, launch).f1.id).toBe(c.id);
    // The only team the POR adds that the PRD did not name.
    expect(l.list.filter((x) => x.first_seen.stage === "launching").map((x) => x.what)).toEqual(["Involve Ingestion team"]);
  });

  it("what an earlier stage named and the launch plan leaves out is flagged, not lost", () => {
    const flagged = l.list.filter((x) => x.flags[0] === NOT_IN_PLAN).map((x) => `${x.kind}:${x.team}`).sort();
    expect(flagged).toEqual(["approval:Legal", "approval:Privacy", "approval:QA", "approval:VDR", "team:Legal", "team:Privacy", "team:QA", "team:Support", "team:UX", "team:VDR"]);
    expect(l.list.find((x) => x.kind === "approval" && x.team === "QA")!.flags).toEqual([NOT_IN_PLAN, "no owner"]);
    expect(security(l.list).flags).not.toContain(NOT_IN_PLAN);
  });

  it("a refresh with nothing new changes nothing", () => {
    const again = fromLaunch(l.list, launch, "2026-11-14T10:00:00Z");
    expect(again.added).toBe(0);
    expect(again.changed).toBe(0);
    expect(again.list).toEqual(l.list);
    expect(fromStarter(b.list, building, {}, "2026-10-21T10:00:00Z").changed).toBe(0);
  });

  it("a drop holds across later reviews and is never proposed again; reopen restores it", () => {
    const legal = b.list.find((x) => x.kind === "approval" && x.team === "Legal")!;
    const dropped = decide(b.list, legal.id, "dropped", "No new contract terms", "building", "2026-10-21T10:00:00Z");
    const after = fromStarter(dropped, building, {}, "2026-10-22T10:00:00Z");
    const later = fromLaunch(after.list, launch, "2026-11-13T10:00:00Z").list;
    const c = later.find((x) => x.id === legal.id)!;
    expect(c.state).toBe("dropped");
    expect(c.decision).toMatchObject({ kind: "dropped", reason: "No new contract terms", stage: "building" });
    expect(later.filter((x) => x.kind === "approval" && x.team === "Legal")).toHaveLength(1);
    expect(decide(later, legal.id, "reopen", "", "launching", "2026-11-13T11:00:00Z").find((x) => x.id === legal.id)!.state).toBe("open");
  });

  it("signals the PM unticked propose nothing", () => {
    const off = Object.fromEntries(starting.signals.filter((g) => g.approvals.includes("Security review")).map((g) => [g.id, true]));
    expect(fromStarter([], starting, off).list.some((c) => c.what === "Security review")).toBe(false);
  });

  it("counts open, at risk, done and dropped", () => {
    const c = counts(l.list);
    expect(c.open + c.done + c.dropped).toBe(l.list.length);
    expect(c.atRisk).toBeGreaterThan(0);
  });

  it("every item is a valid Commitment", () => {
    for (const c of l.list) expect(() => Commitment.parse(c)).not.toThrow();
  });
});
