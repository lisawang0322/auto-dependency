import { PlanDraft, ReleaseTarget, Run, Starter, Signal, type Stage } from "@rrr/schemas";
import type { ReviewBackend, UploadedFile, RunSummary, ProgressStage, PlanExtract, StarterRunInput } from "./types";
import { PLAN_KINDS } from "./types";
import planDraftJson from "../../../fixtures/ingest-142/plan-draft.json";
import planDraftNoTeamsJson from "../../../fixtures/ingest-142/plan-draft.no-team-list.json";
import targetJson from "../../../fixtures/ingest-142/release-target.json";
import targetNoTeamsJson from "../../../fixtures/ingest-142/release-target.no-team-list.json";
import run1110 from "../../../runs/INGEST-142/2026-11-10.json";
import run1113 from "../../../runs/INGEST-142/2026-11-13.json";
import starterPlanJson from "../../../fixtures/ingest-142/starter/plan-draft.json";
import starterTargetJson from "../../../fixtures/ingest-142/starter/release-target.json";
import startingJson from "../../../fixtures/ingest-142/starter/starting.json";
import startingNoDirJson from "../../../fixtures/ingest-142/starter/starting.no-directory.json";
import buildingJson from "../../../fixtures/ingest-142/starter/building.2026-11-13.json";
import porRaw from "../../../fixtures/ingest-142/docs/Ingestion-service-POR-v3.md?raw";
import checksRaw from "../../../fixtures/ingest-142/docs/launch-checklist.csv?raw";
import teamsRaw from "../../../fixtures/ingest-142/docs/team-list.yaml?raw";
import prdRaw from "../../../fixtures/ingest-142/docs/ingestion-service-PRD.md?raw";
import directoryRaw from "../../../fixtures/ingest-142/docs/directory.yaml?raw";
import { fmtDate } from "../model/dates";

const RUNS: Record<string, Run> = {
  "2026-11-10": Run.parse(run1110),
  "2026-11-13": Run.parse(run1113),
};
const PLAN = PlanDraft.parse(planDraftJson);
const PLAN_NO_TEAMS = PlanDraft.parse(planDraftNoTeamsJson);
const TARGET = ReleaseTarget.parse(targetJson);
const TARGET_NO_TEAMS = ReleaseTarget.parse(targetNoTeamsJson);
const STARTER_PLAN = PlanDraft.parse(starterPlanJson);
const STARTER_TARGET = ReleaseTarget.parse(starterTargetJson);
const STARTING = Starter.parse(startingJson);
const STARTING_NO_DIR = Starter.parse(startingNoDirJson);
const BUILDING = Starter.parse(buildingJson);
const EPIC = TARGET.epic.key;

const kb = (s: string) => `${Math.max(1, Math.round(new TextEncoder().encode(s).length / 1024))} KB`;

