/**
 * Read-only Jira access behind one interface.
 *  - FixtureSource: a snapshot directory (projects.json + issues/*.json); JQL is evaluated locally.
 *  - McpCacheSource: a directory the agent fills with raw Atlassian MCP responses. Anything missing is
 *    recorded as a pending request; the script writes requests.json and exits so the agent can run them.
 * Both read the same file layout, so Stage B/C logic is identical for --source fixture and --source mcp.
 * Nothing here can write to Jira.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RawIssue, RawProject, JiraRequest } from "./jira-types.js";
import { parseJql, matchesJql } from "./jql.js";

/** null = the call failed or the issue is not visible; undefined = not fetched yet (MCP mode). */
export type Maybe<T> = T | null | undefined;

export interface JiraSource {
  readonly label: string;
  listProjects(): Maybe<RawProject[]>;
  getIssue(key: string): Maybe<RawIssue>;
  search(jql: string, maxResults: number): Maybe<RawIssue[]>;
  /** Calls still needed (MCP mode only). */
  pending(): JiraRequest[];
  warnings: string[];
}

const ISSUE_FIELDS = ["summary", "description", "issuetype", "status", "resolution", "project", "assignee", "duedate", "created", "updated", "components", "fixVersions", "parent", "issuelinks", "comment"];

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export class FixtureSource implements JiraSource {
  readonly label: string;
  warnings: string[] = [];
  private issues = new Map<string, RawIssue>();
  constructor(readonly dir: string) {
    if (!existsSync(dir)) throw new Error(`fixture dir not found: ${dir}`);
    this.label = dir.replace(/\/+$/, "").split("/").pop() ?? dir;
    const idir = join(dir, "issues");
    if (existsSync(idir)) for (const f of readdirSync(idir).filter((f) => f.endsWith(".json")).sort()) {
      const i = readJson(join(idir, f)) as RawIssue;
      this.issues.set(i.key, i);
    }
  }
  listProjects(): Maybe<RawProject[]> {
    const p = join(this.dir, "projects.json");
    if (!existsSync(p)) { this.warnings.push("projects.json missing in fixture"); return null; }
    return readJson(p);
  }
  getIssue(key: string): Maybe<RawIssue> {
    return this.issues.get(key) ?? null;
  }
  search(jql: string, maxResults: number): Maybe<RawIssue[]> {
    const clauses = parseJql(jql);
    return [...this.issues.values()].filter((i) => matchesJql(i, clauses)).sort((a, b) => a.key.localeCompare(b.key)).slice(0, maxResults);
  }
  pending(): JiraRequest[] { return []; }
}

export function searchFileName(jql: string): string {
  return "searches/" + createHash("sha1").update(jql).digest("hex").slice(0, 16) + ".json";
}

export class McpCacheSource implements JiraSource {
  readonly label: string;
  warnings: string[] = [];
  private requests = new Map<string, JiraRequest>();
  constructor(readonly dir: string, readonly cloudId?: string) {
    mkdirSync(join(dir, "issues"), { recursive: true });
    mkdirSync(join(dir, "searches"), { recursive: true });
    this.label = dir.replace(/\/+$/, "").split("/").pop() ?? dir;
  }
  private load(rel: string): any | undefined {
    const p = join(this.dir, rel);
    if (!existsSync(p)) return undefined;
    return readJson(p);
  }
  private need(req: JiraRequest): undefined {
    this.requests.set(req.save_as, req);
    return undefined;
  }
  private failed(rel: string, data: any): boolean {
    if (data && typeof data === "object" && "error" in data) {
      this.warnings.push(`${rel}: ${String(data.error)}`);
      return true;
    }
    return false;
  }
  listProjects(): Maybe<RawProject[]> {
    const data = this.load("projects.json");
    if (data === undefined) return this.need({ tool: "getVisibleJiraProjects", args: { cloudId: this.cloudId ?? "<cloudId>", maxResults: 100 }, save_as: "projects.json" });
    if (this.failed("projects.json", data)) return null;
    return Array.isArray(data) ? data : data.values ?? data.projects ?? [];
  }
  getIssue(key: string): Maybe<RawIssue> {
    const rel = `issues/${key}.json`;
    const data = this.load(rel);
    if (data === undefined) return this.need({ tool: "getJiraIssue", args: { cloudId: this.cloudId ?? "<cloudId>", issueIdOrKey: key, fields: ISSUE_FIELDS }, save_as: rel });
    if (this.failed(rel, data)) return null;
    return data;
  }
  search(jql: string, maxResults: number): Maybe<RawIssue[]> {
    const rel = searchFileName(jql);
    const data = this.load(rel);
    if (data === undefined) return this.need({ tool: "searchJiraIssuesUsingJql", args: { cloudId: this.cloudId ?? "<cloudId>", jql, maxResults, fields: ISSUE_FIELDS }, save_as: rel });
    if (this.failed(rel, data)) return null;
    const issues: RawIssue[] = Array.isArray(data) ? data : data.issues ?? [];
    return issues.slice(0, maxResults);
  }
  pending(): JiraRequest[] { return [...this.requests.values()]; }
  writeRequests(): string {
    const p = join(this.dir, "requests.json");
    writeFileSync(p, JSON.stringify(this.pending(), null, 2) + "\n");
    return p;
  }
}

export function openSource(opts: { source: string; dir: string; cloudId?: string }): JiraSource {
  if (opts.source === "fixture") return new FixtureSource(opts.dir);
  if (opts.source === "mcp") return new McpCacheSource(opts.dir, opts.cloudId);
  throw new Error(`--source must be fixture, mcp or rest, got ${opts.source}`);
}

/** If MCP calls are still pending, write requests.json, explain, and exit 3. */
export function stopIfPending(src: JiraSource): void {
  const pending = src.pending();
  if (!pending.length) return;
  const p = (src as McpCacheSource).writeRequests();
  console.error(`Needs ${pending.length} Jira read call(s) through the Atlassian MCP server. They are listed in ${p}.`);
  console.error(`Run each call, save its raw JSON response at <cache-dir>/<save_as> (or {"error": "..."} if it failed), then re-run this stage.`);
  process.exit(3);
}
