import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanDraft, ReleaseTarget, Run, Signal, Starter, Commitment } from "@throughline/schemas";
import { fromStarter, fromLaunch, decide as decideCommitment } from "@throughline/schemas";
import { PLAN_KINDS, type ActionsGlance, type ReviewBackend, type JiraConnection, type DecisionStore, type UploadedFile, type FileKind, type JiraState, type RunSummary, type ProgressStage, type Stage, type AgentConsent, type AgentRead, type AgentReadStage, type ReadProgress, type UserInfo, type DirectoryInfo, type DirectorySourceId, type ProjectRecord, type ProjectStore, type ProjectData, type PathStep, type ProjectEvent, type ProjectSummary, type HistoryRecord } from "./backend/types";
import { storableFiles } from "./backend/projects";
import { sampleFiles, SAMPLE_DIRECTORY } from "./backend/fixtureBackend";
import { fmtDate } from "./model/dates";
import { applyChoices, type TeamChoice } from "./model/review";
import { GetStarted, STAGE_SHORT } from "./screens/GetStarted";
import { PlanDocuments } from "./screens/PlanDocuments";
import { PlanOfRecordDialog } from "./screens/PlanOfRecordDialog";
import { ConnectApps } from "./screens/ConnectApps";
import { Running } from "./screens/Running";
import { Review, type OwnerSource } from "./screens/Review";
import { EarlyResults } from "./screens/EarlyResults";
import { ProjectReview } from "./screens/ProjectReview";
import { Overview, type CheckItem, type NextUp } from "./screens/Overview";
import { allTeamsResolved } from "./model/review";

/** A project's places: its overview (the hub), plan, connections, review and history, the same at every point in its life;
 *  "start" (stage and organisation) opens from the overview, and on a new project's first visit. */
/** "results" names only the step bar's last step: a reviewed stage's results are the overview itself. */
export type Screen = "overview" | "start" | "plan" | "apps" | "running" | "results" | "history";

export interface AppProps {
  backend: ReviewBackend; jira: JiraConnection; store: DecisionStore; user?: UserInfo | null; initialConsent?: AgentConsent; initialMode?: string | null; onSignOut?: () => void;
  /** The project opened from the portal, and where to save it; without one the app is a one-off session (tests, embeds). */
  project?: ProjectRecord; projectStore?: ProjectStore; onHome?: () => void;
}

/** The phase a project is in, read from what it has, never chosen: a plan of record means preparing to launch, work
 *  tracked in Jira (connected, with the epic) means building, and anything else is just starting. */
export function phaseOf(hasPlanOfRecord: boolean, jiraOn: boolean, epicOk: boolean): Stage {
  return hasPlanOfRecord ? "launching" : jiraOn && epicOk ? "building" : "starting";
}

/** One account of a reading done in two parts (the PRD, then the plan of record): what both found, together. */
function mergeReads(a: AgentRead | null, b: AgentRead | null): AgentRead | null {
  if (!a || !b) return a ?? b;
  return {
    ...b, status: a.status === "failed" || b.status === "failed" ? "failed" : "done", cached: a.cached && b.cached, session_url: b.session_url ?? a.session_url,
    items_read: b.items_read, signals_read: a.signals_read, files_read: [...a.files_read, ...b.files_read], unreadable: [...a.unreadable, ...b.unreadable],
    warnings: [...a.warnings, ...b.warnings], error: a.error ?? b.error,
  };
}

export function guessKind(name: string, files: UploadedFile[]): FileKind {
  const n = name.toLowerCase();
  if (/check|readiness|gate/.test(n)) return "checks";
  if (/org|team|owner|raci|roster|directory/.test(n)) return "teams";
  if (/prd|one.?pager|brief|spec|requirements/.test(n)) return "prd";
  if (/por|plan.?of.?record|\.pptx?$|\.key$|deck|slides/.test(n)) return "plan";
  if (!files.some((f) => PLAN_KINDS.includes(f.kind))) return "plan";
  return "other";
}

