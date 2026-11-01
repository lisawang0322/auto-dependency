import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeIdp, type FakeIdp } from "./tests/fake-idp.js";
import { startFakeJira, type FakeJira } from "../skills/release-reader/tests/fake-jira.js";
import { startServer } from "./index.js";
import { Store } from "./store.js";
import { safeNext } from "./auth.js";

/** A tiny cookie jar + manual redirects, so the whole code flow runs through fetch. */
function client(base: string) {
  const jar = new Map<string, string>();
  const take = (res: Response) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const [k, v] = kv.split("="); if (v === "" || /Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const req = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url.startsWith("http") ? url : base + url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: cookie() } });
    take(res);
    return res;
  };
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await req(path, { method, headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };
  /** Follow redirects by hand, across hosts, carrying the jar. */
  const follow = async (url: string, max = 6) => {
    let res = await req(url);
    for (let i = 0; i < max && res.status >= 300 && res.status < 400; i++) res = await req(res.headers.get("location")!);
    return res;
  };
  return { req, json, follow, jar };
}

describe("sign-in with the company identity provider (OIDC)", () => {
  let idp: FakeIdp, jira: FakeJira, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-auth-"));
    idp = await startFakeIdp();
    jira = await startFakeJira("fixtures/ingest-142/jira/2026-11-13");
    // The provider redirects back to appUrl, so the port must be known before the server starts: borrow one.
    const probe = await startServer({ port: 0, quiet: true, creds: null, storePath: ":memory:", devin: null });
    const port = Number(new URL(probe.url).port);
    await probe.close();
    srv = await startServer({ port, quiet: true, creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), storePath: ":memory:", devin: null, guiDist: join(tmp, "nodist"),
      auth: { mode: "oidc", issuer: idp.url, clientId: "app-client-id", clientSecret: "app-secret", appUrl: `http://127.0.0.1:${port}`, sessionSecret: "test-secret" } });
  });
  afterAll(async () => { await srv?.close(); await idp.close(); await jira.close(); rmSync(tmp, { recursive: true, force: true }); });

  it("runs the whole flow against the fake provider, keeps a session, and scopes work to the user", async () => {
    const c = client(srv.url);

    // Signed out: health says so, the API refuses.
    const h0 = (await c.json("GET", "/api/health")).data;
    expect(h0.auth).toEqual({ mode: "oidc", user: null, login_url: "/auth/login" });
    expect(h0.settings).toBeNull();
    const refused = await c.json("GET", "/api/settings");
    expect(refused.status).toBe(401);
    expect(refused.data.login_url).toBe("/auth/login");

    // /auth/login → provider → /auth/callback → next.
    const done = await c.follow("/auth/login?next=%2F%3Fbackend%3Dlive");
    expect(done.status).toBe(404); // landed on "/?backend=live": no GUI build in this test, so the static handler's note
    expect(await done.text()).toMatch(/GUI not built/);
    expect(c.jar.has("rrr_session")).toBe(true);
    expect(c.jar.has("rrr_login")).toBe(false);
    expect(idp.calls).toContain("POST /token");
    const h1 = (await c.json("GET", "/api/health")).data;
    expect(h1.auth.user).toMatchObject({ name: "Lisa Wang", email: "lisa@example.com", org: "tenant-abc" });
    expect(h1.settings).toEqual({ agent_consent: "unknown", agent_mode: null });
    expect(h1.runs_root).toMatch(/orgs\/tenant-abc$/);

    // Settings and decisions live on the server, per user.
    expect((await c.json("PUT", "/api/settings", { agent_consent: "yes" })).data).toEqual({ agent_consent: "yes", agent_mode: null });
    expect((await c.json("PUT", "/api/settings", { agent_consent: "maybe" })).status).toBe(400);
    const key = encodeURIComponent("INGEST-142/2026-11-13");
    expect((await c.json("GET", `/api/decisions/${key}`)).data).toEqual({ decisions: {}, log: [], actionsDone: {} });
    const dec = { decisions: { f1: { kind: "kept", reason: "", at: "2026-10-31T00:00:00Z" } }, log: [{ time: "10:00", text: "Kept" }], actionsDone: { a1: true } };
    expect((await c.json("PUT", `/api/decisions/${key}`, dec)).status).toBe(200);
    expect((await c.json("GET", `/api/decisions/${key}`)).data).toEqual(dec);
    expect((await c.json("PUT", `/api/decisions/${key}`, { nope: 1 })).status).toBe(400);

    // Jira credentials are the user's; runs go under the organisation.
    expect((await c.json("POST", "/api/jira/connect", { site: jira.url, email: "me@example.com", token: "secret" })).data).toMatchObject({ connected: true, user: "Fixture User" });
    const plan = (await c.json("POST", "/api/plan", { files: [{ name: "Ingestion-service-POR-v3.md", kind: "plan", sample: true }, { name: "launch-checklist.csv", kind: "checks", sample: true }, { name: "team-list.yaml", kind: "teams", sample: true }] })).data.plan;
    const target = (await c.json("POST", "/api/target", { plan, epic: "INGEST-142", label: "2026-11-13" })).data.target;
    const start = await c.json("POST", "/api/run", { plan, target, label: "2026-11-13" });
    let job: any;
    for (let i = 0; i < 100 && !job?.done; i++) { await new Promise((r) => setTimeout(r, 50)); job = (await c.json("GET", `/api/jobs/${start.data.job}`)).data; }
    expect(job.run_id).toBe("2026-11-13");
    expect(existsSync(join(tmp, "runs/orgs/tenant-abc/INGEST-142/2026-11-13.json"))).toBe(true);
    expect((await c.json("GET", "/api/runs/INGEST-142")).data).toEqual([{ id: "2026-11-13", label: "2026-11-13" }]);

    // Cross-site writes are refused; GETs are not affected.
    const cross = await c.req("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: "{}" });
    expect(cross.status).toBe(403);
    const form = await c.req("/api/settings", { method: "PUT", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(415);

    // Sign out ends the session.
    const out = await c.req("/auth/logout", { method: "POST" });
    expect(out.status).toBe(204);
    expect(c.jar.has("rrr_session")).toBe(false);
    expect((await c.json("GET", "/api/settings")).status).toBe(401);

    // Signing in again finds the same user, with their settings, in a new session.
    const d = client(srv.url);
    await d.follow("/auth/login");
    expect((await d.json("GET", "/api/settings")).data).toEqual({ agent_consent: "yes", agent_mode: null });
    expect(d.jar.get("rrr_session")).not.toBe(c.jar.get("rrr_session"));
  });

  it("rejects a tampered state, a forged token, and an unsafe next", async () => {
    const c = client(srv.url);
    const start = await c.req("/auth/login");
    expect(start.status).toBe(302);
    const bad = await c.req("/auth/callback?code=x&state=not-the-one");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/state did not match/);
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example/x")).toBe("/");
    expect(safeNext("/?backend=live")).toBe("/?backend=live");
    // A token signed by someone else's key does not verify.
    const forged = idp.token({ iss: idp.issuer, aud: "app-client-id", sub: "x", exp: Math.floor(Date.now() / 1000) + 60, nonce: "n" }).replace(/\.[^.]+$/, ".AAAA");
    await expect(srv.app.auth.verifyIdToken(forged, "n")).rejects.toThrow(/signature did not verify/);
    await expect(srv.app.auth.verifyIdToken(idp.token({ iss: idp.issuer, aud: "other-app", sub: "x", exp: Math.floor(Date.now() / 1000) + 60, nonce: "n" }), "n")).rejects.toThrow(/not issued for this app/);
    await expect(srv.app.auth.verifyIdToken(idp.token({ iss: idp.issuer, aud: "app-client-id", sub: "x", exp: Math.floor(Date.now() / 1000) - 600, nonce: "n" }), "n")).rejects.toThrow(/expired/);
    await expect(srv.app.auth.verifyIdToken(idp.token({ iss: idp.issuer, aud: "app-client-id", sub: "x", exp: Math.floor(Date.now() / 1000) + 60, nonce: "other" }), "n")).rejects.toThrow(/nonce/);
  });
});

