import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Run } from "@rrr/schemas";
import { startFakeJira, type FakeJira } from "../../skills/release-reader/tests/fake-jira.js";
import { runDoctor } from "../doctor.js";
import { renderReport } from "../lib/report.js";
import { runReview } from "../lib/pipeline.js";

const DOCS = "fixtures/ingest-142/docs";
const FILES = [`${DOCS}/Ingestion-service-POR-v3.md`, `${DOCS}/launch-checklist.csv`, `${DOCS}/team-list.yaml`];
const SNAP = "fixtures/ingest-142/jira/2026-11-13";

describe("npm run doctor", () => {
  let jira: FakeJira;
  beforeAll(async () => { jira = await startFakeJira(SNAP); });
  afterAll(async () => { await jira.close(); });
  const env = (token: string) => ({ ...process.env, JIRA_FIXTURE_DIR: undefined, JIRA_SITE: jira.url, JIRA_EMAIL: "me@example.com", JIRA_API_TOKEN: token });

  it("reports Jira access, the visible projects and the epic", async () => {
    const checks = await runDoctor({ env: env("secret"), epic: "INGEST-142" });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by.Node.level).toBe("ok");
    expect(by.Jira.level).toBe("ok");
    expect(by.Jira.detail).toMatch(/as Fixture User; 6 visible projects: INGEST, DATA, SEC, SRE/);
    expect(by.Epic).toMatchObject({ level: "ok" });
    expect(by.Epic.detail).toMatch(/INGEST-142 "Ingestion service launch" is an Epic, In Progress, fix version 1.0 \(2026-11-20\)/);
  });

  it("fails on bad credentials, a missing epic, and a non-epic", async () => {
    expect((await runDoctor({ env: env("wrong") })).find((c) => c.name === "Jira")).toMatchObject({ level: "fail" });
    expect((await runDoctor({ env: env("secret"), epic: "NOPE-1" })).find((c) => c.name === "Epic")).toMatchObject({ level: "fail" });
    const story = (await runDoctor({ env: env("secret"), epic: "INGEST-150" })).find((c) => c.name === "Epic")!;
    expect(story.level).toBe("fail");
    expect(story.detail).toMatch(/not an Epic/);
  });

  it("only warns when no credentials are set", async () => {
    const checks = await runDoctor({ env: { ...process.env, JIRA_SITE: undefined, JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined, JIRA_FIXTURE_DIR: undefined } });
    expect(checks.find((c) => c.name === "Jira")).toMatchObject({ level: "warn" });
    expect(checks.some((c) => c.level === "fail")).toBe(false);
  });
});

describe("npm run report", () => {
  const run = Run.parse(JSON.parse(readFileSync("runs/INGEST-142/2026-11-13.json", "utf8")));
  const html = renderReport(run, { goNoGo: "2026-11-13", comparedWith: "2026-11-10" });

  it("is one self-contained page with the findings, teams, plan and linkage gaps", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script|https?:\/\//);
    expect(html).not.toMatch(/undefined|\[object/);
    expect(html).toContain("Amber");
    expect(html).toContain("Launch Nov 20, 2026 · 7 days out · go/no-go Nov 13, 2026");
    expect(html).toContain("4 findings to act on, 1 weak hidden below, 1 other linkage gap");
    expect(html).toContain("Approval still open: Security review approved (SEC-881 is In Review)");
    expect(html).toContain("Ask Security to get SEC-881 approved");
    expect(html).toContain("SRE-412 due date moved Nov 13 → Nov 22");
    expect(html).toContain("Raise ingestion cluster quota");
    expect(html).toContain("Since 2026-11-10:");
    expect(html).toContain("Jira was only read; nothing was changed.");
    expect((html.match(/<article class="finding/g) ?? []).length).toBe(5);
    expect((html.match(/<section class="team"/g) ?? []).length).toBe(4);
  });

  it("escapes HTML and is repeatable", () => {
    const hacked = structuredClone(run);
    hacked.findings[0].title = "<img src=x onerror=alert(1)> & co";
    expect(renderReport(hacked)).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; co");
    expect(renderReport(run, { goNoGo: "2026-11-13", comparedWith: "2026-11-10" })).toBe(html);
  });
});

describe("review checkpoints (--stop-after / --resume)", () => {
  let tmp: string;
  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "rrr-ck-")); });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  it("stops after Stage A, takes the person's edit on resume, stops after Stage B, then finishes", async () => {
    const base = { files: FILES, epicKey: "INGEST-142", source: { kind: "fixture" as const, dir: SNAP }, label: "2026-11-13", runsRoot: tmp, readAt: "2026-11-13T09:00:00.000Z", analyzedAt: "2026-11-13T09:00:00.000Z" };
    const a = await runReview({ ...base, stopAfter: "plan" });
    expect(a.stopped).toBe("plan");
    const planFile = join(tmp, "INGEST-142/2026-11-13/plan-draft.json");
    expect(existsSync(planFile)).toBe(true);
    // The person corrects the inferred SRE date, as they would in the GUI.
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    const p4 = plan.items.find((i: any) => i.id === "p4");
    p4.due = "2026-11-12"; p4.due_is_inferred = false;
    writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const b = await runReview({ ...base, files: [], resume: true, stopAfter: "target" });
    expect(b.stopped).toBe("target");
    if (b.stopped !== "target") return;
    expect(b.plan.items.find((i) => i.id === "p4")!.due).toBe("2026-11-12");
    expect(existsSync(join(tmp, "INGEST-142/2026-11-13/release-target.json"))).toBe(true);

    const c = await runReview({ ...base, files: [], resume: true });
    expect(c.stopped).toBeNull();
    if (c.stopped !== null) return;
    expect(c.run.plan.items.find((i) => i.id === "p4")!.due).toBe("2026-11-12");
    expect(c.findings.findings.filter((f) => f.shown).length).toBe(4);
    expect(existsSync(join(tmp, "INGEST-142/2026-11-13.json"))).toBe(true);
  });
});
