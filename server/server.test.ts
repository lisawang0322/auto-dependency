import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeJira, type FakeJira } from "../skills/release-reader/tests/fake-jira.js";
import { startServer } from "./index.js";

const DOCS = "fixtures/ingest-142/docs";

describe("local API server", () => {
  let jira: FakeJira, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-server-"));
    jira = await startFakeJira("fixtures/ingest-142/jira/2026-11-13");
    srv = await startServer({ port: 0, quiet: true, creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache") });
  });
  afterAll(async () => { await srv.close(); await jira.close(); rmSync(tmp, { recursive: true, force: true }); });

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(srv.url + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };

  it("starts disconnected and connects with checked credentials", async () => {
    expect((await api("GET", "/api/health")).data.jira.connected).toBe(false);
    const bad = await api("POST", "/api/jira/connect", { site: jira.url, email: "me@example.com", token: "wrong" });
    expect(bad.status).toBe(401);
    expect((await api("POST", "/api/jira/connect", { site: "ftp://nope", email: "a", token: "b" })).status).toBe(400);
    const ok = await api("POST", "/api/jira/connect", { site: jira.url, email: "me@example.com", token: "secret" });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ connected: true, user: "Fixture User" });
  });

  let plan: any, target: any;
  it("extracts the plan from uploaded and sample files", async () => {
    const pptx = readFileSync(join(DOCS, "Ingestion-service-POR-v3.pptx")).toString("base64");
    const r = await api("POST", "/api/plan", { files: [
      { name: "Ingestion-service-POR-v3.pptx", kind: "plan", content_base64: pptx },
      { name: "launch-checklist.csv", kind: "checks", sample: true },
      { name: "team-list.yaml", kind: "teams", sample: true },
      { name: "notes.txt", kind: "other", content_base64: Buffer.from("ignored").toString("base64") },
    ] });
    expect(r.status).toBe(200);
    plan = r.data.plan;
    expect(plan.items.map((i: any) => i.id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
    expect(plan.epic_keys_mentioned).toEqual(["INGEST-142"]);
    expect(plan.files.map((f: any) => f.name)).toEqual(["Ingestion-service-POR-v3.pptx", "launch-checklist.csv", "team-list.yaml"]);
  });

  it("resolves the epic over REST and rejects an unknown one", async () => {
    const r = await api("POST", "/api/target", { plan, epic: "INGEST-142", label: "2026-11-13" });
    expect(r.status).toBe(200);
    target = r.data.target;
    expect(target.projects.map((p: any) => [p.team, p.jira_project])).toEqual([["Ingestion team", "INGEST"], ["Data Platform", "DATA"], ["Security", "SEC"], ["SRE", "SRE"]]);
    const bad = await api("POST", "/api/target", { plan, epic: "NOPE-1", label: "2026-11-13" });
    expect(bad.status).toBe(404);
    expect(bad.data.error).toMatch(/NOPE-1/);
  });

  it("runs the review as a job and saves the run", async () => {
    const r = await api("POST", "/api/run", { plan, target, label: "2026-11-13" });
    expect(r.status).toBe(202);
    let job: any;
    for (let i = 0; i < 100 && !job?.done; i++) { await new Promise((r) => setTimeout(r, 50)); job = (await api("GET", `/api/jobs/${r.data.job}`)).data; }
    expect(job.error).toBeUndefined();
    expect(job).toMatchObject({ done: true, stage: 3, run_id: "2026-11-13" });
    expect((await api("GET", "/api/runs/INGEST-142")).data).toEqual([{ id: "2026-11-13", label: "2026-11-13" }]);
    const run = (await api("GET", "/api/runs/INGEST-142/2026-11-13")).data;
    expect(run.findings.map((f: any) => [f.plan_item_id, f.gap_type, f.strength])).toEqual([["p3", "process", "strong"], ["p4", "cross_team_date", "moderate"], ["p6", "commitment", "moderate"], ["p7", "process", "moderate"], ["p5", "commitment", "weak"]]);
    expect(run.teams.map((t: any) => [t.team, t.status])).toEqual([["Ingestion team", "at_risk"], ["Data Platform", "at_risk"], ["Security", "at_risk"], ["SRE", "late"]]);
    expect(existsSync(join(tmp, "runs/INGEST-142/2026-11-13/status.json"))).toBe(true);
    expect((await api("GET", "/api/runs/INGEST-142/2026-11-12")).status).toBe(404);
  });

  it("disconnects and then refuses to resolve", async () => {
    await api("POST", "/api/jira/disconnect");
    expect((await api("POST", "/api/target", { plan, epic: "INGEST-142" })).status).toBe(400);
  });
});

describe("local API server: the early stages", () => {
  let jira: FakeJira, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-server-starter-"));
    jira = await startFakeJira("fixtures/ingest-142/jira/2026-11-13");
    srv = await startServer({ port: 0, quiet: true, creds: { site: jira.url, email: "me@example.com", token: "secret" }, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache") });
  });
  afterAll(async () => { await srv.close(); await jira.close(); rmSync(tmp, { recursive: true, force: true }); });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(srv.url + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const files = [{ name: "ingestion-service-PRD.docx", kind: "prd", content_base64: readFileSync(join(DOCS, "ingestion-service-PRD.docx")).toString("base64") }, { name: "directory.yaml", kind: "teams", sample: true }];

  it("returns the PRD's signals and the needed teams with stage=building", async () => {
    const r = await api("POST", "/api/plan", { files, stage: "building" });
    expect(r.status).toBe(200);
    expect(r.data.project).toBe("Ingestion service");
    expect(r.data.signals.map((g: any) => g.locator)).toEqual(["§1 Goals", "§1 Goals", "§2 Scope", "§3 Data", "§4 Users", "§5 Requirements"]);
    expect(r.data.plan.teams.filter((t: any) => t.mentioned_in.includes("signals")).map((t: any) => t.name)).toContain("Privacy");
    expect(r.data.plan.files.map((f: any) => f.notes)).toEqual(["6 signals about teams and approvals", "10 teams · 21 people"]);
  });

  it("runs the building stage as a job over the fake Jira and saves it", async () => {
    const start = await api("POST", "/api/starter", { files, stage: "building", epic: "INGEST-142", exclude_signals: ["g4"], label: "2026-11-13" });
    expect(start.status).toBe(202);
    let job: any;
    for (let i = 0; i < 100; i++) { job = (await api("GET", `/api/jobs/${start.data.job}`)).data; if (job.done) break; await new Promise((r) => setTimeout(r, 100)); }
    expect(job.error).toBeUndefined();
    const st = job.result;
    expect(st.stage).toBe("building");
    expect(st.excluded_signals).toEqual(["g4"]);
    expect(st.coverage.map((c: any) => c.team)).not.toContain("Privacy"); // unticked with g4
    expect(st.coverage.find((c: any) => c.team === "Security")).toMatchObject({ state: "covered" });
    expect(st.approval_status.find((a: any) => a.name === "QA sign-off")).toMatchObject({ state: "no_owner", ticket: "INGEST-170" });
    expect(existsSync(join(tmp, "runs/INGEST-142/2026-11-13.building.json"))).toBe(true);
    const bad = await api("POST", "/api/starter", { files, stage: "building" });
    expect(bad.status).toBe(400);
  });
});
