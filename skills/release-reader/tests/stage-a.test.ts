import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadFile } from "../scripts/lib/files.js";
import { extractPlan, checkApplies, deriveLabel, containsQuote } from "../scripts/lib/plan-extract.js";
import { findDatePhrase, findLaunchDate, addDays } from "../scripts/lib/dates.js";
import { extractIssueKeys } from "../scripts/lib/keys.js";
import { PlanDraft } from "@rrr/schemas";

const DOCS = resolve(__dirname, "../../../fixtures/ingest-142/docs");
const POR = resolve(DOCS, "Ingestion-service-POR-v3.md");
const CHECKS = resolve(DOCS, "launch-checklist.csv");
const TEAMS = resolve(DOCS, "team-list.yaml");

async function run(paths: string[]) {
  const files = [];
  for (const p of paths) files.push(await loadFile(p));
  return extractPlan({ files });
}

describe("Stage A: extract-plan", () => {
  it("the POR alone gives the plan items, each with a source quote", async () => {
    const d = await run([POR]);
    expect(PlanDraft.safeParse(d).success).toBe(true);
    expect(d.launch_date).toBe("2026-11-20");
    expect(d.items.length).toBe(4);
    for (const it of d.items) {
      expect(it.source.quote.length).toBeGreaterThan(10);
      expect(it.source.file).toBe("Ingestion-service-POR-v3.md");
      expect(it.source.locator).toMatch(/^§\d$/);
      expect(it.owner_team).toBeTruthy();
    }
    expect(d.items.map((i) => i.kind)).toEqual(["deliverable", "dependency", "approval", "dependency"]);
    expect(d.items.map((i) => i.owner_team)).toEqual(["Ingestion team", "Data Platform", "Security", "SRE"]);
    // Teams discovered from prose, with roles, even without a team list
    expect(d.teams.map((t) => t.name)).toEqual(["Ingestion team", "Data Platform", "Security", "SRE"]);
    expect(d.teams.every((t) => t.jira_project_hint === null)).toBe(true);
    expect(d.teams[0].project_keys_mentioned).toEqual(["INGEST"]);
  });

  it("the SRE item has due_is_inferred: true, resolved to the week before launch", async () => {
    const d = await run([POR]);
    const sre = d.items.find((i) => i.owner_team === "SRE")!;
    expect(sre.due_is_inferred).toBe(true);
    expect(sre.due).toBe("2026-11-13");
    expect(sre.due_text).toBe("the week before launch");
    expect(sre.text).toBe("SRE capacity and on-call in place");
    const others = d.items.filter((i) => i.owner_team !== "SRE");
    expect(others.every((i) => i.due_is_inferred === false)).toBe(true);
  });

  it("the POR plus the checklist adds exactly 3 checklist items", async () => {
    const d = await run([POR, CHECKS]);
    const checks = d.items.filter((i) => i.kind === "checklist");
    expect(checks.length).toBe(3);
    expect(checks.map((c) => c.source.locator).sort()).toEqual(["#4", "#6", "#9"]);
    expect(checks.map((c) => c.text)).toEqual(["Load test passed at 2× peak", "Production DB permissions reviewed", "Rollback plan documented"]);
    // "Service team" maps to the deliverable owner; relative due dates are inferred
    expect(checks.find((c) => c.source.locator === "#9")!.owner_team).toBe("Ingestion team");
    expect(checks.find((c) => c.source.locator === "#6")!.owner_team).toBe("Data Platform");
    expect(checks.every((c) => c.due_is_inferred)).toBe(true);
    expect(checks.map((c) => c.due)).toEqual(["2026-11-15", "2026-11-13", "2026-11-16"]);
    expect(d.items.length).toBe(7);
    expect(d.files.find((f) => f.name === "launch-checklist.csv")!.notes).toBe("9 checks · 3 apply to this release");
  });

  it("epic_keys_mentioned includes INGEST-142", async () => {
    const d = await run([POR]);
    expect(d.epic_keys_mentioned).toContain("INGEST-142");
  });

  it("the team list fills jira_project_hint, owners and components", async () => {
    const d = await run([POR, CHECKS, TEAMS]);
    expect(d.teams.map((t) => t.jira_project_hint)).toEqual(["INGEST", "DATA", "SEC", "SRE"]);
    expect(d.teams.reduce((n, t) => n + t.owners.length, 0)).toBe(11);
    expect(d.files.map((f) => f.read_as)).toEqual([["plan_items"], ["launch_checks"], ["teams_and_owners"]]);
    expect(d.warnings).toEqual([]);
  });

  it("agent items without a quote found in the files are dropped with a warning", async () => {
    const files = [await loadFile(POR)];
    const d = extractPlan({
      files,
      agentItems: [
        { text: "Made up", kind: "deliverable", owner_team: "SRE", source: { file: "Ingestion-service-POR-v3.md", locator: "§9", quote: "this sentence is not in the file" } },
        { text: "Peak load assumption", kind: "dependency", owner_team: "Ingestion team", due_text: "at launch", source: { file: "Ingestion-service-POR-v3.md", locator: "§5", quote: "Peak load at launch is 2× the batch importer's peak." } },
      ],
    });
    expect(d.items.some((i) => i.text === "Made up")).toBe(false);
    expect(d.warnings.some((w) => w.includes("Made up"))).toBe(true);
    const kept = d.items.find((i) => i.text === "Peak load assumption")!;
    expect(kept.due).toBe("2026-11-20");
    expect(kept.due_is_inferred).toBe(true);
  });

  it("is repeatable", async () => {
    const a = JSON.stringify(await run([POR, CHECKS, TEAMS]));
    const b = JSON.stringify(await run([POR, CHECKS, TEAMS]));
    expect(a).toBe(b);
  });
});

