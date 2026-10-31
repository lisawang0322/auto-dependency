import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeJira, type FakeJira } from "../skills/release-reader/tests/fake-jira.js";
import { startServer } from "./index.js";
import { startFakeDevin, naiveReader, type FakeDevin } from "./tests/fake-devin.js";
import { readingPrompt, parseReading, itemRules } from "./devin.js";

const DOCS = "fixtures/ingest-142/docs";

describe("local API server", () => {
  let jira: FakeJira, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-server-"));
    jira = await startFakeJira("fixtures/ingest-142/jira/2026-11-13");
    srv = await startServer({ port: 0, quiet: true, storePath: ":memory:", creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache") });
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
    srv = await startServer({ port: 0, quiet: true, storePath: ":memory:", creds: { site: jira.url, email: "me@example.com", token: "secret" }, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache") });
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

describe("Devin reads the uploads (agent: \"devin\")", () => {
  let jira: FakeJira, devin: FakeDevin, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-server-devin-"));
    jira = await startFakeJira("fixtures/ingest-142/jira/2026-11-13");
    devin = await startFakeDevin({ answer: (s) => {
      const out = naiveReader(s) as any;
      // Devin also finds the assumption the rules skip, and one item with a quote that is not in the file.
      out.items.push({ text: "Load test at 2× the batch importer's peak", kind: "dependency", owner_team: "SRE", due_text: null, source: { file: "Ingestion-service-POR-v3.md", locator: "§5", quote: "Peak load at launch is 2× the batch importer's peak." } });
      out.items.push({ text: "Made up", kind: "approval", owner_team: "Legal", due_text: null, source: { file: "Ingestion-service-POR-v3.md", locator: "§4", quote: "Legal signs off by Nov 1." } });
      out.items.push({ text: "bad kind", kind: "wish", source: { file: "Ingestion-service-POR-v3.md", locator: "§1", quote: "x" } });
      return out;
    } });
    srv = await startServer({ port: 0, quiet: true, storePath: ":memory:", creds: { site: jira.url, email: "me@example.com", token: "secret" }, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), agentCacheRoot: join(tmp, "agent"),
      devin: { apiKey: "cog_test", baseUrl: devin.url, pollMs: 10, timeoutMs: 5_000, maxAcu: 1, defaultMode: "normal", modes: ["lite", "normal", "ultra"] } });
  });
  afterAll(async () => { await srv.close(); await jira.close(); await devin.close(); rmSync(tmp, { recursive: true, force: true }); });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(srv.url + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const poll = async (job: string) => { let j: any; for (let i = 0; i < 200; i++) { j = (await api("GET", `/api/jobs/${job}`)).data; if (j.done) return j; await new Promise((r) => setTimeout(r, 20)); } return j; };
  const por = readFileSync(join(DOCS, "Ingestion-service-POR-v3.md")).toString("base64");
  const files = [
    { name: "Ingestion-service-POR-v3.md", kind: "plan", content_base64: por },
    { name: "launch-checklist.csv", kind: "checks", sample: true },
    { name: "team-list.yaml", kind: "teams", sample: true },
  ];

  it("advertises the agent and runs the reading as a job: Devin's items pass the quote check, bad ones are dropped", async () => {
    expect((await api("GET", "/api/health")).data.agent).toMatchObject({ available: true, name: "Devin", max_acu: 1, api: "v3", modes: ["lite", "normal", "ultra"], default_mode: "normal" });
    expect((await api("GET", "/api/health")).data.settings).toEqual({ agent_consent: "unknown", agent_mode: "normal" });
    const r = await api("POST", "/api/plan", { files, agent: "devin" });
    expect(r.status).toBe(202);
    const job = await poll(r.data.job);
    expect(job.error).toBeUndefined();
    expect(job.stage).toBe(3);
    const { plan, agent } = job.result;
    expect(agent).toMatchObject({ name: "Devin", status: "done", cached: false, items_read: 5, signals_read: 0, session_url: "https://app.devin.ai/sessions/devin-1", error: null, mode: "normal" });
    expect(devin.sessions[0].devin_mode).toBe("normal");
    expect(agent.files_read).toEqual([{ name: "Ingestion-service-POR-v3.md", how: "text" }]);
    expect(agent.warnings).toEqual(["Devin item 6 was dropped: Invalid enum value. Expected 'deliverable' | 'dependency' | 'approval' | 'checklist', received 'wish'."]);
    // The rules' 7 items plus the one Devin added; Devin's duplicates of the rules' items are kept once.
    expect(plan.items).toHaveLength(8);
    expect(plan.items.find((i: any) => i.text.startsWith("Load test at 2×"))).toMatchObject({ kind: "dependency", owner_team: "SRE", source: { locator: "§5" } });
    expect(plan.items.every((i: any) => i.source.quote_verified === undefined)).toBe(true);
    expect(plan.warnings).toContain('Dropped agent item "Made up": its quote was not found in Ingestion-service-POR-v3.md.');
    expect(plan.files[0].notes).toMatch(/ · 1 item read by the agent$/);
    // Only the document went to Devin; the csv and yaml stayed with the parsers. One session, capped.
    expect(devin.uploads.map((u) => u.name)).toEqual(["Ingestion-service-POR-v3.md"]);
    expect(devin.sessions).toHaveLength(1);
    expect(devin.sessions[0].max_acu_limit).toBe(1);
    // A cog_ key means the v3 API: attachments and the output schema travel as fields, not inside the prompt.
    expect(devin.sessions[0].api).toBe("v3");
    expect(devin.sessions[0].prompt).not.toContain('ATTACHMENT:"');
    expect(devin.sessions[0].prompt).toContain("- Ingestion-service-POR-v3.md (attached)");
    expect(devin.sessions[0].prompt).toContain("A plan item is");
    expect(devin.sessions[0].attachments.map((a) => a.name)).toEqual(["Ingestion-service-POR-v3.md"]);
    expect((devin.sessions[0].output_schema as any)?.required).toEqual(["done", "items", "files_read"]);
    expect(devin.sessions[0].title).toBe("Readiness Review: read Ingestion-service-POR-v3.md");
    expect((await api("GET", "/api/health")).data.agent.api).toBe("v3");
  });

  it("reuses the cached reading when the same document comes back, even read as something else", async () => {
    const r = await api("POST", "/api/plan", { files: [{ ...files[0], kind: "prd" }, files[1]], agent: "devin" });
    const job = await poll(r.data.job);
    expect(job.error).toBeUndefined();
    expect(job.result.agent).toMatchObject({ status: "done", cached: true, items_read: 5 });
    expect(devin.sessions).toHaveLength(1);
    expect(job.result.plan.items.some((i: any) => i.text.startsWith("Load test at 2×"))).toBe(true);
  });

  it("a chosen reading mode is saved per person, sent on the session, and read again on a change of tier", async () => {
    expect((await api("PUT", "/api/settings", { agent_mode: "sideways" })).status).toBe(400);
    expect((await api("PUT", "/api/settings", { agent_mode: "lite" })).data).toEqual({ agent_consent: "unknown", agent_mode: "lite" });
    const before = devin.sessions.length;
    const r = await api("POST", "/api/plan", { files, agent: "devin" });
    const job = await poll(r.data.job);
    expect(job.result.agent).toMatchObject({ status: "done", cached: false, mode: "lite" });
    expect(devin.sessions).toHaveLength(before + 1);
    expect(devin.sessions[before].devin_mode).toBe("lite");
    // Back to the default: that reading is cached from the first test, so no new session.
    expect((await api("PUT", "/api/settings", { agent_mode: null })).data.agent_mode).toBe("normal");
    const again = await poll((await api("POST", "/api/plan", { files, agent: "devin" })).data.job);
    expect(again.result.agent).toMatchObject({ status: "done", cached: true, mode: "normal" });
    expect(devin.sessions).toHaveLength(before + 1);
  });

  it("without agent: \"devin\" the route is synchronous and rules-only", async () => {
    const r = await api("POST", "/api/plan", { files });
    expect(r.status).toBe(200);
    expect(r.data.agent).toBeUndefined();
    expect(r.data.plan.items).toHaveLength(7);
  });

  it("keeps items from a format the server cannot read, marked unchecked", async () => {
    const r = await api("POST", "/api/plan", { files: [{ name: "Launch-plan.key", kind: "plan", content_base64: Buffer.from("\u0000keynote bundle\u0000\n- Ingestion team will have the service live by Nov 18.\n").toString("base64") }, files[1], files[2]], launch_date: "2026-11-20", agent: "devin" });
    const job = await poll(r.data.job);
    expect(job.error).toBeUndefined();
    expect(job.result.agent).toMatchObject({ status: "done", cached: false, items_read: 1 });
    const mine = job.result.plan.items.find((i: any) => i.source.file === "Launch-plan.key");
    expect(mine).toMatchObject({ kind: "deliverable", owner_team: "Ingestion team", due: "2026-11-18", source: { quote_verified: false } });
    expect(job.result.plan.warnings.some((w: string) => /could not read it, so the quote/.test(w))).toBe(true);
  });
});

describe("Devin with a legacy key (v1 API)", () => {
  it("references attachments inside the prompt and reads status_enum", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "rrr-server-devin-v1-"));
    const devin = await startFakeDevin({ apiKey: "apk_user_test", answer: naiveReader });
    const srv = await startServer({ port: 0, quiet: true, storePath: ":memory:", creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), agentCacheRoot: join(tmp, "agent"), devin: { apiKey: "apk_user_test", baseUrl: devin.url, pollMs: 10, timeoutMs: 5_000 } });
    try {
      expect((await (await fetch(srv.url + "/api/health")).json()).agent.api).toBe("v1");
      const res = await fetch(srv.url + "/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }], agent: "devin" }) });
      const { job } = await res.json();
      let j: any;
      for (let i = 0; i < 200; i++) { j = await (await fetch(srv.url + `/api/jobs/${job}`)).json(); if (j.done) break; await new Promise((r) => setTimeout(r, 20)); }
      expect(j.result.agent).toMatchObject({ status: "done", items_read: 3 });
      expect(devin.sessions[0].api).toBe("v1");
      expect(devin.sessions[0].prompt).toContain('ATTACHMENT:"');
      expect(devin.calls).toContain("POST /v1/attachments");
    } finally { await srv.close(); await devin.close(); rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("Devin fails or is absent", () => {
  it("falls back to the rules with the error in the result when the session ends without output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "rrr-server-devin-fail-"));
    const devin = await startFakeDevin({ endWith: "expired" });
    const srv = await startServer({ port: 0, quiet: true, storePath: ":memory:", creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), agentCacheRoot: join(tmp, "agent"), devin: { apiKey: "cog_test", baseUrl: devin.url, pollMs: 10, timeoutMs: 5_000 } });
    try {
      const res = await fetch(srv.url + "/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }, { name: "launch-checklist.csv", kind: "checks", sample: true }], agent: "devin" }) });
      expect(res.status).toBe(202);
      const { job } = await res.json();
      let j: any;
      for (let i = 0; i < 200; i++) { j = await (await fetch(srv.url + `/api/jobs/${job}`)).json(); if (j.done) break; await new Promise((r) => setTimeout(r, 20)); }
      expect(j.error).toBeUndefined();
      expect(j.result.agent).toMatchObject({ status: "failed", cached: false, items_read: 0, error: "Devin session ended (error) without a result." });
      expect(j.result.plan.items).toHaveLength(7);
      // A failed reading is not cached: the next request tries again.
      const again = await fetch(srv.url + "/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }], agent: "devin" }) });
      await again.json();
      await new Promise((r) => setTimeout(r, 150));
      expect(devin.sessions).toHaveLength(2);
    } finally { await srv.close(); await devin.close(); rmSync(tmp, { recursive: true, force: true }); }
  });

  it("refuses agent: \"devin\" when no key is configured, and says so on /api/health", async () => {
    const srv = await startServer({ port: 0, quiet: true, storePath: ":memory:", creds: null, devin: null });
    try {
      expect((await (await fetch(srv.url + "/api/health")).json()).agent).toEqual({ available: false, name: "Devin", max_acu: null, api: null, modes: [], default_mode: null });
      const res = await fetch(srv.url + "/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }], agent: "devin" }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/DEVIN_API_KEY/);
    } finally { await srv.close(); }
  });
});

describe("the reading prompt and result parser", () => {
  it("builds the prompt from the skill's item rules, with every attachment and the output shape", () => {
    const p = readingPrompt({ files: [{ name: "Plan.pptx", url: "https://x/1" }], stage: "launching", rules: itemRules() });
    expect(p).toContain('- Plan.pptx: ATTACHMENT:"https://x/1"');
    expect(p).toContain("A plan item is something a team must deliver");
    expect(p).toContain('"files_read"');
    expect(p).not.toContain("A signal is");
    const early = readingPrompt({ files: [{ name: "PRD.docx", url: "https://x/2" }], stage: "starting", rules: itemRules(), signalRules: "- customer_data: implies Privacy, Legal" });
    expect(early).toContain("A signal is");
    expect(early).toContain("- customer_data: implies Privacy, Legal");
  });
  it("drops malformed entries and items that name a file that was not uploaded, with warnings", () => {
    const r = parseReading({ done: true, items: [
      { text: "A", kind: "approval", owner_team: null, source: { file: "Plan.pptx", quote: "q" } },
      { text: "B", kind: "approval", source: { file: "Other.pdf", locator: "page 1", quote: "q" } },
      "nonsense",
    ], signals: [{ quote: "s", file: "Plan.pptx", rule_ids: [] }], files_read: [{ name: "Plan.pptx" }], unreadable: [] }, ["Plan.pptx"]);
    expect(r.items).toEqual([{ text: "A", kind: "approval", owner_team: null, due_text: null, source: { file: "Plan.pptx", locator: "document", quote: "q" } }]);
    expect(r.signals).toEqual([]);
    expect(r.files_read).toEqual([{ name: "Plan.pptx", how: "" }]);
    expect(r.warnings).toHaveLength(3);
    expect(parseReading("not an object", []).warnings).toHaveLength(1);
  });
});
