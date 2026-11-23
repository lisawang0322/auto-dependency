/**
 * An employee directory or team list: teams, their Jira project, and the people on them.
 * Accepts the team-list format the reader already takes (yaml/json `teams[]` with `owners`, or a csv
 * with team/project/owner columns) plus `people: [{name, title}]` and `aliases: [...]`.
 */
import type { LoadedFile } from "../../../throughline-reader/scripts/lib/files.js";

export interface Person { name: string; title: string | null }
export interface DirectoryEntry { name: string; aliases: string[]; project: string | null; people: Person[] }

function person(v: unknown): Person | null {
  if (typeof v === "string") {
    const m = v.match(/^(.*?)\s*\((.+)\)\s*$/);
    return m ? { name: m[1].trim(), title: m[2].trim() } : { name: v.trim(), title: null };
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const name = String(o.name ?? o.displayName ?? "").trim();
    return name ? { name, title: o.title ? String(o.title) : o.role ? String(o.role) : null } : null;
  }
  return null;
}

/** The same entries from teams an agent read out of a team list or org chart (owners written "Name (title)"). */
export function directoryFromAgentTeams(teams: { name: string; jira_project?: string | null; owners?: string[] }[]): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  for (const t of teams) {
    const name = String(t.name ?? "").trim();
    if (!name) continue;
    const project = t.jira_project ? String(t.jira_project).trim().toUpperCase() : null;
    out.push({ name, aliases: [], project, people: (t.owners ?? []).map(person).filter((p): p is Person => !!p && !!p.name) });
  }
  return out;
}

export function loadDirectory(f: LoadedFile): DirectoryEntry[] {
  const d = f.data as any;
  const out: DirectoryEntry[] = [];
  if (d && Array.isArray(d.teams)) {
    for (const t of d.teams) {
      const name = String(t.name ?? t.team ?? "").trim();
      if (!name) continue;
      const project = t.jira_project ?? t.jira ?? t.project ?? t.key ?? null;
      const raw = [...(Array.isArray(t.people) ? t.people : []), ...(Array.isArray(t.owners) ? t.owners : typeof t.owners === "string" ? t.owners.split(/[;|]/) : [])];
      out.push({ name, aliases: Array.isArray(t.aliases) ? t.aliases.map(String) : [], project: project ? String(project).toUpperCase() : null, people: raw.map(person).filter((p): p is Person => !!p && !!p.name) });
    }
  } else if (f.rows && f.rows.length > 1) {
    const h = f.rows[0].map((c) => c.toLowerCase());
    const col = (re: RegExp) => h.findIndex((c) => re.test(c));
    const cTeam = col(/^(team|name)$/), cProj = col(/project|jira/), cOwn = col(/owner|people|person|member/), cTitle = col(/title|role/);
    for (const r of f.rows.slice(1)) {
      const name = cTeam >= 0 ? (r[cTeam] ?? "").trim() : "";
      if (!name) continue;
      let e = out.find((x) => x.name === name);
      if (!e) { e = { name, aliases: [], project: cProj >= 0 && r[cProj] ? r[cProj].toUpperCase() : null, people: [] }; out.push(e); }
      if (cOwn >= 0) for (const o of (r[cOwn] ?? "").split(/[;|]/)) {
        const p = person(o.trim());
        if (p && p.name) { if (!p.title && cTitle >= 0 && r[cTitle]) p.title = r[cTitle]; e.people.push(p); }
      }
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\bteam\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function findTeam(dir: DirectoryEntry[], team: string): DirectoryEntry | null {
  const want = norm(team);
  return dir.find((e) => norm(e.name) === want || e.aliases.some((a) => norm(a) === want)) ?? null;
}

/** "Priya Raman · Eng manager, Data Platform", or null when the directory has nobody for the team. */
export function contactFor(dir: DirectoryEntry[], team: string): string | null {
  const e = findTeam(dir, team);
  const p = e?.people[0];
  return p ? (p.title ? `${p.name} · ${p.title}` : p.name) : null;
}

/** Which directory team a person belongs to, by display name (titles ignored). */
export function teamOfPerson(dir: DirectoryEntry[], displayName: string | null | undefined): DirectoryEntry | null {
  if (!displayName) return null;
  const want = displayName.toLowerCase().trim();
  return dir.find((e) => e.people.some((p) => p.name.toLowerCase() === want)) ?? null;
}
