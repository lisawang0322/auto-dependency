import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeIdp, type FakeIdp } from "./tests/fake-idp.js";
import { startFakeJira, type FakeJira } from "../skills/throughline-reader/tests/fake-jira.js";
import { startServer } from "./index.js";

/** The auth test's cookie jar: manual redirects across hosts, carrying cookies. */
function client(base: string) {
  const jar = new Map<string, string>();
  const take = (res: Response) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (v === "" || /Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const req = async (url: string, init: RequestInit = {}) => { const res = await fetch(url.startsWith("http") ? url : base + url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: cookie() } }); take(res); return res; };
  const json = async (method: string, path: string, body?: unknown) => { const res = await req(path, { method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, data: await res.json() }; };
  const follow = async (url: string, max = 6) => { let res = await req(url); for (let i = 0; i < max && res.status >= 300 && res.status < 400; i++) res = await req(res.headers.get("location")!); return res; };
  return { req, json, follow, jar };
}

describe("the employee directory: Microsoft Entra ID through the sign-in, Jira projects through the Jira connection", () => {
  let idp: FakeIdp, jira: FakeJira, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-directory-"));
    idp = await startFakeIdp();
    jira = await startFakeJira("fixtures/ingest-142/jira/2026-11-13");
    const probe = await startServer({ port: 0, quiet: true, creds: null, storePath: ":memory:", devin: null });
    const port = Number(new URL(probe.url).port);
    await probe.close();
    srv = await startServer({ port, quiet: true, creds: { site: jira.url, email: "me@example.com", token: "secret" }, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), storePath: ":memory:", devin: null, guiDist: join(tmp, "nodist"),
      auth: { mode: "oidc", issuer: idp.url, clientId: "app-client-id", clientSecret: "app-secret", appUrl: `http://127.0.0.1:${port}`, sessionSecret: "test-secret" },
      directory: { graphBase: idp.graph } });
  });
  afterAll(async () => { await srv?.close(); await idp.close(); await jira.close(); rmSync(tmp, { recursive: true, force: true }); });

  it("connects both layers, merges them into one team list for the reader, and disconnects each on its own", async () => {
    const c = client(srv.url);
    await c.follow("/auth/login?next=%2F");
    expect(c.jar.has("rrr_session")).toBe(true);
    const h0 = (await c.json("GET", "/api/health")).data;
    // The sign-in's consent covered the directory: it is connected on arrival.
    expect(h0.directory.entra.connected).toMatchObject({ teams: 6 });
    expect(h0.directory.jira).toEqual({ available: true, connected: null });
    expect(idp.calls).toContain("GET /graph/users");

    // Entra's own consent still works (a re-connect): the same registration, asking for the Graph scope; the token is used once.
    expect((await c.json("DELETE", "/api/directory/entra")).data.entra.connected).toBeNull();
    const back = await c.follow("/auth/directory/entra/start?next=%2F");
    expect(back.status).toBe(404); // landed on "/": no GUI build here
    expect(idp.scopes[idp.scopes.length - 1]).toBe("openid User.Read.All");
    const d1 = (await c.json("GET", "/api/directory")).data;
    // Departments become teams; a department's outside manager leads it; a disabled account is left out.
    expect(d1.entra.connected).toMatchObject({ label: "Microsoft Entra ID · tenant-abc", teams: 6, people: 13 });
    expect(d1.jira.connected).toBeNull();

    // Jira: every project with its lead and the people assigned to its work.
    const d2 = (await c.json("POST", "/api/directory/jira")).data;
    expect(d2.jira.connected).toMatchObject({ teams: 7 }); // one per project, with its lead and assignees
    expect(d2.jira.connected.label).toMatch(/^Jira projects · 127\.0\.0\.1/);

    // The plan step takes the merged directory as a file: Entra's people under Jira's project keys.
    const r = await c.json("POST", "/api/plan", { files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }, { name: "Employee directory.yaml", kind: "teams", via: "directory", source: "server" }] });
    expect(r.status).toBe(200);
    const teams = r.data.plan.teams;
    const data = teams.find((t: any) => t.name === "Data Platform");
    expect(data).toMatchObject({ jira_project_hint: "DATA" });
    expect(data.owners).toEqual(expect.arrayContaining(["Wei Zhang (project lead)", "Anika Rao (director, platform)", "Tomás Herrera (DBA)"]));
    // A team is contacted through its own lead, not the director the lead reports to: Security's first owner is its
    // security lead, and the platform director comes last, as the escalation.
    const security = teams.find((t: any) => t.name === "Security");
    expect(security.owners[0]).toMatch(/^Jordan Blake/);
    expect(security.owners[security.owners.length - 1]).toBe("Anika Rao (director, platform)");
    expect(r.data.plan.files.find((f: any) => f.name === "Employee directory.yaml").notes).toMatch(/^\d+ teams · \d+ Jira projects · \d+ owners$/);
    // The merged team list is written under the person's upload root (per organisation) and reads as a team list.
    const file = (readdirSync(join(tmp, "up"), { recursive: true }) as string[]).find((f) => f.endsWith("Employee directory.yaml"));
    expect(file).toBeDefined();
    expect(readFileSync(join(tmp, "up", file!), "utf8")).toMatch(/jira_project: DATA/);

    // Disconnect one layer; the other stays; nothing left means the file cannot be made.
    expect((await c.json("DELETE", "/api/directory/entra")).data.entra.connected).toBeNull();
    expect((await c.json("GET", "/api/directory")).data.jira.connected).toMatchObject({ teams: 7 });
    expect((await c.json("DELETE", "/api/directory/jira")).data.jira.connected).toBeNull();
    const none = await c.json("POST", "/api/plan", { files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }, { name: "Employee directory.yaml", kind: "teams", via: "directory", source: "server" }] });
    expect(none.status).toBe(400);
    expect(none.data.error).toMatch(/No employee directory is connected/);
  });

  it("refuses the Jira layer when Jira is not connected, and an unknown source", async () => {
    const c = client(srv.url);
    await c.follow("/auth/login?next=%2F");
    expect((await c.json("DELETE", "/api/directory/ldap")).status).toBe(404);
  });
});
