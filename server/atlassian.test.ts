import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeJira, type FakeJira } from "../skills/release-reader/tests/fake-jira.js";
import { startServer } from "./index.js";
import { TokenBox } from "./crypto.js";

function client(base: string) {
  const jar = new Map<string, string>();
  const take = (res: Response) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (v === "" || /Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const req = async (url: string, init: RequestInit = {}) => { const res = await fetch(url.startsWith("http") ? url : base + url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: cookie() } }); take(res); return res; };
  const json = async (method: string, path: string, body?: unknown) => { const res = await req(path, { method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, data: res.status === 204 ? null : await res.json() }; };
  const follow = async (url: string, max = 6) => { let res = await req(url); for (let i = 0; i < max && res.status >= 300 && res.status < 400; i++) res = await req(res.headers.get("location")!); return res; };
  return { req, json, follow, jar };
}

describe("Jira through Sign in with Atlassian (OAuth 2.0 3LO)", () => {
  let jira: FakeJira, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-atl-"));
    // Short-lived access tokens, so the refresh path runs in the test.
    jira = await startFakeJira("fixtures/ingest-142/jira/2026-11-13", { oauth: { clientId: "jira-app", clientSecret: "jira-secret", cloudId: "cloud-1", accessTtlSec: 30 } });
    const probe = await startServer({ port: 0, quiet: true, creds: null, storePath: ":memory:", devin: null, atlassian: null });
    const port = Number(new URL(probe.url).port);
    await probe.close();
    srv = await startServer({ port, quiet: true, creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), storePath: ":memory:", devin: null, guiDist: join(tmp, "nodist"), tokenKey: "test-token-key",
      atlassian: { clientId: "jira-app", clientSecret: "jira-secret", appUrl: `http://127.0.0.1:${port}`, authBase: jira.url, apiBase: jira.url } });
  });
  afterAll(async () => { await srv?.close(); await jira.close(); rmSync(tmp, { recursive: true, force: true }); });

  it("connects through the provider, reads Jira over the gateway with a bearer token, refreshes with rotation, and disconnects", async () => {
    const c = client(srv.url);
    const h0 = (await c.json("GET", "/api/health")).data;
    expect(h0.jira).toMatchObject({ connected: false, oauth: true, method: null });

    // Start → /authorize (approved at once) → callback → next.
    const done = await c.follow("/auth/atlassian/start?next=%2F%3Fbackend%3Dlive");
    expect(done.status).toBe(404); // "/?backend=live" with no GUI build: the static handler's note
    expect(c.jar.has("rrr_atl")).toBe(false);
    expect(jira.calls).toContain("POST /oauth/token");
    expect(jira.calls).toContain("GET /oauth/token/accessible-resources");
    const h1 = (await c.json("GET", "/api/health")).data;
    expect(h1.jira).toMatchObject({ connected: true, oauth: true, method: "oauth", user: "Fixture User", sites: 1 });
    expect(h1.jira.site).toBe(jira.url.replace(/^https?:\/\//, ""));
    expect((await c.json("GET", "/api/jira/sites")).data).toEqual({ sites: [{ id: "cloud-1", url: jira.url, name: "Fixture Site" }], current: "cloud-1" });
    expect((await c.json("POST", "/api/jira/site", { cloud_id: "nope" })).status).toBe(400);

    // A review over the gateway: every Jira call carries the bearer token under /ex/jira/<cloudId>.
    const plan = (await c.json("POST", "/api/plan", { files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }, { name: "launch-checklist.csv", kind: "checks", sample: true }, { name: "team-list.yaml", kind: "teams", sample: true }] })).data.plan;
    const t = await c.json("POST", "/api/target", { plan, epic: "INGEST-142", label: "2026-11-13" });
    expect(t.status).toBe(200);
    expect(t.data.target.projects.map((p: any) => p.jira_project)).toEqual(["INGEST", "DATA", "SEC", "SRE"]);
    expect(jira.calls.some((x) => x.startsWith("GET /ex/jira/cloud-1/rest/api/3/"))).toBe(true);
    expect(jira.calls.some((x) => /^GET \/rest\/api\/3\/project/.test(x))).toBe(false); // never the plain site path

    // The 30-second token is "about to expire" from the client's point of view (60-second margin), so the next read
    // refreshed it; the fake rotates refresh tokens, and the server stored the new one.
    const issued = jira.issued.length;
    expect(issued).toBeGreaterThanOrEqual(2);
    expect(jira.calls.filter((x) => x === "POST /oauth/token").length).toBe(issued);
    const old = jira.issued[0].refresh;
    const reuse = await fetch(jira.url + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: "jira-app", client_secret: "jira-secret", grant_type: "refresh_token", refresh_token: old }) });
    expect(reuse.status).toBe(400); // rotation: a used refresh token is dead

    // Disconnect forgets the tokens; the company has no environment credentials here, so Jira is gone.
    expect((await c.json("POST", "/api/jira/disconnect")).data).toMatchObject({ connected: false, method: null });
    expect((await c.json("POST", "/api/target", { plan, epic: "INGEST-142" })).status).toBe(400);
  });

  it("refuses a mismatched state and a callback nobody started, and the popup variant answers with a page that messages its opener", async () => {
    const c = client(srv.url);
    const bad = await c.req("/auth/atlassian/callback?code=x&state=y");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/expired or was not started/);
    await c.req("/auth/atlassian/start?popup=1");
    const wrong = await c.req("/auth/atlassian/callback?code=x&state=not-it");
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("content-type")).toMatch(/text\/html/);
    expect(await wrong.text()).toMatch(/postMessage\(\{type:"rrr:atlassian",ok:false/);
    const ok = await c.follow("/auth/atlassian/start?popup=1");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/ok:true.*window\.close\(\)/);
  });
});

describe("the token box", () => {
  it("round-trips and rejects tampering or another key", () => {
    const a = new TokenBox("k1"), b = new TokenBox("k2");
    const sealed = a.seal({ access_token: "x", n: 1 });
    expect(a.open(sealed)).toEqual({ access_token: "x", n: 1 });
    expect(b.open(sealed)).toBeNull();
    expect(a.open(sealed.slice(0, -2) + "zz")).toBeNull();
    expect(a.open("garbage")).toBeNull();
  });
});