describe("helpers", () => {
  it("parses absolute and relative dates", () => {
    const L = "2026-11-20";
    expect(findDatePhrase("done by Nov 18.", L)?.due).toBe("2026-11-18");
    expect(findDatePhrase("done by November 18, 2027.", L)?.due).toBe("2027-11-18");
    expect(findDatePhrase("done 18 Nov.", L)?.due).toBe("2026-11-18");
    expect(findDatePhrase("done 2026-11-01", L)?.due).toBe("2026-11-01");
    expect(findDatePhrase("in place the week before launch", L)).toMatchObject({ due: "2026-11-13", inferred: true });
    expect(findDatePhrase("two days after launch", L)).toMatchObject({ due: "2026-11-22", inferred: true });
    expect(findDatePhrase("5 days before launch", L)).toMatchObject({ due: "2026-11-15", inferred: true });
    expect(findDatePhrase("the day before launch", L)).toMatchObject({ due: "2026-11-19", inferred: true });
    expect(findDatePhrase("ready at launch", L)).toMatchObject({ due: "2026-11-20", inferred: true });
    expect(findDatePhrase("the week before launch", null)).toMatchObject({ due: null, inferred: true });
    expect(findDatePhrase("no date here", L)).toBeNull();
    expect(addDays("2026-11-01", -2)).toBe("2026-10-30");
    expect(findLaunchDate("Epic: X-1 · Launch date: 2026-11-20 · v1")).toBe("2026-11-20");
    expect(findLaunchDate("We launch on Nov 20, 2026 for real.")).toBe("2026-11-20");
  });
  it("extracts issue keys", () => {
    expect(extractIssueKeys("see INGEST-142 and data-1 and SEC-881, SEC-881")).toEqual(["INGEST-142", "SEC-881"]);
  });
  it("decides which checklist rows apply", () => {
    const profile = "This is a new service with production database access, backend only.";
    expect(checkApplies("All launches", profile)).toBe(true);
    expect(checkApplies("New services", profile)).toBe(true);
    expect(checkApplies("Production database access", profile)).toBe(true);
    expect(checkApplies("Customer-facing UI", profile)).toBe(false);
    expect(checkApplies("Mobile apps", profile)).toBe(false);
  });
  it("derives labels and matches quotes loosely", () => {
    expect(deriveLabel("Security will have the security review approved", "Security", null)).toBe("Security review approved");
    expect(containsQuote("Hello   “world”.", "hello world")).toBe(true);
  });
});