export function App({ backend, jira, store, user = null, initialConsent = "unknown", initialMode = null, onSignOut, project: saved, projectStore, onHome }: AppProps) {
  // A saved project comes back as it was left: its files (kept on the server), its reading, epic, choices and results.
  const d: ProjectData = saved?.data ?? {};
  const restoredResults = !!d.confirmed && (!!d.runId || !!d.starter);
  /** Until its first review, a project is set up as steps; after that every visit starts at the overview. */
  const [screen, setScreen] = useState<Screen>(d.records?.length || restoredResults ? "overview" : d.files?.some((f) => f.via !== "directory") ? "plan" : "start");
  // The browser's Back and Forward move between screens: each screen the person goes to is a history entry. "Working on
  // it" is never kept as one, and the entry a pop lands on already names its screen, so nothing is pushed twice.
  const opened = useRef(true);
  useEffect(() => {
    const st = history.state as { screen?: Screen } | null;
    const first = opened.current;
    opened.current = false;
    if (st?.screen === screen) return;
    // Opening the project takes over the entry it was opened on, even when Back reopened it on another screen.
    if (first || !st?.screen || st.screen === "running") history.replaceState({ ...st, screen }, "");
    else history.pushState({ screen }, "");
  }, [screen]);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => { const sc = (e.state as { screen?: Screen } | null)?.screen; if (sc) { setOpenRecord(null); setScreen(sc === "running" ? "apps" : sc === "results" ? "overview" : sc); } };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const [name, setName] = useState(saved?.name ?? "New project");
  const [events, setEvents] = useState<ProjectEvent[]>(d.events ?? []);
  const [summary, setSummary] = useState<ProjectSummary | null>(d.summary ?? null);
  /** The current review's checklist, which the panel beside it shows (handed over by the review as it renders). */
  const [actionsGlance, setActionsGlance] = useState<ActionsGlance | null>(null);
  /** Every review, kept so it can be opened after the project moves on or is re-run. The current one takes the summary. */
  const [records, setRecords] = useState<HistoryRecord[]>(d.records ?? []);
  const [currentRecord, setCurrentRecord] = useState<string | null>(d.records?.length ? d.records[d.records.length - 1].id : null);
  /** What the project has promised, carried from stage to stage. A project saved before the list existed starts it from
   *  its early-stage reviews; its launch reviews join at the next run. */
  const [commitments, setCommitments] = useState<Commitment[]>(() => d.commitments?.length ? d.commitments
    : (d.records ?? []).reduce<Commitment[]>((l, r) => (r.starter ? fromStarter(l, r.starter, r.signalsOff ?? {}).list : l), []));
  const addRecord = useCallback((r: HistoryRecord) => { setRecords((cur) => (cur.some((x) => x.id === r.id) ? cur : [...cur, r])); setCurrentRecord(r.id); }, []);
  const logEvent = useCallback((text: string) => setEvents((e) => [...e, { at: new Date().toISOString(), text }]), []);
  const [files, setFiles] = useState<UploadedFile[]>(d.files ?? []);
  // Two readings, by what each file is: the plan of record's (plan) and the PRD's (earlyPlan). A project saved when a chosen
  // stage decided the one reading keeps it as the reading it was.
  const legacyEarly = d.earlyPlan === undefined && d.stage !== "launching";
  const [plan, setPlan] = useState<PlanDraft | null>(legacyEarly ? null : d.plan ?? null);
  const [earlyPlan, setEarlyPlan] = useState<PlanDraft | null>(legacyEarly ? d.plan ?? null : d.earlyPlan ?? null);
  const [signals, setSignals] = useState<Signal[]>(d.signals ?? []);
  const [signalsOff, setSignalsOff] = useState<Record<string, boolean>>(d.signalsOff ?? {});
  const [project, setProject] = useState<string | null>(d.project ?? null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planDates, setPlanDates] = useState<Record<string, string>>(d.planDates ?? {});
  const [planConfirmed, setPlanConfirmed] = useState(!!d.planConfirmed);
  /** The launch check without a plan of record, turned on by the person: each team read from its commitments and Jira. */
  const [launchCheck, setLaunchCheck] = useState(!!d.launchCheck);
  /** Adding a launch checklist or plan of record, in a dialog over the project (see addPlanOfRecord). */
  const [por, setPor] = useState<null | "pick" | "added" | "reading" | "checking">(null);
  const [porError, setPorError] = useState<string | null>(null);
  const openChecklist = () => { setPorError(null); setPor("pick"); };
  const [jiraState, setJiraState] = useState<JiraState>(d.jiraOn && backend.mode === "sample" ? "on" : "off");
  const [epic, setEpic] = useState(d.epic ?? "");
  const epicVal = epic.trim();
  const epicOk = /^[A-Z][A-Z0-9]+-\d+$/.test(epicVal);
  /** What the files are: a PRD (read for signals) and a plan of record (read for dated items), either or both. */
  const hasPrd = files.some((f) => f.kind === "prd");
  const hasPor = files.some((f) => f.kind === "plan");
  /** The phase, as the evidence shows it. It names the project's place and the history's records; it decides nothing. */
  /** Launch readiness from the commitments: on, with no plan of record (which brings its own launch review instead). */
  const readinessOn = launchCheck && !hasPor && jiraState === "on" && epicOk;
  const stage: Stage = phaseOf(hasPor || readinessOn, jiraState === "on", epicOk);
  const onCommitment = useCallback((id: string, kind: "kept" | "dropped" | "reopen", reason: string) => {
    setCommitments((cur) => decideCommitment(cur, id, kind, reason, stage, new Date().toISOString()));
  }, [stage]);
  const [target, setTarget] = useState<ReleaseTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  /** The reading the target was matched for: a new plan of record keeps the old target until its own match is back. */
  const targetFor = useRef<unknown>(null);
  const [launch, setLaunch] = useState<string>(d.launch ?? "");
  const [choices, setChoices] = useState<Record<string, TeamChoice>>((d.choices ?? {}) as Record<string, TeamChoice>);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsById, setRunsById] = useState<Record<string, Run>>({});
  const [confirmed, setConfirmed] = useState(!!d.confirmed);
  const [progress, setProgress] = useState<ProgressStage>(0);
  const [runId, setRunId] = useState<string | null>(d.runId ?? null);
  const [starter, setStarter] = useState<Starter | null>(d.starter ?? null);
  /** The restored values, so the effects below do not undo them on the first pass (React may run an effect twice in development). */
  const restoredFiles = useRef(files);
  const restoredEpic = useRef<string | null>(d.choices && Object.keys(d.choices).length ? (d.epic ?? null) : null);
  // The agent (Devin) reading uploads: asked once, remembered; progress while it reads; what it read.
  const [agentConsent, setAgentConsentState] = useState<AgentConsent>(initialConsent);
  const setAgentConsent = useCallback((c: AgentConsent) => { setAgentConsentState(c); void backend.saveSettings({ agent_consent: c }).catch(() => {}); }, [backend]);
  // The Devin tier that reads the files: null means the company default. Changing it re-reads (a different tier may read differently).
  const [agentMode, setAgentModeState] = useState<string | null>(initialMode);
  const setAgentMode = useCallback((m: string | null) => { setAgentModeState(m); void backend.saveSettings({ agent_mode: m }).catch(() => {}); }, [backend]);
  const [agentStage, setAgentStage] = useState<AgentReadStage | null>(null);
  const [agentProgress, setAgentProgress] = useState<ReadProgress | null>(null);
  const [agentRead, setAgentRead] = useState<AgentRead | null>(d.agentRead ?? null);
  const [planReading, setPlanReading] = useState(false);
  /** How the current plan was read (agent or rules), so a connector change can re-read the same way without asking again. */
  const lastRead = useRef<boolean | null>(d.lastRead ?? null);
  const seq = useRef(0);

  const hasPlanFile = files.some((f) => PLAN_KINDS.includes(f.kind));
  /** Anything Devin (or the rules) can read: every upload but "other"; the directory connector's export is structured data, not a document. */
  const hasReadable = files.some((f) => f.kind !== "other" && f.via !== "directory");
  const teamFiles = files.filter((f) => f.kind === "teams");
  const hasTeamList = teamFiles.length > 0;
  const directoryFile = teamFiles.find((f) => f.via === "directory") ?? null;
  const uploadedTeamList = teamFiles.find((f) => f.via !== "directory") ?? null;
  const ownerSource: OwnerSource = directoryFile ? "directory" : uploadedTeamList ? "files" : "inferred";
  const live = backend.mode === "live";

  // Each step starts at the top of the page.
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);

  // Live mode may already be connected (credentials from the server's environment).
  // A sample project that was connected stays connected (the stand-in has no server to ask).
  useEffect(() => { let on = true; jira.initialState().then((s) => { if (on) setJiraState((cur) => (backend.mode === "sample" && cur === "on" ? cur : s)); }); return () => { on = false; }; }, [jira]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-extract whenever the files or their "Read as" change. A directory connected on step 3 is a file too, but it does not
  // send the person back to confirm the plan.
  const uploadKey = files.filter((f) => f.via !== "directory").map((f) => `${f.id}:${f.kind}`).join("|");
  const prevUploadKey = useRef(uploadKey);
  const restoredKey = useRef(uploadKey);
  useEffect(() => {
    // Opening a saved project: its readings and results are as they were left; nothing is read again.
    if (files === restoredFiles.current && uploadKey === restoredKey.current && (plan || earlyPlan)) return;
    const uploadChanged = prevUploadKey.current !== uploadKey;
    if (uploadChanged) { setPlanConfirmed(false); prevUploadKey.current = uploadKey; }
    setConfirmed(false);
    setTarget(null);
    setChoices({});
    setStarter(null);
    // Nothing is read until the person asks: files land, "Read as" is set, then one click reads them, with Devin or
    // with the built-in rules alone. A change to the uploads makes any earlier reading stale, so the results clear.
    // A connector (the employee directory on step 3) is not an upload: it re-reads the same way as before, silently.
    if (uploadChanged || !(plan || earlyPlan) || lastRead.current === null) {
      lastRead.current = null;
      ++seq.current;
      setAgentRead(null);
      setAgentStage(null);
      setPlanReading(false);
      setPlan(null); setEarlyPlan(null); setSignals([]); setProject(null); setPlanError(null);
      return;
    }
    readFilesRef.current?.(lastRead.current);
  }, [files, backend, hasPlanFile, uploadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The deliberate step: read the files as they stand now, with Devin (which spends credits), the rules alone, or the
   *  reading a coding agent left in the project's folder. Each file is read for what it is: a PRD for the sentences that
   *  point to a team or an approval, a plan of record and a launch checklist for what they commit to, by when. */
  const readFiles = useCallback((withAgent: boolean, fromFolder = false) => {
    if (!hasReadable) return;
    const useAgent = withAgent && backend.agent.available && !fromFolder;
    lastRead.current = useAgent;
    const my = ++seq.current;
    setAgentRead(null);
    setAgentStage(useAgent ? 0 : null);
    setAgentProgress(null);
    setPlanReading(true);
    setConfirmed(false);
    const teams = files.filter((f) => f.kind === "teams");
    const prdFiles = files.filter((f) => f.kind === "prd");
    const porFiles = files.filter((f) => f.kind === "plan" || f.kind === "checks");
    const opts = { agent: useAgent, folder: fromFolder && saved ? saved.id : undefined, onProgress: (st: AgentReadStage, pr?: ReadProgress) => { if (my === seq.current) { setAgentStage(st); if (pr) setAgentProgress(pr); } } };
    (async () => {
      const early = prdFiles.length ? await backend.extractPlan([...prdFiles, ...teams], "starting", opts) : null;
      const launchRead = porFiles.some((f) => f.kind === "plan") ? await backend.extractPlan([...porFiles, ...teams], "launching", opts) : null;
      if (my !== seq.current) return;
      if (!early && !launchRead) throw new Error("No file was read as a PRD or a plan of record. Set \"Read as\" on the file that describes the project.");
      setEarlyPlan(early?.plan ?? null); setSignals(early?.signals ?? []); setProject(early?.project ?? null);
      setPlan(launchRead?.plan ?? null); setPlanError(null);
      setAgentRead(mergeReads(early?.agent ?? null, launchRead?.agent ?? null)); setAgentStage(null); setAgentProgress(null); setPlanReading(false);
      if (launchRead?.plan.launch_date) setLaunch(launchRead.plan.launch_date);
      const n = files.filter((f) => f.kind !== "other" && f.via !== "directory").length;
      logEvent(fromFolder ? `Your coding agent read ${n} file${n === 1 ? "" : "s"} in the project folder` : useAgent ? `${backend.agent.name} read ${n} file${n === 1 ? "" : "s"}${(early?.agent ?? launchRead?.agent)?.cached ? " (an earlier reading)" : ""}` : "Read the files with the built-in rules");
    })().catch((e) => { if (my === seq.current) { setPlan(null); setEarlyPlan(null); setSignals([]); setAgentStage(null); setPlanReading(false); setPlanError(String(e.message ?? e)); } });
  }, [backend, files, hasReadable, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const readFilesRef = useRef(readFiles);
  readFilesRef.current = readFiles;

  // One epic named in the plan is the answer to "which work is this?": fill it in rather than ask for a click.
  useEffect(() => {
    const keys = [...new Set([...(plan?.epic_keys_mentioned ?? []), ...(earlyPlan?.epic_keys_mentioned ?? [])])];
    if (!epic.trim() && keys.length === 1) setEpic(keys[0]);
  }, [plan, earlyPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  // A one-line note on the plan step for things the app did on its own: a stage change kept the files, sample files replaced yours.
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  /** Set when the plan is confirmed with everything connected: the review runs once the epic's lookup finishes. */
  const [autoRun, setAutoRun] = useState(false);
  /** Set by a suggestion that sends the person to connect something: what to wait for before running the review again. */
  const [rerunWhen, setRerunWhen] = useState<"jira" | "launch" | null>(null);

  // Stage B: resolve once connected and the epic key is valid, against the plan of record's teams when there is one.
  useEffect(() => {
    const base = plan ?? earlyPlan;
    if (!base || jiraState !== "on" || !epicOk) { setTarget(null); setTargetError(null); return; }
    let on = true;
    backend.resolveRelease(base, epicVal, hasTeamList).then(async (t) => {
      if (!on) return;
      targetFor.current = base;
      setTarget(t);
      setTargetError(null);
      // The team choices saved with the project hold for its epic; a different epic starts over.
      if (t.epic.key !== restoredEpic.current) setChoices({});
      restoredEpic.current = null;
      if (t.epic.release_date) setLaunch((cur) => cur || t.epic.release_date!);
      const list = await backend.listRuns(t.epic.key);
      const loaded: Record<string, Run> = {};
      for (const r of list) loaded[r.id] = await backend.loadRun(t.epic.key, r.id);
      if (!on) return;
      setRuns(list);
      setRunsById(loaded);
    }).catch((e) => { if (on) { setTarget(null); setTargetError(String(e.message ?? e)); } });
    return () => { on = false; };
  }, [plan, earlyPlan, jiraState, epicOk, epicVal, hasTeamList, backend]);

  const [storeError, setStoreError] = useState<string | null>(null);
  const addFiles = useCallback((list: FileList | File[] | null, kindOf?: (name: string) => FileKind) => {
    if (!list) return;
    const picked = Array.from(list); // copy now: the input's FileList is cleared after the handler returns
    const added: UploadedFile[] = [];
    setFiles((cur) => {
      const next = [...cur];
      picked.forEach((file) => {
        const kb = Math.max(1, Math.round(file.size / 1024));
        const f: UploadedFile = { id: `u${Date.now()}-${next.length}`, name: file.name, size: `${kb} KB`, kind: kindOf ? kindOf(file.name) : guessKind(file.name, next), sample: false, file };
        added.push(f); next.push(f);
      });
      return next;
    });
    if (picked.length) logEvent(`Added ${picked.map((f) => f.name).join(", ")}`);
    // Kept with the project on the server, so a later visit or run reads it without adding it again.
    if (saved && projectStore) for (const f of added) {
      projectStore.uploadFile(saved.id, f.file!).then((id) => {
        if (id) setFiles((cur) => cur.map((x) => (x.id === f.id ? { ...x, stored: { project: saved.id, id } } : x)));
      }).catch((e) => setStoreError(`${f.name} could not be kept with the project: ${(e as Error).message}. It is read from this browser until you leave.`));
    }
  }, [saved, projectStore, logEvent]);

  // The employee directory (R15), connected first. Two server-held layers (Microsoft Entra ID through the sign-in, Jira's
  // projects through the Jira connection) and an export file; whichever is connected becomes one "directory" file the
  // reader takes as a team list. An export replaces the server layers in the file list; removing it brings them back.
  const [dirInfo, setDirInfo] = useState<DirectoryInfo | null>(null);
  useEffect(() => { let on = true; backend.directory.info().then((d) => { if (on) setDirInfo(d); }).catch(() => {}); return () => { on = false; }; }, [backend]);
  const serverLayers = dirInfo ? [dirInfo.entra.connected, dirInfo.jira.connected].filter((x): x is NonNullable<typeof x> => !!x) : [];
  const serverLabel = serverLayers.map((l) => l.label).join(" + ");
  useEffect(() => {
    setFiles((cur) => {
      const has = cur.find((f) => f.via === "directory");
      if (serverLayers.length && !has) return [...cur, { id: "dir-server", name: "Employee directory.yaml", size: `${serverLayers.reduce((n, l) => n + l.teams, 0)} teams · ${serverLayers.reduce((n, l) => n + l.people, 0)} people`, kind: "teams", sample: false, via: "directory", source: "server" }];
      if (dirInfo && !serverLayers.length && has?.source === "server") return cur.filter((f) => f !== has);
      return cur;
    });
  }, [serverLabel]); // eslint-disable-line react-hooks/exhaustive-deps
  const connectDirectory = useCallback((file: File | null) => {
    setFiles((cur) => {
      const rest = cur.filter((f) => f.via !== "directory");
      if (live && file) {
        const kb = Math.max(1, Math.round(file.size / 1024));
        return [...rest, { id: `d${Date.now()}`, name: file.name, size: `${kb} KB`, kind: "teams", sample: false, file, via: "directory" }];
      }
      return [...rest, { ...SAMPLE_DIRECTORY, id: "dir", via: "directory" }];
    });
  }, [live]);
  const disconnectSource = useCallback(async (s: DirectorySourceId) => { setDirInfo(await backend.directory.disconnect(s)); }, [backend]);
  /** Disconnecting the directory card: the export goes, and so do the server layers behind a server-held file. */
  const disconnectDirectory = useCallback(() => {
    setFiles((cur) => cur.filter((f) => f.via !== "directory"));
    if (serverLayers.length) void (async () => { if (dirInfo?.entra.connected) await disconnectSource("entra"); if (dirInfo?.jira.connected) await disconnectSource("jira"); })();
  }, [serverLayers.length, dirInfo, disconnectSource]);
  const connectEntra = useCallback(async () => { setDirInfo(await backend.directory.connectEntra()); }, [backend]);
  /** Jira's projects need Jira: connect it the way this mode allows (Atlassian's popup, or the sample consent) and then read the projects. */
  const connectJiraDirectory = useCallback(async () => {
    if (jiraState !== "on") {
      if (jira.oauthAvailable) { const s = await jira.startOAuth(); setJiraState(s); if (s !== "on") throw new Error("Jira was not connected."); }
      else if (!jira.credentialsNeeded) { jira.start(); setJiraState(await jira.accept()); }
      else throw new Error("Connect Jira on the apps step first (site, email and API token), then come back for its projects.");
    }
    setDirInfo(await backend.directory.connectJira());
  }, [backend, jira, jiraState]);
  const directoryState = { connected: !!directoryFile, name: directoryFile ? (directoryFile.source === "server" ? serverLabel : directoryFile.name) : null, fromFiles: uploadedTeamList?.name ?? null, info: dirInfo };
  const directoryHandlers = { onConnectDirectory: connectDirectory, onDisconnectDirectory: disconnectDirectory, onConnectEntra: connectEntra, onConnectJira: connectJiraDirectory, onDisconnectSource: disconnectSource };

  const [runError, setRunError] = useState<string | null>(null);
  /** Runs every check whose inputs are here, as one review: who to involve (and, with Jira and the epic, who is on the work)
   *  from the PRD, and what is missing for launch from the plan of record. "earlyOnly" leaves the launch check out, for a
   *  plan of record whose Jira side is not ready yet. */
  const runReview = useCallback(async (opts: { earlyOnly?: boolean; readiness?: boolean } = {}) => {
    const doLaunch = !opts.earlyOnly && !!plan && !!target && jiraState === "on" && epicOk && allTeamsResolved(target.projects, choices);
    const doEarly = !!earlyPlan;
    if (!doLaunch && !doEarly) return;
    const withReadiness = (opts.readiness ?? launchCheck) && !plan;
    setScreen("running");
    setPlanNotice(null); // notes about the files belong to the step that set them, not to the review that follows
    setProgress(0);
    setConfirmed(true);
    setRunError(null);
    try {
      let result: Starter | null = null;
      if (doEarly) {
        const earlyStage: Stage = jiraState === "on" && epicOk ? "building" : "starting";
        const exclude = signals.filter((g) => signalsOff[g.id]).map((g) => g.id);
        result = await backend.runStarter({ stage: earlyStage, files: files.filter((f) => f.kind === "prd" || f.kind === "teams"), excludeSignals: exclude, epic: earlyStage === "building" ? epicVal : null, teamProjects: earlyStage === "building" ? choices as Record<string, string> : undefined }, setProgress);
        setStarter(result);
        setCommitments((cur) => fromStarter(cur, result!, signalsOff).list);
        logEvent(earlyStage === "starting" ? `Found ${result.teams.length} teams to involve` : `Checked team coverage and approvals for ${epicVal}`);
      } else setStarter(null);
      let launchRec: HistoryRecord["launch"] | undefined;
      let id: string | null = null;
      if (doLaunch && plan && target) {
        // What the person confirmed: edited due dates, the launch date, and their team → project choices.
        const confirmedPlan: PlanDraft = {
          ...plan,
          launch_date: launch || plan.launch_date,
          items: plan.items.map((i) => (planDates[i.id] && planDates[i.id] !== i.due ? { ...i, due: planDates[i.id], due_text: planDates[i.id], due_is_inferred: false } : i)),
        };
        const confirmedTarget: ReleaseTarget = { ...target, projects: applyChoices(target.projects, choices) };
        id = await backend.runReview(confirmedPlan, confirmedTarget, setProgress);
        const list = await backend.listRuns(confirmedTarget.epic.key);
        const loaded: Record<string, Run> = {};
        for (const r of list) loaded[r.id] = runsById[r.id] && r.id !== id ? runsById[r.id] : await backend.loadRun(confirmedTarget.epic.key, r.id);
        setRuns(list);
        setRunsById(loaded);
        setCommitments((cur) => fromLaunch(cur, loaded[id!], loaded[id!].release.snapshot_label).list); // dated like the review itself
        launchRec = { epic: confirmedTarget.epic.key, runId: id, target: confirmedTarget, plan, planDates, launch: launch || target.release_window.end };
        logEvent(`Ran the launch review (${fmtDate(id)} run)`);
      }
      setRunId(id);
      // One review, kept as one record, with what each check found.
      addRecord({
        id: `review:${Date.now().toString(36)}`, at: new Date().toISOString(), stage, summary: null,
        title: id ? `Launch review · ${fmtDate(id)} run` : result?.stage === "building" ? `${withReadiness ? "Launch readiness" : "Team coverage"} · ${result.epic ?? ""}`.trim() : "Who to involve",
        files: files.filter((f) => f.kind !== "other").map((f) => f.name), starter: result ?? undefined, signalsOff, launch: launchRec,
        readiness: !id && withReadiness && result?.stage === "building" ? { date: launch || target?.epic.release_date || null } : undefined,
      });
      setScreen("overview");
    } catch (e) {
      setRunError(String((e as Error).message ?? e));
      setConfirmed(false);
      setScreen("apps");
    }
  }, [backend, stage, plan, earlyPlan, target, jiraState, epicOk, launch, planDates, choices, runsById, signals, signalsOff, files, epicVal, launchCheck]); // eslint-disable-line react-hooks/exhaustive-deps

  // An early review from before records existed is recorded when the project opens.
  useEffect(() => {
    if (starter && confirmed && !records.some((r) => r.starter && r.starter.label === starter.label && r.starter.stage === starter.stage))
      addRecord({ id: `${starter.stage}:${starter.label}`, at: starter.analyzed_at, stage: starter.stage, title: starter.stage === "starting" ? "Who to involve" : `Team coverage · ${starter.epic ?? ""}`.trim(), summary: null, files: starter.files.map((f) => f.name), starter, signalsOff });
  }, [starter]); // eslint-disable-line react-hooks/exhaustive-deps

  // The project saves itself as it changes (shortly after, so typing does not write on every key).
  const snapshot: ProjectData = useMemo(() => ({
    stage, files: storableFiles(files), plan, earlyPlan, signals, signalsOff, project, planDates, planConfirmed, epic, launch, choices: choices as Record<string, string>,
    confirmed, runId, starter, agentRead, lastRead: lastRead.current, jiraOn: jiraState === "on", events, summary, records, commitments, launchCheck,
  }), [stage, files, plan, earlyPlan, signals, signalsOff, project, planDates, planConfirmed, epic, launch, choices, confirmed, runId, starter, agentRead, jiraState, events, summary, records, commitments, launchCheck]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const firstSave = useRef(true);
  /** The save that is waiting out the pause, if any: leaving the project (or the page) writes it at once instead of dropping it. */
  const pendingSave = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!saved || !projectStore) return;
    if (firstSave.current) { firstSave.current = false; return; }
    setSaveState("saving");
    const write = () => { pendingSave.current = null; return projectStore.save(saved.id, name.trim() || "Untitled project", snapshot).then(() => setSaveState("saved")).catch(() => setSaveState("failed")); };
    pendingSave.current = write;
    const t = setTimeout(write, 400);
    return () => clearTimeout(t);
  }, [snapshot, name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const flush = () => { void pendingSave.current?.(); };
    addEventListener("pagehide", flush);
    return () => { removeEventListener("pagehide", flush); flush(); };
  }, []);
  const leave = onHome ? async () => { await pendingSave.current?.(); onHome(); } : undefined;
  const onSummary = useCallback((s: Omit<ProjectSummary, "at">) => {
    setSummary((cur) => (cur && cur.status === s.status && cur.open === s.open && cur.detail === s.detail ? cur : { ...s, at: new Date().toISOString() }));
    // The current review's record carries the same summary, so History shows what each review found.
    setRecords((cur) => cur.map((r) => (r.id === currentRecordRef.current && (r.summary?.status !== s.status || r.summary?.open !== s.open || r.summary?.detail !== s.detail) ? { ...r, summary: { ...s } } : r)));
  }, []);
  const currentRecordRef = useRef(currentRecord);
  currentRecordRef.current = currentRecord;
  // A record can be made just after its review reported (a launch review is recorded once its release is known): fill it in.
  useEffect(() => {
    if (!currentRecord || !summary) return;
    setRecords((cur) => cur.map((r) => (r.id === currentRecord && !r.summary ? { ...r, summary: { status: summary.status, open: summary.open, detail: summary.detail } } : r)));
  }, [currentRecord, summary]);

  /** A past record opened from History, with the runs it needs (launch reviews read their run back from the server or the sample). */
  const [openRecord, setOpenRecord] = useState<HistoryRecord | null>(null);
  const [recordRuns, setRecordRuns] = useState<{ runs: RunSummary[]; byId: Record<string, Run> } | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const showRecord = async (r: HistoryRecord) => {
    setOpenRecord(r); setRecordRuns(null); setRecordError(null); window.scrollTo(0, 0);
    if (!r.launch) return;
    try {
      const list = (await backend.listRuns(r.launch.epic)).filter((x) => x.id <= r.launch!.runId);
      const byId: Record<string, Run> = {};
      for (const x of list) byId[x.id] = await backend.loadRun(r.launch.epic, x.id);
      setRecordRuns({ runs: list, byId });
    } catch (e) { setRecordError(`This review's run could not be loaded: ${(e as Error).message}`); }
  };

  const headerEpic = target?.epic.key ?? (epicOk ? epicVal : null) ?? plan?.epic_keys_mentioned[0] ?? earlyPlan?.epic_keys_mentioned[0] ?? null;
  const headerLaunch = hasPor ? launch || plan?.launch_date || null : null;
  const projectName = project ?? target?.epic.summary ?? (plan || earlyPlan ? "Your plan" : "New project");
  const canResults = confirmed && (!!starter || !!runId);
  /** Before its first review, a project is set up step by step from step 1; after that the overview is its home. */
  const firstRun = records.length === 0 && !canResults;
  /** The step bar is for setting a project up the first time. Afterwards, adding a file or a connection is not a new setup:
   *  the files and connections are places opened from the overview, and the review runs again with what is new. */
  const settingUp = firstRun && (screen === "start" || screen === "plan" || screen === "apps" || screen === "running");
  const steps: { id: Screen; label: string; disabled: boolean; active: boolean; done: boolean }[] = [
    { id: "start", label: "Organisation", disabled: false, active: screen === "start", done: screen !== "start" },
    { id: "plan", label: "Files", disabled: false, active: screen === "plan", done: planConfirmed },
    { id: "results", label: "Review", disabled: true, active: screen === "running", done: false },
  ];
  /** Where "back" goes: the step before while setting up for the first time, otherwise the overview. */
  const back: { label: string; to: Screen } | null = settingUp
    ? ({ plan: { label: "Step 1: Organisation", to: "start" as Screen }, apps: { label: "Step 2: Files", to: "plan" as Screen } } as Partial<Record<Screen, { label: string; to: Screen }>>)[screen] ?? null
    : screen !== "overview" && screen !== "running" ? { label: "Overview", to: "overview" } : null;

  // ---- what the review can check, worked out from the project as it stands ----
  const resolvedTeams = target ? allTeamsResolved(target.projects, choices) : false;
  const jiraReady = jiraState === "on" && epicOk && !!target;
  /** Each check is ready when its inputs are here: who to involve from a PRD; who is on the work from the PRD plus Jira and
   *  the epic; what is missing for launch from a plan of record plus Jira, the epic and every team matched to a project. */
  const involveReady = !!earlyPlan;
  const coverageReady = involveReady && jiraReady;
  const launchReady = !!plan && jiraReady && resolvedTeams;
  /** Something can be reviewed now: who to involve (a PRD), or the launch check when everything it needs is here. */
  const canRunNow = involveReady || launchReady;
  /** The review can run: some check is ready, and a plan of record (which asks for the launch check) has what that needs.
   *  Without it, the connections step asks for the rest, and the person can still run what is ready now. */
  const reviewReady = (involveReady || launchReady) && (!plan || launchReady);
  const planFiles = files.filter((f) => PLAN_KINDS.includes(f.kind));
  const go = (sc: Screen) => () => setScreen(sc);
  const items: CheckItem[] = [
    { id: "org", label: "Your organisation", state: directoryFile || uploadedTeamList ? "done" : "optional",
      detail: directoryFile ? `Connected: ${directoryState.name}` : uploadedTeamList ? `From ${uploadedTeamList.name}` : "Connect your directory so owners are matched to real teams and people.",
      action: { label: directoryFile || uploadedTeamList ? "Manage" : "Connect", go: go("start") } },
    { id: "files", label: "What describes the project", state: hasPlanFile ? "done" : "todo",
      detail: hasPlanFile ? planFiles.map((f) => f.name).join(", ") : "Add a PRD, one-pager or brief, or a plan of record.",
      action: { label: hasPlanFile ? "Change" : "Add", go: go("plan") } },
    { id: "read", label: "Read", state: plan || earlyPlan ? "done" : hasPlanFile ? "todo" : "waiting",
      detail: plan || earlyPlan ? (agentRead?.status === "done" ? `Read by ${agentRead.name}` : "Read") : hasPlanFile ? "Your files are added but not read yet." : "Add a file first.",
      action: { label: plan || earlyPlan ? "See what was read" : "Read", go: go("plan") } },
    // Jira and the epic are needed by a plan of record's launch check; with a PRD alone they add who is on the work.
    { id: "jira", label: "Jira", state: jiraState === "on" ? "done" : !(plan || earlyPlan) ? "waiting" : plan && !earlyPlan ? "todo" : "optional",
      detail: jiraState === "on" ? `Connected · ${jira.site || "read-only"}` : hasPor ? "Where the work is tracked; read-only. The launch check needs it." : "Read-only. Adds who is actually on the work.", action: { label: jiraState === "on" ? "Manage" : "Connect", go: go("apps") } },
    ...(jiraState === "on" || hasPor ? [
      { id: "epic", label: "The epic", state: target ? "done" : epicOk ? "waiting" : jiraState === "on" ? "todo" : "waiting", detail: target ? `${target.epic.key} · ${target.epic.summary}` : epicOk ? `${epicVal} · ${!(plan || earlyPlan) ? "checked in Jira once your files are read" : jiraState !== "on" ? "checked once Jira is connected" : "looking it up in Jira"}` : epicVal ? "Use a Jira key like INGEST-142." : "Which work in Jira this is.", action: { label: target || epicOk ? "Change" : "Pick", go: go("apps") } },
    ] as CheckItem[] : []),
    ...(hasPor ? [
      { id: "teams", label: "Teams matched to Jira projects", state: !target ? "waiting" : resolvedTeams ? "done" : "todo", detail: target ? `${target.projects.filter((t) => t.match !== "unresolved" || choices[t.team]).length} of ${target.projects.length} teams matched` : "After the epic.", action: { label: resolvedTeams ? "Check" : "Match", go: go("apps") } },
    ] as CheckItem[] : []),
    { id: "review", label: "Review", state: canResults ? "done" : reviewReady ? "todo" : "waiting",
      detail: canResults ? (summary?.detail ?? "Reviewed") : reviewReady ? "Everything it needs is here." : "After the steps above.",
      action: canResults ? { label: "Open", go: go("overview") } : { label: "Run the review", go: () => void runReview() } },
  ];
  const firstTodo = items.find((i) => i.state === "todo");
  /** Once reviewed, what would let the review check more, from what the project has: the next thing to add or connect. */
  const unlock: NextUp | null = !canResults ? null
    : !earlyPlan && !hasPrd && !plan ? null
    : earlyPlan && !jiraReady ? { title: "See who's actually on the work", detail: `Connect Jira${epicOk ? ` and ${epicVal}` : " and pick the epic"}: the review then checks which teams are on the work and which approvals have started.`, action: { label: "Connect Jira", go: () => { setRerunWhen("jira"); setScreen("apps"); } } }
    : !hasPor && !readinessOn ? { title: "Ready to launch?", detail: `Checks each team against ${epicOk ? epicVal : "the work"} in Jira: on the work, and every sign-off your PRD asks for done${launch ? `, for the ${fmtDate(launch)} launch` : ""}.`,
        action: { label: "Check launch readiness", go: () => { setLaunchCheck(true); logEvent("Started checking launch readiness"); void runReview({ readiness: true }); } },
        more: { label: "Add a launch checklist", go: openChecklist } }
    : plan && !launchReady ? { title: "Finish what the launch check needs", detail: "Match each team to its Jira project, and the launch check runs with the rest.", action: { label: "Match teams", go: () => { setRerunWhen("launch"); setScreen("apps"); } } }
    : null;
  const next: NextUp = firstTodo && !canResults ? (firstTodo.id === "review"
        ? { title: "Run the review", detail: "Everything it needs is here.", action: { label: "Run the review", go: () => void runReview() } }
        : { title: { files: "Add what describes the project", read: "Read your files", jira: "Connect Jira", epic: "Pick the epic", teams: "Match each team to its Jira project" }[firstTodo.id] ?? firstTodo.label, detail: firstTodo.detail, action: firstTodo.action ? { label: firstTodo.action.label === "Read" ? "Read your files" : firstTodo.action.label, go: firstTodo.action.go } : undefined })
    : unlock ?? (canResults
        ? { title: "Up to date", detail: "Run it again when the plan or the work in Jira changes.", action: { label: "Run the review again", go: () => void runReview() } }
        : { title: "Waiting on the steps below", detail: "Finish the checklist to run the review." });
  // Every arrival at the connections step with the plan confirmed and no review yet arms it: once what is missing is
  // connected, the review runs. Changing the epic, launch date or a team's project there means the person is checking
  // details, so they start it themselves. (A file change clears the results a render later, so it looks again then.)
  useEffect(() => { setAutoRun(screen === "apps" && !canResults && planConfirmed && !rerunWhen); }, [screen, canResults]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (autoRun && screen === "apps" && reviewReady) { setAutoRun(false); void runReview(); }
  }, [autoRun, screen, reviewReady]); // eslint-disable-line react-hooks/exhaustive-deps
  // Sent to the connections step by a suggestion ("see who's actually on the work"): once what it asked for is connected,
  // the review runs again with the check it unlocks. Leaving the step drops it.
  useEffect(() => {
    if (!rerunWhen) return;
    if (screen !== "apps") { setRerunWhen(null); return; }
    if (rerunWhen === "jira" ? jiraReady : launchReady) { setRerunWhen(null); void runReview(); }
  }, [rerunWhen, screen, jiraReady, launchReady]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Adding a launch checklist or plan of record, in a dialog over the project: the picked files join the project, are
   *  read, and the launch review runs on their dated commitments; if it still needs each team's Jira project (or Jira),
   *  the connections step opens and the review runs once that is done. A checklist on its own is read as the plan. */
  const porAgent = useRef(false);
  const addPlanOfRecord = ({ files: picked, sample }: { files: File[]; sample: boolean }) => {
    porAgent.current = backend.agent.available && agentConsent !== "no";
    if (porAgent.current && agentConsent !== "yes") setAgentConsent("yes");
    if (sample) setFiles((cur) => { const add = sampleFiles("launch"); return [...cur.filter((f) => !add.some((a) => a.name === f.name)), ...add]; });
    const isChecklist = (n: string) => /check|readiness|gate/i.test(n);
    const withPlan = sample || picked.some((f) => !isChecklist(f.name));
    addFiles(picked, (n) => (isChecklist(n) && withPlan ? "checks" : "plan"));
    setPorError(null);
    setPor("added");
  };
  // The files have landed (which clears the old reading): read them as they stand now.
  useEffect(() => { if (por === "added") { setPor("reading"); readFilesRef.current(porAgent.current); } }, [files]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (por === "reading" && !planReading) {
      if (planError || !plan) { setPorError(planError ?? "No launch commitments found in these files. Try another file."); setPor("pick"); return; }
      setPor("checking");
    }
    if (por !== "checking") return;
    if (jiraState === "on" && epicOk && targetFor.current !== plan && !targetError) return; // still matching the plan's teams in Jira
    setPor(null);
    setPlanConfirmed(true);
    if (launchReady) void runReview();
    else { setRerunWhen("launch"); setScreen("apps"); }
  }, [por, planReading, planError, plan, target, targetError, launchReady]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The project's path: the checks in the order a project usually meets them. Ticked when the current review ran it; the
   *  one the suggestion above leads to is next. Nothing is required: a step that is not next is simply not here yet. */
  const ran = { involve: !!starter, coverage: starter?.stage === "building", launch: !!(runId && plan) || (readinessOn && starter?.stage === "building") };
  const nextCheck: PathStep["id"] | null = !unlock ? null : unlock.title === "See who's actually on the work" ? "coverage" : "launch";
  const path: PathStep[] = ([["involve", "Who to involve"], ["coverage", "Who's on the work"], ["launch", "Ready to launch"]] as const)
    .map(([id, label]) => ({ id, label, state: ran[id] ? "done" : id === nextCheck ? "next" : "later" }));
  /** A team linked to its Jira project by hand, from its card: kept with the launch check's team → project choices, and the
   *  review runs again with it once the choice is in. */
  const [relinked, setRelinked] = useState(false);
  const teamLink = useMemo(() => ({
    linked: Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== "skip")) as Record<string, string>,
    projects: () => backend.jiraProjects(),
    set: (team: string, project: string | null) => {
      setChoices((cur) => { const n = { ...cur }; if (project) n[team] = project; else delete n[team]; return n; });
      logEvent(project ? `Linked ${team} to the Jira project ${project}` : `Unlinked ${team} from its Jira project`);
      setRelinked(true);
    },
  }), [choices, backend, logEvent]);
  useEffect(() => { if (relinked) { setRelinked(false); void runReview(); } }, [relinked]); // eslint-disable-line react-hooks/exhaustive-deps
  const latestRecord = canResults ? records.find((r) => r.id === currentRecord) ?? null : null;
  const earlierRecords = records.filter((r) => r.id !== latestRecord?.id).slice().reverse().slice(0, 3);

  const planIds = useMemo(() => (plan ? new Set(plan.items.map((i) => i.id)) : null), [plan]);

  return (
    <div>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand">
            {leave ? <button type="button" className="linkbtn home-link" onClick={() => void leave()}>‹ All projects</button> : <span className="name">Throughline</span>}
            {saved ? (
              <>
                <label htmlFor="project-name" className="sr-only">Project name</label>
                <input id="project-name" className="name-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (!name.trim()) setName("Untitled project"); }} />
                <span className="muted">{headerEpic ? <span className="mono">{headerEpic}</span> : null}{headerLaunch ? `${headerEpic ? " · " : ""}launch ${fmtDate(headerLaunch)}` : ""}</span>
                <span className="small muted" data-testid="save-state">{saveState === "saving" ? "Saving…" : saveState === "failed" ? "Not saved" : "Saved"}</span>
              </>
            ) : (
              <span className="muted">{projectName}{headerEpic ? <> · <span className="mono">{headerEpic}</span></> : null}{headerLaunch ? ` · launch ${fmtDate(headerLaunch)}` : ""}</span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            {(plan || earlyPlan) && <span className="stage-chip" data-testid="stage-chip" title="Read from what the project has: a plan of record, work tracked in Jira, or a PRD">{STAGE_SHORT[stage]}</span>}
            <span className="tag">{live ? `Live · ${jira.site || "Jira"}` : "Sample data"}</span>
            {user && <span className="tag" data-testid="user-chip" title={user.email ?? undefined}>{user.name}</span>}
            {onSignOut && <button type="button" className="btn" style={{ minHeight: 32, padding: "0 12px", fontSize: 14 }} onClick={onSignOut}>Sign out</button>}
          </div>
        </div>
        {settingUp && (
          <nav className="wrap steps setup-steps" aria-label="Setup">
            {steps.map((t, i) => (
              <button key={t.id} type="button" aria-current={t.active ? "step" : "false"} disabled={t.disabled} onClick={() => { if (!t.disabled && !t.active) setScreen(t.id); }}>
                <span className={"step-num" + (t.done && !t.active ? " done" : "")} aria-hidden="true">{t.done && !t.active ? "✓" : i + 1}</span>{t.label}
              </button>
            ))}
          </nav>
        )}
      </header>
      <main className="wrap page">
        {/* The plan and connections screens end with their own back button; everywhere else the way back is at the top. */}
        {back && screen !== "plan" && screen !== "apps" && !(screen === "history" && openRecord) && <button type="button" className="linkbtn back-link" onClick={() => setScreen(back.to)}>‹ {back.label}</button>}
        {screen === "start" && (
          <GetStarted onContinue={() => setScreen(canResults ? "overview" : "plan")} workspace={!firstRun}
            jira={jira} jiraState={jiraState} setJiraState={(s) => { setJiraState(s); if (s === "off") setConfirmed(false); }}
            directory={directoryState} live={live} {...directoryHandlers} />
        )}
        {screen === "plan" && (
          <PlanDocuments eyebrow={firstRun ? undefined : "Files"} backLabel={back?.label}
            files={files} plan={plan} earlyPlan={earlyPlan} planError={planError} planDates={planDates} signals={signals} signalsOff={signalsOff}
            notice={planNotice} onDismissNotice={() => setPlanNotice(null)}
            onAddFiles={(list) => { setPlanNotice(null); addFiles(list); }}
            onSetKind={(id, kind) => { setPlanNotice(null); setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, kind } : f))); }}
            onRemove={(id) => { setPlanNotice(null); setFiles((cur) => cur.filter((f) => f.id !== id)); }}
            onLoadSample={(set) => setFiles((cur) => {
              // A sample set joins what is there; a file of the same name is replaced.
              const add = sampleFiles(set);
              const replaced = cur.filter((f) => add.some((a) => a.name === f.name)).length;
              setPlanNotice(replaced ? `Replaced ${replaced} file${replaced === 1 ? "" : "s"} with the sample's.` : null);
              return [...cur.filter((f) => !add.some((a) => a.name === f.name)), ...add];
            })}
            onSetDate={(id, v) => setPlanDates((d) => ({ ...d, [id]: v }))}
            onToggleSignal={(id) => { setSignalsOff((s) => ({ ...s, [id]: !s[id] })); setConfirmed(false); }}
            agent={{ info: backend.agent, consent: agentConsent, setConsent: setAgentConsent, mode: agentMode, setMode: setAgentMode, stage: agentStage, progress: agentProgress, reading: planReading, read: agentRead, read_now: readFiles,
              folder: live && saved?.folder ? { path: saved.folder, use: () => readFiles(false, true) } : undefined }}
            onBack={() => setScreen(back?.to ?? "overview")}
            confirmLabel={canRunNow || !(plan || earlyPlan) ? "Confirm and run the review" : jiraState === "on" ? "Confirm and finish the launch check" : "Confirm and connect Jira"}
            confirmHint={canRunNow
              ? (plan && !launchReady ? "Runs what your PRD allows; the launch check waits for Jira." : "Confirming runs the review.")
              : "The launch check needs Jira, the epic and each team's project."}
            onConfirm={() => {
              setPlanConfirmed(true);
              // Run whatever can run now; the launch check waits for Jira, and the project offers it once reviewed.
              if (canRunNow) { void runReview({ earlyOnly: !launchReady }); return; }
              // Only a plan of record, and its launch check is not ready: that is the one case that needs the connections first.
              setScreen("apps");
            }}
          />
        )}
        {/* A plan of record asks for the launch check, which needs Jira; what the PRD allows can run now, without waiting. */}
        {screen === "apps" && plan && !launchReady && earlyPlan && !canResults && (
          <div className="notice-grey between" role="status" data-testid="partial-run" style={{ marginBottom: 16, gap: 12 }}>
            <span>The launch check needs Jira, the epic and each team's project.</span>
            <button type="button" className="btn" onClick={() => void runReview({ earlyOnly: true })}>Review what we can now</button>
          </div>
        )}
        {screen === "apps" && (plan || earlyPlan) && (
          <ConnectApps eyebrow="Connections" backLabel={back?.label}
            stage={stage}
            jira={jira} jiraState={jiraState} setJiraState={(s) => { setJiraState(s); if (s === "off") setConfirmed(false); }}
            directory={directoryState}
            agent={{ info: backend.agent, consent: agentConsent, setConsent: setAgentConsent, mode: agentMode, setMode: setAgentMode }}
            onConnectDirectory={connectDirectory} onDisconnectDirectory={disconnectDirectory}
            plan={(plan ?? earlyPlan)!} files={files} epic={epic} setEpic={(v) => { setAutoRun(false); setEpic(v.toUpperCase()); setConfirmed(false); }} epicOk={epicOk}
            target={target} targetError={targetError} latestRun={runs.length ? runsById[runs[runs.length - 1].id] ?? null : null} runs={runs}
            launch={launch} setLaunch={(v) => { setAutoRun(false); setLaunch(v); }}
            choices={choices} setChoice={(team, c) => setChoices((cur) => { setAutoRun(false); const n = { ...cur }; if (c === null) delete n[team]; else n[team] = c; return n; })}
            confirmed={confirmed} runError={runError}
            onBack={() => setScreen(back?.to ?? "overview")} onRun={() => void runReview()}
          />
        )}
        {screen === "running" && (
          <Running stage={progress} projectStage={stage} plan={plan ?? earlyPlan} epic={epicVal} latestRun={runId ? runsById[runId] : runs.length ? runsById[runs[runs.length - 1].id] : null} runs={runs}
            signalCount={signals.filter((g) => !signalsOff[g.id]).length} directoryGiven={hasTeamList} />
        )}
        {storeError && <div className="notice-grey" role="alert" style={{ marginBottom: 16 }}>{storeError}</div>}
        {screen === "overview" && (
          <Overview name={name} stage={stage} path={path}
            notice={planNotice} onDismissNotice={() => setPlanNotice(null)}
            next={next} items={items}
            earlier={earlierRecords} onOpenRecord={(r) => { setScreen("history"); void showRecord(r); }}
            onHistory={go("history")}
            onOpenFiles={go("plan")} onOpenConnections={go("apps")}
            actions={canResults ? actionsGlance : null}
            commitments={commitments} onCommitment={onCommitment}
            hasPrdReview={!!starter}
            review={!canResults ? undefined : runId && (!target || !runsById[runId]) ? <p className="sm muted">Loading the review…</p> : (
              <ProjectReview eyebrow={name.trim() || "Review"} store={store} starter={starter} signalsOff={signalsOff} phase={stage} link={jiraState === "on" ? teamLink : undefined}
                launchDate={launch || target?.epic.release_date || null}
                readiness={readinessOn ? { date: launch || target?.epic.release_date || null, onAddChecklist: openChecklist } : undefined}
                launch={runId && target && plan ? { runs, runsById, latestId: runId, target, launch: launch || target.release_window.end, planIds, planDates, plan, ownerSource } : null}
                commitments={commitments} onCommitment={onCommitment} onActions={setActionsGlance} onSummary={onSummary} onConnectApps={go("apps")} />
            )} />
        )}
        {screen === "history" && !openRecord && (
          <div className="flow stack">
            <header className="stack-sm" style={{ gap: 8 }}>
              <span className="eyebrow">History</span>
              <h1 className="flow-title">Everything this project has been through</h1>
              <p className="lead">Each review, kept as it was.</p>
            </header>
            {records.length === 0 && events.length === 0 && <p className="sm muted">Nothing yet.</p>}
            <ol className="timeline" data-testid="history">
              {[
                ...records.map((r) => ({ at: r.at, rec: r as HistoryRecord | null, text: "" })),
                ...events.filter((e) => !/^Ran the launch review|^Found \d+ teams to involve|^Checked team coverage/.test(e.text)).map((e) => ({ at: e.at, rec: null as HistoryRecord | null, text: e.text })),
              ].sort((x, y) => y.at.localeCompare(x.at)).map((item, i) => item.rec ? (
                <li key={item.rec.id} className="tl-record" data-testid={`record-${item.rec.stage}`}>
                  <span className="tl-dot rec" aria-hidden="true" />
                  <div className="card tl-card">
                    <div className="between" style={{ gap: 12, alignItems: "flex-start" }}>
                      <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
                        <span className="small muted">{fmtDate(item.at.slice(0, 10))} · {STAGE_SHORT[item.rec.stage]}{item.rec.id === currentRecord ? " · current" : ""}</span>
                        <span style={{ fontWeight: 600 }}>{item.rec.title}</span>
                        <span className="small muted">{item.rec.files.length ? `From ${item.rec.files.join(", ")}` : ""}</span>
                      </div>
                      <div className="project-status">
                        {item.rec.summary?.status && <span className={"status-pill " + item.rec.summary.status.toLowerCase()}>{item.rec.summary.status}</span>}
                        {item.rec.summary?.open != null && <span className="sm">{item.rec.summary.open} open action{item.rec.summary.open === 1 ? "" : "s"}</span>}
                        {item.rec.summary?.detail && <span className="small muted">{item.rec.summary.detail}</span>}
                      </div>
                    </div>
                    <div><button type="button" className="btn" onClick={() => (item.rec!.id === currentRecord ? setScreen("overview") : void showRecord(item.rec!))}>Open this review</button></div>
                  </div>
                </li>
              ) : (
                <li key={`e${i}`} className="tl-event"><span className="tl-dot" aria-hidden="true" /><span className="small muted mono">{fmtDate(item.at.slice(0, 10))} {item.at.slice(11, 16)}</span><span className="sm">{item.text}</span></li>
              ))}
            </ol>
          </div>
        )}
        {screen === "history" && openRecord && (
          <div className="stack" style={{ gap: 16 }} data-testid="record-view">
            <div className="record-bar" role="note">
              <button type="button" className="linkbtn" onClick={() => setOpenRecord(null)}>‹ History</button>
              <span className="sm"><strong style={{ fontWeight: 600 }}>{openRecord.title}</strong> · {fmtDate(openRecord.at.slice(0, 10))} · {STAGE_SHORT[openRecord.stage]}. A past review, shown as it was; nothing here can be changed.</span>
            </div>
            {recordError && <div className="notice-grey" role="alert">{recordError}</div>}
            {openRecord.starter && (
              <EarlyResults readOnly eyebrow="History" starter={openRecord.starter} signalsOff={openRecord.signalsOff ?? {}} store={store} launch={null} phase={openRecord.stage} readiness={openRecord.readiness}
                onConnectApps={() => {}} />
            )}
            {openRecord.launch && !recordRuns && !recordError && <p className="sm muted">Loading the run…</p>}
            {openRecord.launch && recordRuns && recordRuns.byId[openRecord.launch.runId] && (
              <Review readOnly eyebrow="History" stage="launching" store={store} runs={recordRuns.runs} runsById={recordRuns.byId} latestId={openRecord.launch.runId} target={openRecord.launch.target}
                launch={openRecord.launch.launch} planIds={new Set(openRecord.launch.plan.items.map((i) => i.id))} planDates={openRecord.launch.planDates} plan={openRecord.launch.plan} ownerSource={ownerSource} />
            )}
          </div>
        )}
      </main>
      {por && (
        <PlanOfRecordDialog agentName={backend.agent.available && agentConsent !== "no" ? backend.agent.name : null} error={porError}
          busy={por === "pick" ? null : por === "checking" ? "Getting the launch check ready…" : porAgent.current ? `${backend.agent.name} is reading your files…` : "Reading your files…"}
          onRead={addPlanOfRecord} onClose={() => setPor(null)} />
      )}
    </div>
  );
}
