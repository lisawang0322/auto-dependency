import type { Starter, Commitment } from "@throughline/schemas";
import { findMatch } from "@throughline/schemas";

/**
 * Whether each team is ready to launch, for a company with no plan of record: what the project's commitments say each
 * team owes (being on the work, and the sign-offs the PRD asks of it), checked against Jira by the coverage review.
 * Rules, not judgement:
 *   blocking   nobody from the team is on the work, or a sign-off it owes has not started or has no owner
 *   at risk    a sign-off is in progress
 *   can't tell Jira can't show whether the team is on the work
 *   ready      on the work, and every sign-off it owes is done
 * Anything the PM dropped, or whose signals they unticked, is left out.
 */
export type Readiness = "blocking" | "at_risk" | "unknown" | "ready";
export interface TeamReadiness { team: string; state: Readiness; reasons: string[] }

export const READINESS_ORDER: Readiness[] = ["blocking", "at_risk", "unknown", "ready"];
export const READINESS_LABEL: Record<Readiness, string> = { blocking: "Blocking", at_risk: "At risk", unknown: "Can't tell", ready: "Ready" };

const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();

export function teamReadiness(st: Starter, signalsOff: Record<string, boolean>, commitments: Commitment[] = []): TeamReadiness[] {
  const on = (ids: string[]) => ids.length === 0 || ids.some((id) => !signalsOff[id]);
  const dropped = (kind: "team" | "approval", team: string, what: string) => findMatch(commitments, kind, team, what)?.state === "dropped";
  const coverage = st.coverage.filter((c) => on(c.signal_ids) && !dropped("team", c.team, `Involve ${c.team}`));
  const approvals = st.approval_status.filter((a) => on(a.signal_ids) && !dropped("approval", a.team, a.name) && !dropped("team", a.team, `Involve ${a.team}`));
  const names = [...new Set([...coverage.map((c) => c.team), ...approvals.map((a) => a.team)])];
  return names.map((team) => {
    const cov = coverage.find((c) => same(c.team, team));
    const owes = approvals.filter((a) => same(a.team, team));
    const blocking = [
      ...(cov?.state === "missing" ? ["Nobody on the work"] : []),
      ...owes.filter((a) => a.state === "not_started").map((a) => `${a.name} not started`),
      ...owes.filter((a) => a.state === "no_owner").map((a) => `${a.name} has no owner${a.ticket ? ` (${a.ticket})` : ""}`),
    ];
    const atRisk = owes.filter((a) => a.state === "started").map((a) => `${a.name} in progress${a.ticket ? ` (${a.ticket})` : ""}`);
    const unknown = cov?.state === "unclear" ? ["Can't tell who's on the work"] : [];
    const state: Readiness = blocking.length ? "blocking" : atRisk.length ? "at_risk" : unknown.length ? "unknown" : "ready";
    const done = owes.filter((a) => a.state === "done").map((a) => `${a.name} done`);
    const reasons = [...blocking, ...atRisk, ...unknown, ...(state === "ready" ? [...(cov ? ["On the work"] : []), ...done] : [])];
    return { team, state, reasons };
  });
}

/** The project's answer: not ready while any team blocks; otherwise at risk, can't tell, or ready. */
export function overall(list: TeamReadiness[]): { state: Readiness; counts: Record<Readiness, number> } {
  const counts = { blocking: 0, at_risk: 0, unknown: 0, ready: 0 } as Record<Readiness, number>;
  for (const t of list) counts[t.state]++;
  return { state: READINESS_ORDER.find((s) => counts[s] > 0) ?? "ready", counts };
}
