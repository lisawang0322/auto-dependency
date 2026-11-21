/**
 * Read-only Jira Cloud REST client that plays the agent's role in MCP mode: it runs the pending
 * requests a McpCacheSource recorded and saves the raw responses into the same cache directory.
 * Stage B/C logic never sees a difference between --source fixture, mcp and rest.
 *
 * Only GET /myself, GET /project/search, GET /issue/{key}, GET /issue/{key}/comment and
 * POST /search/jql are used. Nothing here can write to Jira.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JiraRequest, RawIssue, RawProject } from "./jira-types.js";
import { McpCacheSource } from "./jira-source.js";

/** Basic auth with an API token on the site itself, or an OAuth 2.0 (3LO) bearer token through Atlassian's gateway. */
export type RestCreds =
  | { kind?: "basic"; /** https://<you>.atlassian.net */ site: string; email: string; token: string }
  | { kind: "oauth"; /** The site, for display. */ site: string; cloudId: string; /** https://api.atlassian.com unless a test says otherwise. */ apiBase?: string; /** A current access token; refreshes behind the scenes. */ accessToken: () => Promise<string> };

export function credsFromEnv(env = process.env): RestCreds {
  const site = env.JIRA_SITE, email = env.JIRA_EMAIL, token = env.JIRA_API_TOKEN;
  if (!site || !email || !token) throw new Error("--source rest needs JIRA_SITE (https://<you>.atlassian.net), JIRA_EMAIL and JIRA_API_TOKEN in the environment.");
  return { site, email, token };
}

export class JiraAuthError extends Error {}

export class JiraRest {
  readonly site: string;
  readonly method: "basic" | "oauth";
  private base: string;
  private authHeader: () => Promise<string>;
  calls = 0;
  constructor(creds: RestCreds, private fetchImpl: typeof fetch = fetch) {
    this.site = creds.site.replace(/\/+$/, "");
    if (creds.kind === "oauth") {
      this.method = "oauth";
      this.base = `${(creds.apiBase ?? "https://api.atlassian.com").replace(/\/+$/, "")}/ex/jira/${encodeURIComponent(creds.cloudId)}`;
      this.authHeader = async () => `Bearer ${await creds.accessToken()}`;
    } else {
      this.method = "basic";
      this.base = this.site;
      const basic = "Basic " + Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
      this.authHeader = async () => basic;
    }
  }

  /** One call. 404 resolves to null; 401/403 throw JiraAuthError; other failures throw. */
  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any | null> {
    this.calls++;
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { Accept: "application/json", Authorization: await this.authHeader(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new JiraAuthError(this.method === "oauth" ? `Jira ${res.status} on ${method} ${path}: the Atlassian sign-in no longer grants access; connect Jira again.` : `Jira ${res.status} on ${method} ${path}: check JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN, and that the account can see the project.`);
    if (!res.ok) throw new Error(`Jira ${res.status} on ${method} ${path}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async myself(): Promise<{ displayName: string; emailAddress?: string }> {
    const me = await this.call("GET", "/rest/api/3/myself");
    if (!me) throw new JiraAuthError("Jira /myself returned nothing.");
    return me;
  }

  async listProjects(): Promise<RawProject[]> {
    const out: RawProject[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.call("GET", `/rest/api/3/project/search?startAt=${startAt}&maxResults=50&expand=description,lead`);
      const values: any[] = page?.values ?? [];
      for (const p of values) out.push({ key: p.key, name: p.name, projectCategory: p.projectCategory ?? null, description: p.description ?? null, lead: p.lead ? { displayName: p.lead.displayName } : null });
      startAt += values.length;
      if (page?.isLast !== false || !values.length) break;
    }
    return out;
  }

  async getIssue(key: string, fields: string[]): Promise<RawIssue | null> {
    const issue = await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(",")}`);
    if (!issue) return null;
    await this.completeComments(issue);
    return issue;
  }

  /** The issue endpoint returns one page of comments; fetch the rest when there are more. */
  private async completeComments(issue: any): Promise<void> {
    const c = issue.fields?.comment;
    if (!c || typeof c.total !== "number" || c.total <= (c.comments?.length ?? 0)) return;
    const all: any[] = [...(c.comments ?? [])];
    while (all.length < c.total) {
      const page = await this.call("GET", `/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment?startAt=${all.length}&maxResults=100`);
      const got: any[] = page?.comments ?? [];
      if (!got.length) break;
      all.push(...got);
    }
    issue.fields.comment = { comments: all, total: c.total };
  }

  async search(jql: string, maxResults: number, fields: string[]): Promise<RawIssue[]> {
    const out: RawIssue[] = [];
    let nextPageToken: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = { jql, maxResults: Math.min(100, maxResults - out.length), fields };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const page = await this.call("POST", "/rest/api/3/search/jql", body);
      const issues: any[] = page?.issues ?? [];
      for (const i of issues) { await this.completeComments(i); out.push(i); }
      nextPageToken = page?.nextPageToken;
      if (!nextPageToken || !issues.length || out.length >= maxResults) break;
    }
    return out.slice(0, maxResults);
  }
}

/** Run the recorded requests and save each response (or {"error"}) where the cache expects it. */
export async function serveRequestsRest(cacheDir: string, rest: JiraRest, reqs: JiraRequest[], log?: (line: string) => void): Promise<number> {
  for (const r of reqs) {
    const out = join(cacheDir, r.save_as);
    mkdirSync(dirname(out), { recursive: true });
    let data: unknown;
    try {
      if (r.tool === "getVisibleJiraProjects") data = await rest.listProjects();
      else if (r.tool === "getJiraIssue") {
        const issue = await rest.getIssue(String(r.args.issueIdOrKey), r.args.fields as string[]);
        data = issue ?? { error: "Issue does not exist or you do not have permission to see it." };
      } else data = { issues: await rest.search(String(r.args.jql), Number(r.args.maxResults), r.args.fields as string[]) };
    } catch (e) {
      if (e instanceof JiraAuthError) throw e;
      data = { error: String((e as Error).message ?? e) };
    }
    writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
    log?.(`${r.tool} ${r.tool === "searchJiraIssuesUsingJql" ? r.args.jql : r.tool === "getJiraIssue" ? r.args.issueIdOrKey : ""} -> ${r.save_as}`);
  }
  return reqs.length;
}

/** Run `step` until it returns a value, serving its pending Jira reads over REST between rounds. */
export async function runRestLoop<T>(cacheDir: string, rest: JiraRest, step: (src: McpCacheSource) => T | undefined, opts: { maxRounds?: number; log?: (line: string) => void } = {}): Promise<[T, number]> {
  const maxRounds = opts.maxRounds ?? 50;
  let rounds = 0;
  while (rounds < maxRounds) {
    const src = new McpCacheSource(cacheDir, "rest");
    const out = step(src);
    rounds++;
    if (out !== undefined) return [out, rounds];
    const n = await serveRequestsRest(cacheDir, rest, src.pending(), opts.log);
    if (!n) throw new Error("stuck: nothing pending but no result");
  }
  throw new Error(`gave up after ${maxRounds} rounds of Jira reads`);
}
