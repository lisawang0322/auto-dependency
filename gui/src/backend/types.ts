/**
 * Interfaces the GUI talks to. Two implementations: the sample-data demo (fixtureBackend.ts + stubJira.ts,
 * no server) and live mode (liveBackend.ts, talking to server/index.ts, which runs the real stages against
 * Jira). Decisions live in localStorage either way (decisionStore.ts).
 */
import type { PlanDraft, ReleaseTarget, Run } from "@rrr/schemas";

/** What a file is read as. "prd" and "plan" both feed Stage A's plan items; a PRD is the early stages' plan. */
export type FileKind = "prd" | "plan" | "checks" | "teams" | "other";
export const PLAN_KINDS: FileKind[] = ["prd", "plan"];

/** Where the project is (PRD R14). Only "launching" runs this semester; the other two are designed. */
export type Stage = "starting" | "building" | "launching";

export interface UploadedFile {
  id: string;
  name: string;
  size: string;
  kind: FileKind;
  sample: boolean;
  /** The browser File, for uploads in live mode. Sample files have none. */
  file?: File;
  /** Added by connecting the employee directory on the Connect apps step, not uploaded on the plan step. */
  via?: "directory";
}

export interface RunSummary {
  id: string;     // snapshot label, e.g. "2026-11-13"
  label: string;  // "Nov 13"
}

export type ProgressStage = 0 | 1 | 2 | 3; // 0 reader running … 3 done

export interface ReviewBackend {
  readonly mode: "sample" | "live";
  /** Stage A. Sample: the fixture plan-draft, filtered by what was read as what. Live: the real extractor. */
  extractPlan(files: UploadedFile[]): Promise<PlanDraft>;
  /** Stage B. Sample: fixture release-target, with or without the team list. Live: the epic is looked up in Jira. */
  resolveRelease(plan: PlanDraft, epicKey: string, hasTeamList: boolean): Promise<ReleaseTarget>;
  listRuns(epicKey: string): Promise<RunSummary[]>;
  loadRun(epicKey: string, runId: string): Promise<Run>;
  /** reader → analyzer → status; resolves to the saved run id. Sample: animated, then the latest saved run. */
  runReview(plan: PlanDraft, target: ReleaseTarget, onProgress: (stage: ProgressStage) => void): Promise<string>;
}

export type JiraState = "off" | "consent" | "connecting" | "on";

export interface JiraCredentials { site: string; email: string; token: string }

export interface JiraConnection {
  /** Shown once connected ("sample-company.atlassian.net"). */
  readonly site: string;
  readonly scopes: { can: string[]; cannot: string[] };
  /** Live mode asks for a site, email and API token instead of the simulated consent page. */
  readonly credentialsNeeded: boolean;
  /** The state to start in (live mode is already "on" when the server has credentials from its environment). */
  initialState(): Promise<JiraState>;
  /** Open the authorization step. */
  start(): JiraState;
  /** The person accepted (sample mode); resolves when connected. */
  accept(): Promise<JiraState>;
  /** The person entered credentials (live mode); resolves when connected, throws with a message otherwise. */
  connect(creds: JiraCredentials): Promise<JiraState>;
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
/** Keep/dismiss per finding, the log, and which next actions were ticked off (R16), per run. */
export interface RunDecisions { decisions: Decisions; log: LogEntry[]; actionsDone?: Record<string, boolean> }

export interface DecisionStore {
  load(runKey: string): RunDecisions;
  save(runKey: string, data: RunDecisions): void;
}
