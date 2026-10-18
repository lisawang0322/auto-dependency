import { PlanDraft, ReleaseTarget, Run } from "@rrr/schemas";
import type { ReviewBackend, UploadedFile, RunSummary, ProgressStage } from "./types";
import planDraftJson from "../../../fixtures/ingest-142/plan-draft.json";
import planDraftNoTeamsJson from "../../../fixtures/ingest-142/plan-draft.no-team-list.json";
import targetJson from "../../../fixtures/ingest-142/release-target.json";
import targetNoTeamsJson from "../../../fixtures/ingest-142/release-target.no-team-list.json";
import run1110 from "../../../runs/INGEST-142/2026-11-10.json";
import run1113 from "../../../runs/INGEST-142/2026-11-13.json";
import porRaw from "../../../fixtures/ingest-142/docs/Ingestion-service-POR-v3.md?raw";
import checksRaw from "../../../fixtures/ingest-142/docs/launch-checklist.csv?raw";
import teamsRaw from "../../../fixtures/ingest-142/docs/team-list.yaml?raw";
import { fmtDate } from "../model/dates";

const RUNS: Record<string, Run> = {
  "2026-11-10": Run.parse(run1110),
  "2026-11-13": Run.parse(run1113),
};
const PLAN = PlanDraft.parse(planDraftJson);
const PLAN_NO_TEAMS = PlanDraft.parse(planDraftNoTeamsJson);
const TARGET = ReleaseTarget.parse(targetJson);
const TARGET_NO_TEAMS = ReleaseTarget.parse(targetNoTeamsJson);
const EPIC = TARGET.epic.key;

const kb = (s: string) => `${Math.max(1, Math.round(new TextEncoder().encode(s).length / 1024))} KB`;

/** The real sample files, with their real names and sizes. */
export const SAMPLE_FILES: UploadedFile[] = [
  { id: "s1", name: "Ingestion-service-POR-v3.md", size: `${kb(porRaw)} · sample`, kind: "plan", sample: true },
  { id: "s2", name: "launch-checklist.csv", size: `${kb(checksRaw)} · sample`, kind: "checks", sample: true },
  { id: "s3", name: "team-list.yaml", size: `${kb(teamsRaw)} · sample`, kind: "teams", sample: true },
];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FixtureBackend implements ReviewBackend {
  constructor(private delayMs = 300) {}

  async extractPlan(files: UploadedFile[]): Promise<PlanDraft> {
    await wait(this.delayMs);
    const has = (k: UploadedFile["kind"]) => files.some((f) => f.kind === k);
    if (!has("plan")) throw new Error("No file was read as plan items.");
    const base = has("teams") ? PLAN : PLAN_NO_TEAMS;
    const items = base.items.filter((i) => i.kind !== "checklist" || has("checks"));
    const kindOf = { plan: "plan_items", checks: "launch_checks", teams: "teams_and_owners" } as const;
    const fileEntries = files.map((f) => {
      const fx = base.files.find((b) => (f.kind !== "other" && b.read_as.includes(kindOf[f.kind])));
      return { name: f.name, read_as: f.kind === "other" ? [] : [kindOf[f.kind]], notes: fx ? fx.notes + (f.sample ? "" : " (prototype: read as the sample data)") : "Nothing used from this file" };
    });
    return { ...base, items, files: fileEntries, teams: base.teams.map((t) => ({ ...t, mentioned_in: t.mentioned_in.filter((m) => !m.includes("checklist") || has("checks")) })) };
  }

  async resolveRelease(_plan: PlanDraft, epicKey: string, hasTeamList: boolean): Promise<ReleaseTarget> {
    await wait(this.delayMs);
    if (epicKey !== EPIC) throw new Error(`${epicKey} is not in the sample data. The sample release is ${EPIC}.`);
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
}
