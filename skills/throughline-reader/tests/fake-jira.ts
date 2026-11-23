/**
 * Test helper: a tiny Jira Cloud REST look-alike served from a fixture snapshot, so the REST source can
 * be exercised end to end without a real site. It pages deliberately small (projects, comments, search)
 * to exercise the client's pagination.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { FixtureSource } from "../scripts/lib/jira-source.js";

export interface FakeJira { url: string; close(): Promise<void>; calls: string[]; /** With `oauth`: the cloud id the gateway path uses, and the tokens issued so far. */ cloudId: string; issued: { access: string; refresh: string }[] }

/** With `oauth`, the fake also plays auth.atlassian.com and api.atlassian.com: /authorize (approves at once), /oauth/token
 *  (code and rotating refresh grants), /oauth/token/accessible-resources, and Jira under /ex/jira/<cloudId> with a bearer token. */
export async function startFakeJira(snapDir: string, opts: { email?: string; token?: string; oauth?: { clientId?: string; clientSecret?: string; cloudId?: string; accessTtlSec?: number } } = {}): Promise<FakeJira> {
  const fx = new FixtureSource(snapDir);
  const projects = fx.listProjects() ?? [];
  const expectAuth = "Basic " + Buffer.from(`${opts.email ?? "me@example.com"}:${opts.token ?? "secret"}`).toString("base64");
  const calls: string[] = [];
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const oauth = opts.oauth ? { clientId: opts.oauth.clientId ?? "jira-app", clientSecret: opts.oauth.clientSecret ?? "jira-secret", cloudId: opts.oauth.cloudId ?? "cloud-fixture", ttl: opts.oauth.accessTtlSec ?? 3600 } : null;
  const codes = new Map<string, string>();
  const access = new Map<string, number>(); // token → expiry ms
  const refreshTokens = new Set<string>();
  const issued: { access: string; refresh: string }[] = [];
  let base = "";
  const mint = () => { const a = "at-" + randomBytes(6).toString("hex"), r = "rt-" + randomBytes(6).toString("hex"); access.set(a, Date.now() + oauth!.ttl * 1000); refreshTokens.add(r); issued.push({ access: a, refresh: r }); return { access_token: a, refresh_token: r, expires_in: oauth!.ttl, scope: "read:jira-work read:jira-user offline_access", token_type: "Bearer" }; };
  const bearerOk = (h: string | undefined) => { const t = (h ?? "").replace(/^Bearer /, ""); const exp = access.get(t); return !!exp && exp > Date.now(); };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let p = url.pathname;
    calls.push(`${req.method} ${p}`);
    let body = "";
    for await (const c of req) body += c;
    if (oauth) {
      if (p === "/authorize" && req.method === "GET") {
        const q = url.searchParams;
        if (q.get("client_id") !== oauth.clientId || q.get("response_type") !== "code" || q.get("audience") !== "api.atlassian.com" || q.get("prompt") !== "consent" || !q.get("redirect_uri") || !q.get("state")) return json(res, 400, { error: "invalid_request" });
        const code = "code-" + randomBytes(4).toString("hex");
        codes.set(code, q.get("redirect_uri")!);
        const back = new URL(q.get("redirect_uri")!); back.searchParams.set("code", code); back.searchParams.set("state", q.get("state")!);
        res.writeHead(302, { Location: back.toString() }); return res.end();
      }
      if (p === "/oauth/token" && req.method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.client_id !== oauth.clientId || b.client_secret !== oauth.clientSecret) return json(res, 401, { error: "invalid_client" });
        if (b.grant_type === "authorization_code") {
          const redirect = codes.get(b.code);
          if (!redirect || redirect !== b.redirect_uri) return json(res, 400, { error: "invalid_grant", error_description: "unknown code or redirect_uri mismatch" });
          codes.delete(b.code);
          return json(res, 200, mint());
        }
        if (b.grant_type === "refresh_token") {
          if (!refreshTokens.has(b.refresh_token)) return json(res, 400, { error: "invalid_grant", error_description: "refresh token unknown or already used" });
          refreshTokens.delete(b.refresh_token); // rotation: the old one is disabled
          return json(res, 200, mint());
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (p === "/oauth/token/accessible-resources" && req.method === "GET") {
        if (!bearerOk(req.headers.authorization)) return json(res, 401, { error: "invalid_token" });
        return json(res, 200, [{ id: oauth.cloudId, url: base, name: "Fixture Site", scopes: ["read:jira-work", "read:jira-user"], avatarUrl: "" }]);
      }
      const gw = p.match(/^\/ex\/jira\/([^/]+)(\/.*)$/);
      if (gw) {
        if (gw[1] !== oauth.cloudId) return json(res, 404, { errorMessages: ["unknown cloud id"] });
        if (!bearerOk(req.headers.authorization)) return json(res, 401, { errorMessages: ["Unauthorized"] });
        p = gw[2];
      } else if (req.headers.authorization !== expectAuth) return json(res, 401, { errorMessages: ["Unauthorized"] });
    } else if (req.headers.authorization !== expectAuth) return json(res, 401, { errorMessages: ["Unauthorized"] });
    {
      if (p === "/rest/api/3/myself") return json(res, 200, { displayName: "Fixture User", emailAddress: opts.email ?? "me@example.com" });
      if (p === "/rest/api/3/project/search") {
        const startAt = Number(url.searchParams.get("startAt") ?? 0);
        const page = projects.slice(startAt, startAt + 2);
        return json(res, 200, { values: page, startAt, isLast: startAt + 2 >= projects.length, total: projects.length });
      }
      let m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9-]+)\/comment$/);
      if (m) {
        const i = fx.getIssue(m[1]);
        if (!i) return json(res, 404, { errorMessages: ["Issue does not exist"] });
        const all = i.fields.comment?.comments ?? [];
        const startAt = Number(url.searchParams.get("startAt") ?? 0);
        return json(res, 200, { comments: all.slice(startAt, startAt + 2), startAt, total: all.length });
      }
      m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9-]+)$/);
      if (m) {
        const i = fx.getIssue(m[1]);
        if (!i) return json(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
        return json(res, 200, firstCommentPage(i));
      }
      if (p === "/rest/api/3/search/jql" && req.method === "POST") {
        const q = JSON.parse(body || "{}");
        const all = fx.search(String(q.jql), 10_000) ?? [];
        const start = q.nextPageToken ? Number(q.nextPageToken) : 0;
        const size = Math.min(Number(q.maxResults ?? 50), 10);
        const page = all.slice(start, start + size).map(firstCommentPage);
        const next = start + size < all.length ? String(start + size) : undefined;
        return json(res, 200, next ? { issues: page, nextPageToken: next } : { issues: page });
      }
      json(res, 404, { errorMessages: [`no route ${req.method} ${p}`] });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  return { url: base, calls, cloudId: oauth?.cloudId ?? "", issued, close: () => new Promise((r) => server.close(() => r())) };
}

/** Like Jira: the issue endpoint carries only the first page of comments plus the total. */
function firstCommentPage(i: any) {
  const all = i.fields.comment?.comments ?? [];
  return { ...i, fields: { ...i.fields, comment: { comments: all.slice(0, 2), total: all.length, maxResults: 2 } } };
}
