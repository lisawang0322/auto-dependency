/**
 * throughline-status: one row per team, one line per plan item, from the reader's and analyzer's files.
 * Every value here is a rule; nothing is rated. Same input, same output.
 *
 *   result per item   late  = a cross-team date finding on the item
 *                     gap   = any other non-weak finding
 *                     weak  = a weak finding
 *                     ok    = no finding
 *   team status       late if any item is late, at_risk if any is a gap, else on_track
 *   change_note       what moved since the previous run for the tickets behind this team's items
 */
import type { PlanDraft, ReleaseTarget, Release, Findings, Finding, Team, TeamItem, Status } from "@throughline/schemas";

export interface StatusOptions {
  plan: PlanDraft;
  target: ReleaseTarget;
  release: Release;
  findings: Findings;
  /** The previous run, for change notes. */
  previous?: { release: Release; teams: Team[]; snapshot_label: string } | null;
}

interface TicketFact { key: string; status: string; resolution: string | null; due: string | null; reach: "epic" | "story" | "link" | "comment_mention" | "search" }

const DONE = new Set(["done", "closed", "resolved", "released", "complete", "completed"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string | null): string {
  if (!iso) return "none";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
}

export function daysBetween(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86_400_000);
}

export function ticketIndex(release: Release): Map<string, TicketFact> {
  const m = new Map<string, TicketFact>();
  m.set(release.epic.key, { key: release.epic.key, status: release.epic.status, resolution: null, due: release.epic.due, reach: "epic" });
  for (const s of release.stories) m.set(s.key, { key: s.key, status: s.status, resolution: s.resolution ?? null, due: s.due, reach: "story" });
  for (const r of release.related) if (!m.has(r.key)) m.set(r.key, { key: r.key, status: r.status, resolution: r.resolution ?? null, due: r.due, reach: r.reached_by === "link" ? "link" : "comment_mention" });
  for (const c of release.search_candidates) if (!m.has(c.key)) m.set(c.key, { key: c.key, status: c.status, resolution: c.resolution ?? null, due: c.due, reach: "search" });
  return m;
}

function isDone(t: TicketFact): boolean { return DONE.has(t.status.toLowerCase()); }
/** A resolution worth showing next to the status: anything but the plain "done" ones. */
function oddResolution(t: TicketFact): boolean { return !!t.resolution && !["done", "fixed", "resolved"].includes(t.resolution.toLowerCase()); }

