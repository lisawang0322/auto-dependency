/**
 * The orchestrator: reader (A, B, C) → analyzer → status → saved run, as plain functions so the CLI
 * (scripts/review.ts) and the local API server (server/index.ts) run exactly the same code.
 * Jira is only ever read. --source fixture reads a snapshot directory; --source rest reads Jira Cloud
 * over REST through the same request cache the MCP mode uses.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PlanDraft, ReleaseTarget, Release, Findings, Status, Run, ReadAs, type Team } from "@throughline/schemas";
import { loadFile } from "../../skills/throughline-reader/scripts/lib/files.js";
import { type AgentItem, type AgentTeam, type AgentLaunchDate, containsQuote, extractPlan } from "../../skills/throughline-reader/scripts/lib/plan-extract.js";
import { FixtureSource, type JiraSource } from "../../skills/throughline-reader/scripts/lib/jira-source.js";
import { JiraRest, runRestLoop, type RestCreds } from "../../skills/throughline-reader/scripts/lib/jira-rest.js";
import { resolveRelease } from "../../skills/throughline-reader/scripts/lib/resolve.js";
import { readJira } from "../../skills/throughline-reader/scripts/lib/read.js";
import { analyze } from "../../skills/throughline-analyzer/scripts/lib/analyze.js";
import { loadTemplates, loadPhrases } from "../../skills/throughline-analyzer/scripts/lib/config.js";
import { computeStatus } from "../../skills/throughline-status/scripts/lib/status.js";

export type SourceSpec =
  | { kind: "fixture"; dir: string }
  | { kind: "rest"; creds: RestCreds; cacheDir: string; log?: (line: string) => void };

export function todayLabel(d = new Date()): string { return d.toISOString().slice(0, 10); }

/** Run one reader step against the chosen source, serving REST reads between rounds when needed. */
export async function withSource<T>(spec: SourceSpec, step: (src: JiraSource) => T | undefined): Promise<T> {
  if (spec.kind === "fixture") {
    const out = step(new FixtureSource(spec.dir));
    if (out === undefined) throw new Error("fixture source left a read pending; the snapshot is incomplete");
    return out;
  }
  const rest = new JiraRest(spec.creds);
  const [out] = await runRestLoop(spec.cacheDir, rest, step, { log: spec.log });
  return out;
}

// ---------- stages ----------

/** What an agent read out of the files, when it read them all: the parsers then read nothing on their own. */
export interface AgentReading { items: AgentItem[]; teams: AgentTeam[]; launchDate?: AgentLaunchDate | null; epicKeys?: string[]; /** The paths the agent read. */ files: string[] }

export async function stageA(opts: { files: string[]; readAs?: Record<string, ReadAs[]>; launchDate?: string | null; agentItems?: AgentItem[]; agent?: AgentReading | null }): Promise<PlanDraft> {
  const files = [];
  for (const p of opts.files) files.push(await loadFile(p));
  const a = opts.agent;
  return extractPlan({ files, readAs: opts.readAs, launchDate: opts.launchDate ?? null, agentItems: a?.items ?? opts.agentItems, agentTeams: a?.teams, agentLaunchDate: a?.launchDate ?? null, agentEpicKeys: a?.epicKeys, agentOnly: !!a, agentFiles: a?.files.map((p) => basename(p)) });
}

export async function stageB(opts: { plan: PlanDraft; epicKey: string | null; source: SourceSpec; noSearch?: string[] }): Promise<ReleaseTarget> {
  return withSource(opts.source, (src) => resolveRelease({ plan: opts.plan, source: src, epicKey: opts.epicKey, noSearch: opts.noSearch }));
}

export async function stageC(opts: { plan: PlanDraft; target: ReleaseTarget; source: SourceSpec; label: string; readAt?: string }): Promise<Release> {
  return withSource(opts.source, (src) => readJira({ plan: opts.plan, target: opts.target, source: src, snapshotLabel: opts.label, readAt: opts.readAt }));
}