describe("AUTH=none keeps one local user", () => {
  it("answers as the local user, with settings and decisions stored, and no /auth routes", async () => {
    const srv = await startServer({ port: 0, quiet: true, creds: null, storePath: ":memory:", devin: null });
    try {
      const c = client(srv.url);
      const h = (await c.json("GET", "/api/health")).data;
      expect(h.auth).toEqual({ mode: "none", user: { id: "local", name: "You", email: null, org: "local" }, login_url: null });
      expect(h.settings).toEqual({ agent_consent: "unknown", agent_mode: null });
      await c.json("PUT", "/api/settings", { agent_consent: "no" });
      expect((await c.json("GET", "/api/health")).data.settings).toEqual({ agent_consent: "no", agent_mode: null });
      expect((await c.req("/auth/login")).status).toBe(404);
    } finally { await srv.close(); }
  });
});

describe("the store", () => {
  it("upserts users by identity, expires sessions, and keeps settings per user", () => {
    const s = new Store(":memory:");
    const a = s.upsertUser({ issuer: "i", sub: "1", email: "a@x", name: "A", org: "o" });
    const a2 = s.upsertUser({ issuer: "i", sub: "1", email: "a2@x", name: "A2", org: "o" });
    expect(a2.id).toBe(a.id);
    expect(s.user(a.id)?.name).toBe("A2");
    const b = s.upsertUser({ issuer: "i", sub: "2", email: null, name: "B", org: "o" });
    expect(b.id).not.toBe(a.id);
    const live = s.createSession(a.id, 60_000), dead = s.createSession(a.id, -1);
    expect(s.sessionUser(live.id)?.id).toBe(a.id);
    expect(s.sessionUser(dead.id)).toBeNull();
    s.setSetting(a.id, "agent_consent", "yes");
    expect(s.setting(a.id, "agent_consent")).toBe("yes");
    expect(s.setting(b.id, "agent_consent")).toBeNull();
    s.deleteUserSessions(a.id);
    expect(s.sessionUser(live.id)).toBeNull();
    s.close();
  });
});