function capitalize(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function resultOf(f: Finding | undefined): TeamItem["result"] {
  if (!f) return "ok";
  if (f.strength === "weak") return "weak";
  if (f.gap_type === "cross_team_date") return "late";
  return "gap";
}

function noteOf(f: Finding | undefined, item: PlanDraft["items"][number], ticket: TicketFact | undefined, launch: string | null, linkageGap: boolean): string {
  if (!f) {
    const base = ticket && isDone(ticket) ? "Done" : "On track";
    return linkageGap ? `${base} · linkage gap` : base;
  }
  if (f.strength === "weak") return "Weak evidence";
  if (f.gap_type === "cross_team_date" && ticket?.due) {
    if (launch && ticket.due > launch) return `Due ${daysBetween(launch, ticket.due)} days after launch`;
    if (item.due) return `Due ${daysBetween(item.due, ticket.due)} days after the plan date`;
    return "Due after the plan date";
  }
  if (f.evidence.length === 0 || f.none_found) return "No ticket";
  if (f.gap_type === "process") return item.kind === "approval" ? "Approval still open" : "Not done";
  return "Open";
}

function ticketStatusOf(ticket: TicketFact | undefined, f: Finding | undefined, release: Release, matchWay: string | undefined, matchScore: string): string {
  if (!ticket) {
    if (matchWay === "comment") { const m = matchScore.match(/comment on ([A-Z][A-Z0-9]+-\d+)/); return m ? `Promised in a comment on ${m[1]}` : "Promised in a comment"; }
    return "No ticket found";
  }
  if (ticket.reach === "epic") {
    const done = release.stories.filter((s) => DONE.has(s.status.toLowerCase())).length;
    return `${ticket.status} · ${done} of ${release.stories.length} stories done`;
  }
  const qualifier = f?.strength === "weak" ? "comment only" : ticket.reach === "story" ? "in the epic" : ticket.reach === "link" ? "linked" : "not linked to epic";
  const res = oddResolution(ticket) ? ` (${ticket.resolution})` : "";
  return `${ticket.status}${res} · ${qualifier}`;
}

export function computeStatus(opts: StatusOptions): Status {
  const { plan, target, release, findings } = opts;
  const warnings: string[] = [];
  const tickets = ticketIndex(release);
  const prevTickets = opts.previous ? ticketIndex(opts.previous.release) : null;
  const findingByItem = new Map<string, Finding>();
  for (const f of findings.findings) if (!findingByItem.has(f.plan_item_id)) findingByItem.set(f.plan_item_id, f);
  const matchByItem = new Map(findings.matches.map((m) => [m.plan_item_id, m]));
  const linkageTargets = new Set(findings.linkage_gaps.filter((g) => !g.finding_id).map((g) => g.to));
  const serviceProject = release.epic.key.slice(0, release.epic.key.lastIndexOf("-"));

  const projects = target.projects.filter((p) => p.jira_project);
  for (const p of target.projects) if (!p.jira_project) warnings.push(`${p.team}: no Jira project resolved, so it has no status row; its plan items are listed under the service team.`);
  const teamOf = (item: PlanDraft["items"][number]) => {
    const owner = (item.owner_team ?? "").toLowerCase();
    return projects.find((p) => p.team.toLowerCase() === owner) ?? projects.find((p) => p.jira_project === serviceProject) ?? projects[0];
  };

  const teams: Team[] = projects.map((p) => {
    const planTeam = plan.teams.find((t) => t.name.toLowerCase() === p.team.toLowerCase());
    const role = planTeam?.role ? capitalize(planTeam.role) : p.jira_project === serviceProject ? "Service team" : "";
    const items: TeamItem[] = plan.items.filter((i) => teamOf(i) === p).map((item) => {
      const f = findingByItem.get(item.id);
      const m = matchByItem.get(item.id);
      const ticket = m?.key ? tickets.get(m.key) : undefined;
      const result = resultOf(f);
      return {
        plan_item_id: item.id,
        text: item.text,
        ticket: ticket?.key ?? null,
        ticket_status: ticketStatusOf(ticket, f, release, m?.way, m?.score ?? ""),
        plan_due: item.due,
        jira_due: ticket?.due ?? null,
        result,
        note: noteOf(f, item, ticket, findings.launch_date, !!ticket && linkageTargets.has(ticket.key)),
        finding_id: f?.id ?? null,
      };
    });
    const status: Team["status"] = items.some((i) => i.result === "late") ? "late" : items.some((i) => i.result === "gap") ? "at_risk" : "on_track";
    return { team: p.team, project_key: p.jira_project!, role, status, items, change_note: opts.previous ? changeNote(items, opts.previous.teams.find((t) => t.team === p.team) ?? null, tickets, prevTickets!) : "" };
  });

  return {
    schema_version: 1,
    snapshot_label: release.snapshot_label,
    epic: release.epic.key,
    compared_with: opts.previous?.snapshot_label ?? null,
    teams,
    warnings: [...warnings, ...findings.warnings.filter((w) => w.startsWith("status:"))],
  };
}

/** What moved for this team's tickets since the previous run. */
export function changeNote(items: TeamItem[], prevTeam: Team | null, now: Map<string, TicketFact>, before: Map<string, TicketFact>): string {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const prevItem = prevTeam?.items.find((p) => p.plan_item_id === it.plan_item_id) ?? null;
    const key = it.ticket ?? prevItem?.ticket ?? null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const a = before.get(key), b = now.get(key);
    if (a && b) {
      if (a.status !== b.status) notes.push(oddResolution(b) ? `${key} moved to ${b.status} (${b.resolution})` : `${key} moved to ${b.status}`);
      if ((a.due ?? null) !== (b.due ?? null)) notes.push(`${key} due date moved ${fmtDate(a.due)} → ${fmtDate(b.due)}`);
    }
    if (prevItem?.ticket && !it.ticket) notes.push(`${prevItem.ticket} no longer counts for "${it.text}"; ${it.ticket_status[0].toLowerCase()}${it.ticket_status.slice(1)}`);
    if (!prevItem?.ticket && it.ticket && prevItem) notes.push(`${it.ticket} now covers "${it.text}"`);
  }
  return notes.join("; ");
}
