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

describe("agent-written plan items (--agent-items)", () => {
  it("adds items that quote the file, drops the rest with a warning, and keeps the rules' items", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "rrr-agent-"));
    try {
      const base = { files: FILES, epicKey: "INGEST-142", source: { kind: "fixture" as const, dir: SNAP }, label: "2026-11-13", runsRoot, stopAfter: "plan" as const };
      const rules = await runReview(base);
      if (rules.stopped !== "plan") throw new Error("expected to stop after plan");
      const out = await runReview({ ...base, agentItems: [
        { text: "Load test at 2× the batch importer's peak", kind: "dependency", owner_team: "SRE", due_text: "the week before launch",
          source: { file: "Ingestion-service-POR-v3.md", locator: "§5", quote: "Peak load at launch is 2× the batch importer's peak." } },
        { text: "Legal sign-off", kind: "approval", owner_team: "Legal", source: { file: "Ingestion-service-POR-v3.md", locator: "§4", quote: "Legal will sign off by Nov 1." } },
        { text: "Security review (again)", kind: "approval", owner_team: "Security", source: { file: "Ingestion-service-POR-v3.md", locator: "§4", quote: "Security will have the security review approved by Nov 14." } },
      ] });
      if (out.stopped !== "plan") throw new Error("expected to stop after plan");
      expect(out.plan.items).toHaveLength(rules.plan.items.length + 1);
      const added = out.plan.items.find((i) => i.text === "Load test at 2× the batch importer's peak")!;
      expect(added).toMatchObject({ kind: "dependency", owner_team: "SRE", due_text: "the week before launch", due_is_inferred: true, source: { file: "Ingestion-service-POR-v3.md", locator: "§5" } });
      expect(added.due).toBeTruthy();
      expect(out.plan.warnings.filter((w) => w.startsWith("Dropped agent item"))).toEqual([
        'Dropped agent item "Legal sign-off": its quote was not found in Ingestion-service-POR-v3.md.',
      ]);
      expect(JSON.parse(readFileSync(out.file, "utf8")).items).toHaveLength(out.plan.items.length);
    } finally { rmSync(runsRoot, { recursive: true, force: true }); }
  });

  it("keeps items from a file the command cannot read, marked quote_verified: false, with a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rrr-agent-fmt-"));
    try {
      const deck = join(dir, "Launch-plan.key");
      writeFileSync(deck, "\u0000binary keynote bundle, not readable by the command\u0000");
      const out = await runReview({ files: [deck, `${DOCS}/launch-checklist.csv`, `${DOCS}/team-list.yaml`], epicKey: "INGEST-142", source: { kind: "fixture", dir: SNAP }, label: "2026-11-13", runsRoot: dir, stopAfter: "plan", launchDate: "2026-11-20", agentItems: [
        { text: "Ingestion service live in production", kind: "deliverable", owner_team: "Ingestion team", due_text: "by Nov 18", source: { file: "Launch-plan.key", locator: "slide 4", quote: "Ingestion live in prod by Nov 18 (Ingestion team)." } },
        { text: "No quote", kind: "approval", owner_team: "Security", source: { file: "Launch-plan.key", locator: "slide 5", quote: "" } },
      ] });
      if (out.stopped !== "plan") throw new Error("expected to stop after plan");
      const mine = out.plan.items.find((i) => i.source.file === "Launch-plan.key")!;
      expect(mine).toMatchObject({ kind: "deliverable", owner_team: "Ingestion team", due: "2026-11-18", source: { locator: "slide 4", quote_verified: false } });
      expect(out.plan.items.filter((i) => i.source.file === "Launch-plan.key")).toHaveLength(1);
      expect(out.plan.items.find((i) => i.source.file === "launch-checklist.csv")!.source.quote_verified).toBeUndefined();
      expect(out.plan.files.find((f) => f.name === "Launch-plan.key")).toMatchObject({ read_as: ["plan_items"], notes: "1 item read by the agent (quotes not checked: the command could not read the file)" });
      expect(out.plan.warnings).toContain('Launch-plan.key: the command could not read it, so the quote for "Ingestion service live in production" was not checked; confirm it against the file.');
      expect(out.plan.warnings).toContain('Dropped agent item "No quote": it has no quote.');
      expect(out.plan.warnings.some((w) => /A POR is required|not used/.test(w))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
