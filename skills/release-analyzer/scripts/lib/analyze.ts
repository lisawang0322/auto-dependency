/**
 * release-analyzer core: compares the confirmed plan with the reader's Jira facts.
 * Everything here is a rule. No model rates anything. Same input → same output (apart from analyzed_at).
 */
import {
  PlanDraft, PlanItem, ReleaseTarget, Release, Findings, Finding, LinkageGap, ItemMatch, MatchWay, Strength, GapType, Evidence,
} from "@rrr/schemas";
import { keywordsFor, scoreText, scoreLabel, fill } from "./text.js";

export interface Templates { titles: Record<string, string>; actions: Record<string, string> }
export interface Phrases { promise: string[]; claim: string[] }

export interface AnalyzeOptions {
  plan: PlanDraft;
  target: ReleaseTarget;
  release: Release;
  templates: Templates;
  phrases: Phrases;
  /** Whether a team list was among the plan files. Default: detected from plan.files. */
  teamListGiven?: boolean;
  /** Go/no-go date. Default: the Friday before the launch date. */
  goNoGo?: string | null;
  analyzedAt?: string;
  /** How many non-weak findings are shown (R8). */
  cap?: number;
}

// ---------- Jira status rules ----------

const DONE_STATUSES = new Set(["done", "closed", "resolved", "released", "complete", "completed"]);
const ABANDONED_RESOLUTIONS = new Set(["duplicate", "won't do", "wont do", "won't fix", "wontfix", "cannot reproduce", "declined", "cancelled", "canceled", "rejected", "obsolete", "not a bug"]);

interface Ticket {
  key: string;
  project: string;
  summary: string;
  status: string;
  resolution: string | null;
  due: string | null;
  /** How the reader reached it. */
  reach: "epic" | "story" | "link" | "comment_mention" | "search";
  /** For link / comment_mention: the issue it hangs off; for search: null. */
  via: string | null;
  link_type: string | null;
}

export function isAbandoned(t: { status: string; resolution?: string | null }): boolean {
  return !!t.resolution && ABANDONED_RESOLUTIONS.has(t.resolution.toLowerCase());
}
export function isDone(t: { status: string; resolution?: string | null }): boolean {
  return DONE_STATUSES.has(t.status.toLowerCase()) && !isAbandoned(t);
}

// ---------- dates ----------

export function fridayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  let back = (t.getUTCDay() - 5 + 7) % 7;
  if (back === 0) back = 7;
  const r = new Date(t.getTime() - back * 86_400_000);
  return `${r.getUTCFullYear()}-${String(r.getUTCMonth() + 1).padStart(2, "0")}-${String(r.getUTCDate()).padStart(2, "0")}`;
}

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

// ---------- matching ----------

interface CommentHit { issue: string; author: string; created: string; body: string; promise: boolean; claim: boolean }

interface Match {
  item: PlanItem;
  keywords: string[];
  way: MatchWay;
  ticket: Ticket | null;
  score: string;
  note: string;
  /** Linked tickets that would have matched but were closed without being done (Duplicate, Won't Do…). */
  abandoned: Ticket[];
  /** Comments whose text matches the item. */
  comments: CommentHit[];
  /** Search candidates for this item that did not match well enough. */
  rejected: { key: string; summary: string; score: string }[];
}

function reachText(t: Ticket, epic: string): string {
  switch (t.reach) {
    case "epic": return `the epic itself`;
    case "story": return `in the epic`;
    case "link": return `linked to ${t.via} (${t.link_type})`;
    case "comment_mention": return `mentioned in a comment on ${t.via}, not linked to ${epic}`;
    case "search": return `found by search in ${t.project}, not linked to ${epic}`;
  }
}

function ticketMeta(t: Ticket, epic: string): string {
  return `${t.status}${t.resolution ? ` (${t.resolution})` : ""} · due ${t.due ?? "none"} · ${reachText(t, epic)}`;
}

// ---------- main ----------