export function analyzeStep(opts: { plan: PlanDraft; target: ReleaseTarget; release: Release; goNoGo?: string | null; analyzedAt?: string }): Findings {
  return analyze({ plan: opts.plan, target: opts.target, release: opts.release, templates: loadTemplates(), phrases: loadPhrases(), goNoGo: opts.goNoGo, analyzedAt: opts.analyzedAt });
}

export function statusStep(opts: { plan: PlanDraft; target: ReleaseTarget; release: Release; findings: Findings; previous: Run | null; previousLabel: string | null }): Status {
  const previous = opts.previous ? { release: opts.previous.release, teams: opts.previous.teams, snapshot_label: opts.previousLabel ?? opts.previous.release.snapshot_label } : null;
  return computeStatus({ plan: opts.plan, target: opts.target, release: opts.release, findings: opts.findings, previous });
}

// ---------- saved runs ----------

export function runDir(runsRoot: string, epic: string): string { return join(runsRoot, epic); }

export function listRunLabels(runsRoot: string, epic: string): string[] {
  const dir = runDir(runsRoot, epic);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
}

export function loadRun(runsRoot: string, epic: string, label: string): Run {
  return Run.parse(JSON.parse(readFileSync(join(runDir(runsRoot, epic), `${label}.json`), "utf8")));
}

/** The newest saved run with a label before this one, for change notes. */
export function previousRun(runsRoot: string, epic: string, label: string): { run: Run; label: string } | null {
  const before = listRunLabels(runsRoot, epic).filter((l) => l < label);
  if (!before.length) return null;
  const l = before[before.length - 1];
  return { run: loadRun(runsRoot, epic, l), label: l };
}

export function assembleRun(parts: { plan: PlanDraft; target: ReleaseTarget; release: Release; findings: Findings; status: Status }): Run {
  return Run.parse({ plan: parts.plan, target: parts.target, release: parts.release, findings: parts.findings.findings, linkage_gaps: parts.findings.linkage_gaps, teams: parts.status.teams });
}

/** Writes runs/<epic>/<label>.json and the five stage files under runs/<epic>/<label>/. */
export function saveRun(runsRoot: string, epic: string, label: string, parts: { plan: PlanDraft; target: ReleaseTarget; release: Release; findings: Findings; status: Status }): { runFile: string; run: Run } {
  const run = assembleRun(parts);
  const dir = runDir(runsRoot, epic);
  mkdirSync(join(dir, label), { recursive: true });
  const w = (name: string, data: unknown) => writeFileSync(join(dir, label, name), JSON.stringify(data, null, 2) + "\n");
  w("plan-draft.json", parts.plan); w("release-target.json", parts.target); w("release.json", parts.release); w("findings.json", parts.findings); w("status.json", parts.status);
  const runFile = join(dir, `${label}.json`);
  writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n");
  return { runFile: resolve(runFile), run };
}

// ---------- the whole thing ----------

export type Stage = "plan" | "target" | "release" | "findings" | "status" | "saved";

export interface ReviewInput {
  files: string[];
  /** Stop after this stage, leaving its file under runs/<epic>/<label>/ for the person to confirm or edit. */
  stopAfter?: "plan" | "target" | null;
  /** Reuse confirmed stage files found under runs/<epic>/<label>/ instead of recomputing them. */
  resume?: boolean;
  readAs?: Record<string, ReadAs[]>;
  launchDate?: string | null;
  /** Items the agent extracted by reading the plan files itself (throughline-reader/SKILL.md); each must quote its file or it is dropped. */
  agentItems?: AgentItem[];
  epicKey: string | null;
  source: SourceSpec;
  label?: string;
  noSearch?: string[];
  goNoGo?: string | null;
  runsRoot?: string;
  readAt?: string;
  analyzedAt?: string;
  onStage?: (stage: Stage, detail: string) => void;
}

