/**
 * Interfaces the GUI talks to. Two implementations: the sample-data demo (fixtureBackend.ts + stubJira.ts,
 * no server) and live mode (liveBackend.ts, talking to server/index.ts, which runs the real stages against
 * Jira). Decisions live in localStorage either way (decisionStore.ts).
 */
import type { PlanDraft, ReleaseTarget, Run, Signal, Starter } from "@rrr/schemas";

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
  /** Added by connecting the employee directory (on Get started or Connect apps), not uploaded on the plan step. */
  via?: "directory";
  /** A directory the server holds (Microsoft Entra ID, Jira projects): no content travels; the server writes the merged team list. */
  source?: "server";
}

/** One connected directory layer, as the server reports it. */
export interface DirectorySummary { label: string; teams: number; people: number; connected_at: string }
/** The two server-side layers of the employee directory (PRD "Employee directory sources"): people from the identity provider, teams from Jira. */
export interface DirectoryInfo { entra: { available: boolean; connected: DirectorySummary | null }; jira: { available: boolean; connected: DirectorySummary | null } }
export type DirectorySourceId = "entra" | "jira";
export interface DirectoryConnection {
  info(): Promise<DirectoryInfo>;
  /** Microsoft Entra ID through the sign-in the person already has: consent in a popup, then the server reads names, titles, departments and managers. */
  connectEntra(): Promise<DirectoryInfo>;
  /** Jira's projects as teams, through the Jira connection: each project, its lead and who is assigned its work. */
  connectJira(): Promise<DirectoryInfo>;
  disconnect(source: DirectorySourceId): Promise<DirectoryInfo>;
}

export interface RunSummary {
  id: string;     // snapshot label, e.g. "2026-11-13"
  label: string;  // "Nov 13"
}

export type ProgressStage = 0 | 1 | 2 | 3; // 0 reader running … 3 done

/** The agent that can read uploads on the person's behalf (Devin, set up by the company on the server). */
export interface AgentInfo { available: boolean; name: string; /** Devin tiers the person may pick (v3); empty when there is no choice. */ modes?: string[]; default_mode?: string | null }
/** Whether the person let the agent read their files; asked once, kept in localStorage. */
export type AgentConsent = "unknown" | "yes" | "no";
/** 0 uploading · 1 the agent is reading · 2 checking quotes · 3 done */
export type AgentReadStage = 0 | 1 | 2 | 3;
/** What the agent did with the uploads (server/index.ts AgentRead). */
export interface AgentRead {
  name: string;
  status: "done" | "failed";
  cached: boolean;
  session_url: string | null;
  mode?: string | null;
  /** Plan items (not checks). */
  items_read: number;
  signals_read: number;
  /** Checks read from checklists and how many apply to this release; teams read from team lists. */
  checks_read?: number;
  checks_apply?: number;
  teams_read?: number;
  files_read: { name: string; how: string }[];
  unreadable: { name: string; reason: string }[];
  warnings: string[];
  error: string | null;
}
/** How far along a reading is, from the server's job: 0–100 and what is happening. */
export interface ReadProgress { pct: number; detail: string }
export interface ExtractOptions { agent?: boolean; onProgress?: (s: AgentReadStage, progress?: ReadProgress) => void }

/** Stage A's result. The early stages add the PRD's signals and the project name (release-starter). */
export interface PlanExtract { plan: PlanDraft; signals: Signal[]; project: string | null; agent?: AgentRead | null }

export interface StarterRunInput { stage: "starting" | "building"; files: UploadedFile[]; excludeSignals: string[]; epic: string | null }

export interface ReviewBackend {
  readonly mode: "sample" | "live";
  readonly agent: AgentInfo;
  readonly directory: DirectoryConnection;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  /** Stage A. Sample: the fixture plan-draft, filtered by what was read as what. Live: the real extractor.
   *  With opts.agent the agent reads the documents first (a job; onProgress follows it) and its items go through the quote check. */
  extractPlan(files: UploadedFile[], stage: Stage, opts?: ExtractOptions): Promise<PlanExtract>;
  /** Stage B. Sample: fixture release-target, with or without the team list. Live: the epic is looked up in Jira. */
  resolveRelease(plan: PlanDraft, epicKey: string, hasTeamList: boolean): Promise<ReleaseTarget>;
  listRuns(epicKey: string): Promise<RunSummary[]>;
  loadRun(epicKey: string, runId: string): Promise<Run>;
  /** reader → analyzer → status; resolves to the saved run id. Sample: animated, then the latest saved run. */
  runReview(plan: PlanDraft, target: ReleaseTarget, onProgress: (stage: ProgressStage) => void): Promise<string>;
  /** The early stages (release-starter): signals → teams, contacts, approvals, actions; building adds Jira coverage. */
  runStarter(input: StarterRunInput, onProgress: (stage: ProgressStage) => void): Promise<Starter>;
}

export type JiraState = "off" | "consent" | "connecting" | "on";

export interface JiraCredentials { site: string; email: string; token: string }

export interface JiraConnection {
  /** Shown once connected ("sample-company.atlassian.net"). */
  readonly site: string;
  readonly scopes: { can: string[]; cannot: string[] };
  /** Live mode without Sign in with Atlassian asks for a site, email and API token instead of the simulated consent page. */
  readonly credentialsNeeded: boolean;
  /** Live mode with Sign in with Atlassian set up on the server: connect through Atlassian's own consent page in a popup. */
  readonly oauthAvailable: boolean;
  /** How the current connection was made, for the card. */
  readonly method: "oauth" | "token" | "company" | "fixture" | null;
  /** Open Atlassian's sign-in in a popup and resolve when the server reports the connection (or the popup is closed). */
  startOAuth(): Promise<JiraState>;
  /** The person's Jira sites when they have more than one (OAuth), and which is in use. */
  sites(): Promise<{ sites: { id: string; url: string; name: string }[]; current: string | null }>;
  chooseSite(cloudId: string): Promise<JiraState>;
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
export interface RunDecisions { decisions: Decisions; log: LogEntry[]; actionsDone?: Record<string, boolean>; contacted?: Record<string, boolean> }

export interface DecisionStore {
  load(runKey: string): Promise<RunDecisions>;
  /** Fire and forget; the screen keeps its own copy. */
  save(runKey: string, data: RunDecisions): void;
}

/** Per-user settings kept by the server in live mode (and by the browser in sample mode). */
export interface Settings { agent_consent: AgentConsent; /** The chosen Devin tier, or null for the company default. */ agent_mode?: string | null }
/** The signed-in person (live mode with sign-in), or null. */
export interface UserInfo { id: string; name: string; email: string | null; org: string }
