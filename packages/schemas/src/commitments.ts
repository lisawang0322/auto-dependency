/**
 * Commitments: one running list per project that every stage shares (PRD "Commitments: one list the stages
 * share"). A review proposes teams and approvals; the list keeps each one from the stage it was first written
 * down in to launch, with its sources, ticket, state, the PM's decision and a line per review that changed it.
 *
 * This first slice carries teams and approvals. Everything here is pure: the GUI merges after each review and
 * saves the list with the project, which writes it to commitments.yaml. Items are never deleted, and a review
 * that changes nothing adds nothing, so a refresh with no new files leaves the list as it was.
 */
import { z } from "zod";
import type { Starter, Run, Finding } from "./index.js";

export const CommitmentKind = z.enum(["team", "approval"]);
export type CommitmentKind = z.infer<typeof CommitmentKind>;
export const CommitmentState = z.enum(["proposed", "open", "tracked", "done", "dropped"]);
export type CommitmentState = z.infer<typeof CommitmentState>;
export const CommitmentStage = z.enum(["starting", "building", "launching"]);
export type CommitmentStage = z.infer<typeof CommitmentStage>;

export const CommitmentSource = z.object({ file: z.string(), locator: z.string(), quote: z.string() });
export type CommitmentSource = z.infer<typeof CommitmentSource>;

export const Commitment = z.object({
  /** Stable for the project's life; never reused. */
  id: z.string(),
  kind: CommitmentKind,
  /** The promise in plain words: the approval's name, or the team to involve. */
  what: z.string(),
  team: z.string(),
  /** Why the plan needs it, as the review that found it said. */
  why: z.string().nullable(),
  first_seen: z.object({ stage: CommitmentStage, at: z.string(), file: z.string().nullable(), locator: z.string().nullable() }),
  sources: z.array(CommitmentSource),
  ticket: z.object({ key: z.string(), how: z.string() }).nullable(),
  state: CommitmentState,
  /** What the latest review that looked at it flagged; empty when nothing is wrong. */
  flags: z.array(z.string()),
  /** The PM's call; it holds across reviews until the PM changes it. */
  decision: z.object({ kind: z.enum(["kept", "dropped"]), reason: z.string(), at: z.string(), stage: CommitmentStage }).nullable(),
  history: z.array(z.object({ at: z.string(), stage: CommitmentStage, text: z.string() })),
});
export type Commitment = z.infer<typeof Commitment>;

/** The flag on an item an earlier stage named and the launch plan (POR and checklist) does not. */
export const NOT_IN_PLAN = "not in the launch plan";

export interface MergeResult { list: Commitment[]; added: number; changed: number }

