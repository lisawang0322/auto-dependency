/**
 * Just starting (PRD R17): from the PRD's signals, the teams to involve (role, why, when, a likely
 * contact from the directory), the approvals to plan for, and the first actions. Rules only.
 */
import type { Signal, TeamToInvolve, ApprovalNeeded, StarterAction, InvolveRole } from "@throughline/schemas";
import type { SignalRules, RuleTeam, RuleApproval } from "./config.js";
import { contactFor, type DirectoryEntry } from "./directory.js";

const RANK: Record<InvolveRole, number> = { core: 0, approve: 1, consult: 2, inform: 3 };

export interface SuggestInput { signals: Signal[]; rules: SignalRules; directory: DirectoryEntry[]; excludeSignals?: string[] }
export interface Suggestion { teams: TeamToInvolve[]; approvals: ApprovalNeeded[]; next_actions: StarterAction[] }

/** The signals still on, in order. */
export function activeSignals(signals: Signal[], exclude: string[] = []): Signal[] {
  const off = new Set(exclude);
  return signals.filter((s) => !off.has(s.id));
}

/** "Priya Raman (Data Platform)" for an action's who, or just the team. */
export function whoFor(directory: DirectoryEntry[], team: string): string {
  const c = contactFor(directory, team);
  return c ? `${c.split(" · ")[0]} (${team})` : team;
}

export function suggest(input: SuggestInput): Suggestion {
  const signals = activeSignals(input.signals, input.excludeSignals);
  const byRule = new Map(input.rules.rules.map((r) => [r.id, r]));
  // Each (rule, team) entry once, with every signal that triggered it; order = first appearance.
  const teamEntries = new Map<string, { entry: RuleTeam; signal_ids: string[] }[]>();
  const approvalEntries = new Map<string, { entry: RuleApproval; signal_ids: string[] }>();
  for (const s of signals) {
    for (const rid of s.rule_ids) {
      const rule = byRule.get(rid);
      if (!rule) continue;
      for (const t of rule.teams) {
        const list = teamEntries.get(t.team) ?? [];
        const hit = list.find((x) => x.entry === t);
        if (hit) { if (!hit.signal_ids.includes(s.id)) hit.signal_ids.push(s.id); }
        else list.push({ entry: t, signal_ids: [s.id] });
        teamEntries.set(t.team, list);
      }
      for (const a of rule.approvals ?? []) {
        const hit = approvalEntries.get(a.name);
        if (hit) { if (!hit.signal_ids.includes(s.id)) hit.signal_ids.push(s.id); }
        else approvalEntries.set(a.name, { entry: a, signal_ids: [s.id] });
      }
    }
  }
  const teams: TeamToInvolve[] = [];
  const next_actions: StarterAction[] = [];
  for (const [team, list] of teamEntries) {
    const best = [...list].sort((a, b) => RANK[a.entry.role] - RANK[b.entry.role])[0];
    const signal_ids = [...new Set(list.flatMap((x) => x.signal_ids))];
    teams.push({ team, role: best.entry.role, why: best.entry.why, when: best.entry.when, signal_ids, contact: contactFor(input.directory, team) });
    const withAction = [...list].sort((a, b) => RANK[a.entry.role] - RANK[b.entry.role]).find((x) => x.entry.action);
    if (withAction) next_actions.push({
      id: `a${next_actions.length + 1}`, team, text: withAction.entry.action!, who: whoFor(input.directory, team),
      when: withAction.entry.action_when ?? "this week", why: withAction.entry.action_why ?? withAction.entry.why, signal_ids: withAction.signal_ids,
    });
  }
  // Teams in involvement order (core first), then by first appearance; actions keep the same order.
  const order = (t: string) => teams.findIndex((x) => x.team === t);
  teams.sort((a, b) => RANK[a.role] - RANK[b.role] || order(a.team) - order(b.team));
  const actionOrder = new Map(teams.map((t, i) => [t.team, i]));
  next_actions.sort((a, b) => (actionOrder.get(a.team) ?? 99) - (actionOrder.get(b.team) ?? 99));
  next_actions.forEach((a, i) => { a.id = `a${i + 1}`; });
  const approvals: ApprovalNeeded[] = [...approvalEntries.values()].map(({ entry, signal_ids }) => ({ name: entry.name, team: entry.team, why: entry.why, start: entry.start, signal_ids }));
  return { teams, approvals, next_actions };
}