export type ReviewResult =
  | { stopped: "plan"; file: string; plan: PlanDraft }
  | { stopped: "target"; file: string; plan: PlanDraft; target: ReleaseTarget }
  | { stopped: null; runFile: string; run: Run; label: string; findings: Findings; status: Status };

/** Where a stage file lives while the person confirms it. The epic is only known after Stage B, so Stage A's file sits under the key the person gave. */
export function stageFile(runsRoot: string, epic: string, label: string, name: "plan-draft.json" | "release-target.json"): string {
  return join(runDir(runsRoot, epic), label, name);
}

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const label = input.label ?? todayLabel();
  const runsRoot = input.runsRoot ?? "runs";
  const say = input.onStage ?? (() => {});
  const keyForFiles = (input.epicKey ?? "unknown-epic").toUpperCase();
  const keep = (name: "plan-draft.json" | "release-target.json", data: unknown) => {
    const f = stageFile(runsRoot, keyForFiles, label, name);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
    return resolve(f);
  };
  const reuse = <T>(name: "plan-draft.json" | "release-target.json", schema: { parse(x: unknown): T }): T | null => {
    const f = stageFile(runsRoot, keyForFiles, label, name);
    return input.resume && existsSync(f) ? schema.parse(JSON.parse(readFileSync(f, "utf8"))) : null;
  };

  let plan = reuse("plan-draft.json", PlanDraft);
  if (plan) say("plan", `reused confirmed ${stageFile(runsRoot, keyForFiles, label, "plan-draft.json")}: ${plan.items.length} plan items`);
  else {
    plan = await stageA({ files: input.files, readAs: input.readAs, launchDate: input.launchDate, agentItems: input.agentItems });
    say("plan", `${plan.items.length} plan items, ${plan.teams.length} teams, ${plan.warnings.length} warnings`);
  }
  if (input.stopAfter === "plan") return { stopped: "plan", file: keep("plan-draft.json", plan), plan };

  let target = reuse("release-target.json", ReleaseTarget);
  if (target) say("target", `reused confirmed ${stageFile(runsRoot, keyForFiles, label, "release-target.json")}: epic ${target.epic.key}`);
  else {
    target = await stageB({ plan, epicKey: input.epicKey, source: input.source, noSearch: input.noSearch });
    say("target", `epic ${target.epic.key}, ${target.projects.filter((p) => p.match !== "unresolved").length}/${target.projects.length} teams resolved`);
  }
  if (input.stopAfter === "target") return { stopped: "target", file: keep("release-target.json", target), plan, target };

  const release = await stageC({ plan, target, source: input.source, label, readAt: input.readAt });
  say("release", `${release.stories.length} stories, ${release.related.length} related, ${release.search_candidates.length} search candidates`);
  const findings = analyzeStep({ plan, target, release, goNoGo: input.goNoGo, analyzedAt: input.analyzedAt });
  say("findings", `${findings.findings.length} findings (${findings.findings.filter((f) => f.shown).length} shown), ${findings.linkage_gaps.length} linkage gaps`);
  const prev = previousRun(runsRoot, target.epic.key, label);
  const status = statusStep({ plan, target, release, findings, previous: prev?.run ?? null, previousLabel: prev?.label ?? null });
  say("status", status.teams.map((t) => `${t.team}: ${t.status}`).join(", ") + (prev ? ` (compared with ${prev.label})` : " (first run)"));
  const saved = saveRun(runsRoot, target.epic.key, label, { plan, target, release, findings, status });
  say("saved", saved.runFile);
  return { stopped: null, ...saved, label, findings, status };
}

