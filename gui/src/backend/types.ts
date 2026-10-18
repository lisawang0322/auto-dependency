/**
 * Interfaces the GUI talks to. Today they are backed by fixture and run files (fixtureBackend.ts),
 * a simulated OAuth flow (stubJira.ts) and localStorage (decisionStore.ts). A live agent can replace
 * them without touching the screens.
 */
import type { PlanDraft, ReleaseTarget, Run } from "@rrr/schemas";

export type FileKind = "plan" | "checks" | "teams" | "other";

export interface UploadedFile {
  id: string;
  name: string;
  size: string;
  kind: FileKind;
  sample: boolean;
}

export interface RunSummary {
  id: string;     // snapshot label, e.g. "2026-11-13"
  label: string;  // "Nov 13"
}

export type ProgressStage = 0 | 1 | 2 | 3; // 0 reader running … 3 done

export interface ReviewBackend {
  /** Stage A. Stubbed: any upload with plan items gives the fixture plan-draft, filtered by what was read as what. */
  extractPlan(files: UploadedFile[]): Promise<PlanDraft>;
  /** Stage B. Stubbed: fixture release-target, with or without the team list. */
  resolveRelease(plan: PlanDraft, epicKey: string, hasTeamList: boolean): Promise<ReleaseTarget>;
  listRuns(epicKey: string): Promise<RunSummary[]>;
  loadRun(epicKey: string, runId: string): Promise<Run>;
  /** reader → analyzer → status. Stubbed: reports progress, then returns the latest saved run id. */
  runReview(plan: PlanDraft, target: ReleaseTarget, onProgress: (stage: ProgressStage) => void): Promise<string>;
}

export type JiraState = "off" | "consent" | "connecting" | "on";

export interface JiraConnection {
  readonly site: string;
  readonly scopes: { can: string[]; cannot: string[] };
  /** Open the authorization step. */
  start(): JiraState;
  /** The person accepted; resolves when connected. */
  accept(): Promise<JiraState>;
  cancel(): JiraState;
  disconnect(): JiraState;
}

export interface Decision {
  kind: "kept" | "dismissed";
  reason: string;
  at: string; // ISO
}
export type Decisions = Record<string, Decision>;
export interface LogEntry { time: string; text: string }
export interface RunDecisions { decisions: Decisions; log: LogEntry[] }

export interface DecisionStore {
  load(runKey: string): RunDecisions;
  save(runKey: string, data: RunDecisions): void;
}
