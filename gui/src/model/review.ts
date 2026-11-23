/** Pure review logic: status roll-up, weak filter, 10-finding cap, the "all teams resolved" gate. */
import type { Finding, Team, TeamItem, TeamStatus, TeamProject } from "@throughline/schemas";
import type { Decisions } from "../backend/types";

export const FINDING_CAP = 10;
export type Effective = "ok" | "gap" | "late" | "weak" | "dismissed";
export interface ItemView extends TeamItem { effective: Effective; plan_due_effective: string | null; note_effective: string }
export interface TeamView extends Omit<Team, "items" | "status"> { items: ItemView[]; status: TeamStatus }

/** Apply decisions and plan-date edits; drop items whose plan item is not in the confirmed plan. */
export function rollup(teams: Team[], decisions: Decisions, planIds: Set<string> | null, planDates: Record<string, string> = {}): TeamView[] {
  return teams.map((t) => {
    const items: ItemView[] = t.items
      .filter((i) => !planIds || planIds.has(i.plan_item_id))
      .map((i) => {
        const dec = i.finding_id ? decisions[i.finding_id] : undefined;
        const dismissed = dec?.kind === "dismissed";
        return {
          ...i,
          effective: dismissed ? "dismissed" : i.result,
          note_effective: dismissed ? `Dismissed — ${dec!.reason}` : i.note,
          plan_due_effective: planDates[i.plan_item_id] ?? i.plan_due,
        };
      });
    return { ...t, items, status: teamStatus(items) };
  });
}

export function teamStatus(items: { effective: Effective }[]): TeamStatus {
  if (items.some((i) => i.effective === "late")) return "late";
  if (items.some((i) => i.effective === "gap")) return "at_risk";
  return "on_track";
}

export function releaseStatus(teams: { status: TeamStatus }[]): "Green" | "Amber" {
  return teams.some((t) => t.status !== "on_track") ? "Amber" : "Green";
}

const RANK: Record<Finding["strength"], number> = { strong: 0, moderate: 1, weak: 2 };

/** Weak findings hidden unless asked for; strongest first; never more than the cap. */
export function visibleFindings(findings: Finding[], showWeak: boolean, cap = FINDING_CAP): Finding[] {
  return findings
    .filter((f) => showWeak || f.strength !== "weak")
    .map((f, i) => ({ f, i }))
    .sort((a, b) => RANK[a.f.strength] - RANK[b.f.strength] || a.i - b.i)
    .map((x) => x.f)
    .slice(0, cap);
}

export function hiddenWeakCount(findings: Finding[], showWeak: boolean): number {
  return showWeak ? 0 : findings.filter((f) => f.strength === "weak").length;
}

export type TeamChoice = string | "skip"; // project key, or "skip" = don't search this team

/** Every team has a project (from the reader or the person) or was marked "don't search". */
export function allTeamsResolved(projects: TeamProject[], choices: Record<string, TeamChoice>): boolean {
  return projects.every((p) => isResolved(p, choices[p.team]));
}

export function isResolved(p: TeamProject, choice: TeamChoice | undefined): boolean {
  if (choice === "skip") return true;
  if (choice) return true;
  return p.match !== "unresolved" && !!p.jira_project;
}

/** The effective project per team after the person's choices, as the reader's Stage C would see it. */
export function applyChoices(projects: TeamProject[], choices: Record<string, TeamChoice>): TeamProject[] {
  return projects.map((p) => {
    const c = choices[p.team];
    if (c === "skip") return { ...p, search: false };
    if (c && c !== p.jira_project) return { ...p, jira_project: c, match: p.match === "unresolved" ? "name" : p.match, evidence: "Chosen by you", candidates: p.candidates };
    return p;
  });
}

export function openFindingCount(findings: Finding[], decisions: Decisions): number {
  return findings.filter((f) => f.strength !== "weak" && !decisions[f.id]).length;
}

/** One row of "Your next actions" (R16): what, who, by when, why, from the finding's next_action. */
export interface NextActionView { id: string; text: string; who: string; when: string; why: string; kept: boolean }

/** Every shown finding that is open or kept is a next action; dismissed ones drop out. */
export function nextActions(shown: Finding[], decisions: Decisions): NextActionView[] {
  return shown
    .filter((f) => decisions[f.id]?.kind !== "dismissed")
    .map((f) => ({
      id: f.id,
      text: f.next_action?.action ?? f.ask ?? f.title,
      who: f.next_action?.who ?? f.owner,
      when: f.next_action?.by_when ?? "before go/no-go",
      why: f.next_action?.why ?? f.title,
      kept: decisions[f.id]?.kind === "kept",
    }));
}
