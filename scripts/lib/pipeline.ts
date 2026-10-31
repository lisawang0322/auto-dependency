/**
 * The orchestrator: reader (A, B, C) → analyzer → status → saved run, as plain functions so the CLI
 * (scripts/review.ts) and the local API server (server/index.ts) run exactly the same code.
 * Jira is only ever read. --source fixture reads a snapshot directory; --source rest reads Jira Cloud
 * over REST through the same request cache the MCP mode uses.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PlanDraft, ReleaseTarget, Release, Findings, Status, Run, ReadAs, type Team } from "@rrr/schemas";
import { loadFile } from "../../skills/release-reader/scripts/lib/files.js";
import { extractPlan } from "../../skills/release-reader/scripts/lib/plan-extract.js";
import { FixtureSource, type JiraSource } from "../../skills/release-reader/scripts/lib/jira-source.js";
import { JiraRest, runRestLoop, type RestCreds } from "../../skills/release-reader/scripts/lib/jira-rest.js";
import { resolveRelease } from "../../skills/release-reader/scripts/lib/resolve.js";
import { readJira } from "../../skills/release-reader/scripts/lib/read.js";
import { analyze } from "../../skills/release-analyzer/scripts/lib/analyze.js";
import { loadTemplates, loadPhrases } from "../../skills/release-analyzer/scripts/lib/config.js";
import { computeStatus } from "../../skills/release-status/scripts/lib/status.js";

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

export async function stageA(opts: { files: string[]; readAs?: Record<string, ReadAs[]>; launchDate?: string | null }): Promise<PlanDraft> {
  const files = [];
  for (const p of opts.files) files.push(await loadFile(p));
  return extractPlan({ files, readAs: opts.readAs, launchDate: opts.launchDate ?? null });
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
  readAs?: Record<string, ReadAs[]>;
  launchDate?: string | null;
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

export async function runReview(input: ReviewInput): Promise<{ runFile: string; run: Run; label: string; findings: Findings; status: Status }> {
  const label = input.label ?? todayLabel();
  const runsRoot = input.runsRoot ?? "runs";
  const say = input.onStage ?? (() => {});
  const plan = await stageA({ files: input.files, readAs: input.readAs, launchDate: input.launchDate });
  say("plan", `${plan.items.length} plan items, ${plan.teams.length} teams, ${plan.warnings.length} warnings`);
  const target = await stageB({ plan, epicKey: input.epicKey, source: input.source, noSearch: input.noSearch });
  say("target", `epic ${target.epic.key}, ${target.projects.filter((p) => p.match !== "unresolved").length}/${target.projects.length} teams resolved`);
  const release = await stageC({ plan, target, source: input.source, label, readAt: input.readAt });
  say("release", `${release.stories.length} stories, ${release.related.length} related, ${release.search_candidates.length} search candidates`);
  const findings = analyzeStep({ plan, target, release, goNoGo: input.goNoGo, analyzedAt: input.analyzedAt });
  say("findings", `${findings.findings.length} findings (${findings.findings.filter((f) => f.shown).length} shown), ${findings.linkage_gaps.length} linkage gaps`);
  const prev = previousRun(runsRoot, target.epic.key, label);
  const status = statusStep({ plan, target, release, findings, previous: prev?.run ?? null, previousLabel: prev?.label ?? null });
  say("status", status.teams.map((t) => `${t.team}: ${t.status}`).join(", ") + (prev ? ` (compared with ${prev.label})` : " (first run)"));
  const saved = saveRun(runsRoot, target.epic.key, label, { plan, target, release, findings, status });
  say("saved", saved.runFile);
  return { ...saved, label, findings, status };
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
