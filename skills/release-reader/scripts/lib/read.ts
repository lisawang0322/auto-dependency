/**
 * Stage C: read the epic, one hop out, and a scoped search per matched project.
 * Raw facts only: no judgement, no gap labels.
 */
import { PlanDraft, ReleaseTarget, Release, Story, Link, RelatedIssue, SearchCandidate } from "@rrr/schemas";
import { JiraSource } from "./jira-source.js";
import { RawIssue, bodyText } from "./jira-types.js";
import { childrenJql, keywordsFor, scopedSearchJql } from "./jql.js";
import { extractIssueKeys, projectOf } from "./keys.js";
import { linkTargets } from "./resolve.js";

export interface ReadOptions {
  plan: PlanDraft;
  target: ReleaseTarget;
  source: JiraSource;
  snapshotLabel: string;
  readAt?: string;
  searchCap?: number;
}

function excerptAround(text: string, key: string, radius = 70): string {
  const i = text.indexOf(key);
  if (i < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + key.length + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

function toStory(i: RawIssue): Story {
  const f = i.fields;
  return {
    key: i.key,
    summary: f.summary,
    status: f.status?.name ?? "",
    resolution: f.resolution?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    due: f.duedate ?? null,
    components: (f.components ?? []).map((c) => c.name),
    comments: (f.comment?.comments ?? []).map((c) => {
      const body = bodyText(c.body);
      return { author: c.author?.displayName ?? "", created: c.created, body, mentioned_keys: extractIssueKeys(body) };
    }),
  };
}

function brief(i: RawIssue) {
  const f = i.fields;
  return {
    key: i.key,
    project: f.project?.key ?? projectOf(i.key),
    summary: f.summary,
    status: f.status?.name ?? "",
    resolution: f.resolution?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    due: f.duedate ?? null,
    updated: f.updated ?? "",
  };
}

export function readJira(opts: ReadOptions): Release | undefined {
  const { plan, target, source } = opts;
  const warnings: string[] = [];
  const cap = opts.searchCap ?? 20;

  // 1. The epic and its stories
  const epic = source.getIssue(target.epic.key);
  if (epic === undefined) return undefined;
  if (!epic) throw new Error(`${target.epic.key} could not be read.`);
  const kidsRaw = source.search(childrenJql(epic.key), 500);
  if (kidsRaw === undefined) return undefined;
  if (kidsRaw === null) warnings.push(`Could not list the stories of ${epic.key}; continuing with the epic alone.`);
  const kids = (kidsRaw ?? []).slice().sort((a, b) => a.key.localeCompare(b.key));
  const stories = kids.map(toStory);
  const inside = new Set([epic.key, ...kids.map((k) => k.key)]);

  const links: Link[] = [];
  for (const issue of [epic, ...kids]) for (const t of linkTargets(issue)) links.push({ from: issue.key, to: t.key, type: t.type, direction: t.direction });

  // 2. One hop out: link targets first, then comment mentions. First reach wins.
  const related: RelatedIssue[] = [];
  const reached = new Set<string>(inside);
  let pending = false;
  const fetch = (key: string) => {
    const i = source.getIssue(key);
    if (i === undefined) { pending = true; return undefined; }
    return i;
  };
  for (const l of links) {
    if (reached.has(l.to)) continue;
    const i = fetch(l.to);
    if (i === undefined) continue;
    if (!i) { warnings.push(`${l.to} (linked from ${l.from}, ${l.type}) does not exist or is not visible.`); reached.add(l.to); continue; }
    reached.add(l.to);
    related.push({ ...brief(i), reached_by: "link", via: { issue: l.from, link_type: l.type, comment_excerpt: null } });
  }
  const epicStory = toStory(epic);
  for (const s of [epicStory, ...stories]) {
    for (const c of s.comments) {
      for (const key of c.mentioned_keys) {
        if (reached.has(key)) continue;
        const i = fetch(key);
        if (i === undefined) continue;
        reached.add(key);
        if (!i) continue; // keys that don't exist are skipped
        related.push({ ...brief(i), reached_by: "comment_mention", via: { issue: s.key, link_type: null, comment_excerpt: excerptAround(c.body, key) } });
      }
    }
  }
  if (pending) return undefined;

  // 3. Scoped search for unlinked work, per matched project
  const search_candidates: SearchCandidate[] = [];
  const projects_searched: Release["projects_searched"] = [];
  for (const p of target.projects) {
    if (p.match === "unresolved" || !p.jira_project) { warnings.push(`${p.team}: no Jira project resolved, not searched.`); continue; }
    if (p.search === false) { warnings.push(`${p.team}: not searched (marked "don't search").`); continue; }
    projects_searched.push({ team: p.team, jira_project: p.jira_project, match: p.match });
    const items = plan.items.filter((i) => (i.owner_team ?? "").toLowerCase() === p.team.toLowerCase());
    if (!items.length) { warnings.push(`${p.team}: no plan items owned by this team, nothing to search for.`); continue; }
    for (const item of items) {
      const terms = keywordsFor(item.text, item.owner_team);
      if (!terms.length) { warnings.push(`${item.id}: no usable keywords in "${item.text}", not searched.`); continue; }
      const jql = scopedSearchJql(p.jira_project, target.release_window.start, terms);
      const hits = source.search(jql, cap);
      if (hits === undefined) { pending = true; continue; }
      if (hits === null) { warnings.push(`${p.team}: search failed: ${jql}`); continue; }
      if (hits.length >= cap) warnings.push(`${p.team}: search for ${item.id} hit the cap of ${cap}; results may be incomplete: ${jql}`);
      for (const h of hits) {
        if (reached.has(h.key)) continue;
        if (search_candidates.some((c) => c.key === h.key && c.matched_plan_item_id === item.id)) continue;
        const b = brief(h);
        search_candidates.push({ key: b.key, project: b.project, summary: b.summary, status: b.status, resolution: b.resolution, assignee: b.assignee, due: b.due, updated: b.updated, matched_plan_item_id: item.id, match_terms: terms, jql });
      }
    }
  }
  if (pending) return undefined;

  const f = epic.fields;
  const fv = (f.fixVersions ?? [])[0] ?? null;
  return Release.parse({
    schema_version: 1,
    snapshot_label: opts.snapshotLabel,
    read_at: opts.readAt ?? new Date().toISOString(),
    epic: {
      key: epic.key, summary: f.summary, status: f.status?.name ?? "", fix_version: fv?.name ?? null, release_date: fv?.releaseDate ?? null,
      components: (f.components ?? []).map((c) => c.name), due: f.duedate ?? null,
    },
    stories,
    links,
    related,
    search_candidates,
    projects_searched,
    warnings: [...warnings, ...source.warnings],
  });
}
