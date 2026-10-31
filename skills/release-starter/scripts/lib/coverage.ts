/**
 * Building (PRD R18): are the teams the plan needs actually on the Jira work, and which approvals
 * have a ticket and an owner? Works from Stage C's release.json plus one scoped search per approval,
 * through the same JiraSource as the reader (fixture, MCP cache or REST), so Jira is only read.
 */
import type { Release, ReleaseTarget, TeamToInvolve, ApprovalNeeded, TeamCoverage, ApprovalStatus, StarterAction, CoverageState, ApprovalState } from "@rrr/schemas";
import type { JiraSource } from "../../../release-reader/scripts/lib/jira-source.js";
import { scopedSearchJql } from "../../../release-reader/scripts/lib/jql.js";
import { projectOf } from "../../../release-reader/scripts/lib/keys.js";
import { isDone } from "../../../release-analyzer/scripts/lib/analyze.js";
import { fill } from "../../../release-analyzer/scripts/lib/text.js";
import { contactFor, findTeam, teamOfPerson, type DirectoryEntry } from "./directory.js";
import type { SignalRules, RuleApproval } from "./config.js";
import { whoFor } from "./starter.js";

const JOINERS = new Set(["and", "or", "of", "the", "for", "to", "a", "an"]);

export interface Ticket { key: string; project: string; summary: string; status: string; resolution?: string | null; assignee: string | null; due: string | null; how: string }

/** Every ticket Stage C saw, deduplicated, with how it was reached. */
export function ticketsOf(release: Release): Ticket[] {
  const out = new Map<string, Ticket>();
  const put = (t: Ticket) => { if (!out.has(t.key)) out.set(t.key, t); };
  put({ key: release.epic.key, project: projectOf(release.epic.key), summary: release.epic.summary, status: release.epic.status, assignee: null, due: release.epic.due, how: "epic" });
  for (const s of release.stories) put({ key: s.key, project: projectOf(s.key), summary: s.summary, status: s.status, resolution: s.resolution, assignee: s.assignee, due: s.due, how: "in the epic" });
  for (const r of release.related) put({ key: r.key, project: r.project, summary: r.summary, status: r.status, resolution: r.resolution, assignee: r.assignee, due: r.due, how: r.reached_by === "link" ? "linked" : "mentioned in a comment" });
  for (const c of release.search_candidates) put({ key: c.key, project: c.project, summary: c.summary, status: c.status, resolution: c.resolution, assignee: c.assignee, due: c.due, how: "found by search" });
  return [...out.values()];
}

export function approvalRules(rules: SignalRules): Map<string, RuleApproval> {
  const m = new Map<string, RuleApproval>();
  for (const r of rules.rules) for (const a of r.approvals ?? []) if (!m.has(a.name)) m.set(a.name, a);
  return m;
}

/** Projects to look in for an approval: its team's resolved project, else the epic's own project. */
function approvalProjects(a: ApprovalNeeded, target: ReleaseTarget, directory: DirectoryEntry[]): string[] {
  const resolved = target.projects.find((p) => p.team.toLowerCase() === a.team.toLowerCase())?.jira_project ?? findTeam(directory, a.team)?.project ?? null;
  const epicProject = projectOf(target.epic.key);
  return resolved && resolved !== epicProject ? [resolved, epicProject] : [epicProject];
}

/** One scoped search per approval and project (Jira only read). undefined = a read is still pending (MCP mode). */
export function readApprovalTickets(opts: { source: JiraSource; target: ReleaseTarget; approvals: ApprovalNeeded[]; rules: SignalRules; directory: DirectoryEntry[]; cap?: number }): { hits: Record<string, Ticket[]>; searched: Record<string, string[]>; warnings: string[] } | undefined {
  const rulesByName = approvalRules(opts.rules);
  const hits: Record<string, Ticket[]> = {};
  const searched: Record<string, string[]> = {};
  const warnings: string[] = [];
  for (const a of opts.approvals) {
    const rule = rulesByName.get(a.name);
    // Search terms: the keyword phrases' words, minus joiners (a bare "and" would split the JQL).
    const terms = [...new Set((rule?.keywords ?? [a.name.toLowerCase()]).flatMap((k) => k.toLowerCase().split(/\s+/)))].filter((t) => t.length > 1 && !JOINERS.has(t));
    const projects = approvalProjects(a, opts.target, opts.directory);
    hits[a.name] = [];
    searched[a.name] = projects;
    for (const project of projects) {
      const jql = scopedSearchJql(project, opts.target.release_window.start, terms);
      const raw = opts.source.search(jql, opts.cap ?? 50);
      if (raw === undefined) return undefined;
      if (raw === null) { warnings.push(`${a.name}: search failed: ${jql}`); continue; }
      for (const i of raw) hits[a.name].push({ key: i.key, project: i.fields.project?.key ?? projectOf(i.key), summary: i.fields.summary, status: i.fields.status?.name ?? "", resolution: i.fields.resolution?.name ?? null, assignee: i.fields.assignee?.displayName ?? null, due: i.fields.duedate ?? null, how: "found by search" });
    }
  }
  return { hits, searched, warnings };
}

/** The approval's ticket: a summary that contains one of its keyword phrases; an open one beats a done one. */
export function pickApprovalTicket(candidates: Ticket[], rule: RuleApproval | undefined, name: string): Ticket | null {
  const phrases = (rule?.keywords ?? [name]).map((k) => k.toLowerCase());
  const matching = candidates.filter((t) => { const s = t.summary.toLowerCase(); return phrases.some((p) => s.includes(p)); });
  const open = matching.filter((t) => !isDone(t));
  return open[0] ?? matching[0] ?? null;
}