/** Keep the unresolved-team overrides the person made in the GUI (project choice or "don't search"). */
export function applyProjectChoices(target: ReleaseTarget, choices: Record<string, string | "skip">): ReleaseTarget {
  const projects = target.projects.map((p) => {
    const c = choices[p.team];
    if (!c) return p;
    if (c === "skip") return { ...p, search: false };
    return { ...p, jira_project: c, match: p.match === "unresolved" ? ("name" as const) : p.match, evidence: "Chosen by the reviewer" };
  });
  return { ...target, projects };
}

export type { Team };

// ---------- early stages: skills/throughline-starter ----------

import { Starter, type Signal, type PlanFile } from "@throughline/schemas";
import { type LoadedFile } from "../../skills/throughline-reader/scripts/lib/files.js";
import { classifyFile } from "../../skills/throughline-reader/scripts/lib/plan-extract.js";
import { loadRules, DEFAULT_RULES, type SignalRules } from "../../skills/throughline-starter/scripts/lib/config.js";
import { addAgentSignals, type AgentSignal, readSignals, projectName } from "../../skills/throughline-starter/scripts/lib/signals.js";
import { loadDirectory, findTeam, type DirectoryEntry , directoryFromAgentTeams } from "../../skills/throughline-starter/scripts/lib/directory.js";
import { suggest } from "../../skills/throughline-starter/scripts/lib/starter.js";
import { coverage, readApprovalTickets } from "../../skills/throughline-starter/scripts/lib/coverage.js";

export type StarterStage = "signals" | "suggest" | "people" | "target" | "release" | "coverage" | "saved";

export interface StarterInput {
  stage: "starting" | "building";
  /** The PRD (any format) and, optionally, a directory or team list; files are told apart by content. */
  files: string[];
  /** Files to read as the directory regardless of content. */
  directoryFiles?: string[];
  rulesPath?: string;
  excludeSignals?: string[];
  /** Sentences the agent found by reading the PRD itself, each with the rule ids it is an instance of (throughline-starter/SKILL.md). */
  agentSignals?: AgentSignal[];
  /** Building only. */
  epicKey?: string | null;
  /** Building: a team's Jira project the person linked by hand (the reading missed it), or "skip"; applied before the work
   *  is searched, so that project's tickets count for the team. */
  teamProjects?: Record<string, string | "skip">;
  source?: SourceSpec;
  label?: string;
  runsRoot?: string;
  analyzedAt?: string;
  readAt?: string;
  onStage?: (stage: StarterStage, detail: string) => void;
}

export interface StarterInputs { docs: LoadedFile[]; directory: DirectoryEntry[]; files: PlanFile[]; project: string; warnings: string[] }

/** Load the files and tell the PRD from the directory. */
export async function readStarterInputs(files: string[], directoryFiles: string[] = [], agent?: AgentReading | null): Promise<StarterInputs> {
  const docs: LoadedFile[] = [], directory: DirectoryEntry[] = [], out: PlanFile[] = [], warnings: string[] = [];
  const dirSet = new Set(directoryFiles.map((p) => resolve(p)));
  const agentSet = new Set((agent?.files ?? []).map((p) => resolve(p)));
  for (const p of files) {
    const f = await loadFile(p);
    warnings.push(...f.warnings);
    const isDir = dirSet.has(resolve(p)) || classifyFile(f).includes("teams_and_owners");
    if (isDir && agent && agentSet.has(resolve(p))) {
      // A team list the agent read: its teams stand in for the parsed ones, each name checked against the file.
      const unreadable = !f.text && !f.rows && !f.data && !f.segments;
      const mine = agent.teams.filter((t) => t.source?.file === f.name && t.name && (unreadable || containsQuote(f.text, t.name)));
      const entries = directoryFromAgentTeams(mine);
      directory.push(...entries);
      out.push({ name: f.name, read_as: ["teams_and_owners"], notes: `${entries.length} teams · ${entries.reduce((n, e) => n + e.people.length, 0)} people · read by the agent` });
    } else if (isDir) {
      const entries = loadDirectory(f);
      directory.push(...entries);
      out.push({ name: f.name, read_as: ["teams_and_owners"], notes: `${entries.length} teams · ${entries.reduce((n, e) => n + e.people.length, 0)} people` });
    } else {
      docs.push(f);
      out.push({ name: f.name, read_as: ["plan_items"], notes: "" });
    }
  }
  return { docs, directory, files: out, project: projectName(docs), warnings };
}

