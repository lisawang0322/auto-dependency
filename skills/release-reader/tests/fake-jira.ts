/**
 * Test helper: a tiny Jira Cloud REST look-alike served from a fixture snapshot, so the REST source can
 * be exercised end to end without a real site. It pages deliberately small (projects, comments, search)
 * to exercise the client's pagination.
 */
import { createServer, type Server } from "node:http";
import { FixtureSource } from "../scripts/lib/jira-source.js";

export interface FakeJira { url: string; close(): Promise<void>; calls: string[] }

export async function startFakeJira(snapDir: string, opts: { email?: string; token?: string } = {}): Promise<FakeJira> {
  const fx = new FixtureSource(snapDir);
  const projects = fx.listProjects() ?? [];
  const expectAuth = "Basic " + Buffer.from(`${opts.email ?? "me@example.com"}:${opts.token ?? "secret"}`).toString("base64");
  const calls: string[] = [];
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== expectAuth) return json(res, 401, { errorMessages: ["Unauthorized"] });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = url.pathname;
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
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}

/** Like Jira: the issue endpoint carries only the first page of comments plus the total. */
function firstCommentPage(i: any) {
  const all = i.fields.comment?.comments ?? [];
  return { ...i, fields: { ...i.fields, comment: { comments: all.slice(0, 2), total: all.length, maxResults: 2 } } };
}
