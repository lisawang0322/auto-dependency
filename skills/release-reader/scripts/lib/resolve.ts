/** Stage B: resolve the release epic, its window, and each team's Jira project. */
import { PlanDraft, ReleaseTarget, VisibleProject, TeamProject } from "@rrr/schemas";
import { JiraSource } from "./jira-source.js";
import { RawIssue, RawProject } from "./jira-types.js";
import { childrenJql } from "./jql.js";
import { addDays, isoDateOf, minIso } from "./dates.js";
import { projectOf } from "./keys.js";
import { matchTeam, LinkedProject } from "./match.js";

export interface ResolveOptions {
  plan: PlanDraft;
  source: JiraSource;
  epicKey?: string | null;
  /** Teams the person marked "don't search". */
  noSearch?: string[];
}

export function toVisibleProject(p: RawProject): VisibleProject {
  return { key: p.key, name: p.name, category: p.projectCategory?.name ?? null, description: p.description ?? null, lead: p.lead?.displayName ?? null };
}

export function linkTargets(issue: RawIssue): { key: string; type: string; direction: "inward" | "outward" }[] {
  const out: { key: string; type: string; direction: "inward" | "outward" }[] = [];
  for (const l of issue.fields.issuelinks ?? []) {
    if (l.inwardIssue?.key) out.push({ key: l.inwardIssue.key, type: l.type.inward, direction: "inward" });
    if (l.outwardIssue?.key) out.push({ key: l.outwardIssue.key, type: l.type.outward, direction: "outward" });
  }
  return out;
}

/** Projects reached by the epic's own project, its links, and its stories' links. May return undefined while MCP calls are pending. */
export function linkedProjects(epic: RawIssue, stories: RawIssue[], source: JiraSource): LinkedProject[] | undefined {
  const map = new Map<string, LinkedProject>();
  const add = (key: string, via: string, text: string) => {
    const l = map.get(key) ?? { key, via: [], text: "" };
    if (!l.via.includes(via)) l.via.push(via);
    l.text += " " + text;
    map.set(key, l);
  };
  add(projectOf(epic.key), `epic ${epic.key} itself`, epic.fields.summary);
  let pending = false;
  for (const issue of [epic, ...stories]) {
    for (const t of linkTargets(issue)) {
      const target = source.getIssue(t.key);
      if (target === undefined) { pending = true; continue; }
      const text = target ? `${target.fields.summary} ${(target.fields.components ?? []).map((c) => c.name).join(" ")}` : "";
      add(projectOf(t.key), `${t.key} (${t.type}, from ${issue.key})`, text);
    }
  }
  return pending ? undefined : [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function resolveRelease(opts: ResolveOptions): ReleaseTarget | undefined {
  const { plan, source } = opts;
  const warnings: string[] = [];

  // 1. Pick the epic
  const tried: string[] = [];
  let epic: RawIssue | null | undefined = undefined;
  let epicKey: string | null = null;
  const choices = opts.epicKey ? [opts.epicKey] : plan.epic_keys_mentioned;
  if (!choices.length) throw new Error("No epic key: pass --epic KEY or add one to the plan's epic_keys_mentioned.");
  for (const k of choices) {
    const i = source.getIssue(k);
    if (i === undefined) return undefined; // pending MCP
    tried.push(k);
    if (i && (i.fields.issuetype?.name ?? "").toLowerCase() === "epic") { epic = i; epicKey = k; break; }
    if (i) warnings.push(`${k} exists but is a ${i.fields.issuetype?.name ?? "non-epic"}, not an Epic.`);
    else warnings.push(`${k} was not found or is not visible.`);
  }
  if (!epic || !epicKey) throw new Error(`No usable epic among ${tried.join(", ")}: ${warnings.join(" ")}`);
  if (choices.length > 1) warnings.push(`Several epic keys were mentioned (${choices.join(", ")}); used ${epicKey}.`);

  // 2. Fix version and release date
  const fv = (epic.fields.fixVersions ?? [])[0] ?? null;
  const releaseDate = fv?.releaseDate ?? null;
  if (!fv) warnings.push(`${epicKey} has no fix version.`);
  if (plan.launch_date && releaseDate && releaseDate !== plan.launch_date) warnings.push(`Launch date differs: the plan says ${plan.launch_date}, fix version '${fv!.name}' is dated ${releaseDate}.`);
  if (plan.launch_date && fv && !releaseDate) warnings.push(`Fix version '${fv.name}' has no release date; using the plan's ${plan.launch_date}.`);

  // 3. Visible projects
  const raw = source.listProjects();
  // 4. Match teams (needs the epic's links and stories' links). Request both before pausing for MCP.
  const kids = source.search(childrenJql(epicKey), 500);
  if (raw === undefined || kids === undefined) return undefined;
  const projects = (raw ?? []).map(toVisibleProject).sort((a, b) => a.key.localeCompare(b.key));
  if (raw === null) warnings.push("Could not list visible projects; teams cannot be matched.");
  if (kids === null) warnings.push(`Could not list the stories of ${epicKey}.`);
  const linked = linkedProjects(epic, kids ?? [], source);
  if (linked === undefined) return undefined;
  const noSearch = new Set((opts.noSearch ?? []).map((s) => s.toLowerCase()));
  const teamProjects: TeamProject[] = plan.teams.map((t) => {
    const m = matchTeam(t, projects, linked, warnings);
    if (noSearch.has(t.name.toLowerCase())) m.search = false;
    if (m.match === "unresolved") warnings.push(`${t.name}: unresolved. ${m.evidence}`);
    return m;
  });

  // Window: ends on the launch date; starts at the earliest of epic creation and earliest plan date - 30 days
  const end = plan.launch_date ?? releaseDate ?? isoDateOf(epic.fields.duedate) ?? isoDateOf(epic.fields.updated)!;
  const planDates = plan.items.map((i) => i.due).filter((d): d is string => !!d).sort();
  const created = isoDateOf(epic.fields.created);
  let start = created ?? end;
  if (planDates.length) start = minIso(start, addDays(planDates[0], -30));
  if (!created) warnings.push(`${epicKey} has no creation date; the window starts at the earliest plan date minus 30 days.`);

  return ReleaseTarget.parse({
    epic: { key: epicKey, summary: epic.fields.summary, fix_version: fv?.name ?? null, release_date: releaseDate, created },
    release_window: { start, end },
    projects: teamProjects,
    visible_projects: projects,
    warnings: [...warnings, ...source.warnings],
  });
}