/** The real sample files, with their real names and sizes. */
export const SAMPLE_TEAM_LIST: UploadedFile = { id: "s3", name: "team-list.yaml", size: `${kb(teamsRaw)} · sample`, kind: "teams", sample: true };
export const SAMPLE_DIRECTORY: UploadedFile = { id: "s4", name: "directory.yaml", size: `${kb(directoryRaw)} · sample`, kind: "teams", sample: true };
export const SAMPLE_PRD: UploadedFile = { id: "s5", name: "ingestion-service-PRD.md", size: `${kb(prdRaw)} · sample`, kind: "prd", sample: true };
export const SAMPLE_FILES: UploadedFile[] = [
  { id: "s1", name: "Ingestion-service-POR-v3.md", size: `${kb(porRaw)} · sample`, kind: "plan", sample: true },
  { id: "s2", name: "launch-checklist.csv", size: `${kb(checksRaw)} · sample`, kind: "checks", sample: true },
  SAMPLE_TEAM_LIST,
];
/** What "Use sample files" loads per stage: the launch review's three files, or the PRD (the directory is connected on step 3). */
export function sampleFilesFor(stage: Stage): UploadedFile[] { return stage === "launching" ? SAMPLE_FILES : [SAMPLE_PRD]; }

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FixtureBackend implements ReviewBackend {
  readonly mode = "sample" as const;
  constructor(private delayMs = 300) {}

  async extractPlan(files: UploadedFile[], stage: Stage): Promise<PlanExtract> {
    await wait(this.delayMs);
    const has = (k: UploadedFile["kind"]) => files.some((f) => f.kind === k);
    if (!has("plan") && !has("prd")) throw new Error("No file was read as a plan.");
    const kindOf = { prd: "plan_items", plan: "plan_items", checks: "launch_checks", teams: "teams_and_owners" } as const;
    const teamsNote = (f: UploadedFile) => (f.name === "directory.yaml" ? "10 teams · 21 people" : PLAN.files.find((b) => b.read_as.includes("teams_and_owners"))?.notes ?? "");
    if (stage !== "launching") {
      // The early stages: the sample PRD's signals and the plan the apps step needs (teams the signals name).
      const signals = STARTING.signals.filter((g) => files.some((f) => f.name === g.file || (!f.sample && PLAN_KINDS.includes(f.kind))));
      const fileEntries = files.map((f) => {
        if (f.kind === "other") return { name: f.name, read_as: [], notes: "Nothing used from this file" };
        if (f.kind === "teams") return { name: f.name, read_as: ["teams_and_owners" as const], notes: teamsNote(f) };
        return { name: f.name, read_as: ["plan_items" as const], notes: `${signals.filter((g) => g.file === f.name).length || (f.sample ? 0 : signals.length)} signals about teams and approvals${f.sample ? "" : " (prototype: read as the sample PRD)"}` };
      });
      return { plan: { ...STARTER_PLAN, files: fileEntries }, signals: signals.map((g) => Signal.parse(g)), project: STARTING.project };
    }
    const base = has("teams") ? PLAN : PLAN_NO_TEAMS;
    const items = base.items.filter((i) => i.kind !== "checklist" || has("checks"));
    const fileEntries = files.map((f) => {
      if (f.kind === "other") return { name: f.name, read_as: [], notes: "Nothing used from this file" };
      if (f.kind === "teams") return { name: f.name, read_as: [kindOf.teams], notes: teamsNote(f) + (f.sample ? "" : " (prototype: read as the sample data)") };
      const ra = kindOf[f.kind as keyof typeof kindOf];
      const fx = base.files.find((b) => b.read_as.includes(ra));
      return { name: f.name, read_as: [ra], notes: fx ? fx.notes + (f.sample ? "" : " (prototype: read as the sample data)") : "Nothing used from this file" };
    });
    return { plan: { ...base, items, files: fileEntries, teams: base.teams.map((t) => ({ ...t, mentioned_in: t.mentioned_in.filter((m) => !m.includes("checklist") || has("checks")) })) }, signals: [], project: null };
  }

  async resolveRelease(plan: PlanDraft, epicKey: string, hasTeamList: boolean): Promise<ReleaseTarget> {
    await wait(this.delayMs);
    if (epicKey !== EPIC) throw new Error(`${epicKey} is not in the sample data. The sample release is ${EPIC}.`);
    if (plan.files.some((f) => f.name === SAMPLE_PRD.name) || plan.items.length === 0) return structuredClone(STARTER_TARGET);
    return structuredClone(hasTeamList ? TARGET : TARGET_NO_TEAMS);
  }

  async listRuns(epicKey: string): Promise<RunSummary[]> {
    if (epicKey !== EPIC) return [];
    return Object.keys(RUNS).sort().map((id) => ({ id, label: fmtDate(id) }));
  }

  async loadRun(epicKey: string, runId: string): Promise<Run> {
    const r = RUNS[runId];
    if (epicKey !== EPIC || !r) throw new Error(`No saved run ${runId} for ${epicKey}.`);
    return r;
  }

  async runReview(_plan: PlanDraft, _target: ReleaseTarget, onProgress: (s: ProgressStage) => void): Promise<string> {
    for (const s of [0, 1, 2] as const) { onProgress(s); await wait(this.delayMs * 3); }
    onProgress(3);
    const ids = Object.keys(RUNS).sort();
    return ids[ids.length - 1];
  }

  async runStarter(input: StarterRunInput, onProgress: (s: ProgressStage) => void): Promise<Starter> {
    for (const s of [0, 1, 2] as const) { onProgress(s); await wait(this.delayMs * 3); }
    onProgress(3);
    const dir = input.files.some((f) => f.kind === "teams");
    if (input.stage === "starting") return { ...structuredClone(dir ? STARTING : STARTING_NO_DIR), excluded_signals: input.excludeSignals };
    if (input.epic !== EPIC) throw new Error(`${input.epic} is not in the sample data. The sample release is ${EPIC}.`);
    const b = structuredClone(BUILDING);
    if (!dir) { // the sample building run was made with the directory; without it nobody has a name
      b.directory_given = false;
      for (const c of b.coverage) c.contact = null;
      for (const a of b.next_actions) a.who = a.team;
    }
    return { ...b, excluded_signals: input.excludeSignals };
  }
}
