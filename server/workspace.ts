/**
 * Projects as folders (PRD "A project folder any coding agent can work in"): the local-disk demonstration of the
 * direction where each project is its own repo. One folder per project, readable by a person and by any coding agent:
 *
 *   <root>/<project-id>/
 *     project.yaml        name, stage, epic, launch date, files and how each is read, team → Jira choices, status
 *     inputs/             the originals the PM added (kept: re-readable, and the quote check can be repeated)
 *     readings/<stage>/   what was read at that stage: plan.json (items and signals with quotes, who read them)
 *     readings/inbox/     where a coding agent working in the folder writes its reading (reading.json)
 *     reviews/<id>/       every review as it was: review.json and a readable summary.md
 *     teams.yaml          the teams the project uses and their Jira projects; no people
 *     history.md          what happened, one line each
 *     README.md           the status, readable anywhere
 *     AGENTS.md           instructions for any coding agent: the job, the output, and the safety rules
 *     CLAUDE.md, GEMINI.md  one-line pointers to AGENTS.md for agents that look for their own file
 *     .gitignore          keeps the org directory and contact lists out of the repo
 *
 * When git is installed each project folder is a repository, and every save becomes a commit with a plain message:
 * the history a hosted repo would have, with git kept out of the PM's sight.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import YAML from "yaml";

export const SCHEMA = "readiness-project/1";
/** Where a coding agent working in the project folder leaves its reading for the GUI to pick up. */
export const INBOX = "readings/inbox/reading.json";

export interface FolderProject { id: string; name: string; created_at: string; updated_at: string; data: Record<string, any> }

const yamlOut = (o: unknown) => YAML.stringify(o, { lineWidth: 0 });
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const safeSeg = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80) || "x";
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";

/** Is git usable here? Checked once. */
let gitOk: boolean | null = null;
export function hasGit(): boolean {
  if (gitOk === null) { try { execFileSync("git", ["--version"], { stdio: "ignore", timeout: 3000 }); gitOk = true; } catch { gitOk = false; } }
  return gitOk;
}