export function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"; }

/** Where a starter run is saved: runs/<epic>/<label>.building.json or runs/<project-slug>/<label>.starting.json. */
export function starterKey(stage: "starting" | "building", project: string, epic: string | null): string {
  return stage === "building" && epic ? epic : slug(project);
}
export function listStarterLabels(runsRoot: string, key: string, stage: "starting" | "building"): string[] {
  const dir = runDir(runsRoot, key);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\.${stage}\\.json$`);
  return readdirSync(dir).map((f) => f.match(re)?.[1]).filter((x): x is string => !!x).sort();
}
export function loadStarter(runsRoot: string, key: string, stage: "starting" | "building", label: string): Starter {
  return Starter.parse(JSON.parse(readFileSync(join(runDir(runsRoot, key), `${label}.${stage}.json`), "utf8")));
}

/** Signals and what they imply, without Jira: shared by both stages and by the GUI's plan step. */
export function starterSignals(inputs: StarterInputs, rules: SignalRules, excludeSignals: string[] = [], agentSignals: AgentSignal[] = [], agentOnly = false) {
  // With the agent reading everything, the rules' own scan of the PRD is skipped: the signals are the agent's, checked against the file.
  const merged = addAgentSignals(inputs.docs, rules, agentOnly ? [] : readSignals(inputs.docs, rules), agentSignals);
  const signals = merged.signals;
  const s = suggest({ signals, rules, directory: inputs.directory, excludeSignals });
  const files = inputs.files.map((f) => f.read_as.includes("plan_items") ? { ...f, notes: `${signals.filter((g) => g.file === f.name).length} signals about teams and approvals` } : f);
  return { signals, files, agent_added: merged.added, warnings: merged.warnings, ...s };
}

/** The plan Stage B needs at the early stages: Stage A's plan with the needed teams added (directory projects as hints).
 *  A PRD has few dated items, so Stage A's item warnings are dropped; the files carry the signal counts. */
export async function starterPlan(inputs: StarterInputs, sig: { teams: { team: string }[]; files: PlanFile[] }, filePaths: string[], agent?: AgentReading | null): Promise<PlanDraft> {
  const readAs: Record<string, ReadAs[]> = {};
  for (const f of inputs.files) readAs[f.name] = f.read_as;
  const plan = await stageA({ files: filePaths, readAs, agent });
  plan.files = sig.files;
  plan.warnings = [...inputs.warnings, ...plan.warnings.filter((w) => !/no owning team found|No launch date found|read as plan items/.test(w))];
  const needed = sig.teams;
  for (const n of needed) {
    const existing = plan.teams.find((t) => t.name.toLowerCase() === n.team.toLowerCase());
    const d = findTeam(inputs.directory, n.team);
    if (existing) { if (!existing.mentioned_in.includes("signals")) existing.mentioned_in.push("signals"); if (!existing.jira_project_hint && d?.project) existing.jira_project_hint = d.project; }
    else plan.teams.push({ name: n.team, mentioned_in: ["signals"], jira_project_hint: d?.project ?? null, owners: d?.people.map((p) => p.title ? `${p.name} (${p.title})` : p.name) ?? [], components: [], role: null, project_keys_mentioned: [] });
  }
  return plan;
}

export async function runStarter(input: StarterInput): Promise<{ starter: Starter; file: string }> {
  const label = input.label ?? todayLabel();
  const runsRoot = input.runsRoot ?? "runs";
  const say = input.onStage ?? (() => {});
  const rules = loadRules(input.rulesPath ?? DEFAULT_RULES);
  const inputs = await readStarterInputs(input.files, input.directoryFiles);
  if (!inputs.docs.length) throw new Error("No PRD or plan file: every file was read as a team list or directory.");
  const exclude = input.excludeSignals ?? [];
  const agent = input.agentSignals ?? [];
  const sig = starterSignals(inputs, rules, exclude, agent);
  say("signals", `${sig.signals.length} signals in ${inputs.docs.map((d) => d.name).join(", ")}${agent.length ? ` (${sig.agent_added} of ${agent.length} read by the agent added)` : ""}${exclude.length ? ` (${exclude.length} unticked)` : ""}`);
  say("suggest", `${sig.teams.length} teams, ${sig.approvals.length} approvals`);
  say("people", inputs.directory.length ? `${sig.teams.filter((t) => t.contact).length} of ${sig.teams.length} teams have a contact in the directory` : "no directory: teams without names");
  const warnings = [...inputs.warnings, ...sig.warnings];
  const base = {
    schema_version: 1 as const, stage: input.stage, project: inputs.project, label, analyzed_at: input.analyzedAt ?? new Date().toISOString(),
    files: sig.files, directory_given: inputs.directory.length > 0, epic: null as string | null, snapshot_label: null as string | null,
    excluded_signals: exclude, signals: sig.signals, teams: sig.teams, approvals: sig.approvals, coverage: [] as Starter["coverage"], approval_status: [] as Starter["approval_status"],
    next_actions: sig.next_actions, warnings,
  };
  let starter: Starter;
  if (input.stage === "starting") {
    starter = Starter.parse(base);
  } else {
    if (!input.epicKey || !input.source) throw new Error("The building stage needs --epic and a Jira source.");
    const plan = await starterPlan(inputs, sig, input.files);
    const target = applyProjectChoices(await stageB({ plan, epicKey: input.epicKey, source: input.source }), input.teamProjects ?? {});
    say("target", `epic ${target.epic.key}, ${target.projects.filter((p) => p.jira_project).length}/${target.projects.length} needed teams have a Jira project`);
    const release = await stageC({ plan, target, source: input.source, label, readAt: input.readAt });
    say("release", `${release.stories.length} stories, ${release.related.length} related, ${release.search_candidates.length} search candidates`);
    const hits = await withSource(input.source, (src) => readApprovalTickets({ source: src, target, approvals: sig.approvals, rules, directory: inputs.directory }));
    const cov = coverage({ needed: sig.teams, approvals: sig.approvals, release, target, directory: inputs.directory, rules, approvalHits: hits.hits, searched: hits.searched });
    say("coverage", `${cov.coverage.filter((c) => c.state === "covered").length} of ${cov.coverage.length} teams covered; ${cov.approval_status.filter((a) => a.state === "not_started").length} approvals not started`);
    // Needed teams without a Jira project are expected here (Privacy, Legal...); one line says so instead of one warning each.
    const noProject = target.projects.filter((p) => !p.jira_project).map((p) => p.team);
    const targetWarnings = target.warnings.filter((w) => !/: unresolved\. /.test(w) && !/in the team list but not in the plan/.test(w));
    if (noProject.length) targetWarnings.unshift(`No Jira project for ${noProject.join(", ")}: checked by assignee only.`);
    starter = Starter.parse({ ...base, epic: target.epic.key, snapshot_label: release.snapshot_label, coverage: cov.coverage, approval_status: cov.approval_status, next_actions: cov.next_actions, warnings: [...warnings, ...targetWarnings, ...hits.warnings, ...cov.warnings] });
  }
  const key = starterKey(input.stage, inputs.project, starter.epic);
  const dir = runDir(runsRoot, key);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${label}.${input.stage}.json`);
  writeFileSync(file, JSON.stringify(starter, null, 2) + "\n");
  say("saved", resolve(file));
  return { starter, file: resolve(file) };
}