export function analyze(opts: AnalyzeOptions): Findings {
  const { plan, target, release, templates, phrases } = opts;
  const warnings: string[] = [];
  const cap = opts.cap ?? 10;
  const epicKey = release.epic.key;
  const epicProject = projectOf(epicKey);
  const snapshotDate = /^\d{4}-\d{2}-\d{2}$/.test(release.snapshot_label) ? release.snapshot_label : release.read_at.slice(0, 10);
  const launch = plan.launch_date ?? release.epic.release_date ?? target.epic.release_date ?? null;
  const goNoGo = opts.goNoGo !== undefined ? opts.goNoGo : launch ? fridayBefore(launch) : null;
  const teamListGiven = opts.teamListGiven ?? plan.files.some((f) => f.read_as.includes("teams_and_owners"));

  // Teams
  const projectOfTeam = new Map<string, string | null>();
  for (const p of target.projects) projectOfTeam.set(p.team.toLowerCase(), p.jira_project);
  const teamOfProject = new Map<string, string>();
  for (const p of target.projects) if (p.jira_project) teamOfProject.set(p.jira_project, p.team);
  const serviceTeam = teamOfProject.get(epicProject) ?? plan.items.find((i) => i.kind === "deliverable")?.owner_team ?? null;
  if (!serviceTeam) warnings.push("Could not tell which team is the service team (no team maps to the epic's project and no deliverable has an owner); every item counts as another team's.");
  const personOf = (team: string | null): string => {
    if (!teamListGiven || !team) return "";
    const t = plan.teams.find((x) => x.name.toLowerCase() === team.toLowerCase());
    return t?.owners[0] ?? "";
  };

  // Tickets by reach
  const tickets = new Map<string, Ticket>();
  tickets.set(epicKey, { key: epicKey, project: epicProject, summary: release.epic.summary, status: release.epic.status, resolution: null, due: release.epic.due, reach: "epic", via: null, link_type: null });
  for (const s of release.stories) tickets.set(s.key, { key: s.key, project: projectOf(s.key), summary: s.summary, status: s.status, resolution: s.resolution ?? null, due: s.due, reach: "story", via: epicKey, link_type: null });
  for (const r of release.related) tickets.set(r.key, { key: r.key, project: r.project, summary: r.summary, status: r.status, resolution: r.resolution ?? null, due: r.due, reach: r.reached_by === "link" ? "link" : "comment_mention", via: r.via.issue, link_type: r.via.link_type });
  const searchTickets = release.search_candidates.map<Ticket & { item: string }>((c) => ({ key: c.key, project: c.project, summary: c.summary, status: c.status, resolution: c.resolution ?? null, due: c.due, reach: "search", via: null, link_type: null, item: c.matched_plan_item_id }));
  const linkedKeys = new Set<string>([epicKey, ...release.stories.map((s) => s.key)]);
  for (const l of release.links) { linkedKeys.add(l.from); linkedKeys.add(l.to); }

  const allComments: { issue: string; author: string; created: string; body: string }[] = [];
  for (const s of release.stories) for (const c of s.comments) allComments.push({ issue: s.key, author: c.author, created: c.created, body: c.body });
  const promiseRes = phrases.promise.map((p) => new RegExp(p, "i"));
  const claimRes = phrases.claim.map((p) => new RegExp(p, "i"));

  // Match every plan item, in the spec's order
  const matches: Match[] = [];
  for (const item of plan.items) {
    const keywords = keywordsFor(item.text, item.owner_team);
    const ownerProject = item.owner_team ? projectOfTeam.get(item.owner_team.toLowerCase()) ?? null : null;
    const isService = !!serviceTeam && item.owner_team?.toLowerCase() === serviceTeam.toLowerCase();
    const m: Match = { item, keywords, way: "none", ticket: null, score: "", note: "", abandoned: [], comments: [], rejected: [] };
    const n = keywords.length;

    // Candidates reached by the epic or its links. The service team's items live in the epic and its stories;
    // another team's items live in that team's project, reached by a link (the epic's stories are the service team's work).
    const inScope = (t: Ticket) => isService
      ? (t.reach === "epic" || t.reach === "story" || t.project === epicProject)
      : (t.reach !== "epic" && t.reach !== "story" && (ownerProject ? t.project === ownerProject : t.project !== epicProject));
    const linkedCands = [...tickets.values()].filter((t) => (t.reach === "epic" || t.reach === "story" || t.reach === "link") && inScope(t));

    // 1. explicit key in the plan text
    const explicit = [...new Set([...(item.source.quote + " " + item.text).matchAll(KEY_RE)].map((x) => x[0]))];
    for (const k of explicit) {
      const t = tickets.get(k);
      if (t && (t.reach === "epic" || t.reach === "story" || t.reach === "link")) {
        if (isAbandoned(t)) { m.abandoned.push(t); continue; }
        m.way = "linked_key"; m.ticket = t; m.score = `explicit key ${k}`; break;
      }
    }

    const best = (cands: Ticket[]) => {
      let bestT: Ticket | null = null, bestS = -1, bestLabel = "";
      for (const t of cands) {
        const s = scoreText(keywords, t.summary);
        if (!s.accepted) continue;
        if (isAbandoned(t)) { if (!m.abandoned.some((a) => a.key === t.key)) m.abandoned.push(t); continue; }
        if (s.score > bestS) { bestS = s.score; bestT = t; bestLabel = scoreLabel(s, n); }
      }
      return bestT ? { t: bestT, label: bestLabel } : null;
    };

    // 2. linked, by keywords
    if (!m.ticket && n) {
      const b = best(linkedCands);
      if (b) { m.way = "linked_keywords"; m.ticket = b.t; m.score = b.label; }
    }
    // 3. search candidates for this item
    if (!m.ticket && n) {
      const mine = searchTickets.filter((t) => t.item === item.id);
      const b = best(mine);
      if (b) { m.way = "search"; m.ticket = b.t; m.score = b.label; }
      for (const t of mine) if (!b || t.key !== b.t.key) m.rejected.push({ key: t.key, summary: t.summary, score: scoreLabel(scoreText(keywords, t.summary), n) });
    }
    // 4. comments: a ticket mentioned in a comment, or comment text that matches the item
    if (!m.ticket && n) {
      const mentioned = [...tickets.values()].filter((t) => t.reach === "comment_mention" && inScope(t));
      const b = best(mentioned);
      if (b) { m.way = "comment"; m.ticket = b.t; m.score = b.label; }
    }
    if (n) {
      for (const c of allComments) {
        const s = scoreText(keywords, c.body);
        if (!s.accepted) continue;
        m.comments.push({ ...c, promise: promiseRes.some((re) => re.test(c.body)), claim: claimRes.some((re) => re.test(c.body)) });
      }
      m.comments.sort((a, b) => a.created.localeCompare(b.created) || a.issue.localeCompare(b.issue));
    }
    if (!m.ticket && m.comments.length) { m.way = "comment"; m.score = `comment on ${m.comments[0].issue}`; }
    if (!n) { m.note = "no usable keywords in the item text"; warnings.push(`${item.id}: no usable keywords in "${item.text}"; not matched.`); }
    else if (!m.ticket) m.note = m.comments.length ? `no ticket; ${m.comments.length} matching comment${m.comments.length > 1 ? "s" : ""}` : "no ticket and no matching comment";
    for (const r of m.rejected) warnings.push(`${item.id}: search candidate ${r.key} "${r.summary}" matched ${r.score}; not used.`);
    matches.push(m);
  }

  // ---------- gaps ----------
  interface Draft {
    m: Match; gap: GapType; strength: Strength; strength_rule: string; case: string; evidence: Evidence[];
    none_found?: { projects: string[]; jql: string[] }; comment?: CommentHit;
  }
  const drafts: Draft[] = [];
  const searchedFor = (team: string | null) => release.projects_searched.filter((p) => p.team.toLowerCase() === (team ?? "").toLowerCase()).map((p) => p.jira_project);
  const jqlFor = (item: PlanItem, projects: string[]) => projects.map((p) => `project = ${p} AND updated >= ${target.release_window.start} AND text ~ "${keywordsFor(item.text, item.owner_team).join(" ")}"`);

  for (const m of matches) {
    const { item, ticket } = m;
    const isService = !!serviceTeam && item.owner_team?.toLowerCase() === serviceTeam.toLowerCase();
    const strengthOf = (): [Strength, string] => {
      if (m.way === "linked_key" || m.way === "linked_keywords") return ["strong", "the plan item matched a ticket in the epic or linked from it"];
      if (m.way === "search") return ["moderate", "the ticket came from a scoped search, not a link"];
      if (m.way === "comment" && ticket) return ["moderate", "the ticket was reached through a comment mention, not a link"];
      return ["moderate", `nothing was found for the item in ${searchedFor(item.owner_team).join(", ") || "any searched project"}`];
    };
    const ticketEv = (t: Ticket): Evidence => ({ key: t.key, text: t.summary, meta: ticketMeta(t, epicKey) });
    const abandonedEv = m.abandoned.map((t) => ({ key: t.key, text: t.summary, meta: ticketMeta(t, epicKey) + " · closed without being done, so not counted" }));
    const commentEv = (c: CommentHit): Evidence => ({ key: c.issue, text: `Comment by ${c.author} (${c.created.slice(0, 10)}): "${c.body}"`, meta: c.promise ? "promise phrase" : c.claim ? "claim phrase" : "mentions the item" });
    const promises = m.comments.filter((c) => c.promise);
    const claims = m.comments.filter((c) => c.claim || c.promise);

    // a) cross-team date: another team's ticket is due after the plan date or after launch
    if (!isService && ticket && ticket.due && ((item.due && ticket.due > item.due) || (launch && ticket.due > launch))) {
      const [strength, rule] = strengthOf();
      drafts.push({ m, gap: "cross_team_date", strength, strength_rule: rule, case: launch && ticket.due > launch ? "cross_team_date_launch" : "cross_team_date_plan", evidence: [ticketEv(ticket)] });
      continue;
    }
    // b) process: approvals and checklist items
    if (item.kind === "approval" || item.kind === "checklist") {
      if (!ticket && !promises.length) {
        const projects = searchedFor(item.owner_team);
        drafts.push({ m, gap: "process", strength: "moderate", strength_rule: strengthOf()[1], case: "process_none_found", evidence: [...abandonedEv, ...m.comments.map(commentEv)], none_found: { projects, jql: jqlFor(item, projects) } });
        continue;
      }
      if (ticket && !isDone(ticket) && (item.kind === "approval" || (item.due && snapshotDate > item.due) || (ticket.due && item.due && ticket.due > item.due))) {
        const [strength, rule] = strengthOf();
        drafts.push({ m, gap: "process", strength, strength_rule: rule, case: item.kind === "approval" ? "process_open_approval" : "process_open_checklist", evidence: [ticketEv(ticket)] });
        continue;
      }
    }
    // c) commitment: promised in a comment with no ticket (moderate), or claimed in a comment while the ticket is open (weak)
    if (!ticket && promises.length) {
      const projects = searchedFor(item.owner_team);
      drafts.push({ m, gap: "commitment", strength: "moderate", strength_rule: "no ticket was found; the promise exists only in a comment", case: "commitment_none_found", evidence: [commentEv(promises[0]), ...abandonedEv], none_found: { projects, jql: jqlFor(item, projects) }, comment: promises[0] });
      continue;
    }
    if (ticket && !isDone(ticket) && claims.length) {
      drafts.push({ m, gap: "commitment", strength: "weak", strength_rule: "comment text only: the ticket is still open and only a comment says the item is handled", case: "commitment_claim_only", evidence: [commentEv(claims[claims.length - 1]), ticketEv(ticket)], comment: claims[claims.length - 1] });
      continue;
    }
  }

  // ---------- order, ids, next actions ----------
  const rank: Record<Strength, number> = { strong: 0, moderate: 1, weak: 2 };
  drafts.sort((a, b) => rank[a.strength] - rank[b.strength] || (a.m.item.due ?? "9999").localeCompare(b.m.item.due ?? "9999") || a.m.item.id.localeCompare(b.m.item.id, undefined, { numeric: true }));

  const byWhen = (item: PlanItem): string => {
    if (item.due && goNoGo && goNoGo < item.due) return `before go/no-go (${goNoGo})`;
    if (item.due) return item.due;
    if (goNoGo) return `before go/no-go (${goNoGo})`;
    return launch ? `before launch (${launch})` : "before launch";
  };

  const findings: Finding[] = [];
  let shownCount = 0;
  drafts.forEach((d, i) => {
    const { m } = d;
    const item = m.item;
    const t = m.ticket;
    const owner = item.owner_team ?? "unassigned";
    const person = personOf(item.owner_team);
    const vars = {
      item: item.text, key: t?.key ?? "", ticket_status: t?.status ?? "", ticket_due: t?.due ?? "none", plan_date: item.due ?? "no plan date",
      launch_date: launch ?? "", go_no_go: goNoGo ?? "", epic: epicKey, owner, person, projects: (d.none_found?.projects.join(", ") || "the searched projects"),
      commenter: d.comment?.author ?? "", comment_issue: d.comment?.issue ?? "", by_when: byWhen(item), deadline: /^\d{4}-\d{2}-\d{2}$/.test(byWhen(item)) ? `no later than ${byWhen(item)}` : byWhen(item),
    };
    const title = fill(templates.titles[d.case] ?? d.case, vars);
    const action = fill(templates.actions[d.case] ?? d.case, vars);
    const weak = d.strength === "weak";
    const shown = !weak && shownCount < cap;
    if (shown) shownCount++;
    findings.push({
      id: `f${i + 1}`,
      title,
      gap_type: d.gap,
      strength: d.strength,
      strength_rule: d.strength_rule,
      owner,
      owner_source: teamListGiven ? "team_list" : "jira_inferred",
      plan_item_id: item.id,
      plan_quote: item.source.quote,
      plan_source: item.source,
      match_way: m.way,
      evidence: d.evidence,
      ...(d.none_found ? { none_found: d.none_found } : {}),
      why: title,
      next_action: { action, who: teamListGiven ? (person ? `${owner} · ${person}` : owner) : `${owner} (owner inferred)`, by_when: byWhen(item), why: title },
      shown,
      hidden_by_default: weak,
      ask: action,
    });
  });

  // ---------- linkage gaps (R13) ----------
  const gaps: LinkageGap[] = [];
  const seen = new Set<string>();
  const findingOf = new Map(findings.map((f) => [f.plan_item_id, f]));
  const addGap = (from: string, to: Ticket, how: LinkageGap["how"], finding: Finding | null) => {
    if (linkedKeys.has(to.key) || seen.has(`${from}>${to.key}`)) return;
    seen.add(`${from}>${to.key}`);
    const otherTeam = !serviceTeam || (teamOfProject.get(to.project) ?? "").toLowerCase() !== serviceTeam.toLowerCase();
    const suggested_type = otherTeam ? "is blocked by" : "relates to";
    const g: LinkageGap = { id: "", from, to: to.key, to_summary: to.summary, how, suggested_type, finding_id: finding?.id ?? null };
    if (finding) finding.linkage = { from, to: to.key, suggested_type };
    gaps.push(g);
  };
  for (const m of matches) {
    if (!m.ticket) continue;
    if (m.ticket.reach === "search") addGap(epicKey, m.ticket, "search_match", findingOf.get(m.item.id) ?? null);
    if (m.ticket.reach === "comment_mention") addGap(m.ticket.via!, m.ticket, "comment_mention", findingOf.get(m.item.id) ?? null);
  }
  for (const t of tickets.values()) if (t.reach === "comment_mention") addGap(t.via!, t, "comment_mention", null);
  gaps.sort((a, b) => (a.finding_id ? 0 : 1) - (b.finding_id ? 0 : 1) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  gaps.forEach((g, i) => { g.id = `lg${i + 1}`; });

  const itemMatches: ItemMatch[] = matches.map((m) => ({ plan_item_id: m.item.id, way: m.way, key: m.ticket?.key ?? null, score: m.score, note: m.note }));

  return Findings.parse({
    schema_version: 1,
    snapshot_label: release.snapshot_label,
    snapshot_date: snapshotDate,
    analyzed_at: opts.analyzedAt ?? new Date().toISOString(),
    epic: epicKey,
    launch_date: launch,
    go_no_go: goNoGo,
    service_team: serviceTeam,
    team_list_given: teamListGiven,
    findings,
    linkage_gaps: gaps,
    matches: itemMatches,
    warnings,
  });
}
