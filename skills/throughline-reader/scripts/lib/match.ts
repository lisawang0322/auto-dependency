/**
 * Stage B: match plan teams to visible Jira projects. Never guesses silently:
 * two plausible projects means "unresolved" with both as candidates.
 */
import type { PlanTeam, TeamProject, VisibleProject, ProjectCandidate } from "@throughline/schemas";

export interface LinkedProject {
  key: string;
  /** e.g. "SEC-881 (is blocked by, from INGEST-142)" */
  via: string[];
  /** Text of the linked issues (summaries + components), for "fits the team" when names do not match. */
  text: string;
}

const STOP = new Set(["team", "the", "and", "of", "org", "group"]);

function tokens(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));
}

function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 4 && (a.startsWith(b) || b.startsWith(a));
}

function normName(s: string): string {
  return tokens(s).join(" ");
}

export function nameCandidates(team: PlanTeam, projects: VisibleProject[]): ProjectCandidate[] {
  const tn = normName(team.name);
  const tt = tokens(team.name);
  const exact: ProjectCandidate[] = [];
  const partial: ProjectCandidate[] = [];
  for (const p of projects) {
    if (p.key.toLowerCase() === tn || normName(p.name) === tn) {
      exact.push({ key: p.key, name: p.name, evidence: p.key.toLowerCase() === tn ? `key ${p.key} equals the team name` : `project name '${p.name}' equals the team name` });
      continue;
    }
    const fields: [string, string | null][] = [["key", p.key], ["name", p.name], ["category", p.category], ["description", p.description]];
    const hits: string[] = [];
    const allTokensFound = tt.every((t) => fields.some(([, v]) => tokens(v).some((pt) => tokenMatch(t, pt))));
    if (!tt.length || !allTokensFound) continue;
    for (const [label, v] of fields) if (tokens(v).some((pt) => tt.some((t) => tokenMatch(t, pt)))) hits.push(`${label} '${v}'`);
    partial.push({ key: p.key, name: p.name, evidence: `team name matches ${hits.join(", ")}` });
  }
  return exact.length ? exact : partial;
}

export function matchTeam(team: PlanTeam, projects: VisibleProject[], linked: LinkedProject[], warnings: string[]): TeamProject {
  const visible = new Set(projects.map((p) => p.key));
  const byKey = (k: string) => projects.find((p) => p.key === k)!;
  const linkedOf = (k: string) => linked.find((l) => l.key === k);
  const withLink = (c: ProjectCandidate): ProjectCandidate => {
    const l = linkedOf(c.key);
    return l ? { ...c, evidence: `${c.evidence}; linked from the epic via ${l.via.join(", ")}` } : c;
  };
  const base = { team: team.name, search: true };

  // 1. team_list
  if (team.jira_project_hint) {
    if (visible.has(team.jira_project_hint)) {
      const p = byKey(team.jira_project_hint);
      return { ...base, jira_project: p.key, match: "team_list", evidence: `Your team list gives project ${p.key} ('${p.name}')`, candidates: [] };
    }
    warnings.push(`${team.name}: team list names project ${team.jira_project_hint}, which is not visible to this account; trying other sources.`);
  }

  // 2. explicit
  const explicit = (team.project_keys_mentioned ?? []).filter((k) => visible.has(k));
  if (explicit.length === 1) {
    const p = byKey(explicit[0]);
    return { ...base, jira_project: p.key, match: "explicit", evidence: `The plan names project ${p.key} ('${p.name}') next to this team`, candidates: [] };
  }
  if (explicit.length > 1) {
    return { ...base, jira_project: null, match: "unresolved", evidence: `The plan names ${explicit.length} projects for this team`, candidates: explicit.map((k) => withLink({ key: k, name: byKey(k).name, evidence: "named in the plan" })) };
  }

  // 3/4. linked and name
  const cands = nameCandidates(team, projects);
  if (cands.length === 1) {
    const c = cands[0];
    const l = linkedOf(c.key);
    if (l) return { ...base, jira_project: c.key, match: "linked", evidence: `Linked from the epic via ${l.via.join(", ")}; ${c.evidence}`, candidates: [] };
    return { ...base, jira_project: c.key, match: "name", evidence: c.evidence[0].toUpperCase() + c.evidence.slice(1), candidates: [] };
  }
  if (cands.length > 1) {
    const ordered = cands.map(withLink).sort((a, b) => Number(!!linkedOf(b.key)) - Number(!!linkedOf(a.key)) || a.key.localeCompare(b.key));
    return { ...base, jira_project: null, match: "unresolved", evidence: `${cands.length} visible projects fit the name '${team.name}': ${ordered.map((c) => c.key).join(", ")}. Pick one.`, candidates: ordered };
  }
  // No name match: a linked project whose linked issues mention the team
  const tt = tokens(team.name);
  const fits = linked.filter((l) => visible.has(l.key) && tt.every((t) => tokens(l.text).some((pt) => tokenMatch(t, pt))));
  if (fits.length === 1) {
    const p = byKey(fits[0].key);
    return { ...base, jira_project: p.key, match: "linked", evidence: `No project is named like '${team.name}', but issues linked from the epic in ${p.key} mention it: ${fits[0].via.join(", ")}`, candidates: [] };
  }
  const candidates = fits.map((l) => ({ key: l.key, name: byKey(l.key).name, evidence: `linked from the epic via ${l.via.join(", ")}` }));
  return { ...base, jira_project: null, match: "unresolved", evidence: candidates.length ? `${candidates.length} linked projects mention '${team.name}'. Pick one.` : `No visible project matches '${team.name}' by key, name, category, description or epic links.`, candidates };
}
