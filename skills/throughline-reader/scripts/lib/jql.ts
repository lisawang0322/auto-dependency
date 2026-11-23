/**
 * JQL building and a small evaluator used for fixtures and cached MCP responses.
 * The evaluator supports exactly the forms the skill builds:
 *   parent = KEY            (children of an epic; "Epic Link" = KEY and parentEpic = KEY are aliases)
 *   project = X AND updated >= YYYY-MM-DD AND text ~ "w1 w2 w3"
 *   key in (A, B, C)
 * text ~ matches when ANY term occurs in summary, description or a comment (Jira's default OR semantics
 * for an unquoted multi-word term; confirm against your site, see reference/mcp-tools.md).
 */
import { RawIssue, bodyText } from "./jira-types.js";

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to", "by", "with", "is", "are", "be", "as", "from", "into",
  "place", "passed", "done", "ready", "live", "documented", "raised", "reviewed", "approved", "completed", "team", "x", "2x",
]);

/** 2–4 distinctive keywords from a plan item, excluding the owning team's own words. */
export function keywordsFor(itemText: string, ownerTeam: string | null, max = 4): string[] {
  const owner = new Set((ownerTeam ?? "").toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
  const words = itemText.toLowerCase().replace(/[^a-z0-9\- ]+/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (STOP.has(w) || owner.has(w) || w.length < 2) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function scopedSearchJql(project: string, windowStart: string, terms: string[]): string {
  const text = terms.map((t) => t.replace(/"/g, "")).join(" ");
  return `project = ${project} AND updated >= ${windowStart} AND text ~ "${text}"`;
}

export function childrenJql(epicKey: string): string {
  return `parent = ${epicKey}`;
}

// ---------- evaluator ----------

interface Clause { field: string; op: string; value: string | string[] }

export function parseJql(jql: string): Clause[] {
  const clauses: Clause[] = [];
  const parts = jql.split(/\s+AND\s+/i);
  for (const raw of parts) {
    const p = raw.trim();
    if (/\s+OR\s+/i.test(p)) throw new Error(`fixture JQL evaluator does not support OR: ${jql}`);
    const m = p.match(/^("?[\w ]+"?)\s*(=|!=|>=|<=|>|<|~|in)\s*(.+)$/i);
    if (!m) throw new Error(`cannot parse JQL clause: ${p}`);
    const field = m[1].replace(/"/g, "").trim().toLowerCase();
    const op = m[2].toLowerCase();
    let value: string | string[] = m[3].trim();
    if (op === "in") value = value.replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    else value = value.replace(/^"|"$/g, "");
    clauses.push({ field, op, value });
  }
  return clauses;
}

export function issueText(i: RawIssue): string {
  const f = i.fields;
  return [f.summary, bodyText(f.description), ...(f.comment?.comments ?? []).map((c) => bodyText(c.body))].join("\n").toLowerCase();
}

export function matchesJql(issue: RawIssue, clauses: Clause[]): boolean {
  for (const c of clauses) {
    const f = issue.fields;
    switch (c.field) {
      case "project":
        if ((f.project?.key ?? issue.key.slice(0, issue.key.lastIndexOf("-"))) !== c.value) return false;
        break;
      case "parent":
      case "epic link":
      case "parentepic":
        if (f.parent?.key !== c.value) return false;
        break;
      case "key":
        if (c.op === "in" ? !(c.value as string[]).includes(issue.key) : issue.key !== c.value) return false;
        break;
      case "status":
        if ((f.status?.name ?? "").toLowerCase() !== String(c.value).toLowerCase()) return false;
        break;
      case "updated": {
        const d = (f.updated ?? "").slice(0, 10);
        const v = String(c.value).slice(0, 10);
        if (c.op === ">=" && !(d >= v)) return false;
        if (c.op === "<=" && !(d <= v)) return false;
        if (c.op === ">" && !(d > v)) return false;
        if (c.op === "<" && !(d < v)) return false;
        break;
      }
      case "text": {
        const text = issueText(issue);
        const terms = String(c.value).toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.some((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text))) return false;
        break;
      }
      default:
        throw new Error(`fixture JQL evaluator does not support field: ${c.field}`);
    }
  }
  return true;
}