const STOP = new Set(["review", "reviews", "approved", "approval", "sign", "off", "signoff", "the", "a", "an", "of", "for", "and", "team", "check", "done"]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const day = (at: string) => at.slice(0, 10);

function nextId(list: Commitment[]): string {
  const n = list.reduce((m, c) => Math.max(m, Number(c.id.replace(/^c-/, "")) || 0), 0) + 1;
  return `c-${String(n).padStart(3, "0")}`;
}

/** The existing item a proposal is the same commitment as: same kind and team, and for approvals either the
 *  team's only approval or one that shares a word with it ("Security review" ↔ "Security review approved").
 *  Anything weaker is a new item; the PM can drop it. */
export function findMatch(list: Commitment[], kind: CommitmentKind, team: string, what: string): Commitment | null {
  const same = list.filter((c) => c.kind === kind && norm(c.team) === norm(team));
  if (kind === "team") return same[0] ?? null;
  const exact = same.find((c) => norm(c.what) === norm(what));
  if (exact) return exact;
  const w = words(what);
  const sharing = same.filter((c) => [...words(c.what)].some((x) => w.has(x)));
  if (sharing.length === 1) return sharing[0];
  if (same.length === 1 && w.size === 0) return same[0];
  return sharing[0] ?? null;
}

interface Proposal { kind: CommitmentKind; team: string; what: string; why: string | null; sources: CommitmentSource[] }
interface Update { state?: CommitmentState; ticket?: Commitment["ticket"]; flags?: string[]; note?: string }

/** Applies one review's proposals and updates to the list. A dropped item keeps its state; done stays done
 *  unless a review finds it open again. History gets a line only when state, ticket or flags change. */
function apply(list: Commitment[], stage: CommitmentStage, at: string, proposals: Proposal[], updates: (c: Commitment) => Update | null): MergeResult {
  const out = list.map((c) => ({ ...c, sources: [...c.sources], flags: [...c.flags], history: [...c.history] }));
  let added = 0, changed = 0;
  const touched = new Set<string>();
  for (const p of proposals) {
    let c = findMatch(out, p.kind, p.team, p.what);
    if (!c) {
      const first = p.sources[0] ?? null;
      c = {
        id: nextId(out), kind: p.kind, what: p.what, team: p.team, why: p.why,
        first_seen: { stage, at: day(at), file: first?.file ?? null, locator: first?.locator ?? null },
        sources: [], ticket: null, state: "open", flags: [], decision: null,
        history: [{ at: day(at), stage, text: `Added: ${p.kind === "team" ? `involve ${p.team}` : p.what}${first ? ` (${first.file} ${first.locator})` : ""}` }],
      };
      out.push(c);
      added++;
    }
    for (const s of p.sources) if (!c.sources.some((x) => x.file === s.file && x.locator === s.locator && x.quote === s.quote)) c.sources.push(s);
    touched.add(c.id);
  }
  for (const c of out) {
    const u = updates(c);
    if (!u) continue;
    const before = JSON.stringify([c.state, c.ticket, c.flags]);
    if (u.ticket !== undefined && u.ticket) c.ticket = u.ticket;
    if (u.flags) c.flags = u.flags;
    if (u.state && c.state !== "dropped") c.state = u.state;
    if (JSON.stringify([c.state, c.ticket, c.flags]) !== before) {
      changed++;
      c.history.push({ at: day(at), stage, text: u.note ?? describe(c) });
    }
  }
  return { list: out, added, changed };
}

function describe(c: Commitment): string {
  const s = { proposed: "proposed", open: "open", tracked: "tracked", done: "done", dropped: "dropped" }[c.state];
  return [c.ticket ? `${s}, ${c.ticket.key}` : s, ...c.flags].join("; ");
}

/** After a starting or building review: its teams and approvals (only those whose signals the PM kept) join
 *  the list; building also records each team's coverage and each approval's ticket and state in Jira. */
export function fromStarter(list: Commitment[], st: Starter, signalsOff: Record<string, boolean>, at: string = st.analyzed_at): MergeResult {
  const stage: CommitmentStage = st.stage === "building" ? "building" : "starting";
  const on = (ids: string[]) => ids.length === 0 || ids.some((id) => !signalsOff[id]);
  const sig = new Map(st.signals.map((g) => [g.id, g]));
  const srcOf = (ids: string[]) => ids.map((id) => sig.get(id)).filter((g): g is NonNullable<typeof g> => !!g && !signalsOff[g.id]).map((g) => ({ file: g.file, locator: g.locator, quote: g.quote }));
  const proposals: Proposal[] = [
    ...st.teams.filter((t) => on(t.signal_ids)).map((t) => ({ kind: "team" as const, team: t.team, what: `Involve ${t.team}`, why: t.why, sources: srcOf(t.signal_ids) })),
    ...st.approvals.filter((a) => on(a.signal_ids)).map((a) => ({ kind: "approval" as const, team: a.team, what: a.name, why: a.why, sources: srcOf(a.signal_ids) })),
  ];
  if (stage === "starting") return apply(list, stage, at, proposals, () => null);
  const coverage = st.coverage.filter((c) => on(c.signal_ids));
  const approvals = st.approval_status.filter((a) => on(a.signal_ids));
  return apply(list, stage, at, proposals, (c) => {
    if (c.kind === "team") {
      const cov = coverage.find((x) => norm(x.team) === norm(c.team));
      if (!cov) return null;
      return cov.state === "covered" ? { state: "tracked", flags: [] } : { state: "open", flags: [cov.state === "missing" ? "not on the Jira work yet" : "unclear whether on the Jira work"] };
    }
    const a = approvals.find((x) => norm(x.team) === norm(c.team) && findMatch([c], "approval", x.team, x.name));
    if (!a) return null;
    const ticket = a.ticket ? { key: a.ticket, how: "found by search" } : null;
    if (a.state === "done") return { state: "done", ticket, flags: [] };
    const flags = a.state === "no_owner" ? ["no owner"] : a.state === "not_started" ? ["not started"] : [];
    return { state: ticket ? "tracked" : "open", ticket, flags };
  });
}

/** After a launch review: the POR's teams and approval items join the list (most match what the earlier stages
 *  found); each approval takes its finding's ticket and title as a flag, and one with no finding is done. A team or
 *  approval an earlier stage named that the launch plan leaves out is flagged: dropped silently is how it gets lost.
 *  Returns, with the merge, which commitment each finding is about. */
export function fromLaunch(list: Commitment[], run: Pick<Run, "plan" | "findings" | "teams">, at: string): MergeResult & { byFinding: Record<string, string> } {
  const items = run.plan.items.filter((i) => i.kind === "approval" && i.owner_team);
  const proposals: Proposal[] = [
    ...run.plan.teams.map((t) => ({ kind: "team" as const, team: t.name, what: `Involve ${t.name}`, why: null, sources: [] })),
    ...items.map((i) => ({ kind: "approval" as const, team: i.owner_team!, what: i.text, why: null, sources: [{ file: i.source.file, locator: i.source.locator, quote: i.source.quote }] })),
  ];
  // Which commitment each approval item is, worked out against the list as it will stand after the proposals.
  const itemOf = new Map<string, string>(); // plan item id → commitment id
  const merged = apply(list, "launching", at, proposals, () => null);
  for (const i of items) { const c = findMatch(merged.list, "approval", i.owner_team!, i.text); if (c) itemOf.set(i.id, c.id); }
  const findingOf = new Map<string, Finding>();
  for (const f of run.findings) if (itemOf.has(f.plan_item_id) && !findingOf.has(itemOf.get(f.plan_item_id)!)) findingOf.set(itemOf.get(f.plan_item_id)!, f);
  const statusOf = new Map(run.teams.map((t) => [norm(t.team), t.status]));
  const approvalIds = new Set(itemOf.values());
  const inPlan = new Set(proposals.map((p) => findMatch(merged.list, p.kind, p.team, p.what)?.id).filter(Boolean));
  const final = apply(merged.list, "launching", at, [], (c) => {
    if (!inPlan.has(c.id)) return c.state === "open" || c.state === "tracked" ? { flags: [NOT_IN_PLAN, ...c.flags.filter((f) => f !== NOT_IN_PLAN)] } : null;
    if (c.kind === "team") {
      const s = statusOf.get(norm(c.team));
      if (!s) return null;
      return { state: "tracked", flags: s === "late" ? ["late for launch"] : s === "at_risk" ? ["at risk for launch"] : [] };
    }
    if (!approvalIds.has(c.id)) return null;
    const f = findingOf.get(c.id);
    if (!f) return { state: "done", flags: [] };
    const key = f.evidence.find((e) => e.key)?.key ?? null;
    return { state: key ? "tracked" : "open", ticket: key ? { key, how: "linked in Jira" } : undefined, flags: [f.title] };
  });
  const byFinding: Record<string, string> = {};
  for (const f of run.findings) { const id = itemOf.get(f.plan_item_id); if (id) byFinding[f.id] = id; }
  return { list: final.list, added: merged.added, changed: merged.changed + final.changed, byFinding };
}

/** Which commitment each of a run's findings is about, without changing the list (for showing a review). */
export function linkFindings(list: Commitment[], run: Pick<Run, "plan" | "findings">): Record<string, Commitment> {
  const out: Record<string, Commitment> = {};
  for (const f of run.findings) {
    const i = run.plan.items.find((x) => x.id === f.plan_item_id);
    if (!i || i.kind !== "approval" || !i.owner_team) continue;
    const c = findMatch(list, "approval", i.owner_team, i.text);
    if (c) out[f.id] = c;
  }
  return out;
}

/** The PM's call on one item: dropped (with a reason, never proposed again) or kept; reopen clears it. */
export function decide(list: Commitment[], id: string, kind: "kept" | "dropped" | "reopen", reason: string, stage: CommitmentStage, at: string): Commitment[] {
  return list.map((c) => {
    if (c.id !== id) return c;
    if (kind === "reopen") {
      if (!c.decision) return c;
      const state: CommitmentState = c.state === "dropped" ? (c.ticket ? "tracked" : "open") : c.state;
      return { ...c, state, decision: null, history: [...c.history, { at: day(at), stage, text: "Reopened by the PM" }] };
    }
    if (c.decision?.kind === kind && c.decision.reason === reason) return c;
    return {
      ...c, state: kind === "dropped" ? "dropped" : c.state, decision: { kind, reason, at: day(at), stage },
      history: [...c.history, { at: day(at), stage, text: kind === "dropped" ? `Dropped by the PM: ${reason}` : "Kept by the PM" }],
    };
  });
}

/** Counts for the overview: open (open or tracked), at risk (open or tracked with a flag), done, dropped. */
export function counts(list: Commitment[]): { open: number; atRisk: number; done: number; dropped: number } {
  const live = list.filter((c) => c.state === "open" || c.state === "tracked" || c.state === "proposed");
  return { open: live.length, atRisk: live.filter((c) => c.flags.length > 0).length, done: list.filter((c) => c.state === "done").length, dropped: list.filter((c) => c.state === "dropped").length };
}

const STAGE_WORD: Record<CommitmentStage, string> = { starting: "Starting", building: "Building", launching: "Launch" };
/** "Starting · ingestion-service-PRD.md §2 Scope · Nov 13": where an item was first written down. */
export function firstSeenLabel(c: Commitment, fmt: (iso: string) => string = (s) => s): string {
  return [STAGE_WORD[c.first_seen.stage], c.first_seen.file ? `${c.first_seen.file}${c.first_seen.locator ? ` ${c.first_seen.locator}` : ""}` : null, fmt(c.first_seen.at)].filter(Boolean).join(" · ");
}