export interface CoverageInput {
  needed: TeamToInvolve[];
  approvals: ApprovalNeeded[];
  release: Release;
  target: ReleaseTarget;
  directory: DirectoryEntry[];
  rules: SignalRules;
  approvalHits: Record<string, Ticket[]>;
  searched: Record<string, string[]>;
}
export interface CoverageResult { coverage: TeamCoverage[]; approval_status: ApprovalStatus[]; next_actions: StarterAction[]; warnings: string[] }

export function coverage(input: CoverageInput): CoverageResult {
  const warnings: string[] = [];
  const tickets = ticketsOf(input.release);
  const extra = Object.values(input.approvalHits).flat();
  for (const t of extra) if (!tickets.some((x) => x.key === t.key)) tickets.push(t);
  const projectTeam = new Map<string, string>();
  for (const p of input.target.projects) if (p.jira_project) projectTeam.set(p.jira_project, p.team.toLowerCase());
  for (const e of input.directory) if (e.project && !projectTeam.has(e.project)) projectTeam.set(e.project, e.name.toLowerCase());
  // A team Stage B could not resolve (two plausible projects) still counts as on the work when the epic links to a
  // ticket in one of its candidate projects; a search hit there does not count, since the project is unconfirmed.
  const candidateTeam = new Map<string, string>();
  for (const p of input.target.projects) if (!p.jira_project) for (const c of p.candidates) if (!projectTeam.has(c.key) && !candidateTeam.has(c.key)) candidateTeam.set(c.key, p.team.toLowerCase());
  const epicProject = projectOf(input.target.epic.key);

  const coverageRows: TeamCoverage[] = input.needed.map((n) => {
    const key = n.team.toLowerCase();
    const dirEntry = findTeam(input.directory, n.team);
    const mine = tickets.filter((t) => {
      if (t.how === "epic") return false;
      const byPerson = teamOfPerson(input.directory, t.assignee);
      if (byPerson && byPerson === dirEntry) return true;
      if (t.project !== epicProject && projectTeam.get(t.project) === key) return true;
      if (t.how === "linked" && candidateTeam.get(t.project) === key) return true;
      return false;
    });
    const withPeople = mine.filter((t) => t.assignee);
    const people = [...new Set(withPeople.map((t) => t.assignee!))];
    let state: CoverageState, found: string;
    if (withPeople.length) {
      state = "covered";
      found = `${withPeople.slice(0, 3).map((t) => `${t.key} ${t.how}`).join(", ")} · ${people.join(", ")}`;
    } else if (mine.length) {
      state = "unclear";
      found = `${mine[0].key} "${mine[0].summary}" exists but has no assignee`;
    } else {
      state = "missing";
      found = dirEntry || projectTeam.has(key) ? `No one from ${n.team} on any ticket — ${n.why}` : `No one from ${n.team} on any ticket, and the directory does not list that team — ${n.why}`;
    }
    return { team: n.team, state, found, people, tickets: mine.map((t) => t.key), contact: contactFor(input.directory, n.team), signal_ids: n.signal_ids };
  });
  // The epic's own team is the one doing the work; unassigned tickets in its project make a needed team "unclear"
  // only when they match that team's approval, which the approval rows cover.

  const rulesByName = approvalRules(input.rules);
  const approval_status: ApprovalStatus[] = input.approvals.map((a) => {
    const rule = rulesByName.get(a.name);
    const t = pickApprovalTicket([...(input.approvalHits[a.name] ?? []), ...tickets], rule, a.name);
    let state: ApprovalState, detail: string;
    if (!t) { state = "not_started"; detail = `No ticket found in ${(input.searched[a.name] ?? [epicProject]).join(", ")}`; }
    else if (isDone(t)) { state = "done"; detail = `${t.key} · ${t.status}${t.assignee ? " · " + t.assignee : ""}`; }
    else if (!t.assignee) { state = "no_owner"; detail = `${t.key} "${t.summary}" has no assignee`; }
    else { state = "started"; detail = `${t.key} · ${t.status}${t.due ? " · due " + t.due : ""} · ${t.assignee}`; }
    return { name: a.name, team: a.team, state, detail, ticket: t?.key ?? null, signal_ids: a.signal_ids };
  });

  const tpl = input.rules.coverage;
  const next_actions: StarterAction[] = [];
  const push = (team: string, text: string, when: string, why: string, signal_ids: string[]) =>
    next_actions.push({ id: `b${next_actions.length + 1}`, team, text, who: whoFor(input.directory, team), when, why, signal_ids });
  for (const c of coverageRows) {
    const need = input.needed.find((n) => n.team === c.team)!;
    if (c.state === "missing") push(c.team, fill(tpl.team_missing, { team: c.team, why: need.why.replace(/\.$/, "") }), tpl.team_missing_when, "missing team", c.signal_ids);
    else if (c.state === "unclear") { const t = tickets.find((x) => x.key === c.tickets[0])!; push(c.team, fill(tpl.team_unclear, { team: c.team, key: t.key, summary: t.summary }), tpl.team_unclear_when, "no owner on the work", c.signal_ids); }
  }
  for (const a of approval_status) {
    const t = a.ticket ? tickets.find((x) => x.key === a.ticket) : null;
    if (a.state === "not_started") push(a.team, fill(tpl.approval_not_started, { approval: a.name, why: a.detail === "" ? "" : input.approvals.find((x) => x.name === a.name)!.why.toLowerCase(), projects: (input.searched[a.name] ?? [epicProject]).join(", ") }), tpl.approval_not_started_when, "approval not started", a.signal_ids);
    else if (a.state === "no_owner" && t) push(a.team, fill(tpl.approval_no_owner, { approval: a.name, key: t.key, summary: t.summary }), tpl.approval_no_owner_when, "approval has no owner", a.signal_ids);
  }
  return { coverage: coverageRows, approval_status, next_actions, warnings };
}