export class Workspace {
  constructor(private readonly root: string, private readonly opts: { git?: boolean; log?: (s: string) => void; agentsMd?: (d: Record<string, any>) => string } = {}) {}
  private get useGit() { return (this.opts.git ?? true) && hasGit(); }
  private git(dir: string, args: string[]) {
    return execFileSync("git", ["-c", "user.name=Readiness Review", "-c", "user.email=readiness-review@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: dir, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).toString();
  }

  /** The folder that holds this person's projects. */
  base(scope: string) { const d = join(this.root, scope); mkdirSync(d, { recursive: true }); return d; }
  dir(scope: string, id: string) { return join(this.base(scope), safeSeg(id)); }
  exists(scope: string, id: string) { return existsSync(join(this.dir(scope, id), "project.yaml")); }
  inputs(scope: string, id: string) { const d = join(this.dir(scope, id), "inputs"); mkdirSync(d, { recursive: true }); return d; }

  list(scope: string): FolderProject[] {
    const base = this.base(scope);
    return readdirSync(base).filter((n) => existsSync(join(base, n, "project.yaml"))).map((n) => this.get(scope, n)!).filter(Boolean)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  create(scope: string, name: string, data: Record<string, any>): FolderProject {
    const id = `${slug(name)}-${randomBytes(3).toString("hex")}`;
    const dir = this.dir(scope, id);
    mkdirSync(join(dir, "inputs"), { recursive: true });
    const now = new Date().toISOString();
    this.write(dir, { id, name, created_at: now, updated_at: now, data }, null);
    if (this.useGit) {
      try { this.git(dir, ["init", "-q", "-b", "main"]); this.commit(dir, `Created ${name}`); } catch (e) { this.opts.log?.(`workspace: git init failed in ${id}: ${(e as Error).message}`); }
    }
    return this.get(scope, id)!;
  }

  get(scope: string, id: string): FolderProject | null {
    const dir = this.dir(scope, id);
    const pf = join(dir, "project.yaml");
    if (!existsSync(pf)) return null;
    const p = YAML.parse(readFileSync(pf, "utf8")) ?? {};
    const stage = p.stage ?? null;
    const reading = stage && existsSync(join(dir, "readings", stage, "plan.json")) ? readJson(join(dir, "readings", stage, "plan.json")) : null;
    const records: any[] = [];
    if (existsSync(join(dir, "reviews"))) {
      for (const r of readdirSync(join(dir, "reviews"))) { const f = join(dir, "reviews", r, "review.json"); if (existsSync(f)) records.push(readJson(f)); }
    }
    records.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const current = existsSync(join(dir, "reviews", "current.json")) ? readJson(join(dir, "reviews", "current.json")) : null;
    const events = existsSync(join(dir, "history.md"))
      ? readFileSync(join(dir, "history.md"), "utf8").split("\n").map((l) => l.match(/^- (\S+) · (.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ at: m[1], text: m[2] }))
      : [];
    const data: Record<string, any> = {
      ...(p.state ?? {}), stage, epic: p.epic ?? "", launch: p.launch ?? "", files: p.files ?? [], summary: p.summary ?? null,
      plan: reading?.plan ?? null, signals: reading?.signals ?? [], project: reading?.project ?? null, agentRead: reading?.agent_read ?? null,
      starter: current?.starter ?? null, records, events,
    };
    return { id: p.id ?? id, name: p.name ?? id, created_at: p.created_at ?? "", updated_at: p.updated_at ?? "", data };
  }

  save(scope: string, id: string, name: string, data: Record<string, any>): FolderProject | null {
    const dir = this.dir(scope, id);
    const prev = this.get(scope, id);
    if (!prev) return null;
    this.write(dir, { id: prev.id, name, created_at: prev.created_at, updated_at: new Date().toISOString(), data }, prev);
    if (this.useGit && existsSync(join(dir, ".git"))) {
      const before = prev.data.events?.length ?? 0, after = (data.events ?? []) as { text: string }[];
      const msg = after.length > before ? after.slice(before).map((e) => e.text).join("; ") : "Saved changes";
      try { this.commit(dir, msg); } catch (e) { this.opts.log?.(`workspace: commit failed in ${id}: ${(e as Error).message}`); }
    }
    return this.get(scope, id);
  }

  remove(scope: string, id: string): boolean {
    const dir = this.dir(scope, id);
    if (!existsSync(join(dir, "project.yaml"))) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** The project's commits, newest first (empty without git). */
  log(scope: string, id: string): { hash: string; at: string; message: string }[] {
    const dir = this.dir(scope, id);
    if (!this.useGit || !existsSync(join(dir, ".git"))) return [];
    try { return this.git(dir, ["log", "--pretty=format:%h%x09%cI%x09%s", "-n", "200"]).split("\n").filter(Boolean).map((l) => { const [hash, at, message] = l.split("\t"); return { hash, at, message }; }); }
    catch { return []; }
  }
  /** Paths changed since the last commit: what an agent working in the folder touched. */
  changed(scope: string, id: string): string[] {
    const dir = this.dir(scope, id);
    if (!this.useGit || !existsSync(join(dir, ".git"))) return [];
    try { return this.git(dir, ["status", "--porcelain", "-uall"]).split("\n").filter(Boolean).map((l) => l.slice(3).trim()); } catch { return []; }
  }

  /** After a coding agent worked in the folder: anything it changed outside the allowed paths is undone (tracked files restored)
   *  or moved aside (new files, into .scratch/quarantine/, which is never committed). Returns what was done, for the PM. */
  quarantine(scope: string, id: string, allowed: (path: string) => boolean): { restored: string[]; moved: string[] } {
    const dir = this.dir(scope, id);
    const out = { restored: [] as string[], moved: [] as string[] };
    if (!this.useGit || !existsSync(join(dir, ".git"))) return out;
    for (const path of this.changed(scope, id)) {
      if (allowed(path) || path.startsWith(".scratch/")) continue;
      let tracked = true;
      try { this.git(dir, ["ls-files", "--error-unmatch", "--", path]); } catch { tracked = false; }
      if (tracked) { try { this.git(dir, ["checkout", "--", path]); out.restored.push(path); } catch { /* deleted and re-created: leave for the PM */ } }
      else {
        const to = join(dir, ".scratch", "quarantine", path);
        mkdirSync(join(to, ".."), { recursive: true });
        try { renameSync(join(dir, path), to); out.moved.push(path); } catch { /* leave */ }
      }
    }
    return out;
  }

  private commit(dir: string, message: string) {
    this.git(dir, ["add", "-A"]);
    if (!this.git(dir, ["status", "--porcelain"]).trim()) return;
    this.git(dir, ["commit", "-q", "-m", message.slice(0, 200)]);
  }

  /** The project's state, split into the contract's files. Derived files (teams, README, history, AGENTS) are rewritten each time. */
  private write(dir: string, p: Omit<FolderProject, "data"> & { data: Record<string, any> }, prev: FolderProject | null) {
    const d = p.data ?? {};
    mkdirSync(dir, { recursive: true });
    const { stage = null, epic = "", launch = "", files = [], summary = null, plan = null, signals = [], project = null, agentRead = null, starter = null, records = [], events = [], ...state } = d;
    // project.yaml: the settings a person might read or edit; everything the GUI keeps that has no file of its own sits under state.
    writeFileSync(join(dir, "project.yaml"), `# A Readiness Review project. Edited by the GUI; readable by anyone.\n` + yamlOut({ schema: SCHEMA, id: p.id, name: p.name, created_at: p.created_at, updated_at: p.updated_at, stage, epic, launch, summary, files, state }));
    // readings/<stage>/plan.json: what was read at this stage; removed when the reading no longer applies.
    if (stage) {
      const rf = join(dir, "readings", stage, "plan.json");
      if (plan) { mkdirSync(join(dir, "readings", stage), { recursive: true }); writeFileSync(rf, JSON.stringify({ stage, read_at: agentRead ? new Date().toISOString() : null, project, agent_read: agentRead, signals, plan }, null, 2) + "\n"); }
      else if (existsSync(rf)) rmSync(rf);
    }
    // reviews/<id>/: every review as it was, and the current early-stage result.
    for (const r of records as any[]) {
      const rd = join(dir, "reviews", safeSeg(String(r.id)));
      mkdirSync(rd, { recursive: true });
      writeFileSync(join(rd, "review.json"), JSON.stringify(r, null, 2) + "\n");
      writeFileSync(join(rd, "summary.md"), reviewSummary(r));
    }
    if (prev) for (const r of (prev.data.records ?? []) as any[]) if (!(records as any[]).some((x) => x.id === r.id)) rmSync(join(dir, "reviews", safeSeg(String(r.id))), { recursive: true, force: true });
    mkdirSync(join(dir, "reviews"), { recursive: true });
    const cur = join(dir, "reviews", "current.json");
    if (starter) writeFileSync(cur, JSON.stringify({ starter }, null, 2) + "\n"); else if (existsSync(cur)) rmSync(cur);
    // teams.yaml: the teams this project names and their Jira projects. Owners and people are left out on purpose.
    const teams = ((plan?.teams ?? []) as any[]).map((t) => ({ name: t.name, role: t.role ?? null, jira_project: t.jira_project_hint ?? null }));
    writeFileSync(join(dir, "teams.yaml"), `# Teams this project involves. No people: names and contacts stay with the organisation's directory, outside this folder.\n` + yamlOut({ teams }));
    writeFileSync(join(dir, "history.md"), `# History\n\n` + (events as any[]).map((e) => `- ${e.at} · ${String(e.text).replace(/\n/g, " ")}`).join("\n") + "\n");
    writeFileSync(join(dir, "README.md"), readme(p.name, d));
    writeFileSync(join(dir, "AGENTS.md"), this.opts.agentsMd ? this.opts.agentsMd(d) : "# Instructions for coding agents\n");
    // Agents that read their own file name first: point them at the same instructions.
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    writeFileSync(join(dir, "GEMINI.md"), "Read and follow AGENTS.md in this folder.\n");
    writeFileSync(join(dir, ".gitignore"), `# The organisation's directory and any contact lists never belong in a project's history.\norg/\ndirectory*\n*contacts*\n*.people.*\n# Scratch space an agent may use.\n.scratch/\n`);
    mkdirSync(join(dir, "readings", "inbox"), { recursive: true });
    if (!existsSync(join(dir, "readings", "inbox", ".keep"))) writeFileSync(join(dir, "readings", "inbox", ".keep"), "");
  }
}

function reviewSummary(r: any): string {
  const s = r.summary;
  const lines = [`# ${r.title}`, ``, `${String(r.at).slice(0, 10)} · ${r.stage}`, ``];
  if (s) lines.push(`- Status: ${s.status ?? "—"}`, `- Open actions: ${s.open ?? "—"}`, ...(s.detail ? [`- ${s.detail}`] : []), ``);
  if (r.files?.length) lines.push(`From: ${r.files.join(", ")}`, ``);
  const actions = r.starter?.next_actions ?? [];
  if (actions.length) lines.push(`## Next actions`, ``, ...actions.map((a: any) => `- ${a.text} (${a.team}, ${a.when})`), ``);
  if (r.launch) lines.push(`Launch review of ${r.launch.epic}, run ${r.launch.runId}. The run itself is kept with the review runs.`, ``);
  return lines.join("\n");
}

function readme(name: string, d: Record<string, any>): string {
  const s = d.summary;
  const out = [`# ${name}`, ``, `Stage: ${d.stage ?? "not set"}${d.epic ? ` · Epic: ${d.epic}` : ""}${d.launch ? ` · Launch: ${d.launch}` : ""}`, ``];
  if (s) out.push(`Latest review: ${s.status ? `${s.status} · ` : ""}${s.open ?? 0} open actions${s.detail ? ` · ${s.detail}` : ""}`, ``);
  out.push(`Files: ${(d.files ?? []).map((f: any) => f.name).join(", ") || "none yet"}`, ``, `See history.md for what happened, reviews/ for every review, and AGENTS.md for how a coding agent works in this folder.`, ``);
  return out.join("\n");
}

/** The fields of a file entry a project may keep (stored files point into inputs/). */
export function storedPath(dir: string, stored: string): string | null {
  const p = join(dir, "inputs", stored);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}