describe("demo sign-in (AUTH=demo)", () => {
  it("serves a sign-in page of people, keeps a session per person, and connects the sample directory through the demo consent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "rrr-demo-"));
    const srv = await startServer({ port: 0, quiet: true, creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), storePath: ":memory:", devin: null, guiDist: join(tmp, "nodist"), auth: { mode: "demo", appUrl: "http://127.0.0.1", sessionSecret: "demo-secret" } });
    try {
      const c = client(srv.url);
      expect((await c.json("GET", "/api/health")).data.auth).toEqual({ mode: "demo", user: null, login_url: "/auth/login" });
      const page = await c.req("/auth/login?next=%2F");
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Sign in to Sample Co");
      expect(html).toContain("Priya Natarajan");
      expect(html).toContain("Demo identity provider");
      const signed = await c.req("/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "persona=priya&next=%2F" });
      expect(signed.status).toBe(302);
      expect(c.jar.has("rrr_session")).toBe(true);
      const h = (await c.json("GET", "/api/health")).data;
      expect(h.auth.user).toMatchObject({ name: "Priya Natarajan", email: "priya@sample-co.example", org: "sample-co" });
      expect(h.directory.entra).toEqual({ available: true, connected: null });
      // The directory's Entra layer: the demo consent page, then the sample company's departments as teams.
      const consent = await c.req("/auth/directory/entra/start");
      expect(await consent.text()).toContain("Permissions requested");
      const done = await c.req("/auth/directory/entra/callback", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "decision=accept" });
      expect(done.status).toBe(302);
      const d = (await c.json("GET", "/api/directory")).data;
      expect(d.entra.connected).toMatchObject({ label: "Microsoft Entra ID · sample-co (demo)", teams: 7 });
      expect((await c.req("/auth/directory/entra/callback", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "decision=cancel" })).status).toBe(400);
      // A second person is separate.
      const c2 = client(srv.url);
      await c2.req("/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "persona=anika&next=%2F" });
      expect((await c2.json("GET", "/api/health")).data.auth.user.name).toBe("Anika Rao");
      expect((await c2.json("GET", "/api/directory")).data.entra.connected).toBeNull();
      expect((await c.req("/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "persona=nobody" })).status).toBe(400);
    } finally { await srv.close(); rmSync(tmp, { recursive: true, force: true }); }
  });
});
