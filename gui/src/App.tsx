import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanDraft, ReleaseTarget, Run, Signal, Starter } from "@rrr/schemas";
import { PLAN_KINDS, type ReviewBackend, type JiraConnection, type DecisionStore, type UploadedFile, type FileKind, type JiraState, type RunSummary, type ProgressStage, type Stage, type AgentConsent, type AgentRead, type AgentReadStage, type ReadProgress, type UserInfo, type DirectoryInfo, type DirectorySourceId, type ProjectRecord, type ProjectStore, type ProjectData, type ProjectEvent, type ProjectSummary, type HistoryRecord } from "./backend/types";
import { storableFiles } from "./backend/projects";
import { LIFECYCLE } from "./screens/Projects";
import { sampleFilesFor, SAMPLE_DIRECTORY } from "./backend/fixtureBackend";
import { fmtDate } from "./model/dates";
import { applyChoices, type TeamChoice } from "./model/review";
import { GetStarted, STAGE_SHORT } from "./screens/GetStarted";
import { PlanDocuments } from "./screens/PlanDocuments";
import { ConnectApps } from "./screens/ConnectApps";
import { Running } from "./screens/Running";
import { Review, type OwnerSource } from "./screens/Review";
import { EarlyResults } from "./screens/EarlyResults";
import { Overview, type CheckItem, type NextUp } from "./screens/Overview";
import { RUN_LABEL } from "./screens/ConnectApps";
import { allTeamsResolved } from "./model/review";

/** A project's places: its overview (the hub), plan, connections, review and history, the same at every point in its life;
 *  "start" (stage and organisation) opens from the overview, and on a new project's first visit. */
export type Screen = "overview" | "start" | "plan" | "apps" | "running" | "results" | "history";

export interface AppProps {
  backend: ReviewBackend; jira: JiraConnection; store: DecisionStore; user?: UserInfo | null; initialConsent?: AgentConsent; initialMode?: string | null; onSignOut?: () => void;
  /** The project opened from the portal, and where to save it; without one the app is a one-off session (tests, embeds). */
  project?: ProjectRecord; projectStore?: ProjectStore; onHome?: () => void;
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
  const restoredResults = !!d.confirmed && (d.stage === "launching" ? !!d.runId : !!d.starter);
  /** Until its first review, a project is set up as four steps; after that every visit starts at the overview. */
  const [screen, setScreen] = useState<Screen>(!d.stage ? "start" : d.records?.length || restoredResults ? "overview" : "plan");
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
    const onPop = (e: PopStateEvent) => { const sc = (e.state as { screen?: Screen } | null)?.screen; if (sc) { setOpenRecord(null); setScreen(sc === "running" ? "apps" : sc); } };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const [name, setName] = useState(saved?.name ?? "New project");
  const [events, setEvents] = useState<ProjectEvent[]>(d.events ?? []);
  const [summary, setSummary] = useState<ProjectSummary | null>(d.summary ?? null);
  /** Every review, kept so it can be opened after the project moves on or is re-run. The current one takes the summary. */
  const [records, setRecords] = useState<HistoryRecord[]>(d.records ?? []);
  const [currentRecord, setCurrentRecord] = useState<string | null>(d.records?.length ? d.records[d.records.length - 1].id : null);
  const addRecord = useCallback((r: HistoryRecord) => { setRecords((cur) => (cur.some((x) => x.id === r.id) ? cur : [...cur, r])); setCurrentRecord(r.id); }, []);
  const logEvent = useCallback((text: string) => setEvents((e) => [...e, { at: new Date().toISOString(), text }]), []);
  const [stage, setStageChoice] = useState<Stage | null>(d.stage ?? null);
  const [files, setFiles] = useState<UploadedFile[]>(d.files ?? []);
  const [plan, setPlan] = useState<PlanDraft | null>(d.plan ?? null);
  const [signals, setSignals] = useState<Signal[]>(d.signals ?? []);
  const [signalsOff, setSignalsOff] = useState<Record<string, boolean>>(d.signalsOff ?? {});
  const [project, setProject] = useState<string | null>(d.project ?? null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planDates, setPlanDates] = useState<Record<string, string>>(d.planDates ?? {});
  const [planConfirmed, setPlanConfirmed] = useState(!!d.planConfirmed);
  const [jiraState, setJiraState] = useState<JiraState>(d.jiraOn && backend.mode === "sample" ? "on" : "off");
  const [epic, setEpic] = useState(d.epic ?? "");
  const [target, setTarget] = useState<ReleaseTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
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
  const needsJira = stage !== "starting";

  // Each step starts at the top of the page.
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);

  // Live mode may already be connected (credentials from the server's environment).
  // A sample project that was connected stays connected (the stand-in has no server to ask).
  useEffect(() => { let on = true; jira.initialState().then((s) => { if (on) setJiraState((cur) => (backend.mode === "sample" && cur === "on" ? cur : s)); }); return () => { on = false; }; }, [jira]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stage A: re-extract whenever the files, their "read as" or the stage change. A directory connected on
  // step 3 is a file too, but it does not send the person back to confirm the plan.
  const uploadKey = files.filter((f) => f.via !== "directory").map((f) => `${f.id}:${f.kind}`).join("|") + `@${stage}`;
  const prevUploadKey = useRef(uploadKey);
  const restoredKey = useRef(uploadKey);
  useEffect(() => {
    // Opening a saved project: its reading and results are as they were left; nothing is read again. A new stage,
    // like any change to the files, makes the reading stale as usual.
    if (files === restoredFiles.current && uploadKey === restoredKey.current && plan) return;
    const my = ++seq.current;
    const uploadChanged = prevUploadKey.current !== uploadKey;
    if (uploadChanged) { setPlanConfirmed(false); prevUploadKey.current = uploadKey; }
    setConfirmed(false);
    setTarget(null);
    setChoices({});
    setStarter(null);
    // Nothing is read until the person asks: files land, "Read as" is set, then one click reads them, with Devin or
    // with the built-in rules alone. A change to the uploads makes any earlier reading stale, so the results clear.
    // A connector (the employee directory on step 3) is not an upload: it re-reads the same way as before, silently.
    if (uploadChanged || !plan || lastRead.current === null) {
      lastRead.current = null;
      setAgentRead(null);
      setAgentStage(null);
      setPlanReading(false);
      setPlan(null); setSignals([]); setProject(null); setPlanError(null);
      return;
    }
    readFilesRef.current?.(lastRead.current);
  }, [files, backend, hasPlanFile, uploadKey, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The deliberate step: read the files as they stand now, with Devin (which spends credits), the rules alone, or the
   *  reading a coding agent left in the project's folder. */
  const readFiles = useCallback((withAgent: boolean, fromFolder = false) => {
    if (!hasReadable || !stage) return;
    const useAgent = withAgent && backend.agent.available && !fromFolder;
    lastRead.current = useAgent;
    const my = ++seq.current;
    setAgentRead(null);
    setAgentStage(useAgent ? 0 : null);
    setAgentProgress(null);
    setPlanReading(true);
    setConfirmed(false);
    backend.extractPlan(files, stage, { agent: useAgent, folder: fromFolder && saved ? saved.id : undefined, onProgress: (st, pr) => { if (my === seq.current) { setAgentStage(st); if (pr) setAgentProgress(pr); } } }).then((r) => {
      if (my !== seq.current) return;
      setPlan(r.plan); setSignals(r.signals); setProject(r.project); setPlanError(null);
      setAgentRead(r.agent ?? null); setAgentStage(null); setAgentProgress(null); setPlanReading(false);
      if (r.plan.launch_date) setLaunch(r.plan.launch_date);
      logEvent(fromFolder ? `Your coding agent read ${files.filter((f) => f.kind !== "other").length} file${files.length === 1 ? "" : "s"} in the project folder` : useAgent ? `${backend.agent.name} read ${files.filter((f) => f.kind !== "other").length} file${files.length === 1 ? "" : "s"}${r.agent?.cached ? " (an earlier reading)" : ""}` : "Read the files with the built-in rules");
    }).catch((e) => { if (my === seq.current) { setPlan(null); setSignals([]); setAgentStage(null); setPlanReading(false); setPlanError(String(e.message ?? e)); } });
  }, [backend, files, stage, hasReadable, saved]);
  const readFilesRef = useRef(readFiles);
  readFilesRef.current = readFiles;

  const epicVal = epic.trim();
  const epicOk = /^[A-Z][A-Z0-9]+-\d+$/.test(epicVal);

  // One epic named in the plan is the answer to "which work is this?": fill it in rather than ask for a click.
  useEffect(() => {
    if (plan && !epic.trim() && plan.epic_keys_mentioned.length === 1) setEpic(plan.epic_keys_mentioned[0]);
  }, [plan]); // eslint-disable-line react-hooks/exhaustive-deps

  // A one-line note on the plan step for things the app did on its own: a stage change kept the files, sample files replaced yours.
  const [planNotice, setPlanNotice] = useState<string | null>(null);

  // Stage B: resolve once connected and the epic key is valid (not needed when just starting).
  useEffect(() => {
    if (!plan || !needsJira || jiraState !== "on" || !epicOk) { setTarget(null); setTargetError(null); return; }
    let on = true;
    backend.resolveRelease(plan, epicVal, hasTeamList).then(async (t) => {
      if (!on) return;
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
  }, [plan, jiraState, epicOk, epicVal, hasTeamList, backend, needsJira]);

  const [storeError, setStoreError] = useState<string | null>(null);
  const addFiles = useCallback((list: FileList | File[] | null) => {
    if (!list) return;
    const picked = Array.from(list); // copy now: the input's FileList is cleared after the handler returns
    const added: UploadedFile[] = [];
    setFiles((cur) => {
      const next = [...cur];
      picked.forEach((file) => {
        const kb = Math.max(1, Math.round(file.size / 1024));
        const f: UploadedFile = { id: `u${Date.now()}-${next.length}`, name: file.name, size: `${kb} KB`, kind: guessKind(file.name, next), sample: false, file };
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
  const runReview = useCallback(async () => {
    if (!plan || !stage) return;
    setScreen("running");
    setProgress(0);
    setConfirmed(true);
    setRunError(null);
    try {
      if (stage === "launching") {
        if (!target) return;
        // What the person confirmed: edited due dates, the launch date, and their team → project choices.
        const confirmedPlan: PlanDraft = {
          ...plan,
          launch_date: launch || plan.launch_date,
          items: plan.items.map((i) => (planDates[i.id] && planDates[i.id] !== i.due ? { ...i, due: planDates[i.id], due_text: planDates[i.id], due_is_inferred: false } : i)),
        };
        const confirmedTarget: ReleaseTarget = { ...target, projects: applyChoices(target.projects, choices) };
        const id = await backend.runReview(confirmedPlan, confirmedTarget, setProgress);
        const list = await backend.listRuns(confirmedTarget.epic.key);
        const loaded: Record<string, Run> = {};
        for (const r of list) loaded[r.id] = runsById[r.id] && r.id !== id ? runsById[r.id] : await backend.loadRun(confirmedTarget.epic.key, r.id);
        setRuns(list);
        setRunsById(loaded);
        setRunId(id);
        logEvent(`Ran the launch review (${fmtDate(id)} run)`);
      } else {
        const exclude = signals.filter((g) => signalsOff[g.id]).map((g) => g.id);
        const result = await backend.runStarter({ stage, files, excludeSignals: exclude, epic: stage === "building" ? epicVal : null }, setProgress);
        setStarter(result);
        addRecord({ id: `${result.stage}:${Date.now().toString(36)}`, at: new Date().toISOString(), stage: result.stage, title: result.stage === "starting" ? "Who to involve" : `Team coverage · ${result.epic ?? ""}`.trim(), summary: null, files: files.filter((f) => f.kind !== "other").map((f) => f.name), starter: result, signalsOff });
        logEvent(stage === "starting" ? `Found ${result.teams.length} teams to involve` : `Checked team coverage and approvals for ${epicVal}`);
      }
      setScreen("results");
    } catch (e) {
      setRunError(String((e as Error).message ?? e));
      setConfirmed(false);
      setScreen("apps");
    }
  }, [backend, stage, plan, target, launch, planDates, choices, runsById, signals, signalsOff, files, epicVal]);

  useEffect(() => {
    if (stage !== "launching" || !runId || !target || !plan || !confirmed) return;
    addRecord({ id: `launch:${target.epic.key}:${runId}`, at: new Date().toISOString(), stage: "launching", title: `Launch review · ${fmtDate(runId)} run`, summary: null,
      files: files.filter((f) => f.kind !== "other").map((f) => f.name),
      launch: { epic: target.epic.key, runId, target: { ...target, projects: applyChoices(target.projects, choices) }, plan, planDates, launch: launch || target.release_window.end } });
  }, [stage, runId, target?.epic.key, confirmed]); // eslint-disable-line react-hooks/exhaustive-deps
  // An early review from before records existed is recorded when the project opens.
  useEffect(() => {
    if (starter && confirmed && stage !== "launching" && !records.some((r) => r.starter && r.starter.label === starter.label && r.stage === starter.stage))
      addRecord({ id: `${starter.stage}:${starter.label}`, at: starter.analyzed_at, stage: starter.stage, title: starter.stage === "starting" ? "Who to involve" : `Team coverage · ${starter.epic ?? ""}`.trim(), summary: null, files: starter.files.map((f) => f.name), starter, signalsOff });
  }, [starter]); // eslint-disable-line react-hooks/exhaustive-deps

  // The project saves itself as it changes (shortly after, so typing does not write on every key).
  const snapshot: ProjectData = useMemo(() => ({
    stage, files: storableFiles(files), plan, signals, signalsOff, project, planDates, planConfirmed, epic, launch, choices: choices as Record<string, string>,
    confirmed, runId, starter, agentRead, lastRead: lastRead.current, jiraOn: jiraState === "on", events, summary, records,
  }), [stage, files, plan, signals, signalsOff, project, planDates, planConfirmed, epic, launch, choices, confirmed, runId, starter, agentRead, jiraState, events, summary, records]);
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

  /** Moving the project along its life: the files and connections stay; the new stage asks for what it needs next. */
  const nextStage = stage ? LIFECYCLE[LIFECYCLE.findIndex((l) => l.id === stage) + 1]?.id ?? null : null;
  const moveTo = (s: Stage) => {
    logEvent(`Moved from ${STAGE_SHORT[stage!]} to ${STAGE_SHORT[s]}`);
    setStageChoice(s);
    setSummary(null);
    setCurrentRecord(null); // the last review stays in History as a record of the stage the project has left
    setPlanNotice(`Now ${STAGE_SHORT[s].toLowerCase()}. Your files and connections are kept; the checklist shows what this stage still needs.`);
    setScreen("overview");
  };

  const headerEpic = target?.epic.key ?? plan?.epic_keys_mentioned[0] ?? null;
  const headerLaunch = stage === "launching" ? launch || plan?.launch_date || null : null;
  const projectName = project ?? target?.epic.summary ?? (plan ? "Your plan" : "New project");
  const canResults = confirmed && (stage === "launching" ? !!runId : !!starter);
  /** The first time through, the project is set up step by step; once it has a review, it is a workspace with fixed places. */
  const firstRun = records.length === 0 && !canResults;
  const steps: { id: Screen; label: string; disabled: boolean; active: boolean; done: boolean }[] = [
    { id: "start", label: "Stage", disabled: false, active: screen === "start", done: !!stage },
    { id: "plan", label: "Plan", disabled: !stage, active: screen === "plan", done: planConfirmed },
    { id: "apps", label: "Connections", disabled: !plan, active: screen === "apps", done: false },
    { id: "results", label: "Review", disabled: screen !== "running", active: screen === "running", done: false },
  ];
  /** Where "back" goes from each screen: the step before while setting up, the overview after. */
  const back: { label: string; to: Screen } | null = firstRun
    ? ({ plan: { label: "Step 1: Stage", to: "start" as Screen }, apps: { label: "Step 2: Plan", to: "plan" as Screen } } as Partial<Record<Screen, { label: string; to: Screen }>>)[screen] ?? null
    : screen === "start" || screen === "plan" || screen === "apps" ? { label: "Overview", to: "overview" } : null;
  const tabs: { id: Screen; label: string; disabled: boolean; active: boolean }[] = [
    { id: "overview", label: "Overview", disabled: !stage, active: screen === "overview" || screen === "start" },
    { id: "plan", label: "Plan", disabled: !stage, active: screen === "plan" },
    { id: "apps", label: "Connections", disabled: !plan, active: screen === "apps" },
    { id: "results", label: "Review", disabled: !canResults && screen !== "running", active: screen === "results" || screen === "running" },
    { id: "history", label: "History", disabled: !stage, active: screen === "history" },
  ];

  // ---- the overview's checklist: what this stage needs, worked out from the project as it stands ----
  const resolvedTeams = target ? allTeamsResolved(target.projects, choices) : false;
  const reviewReady = !!stage && !!plan && (stage === "starting" || (jiraState === "on" && epicOk && !!target && (stage === "building" || resolvedTeams)));
  const planFiles = files.filter((f) => PLAN_KINDS.includes(f.kind));
  const go = (sc: Screen) => () => setScreen(sc);
  const items: CheckItem[] = !stage ? [] : [
    { id: "org", label: "Your organisation", state: directoryFile || uploadedTeamList ? "done" : "optional",
      detail: directoryFile ? `Connected: ${directoryState.name}` : uploadedTeamList ? `From ${uploadedTeamList.name}` : "Connect your directory so owners are matched to real teams and people.",
      action: { label: directoryFile || uploadedTeamList ? "Manage" : "Connect", go: go("start") } },
    { id: "files", label: stage === "launching" ? "Plan of record" : "PRD or plan", state: hasPlanFile ? "done" : "todo",
      detail: hasPlanFile ? planFiles.map((f) => f.name).join(", ") : stage === "launching" ? "Add your POR deck or doc, and your launch checklist if you have one." : "Add your PRD, one-pager or brief.",
      action: { label: hasPlanFile ? "Change" : "Add", go: go("plan") } },
    { id: "read", label: "Read", state: plan ? "done" : hasPlanFile ? "todo" : "waiting",
      detail: plan ? (agentRead?.status === "done" ? `Read by ${agentRead.name}` : "Read") : hasPlanFile ? "Your files are added but not read for this stage yet." : "Add a file first.",
      action: { label: plan ? "See what was read" : "Read", go: go("plan") } },
    ...(stage !== "starting" ? [
      { id: "jira", label: "Jira", state: jiraState === "on" ? "done" : plan ? "todo" : "waiting", detail: jiraState === "on" ? `Connected · ${jira.site || "read-only"}` : "Where the work is tracked; read-only.", action: { label: jiraState === "on" ? "Manage" : "Connect", go: go("apps") } },
      { id: "epic", label: "The epic", state: target ? "done" : jiraState === "on" ? "todo" : "waiting", detail: target ? `${target.epic.key} · ${target.epic.summary}` : epicVal && !epicOk ? "Use a Jira key like INGEST-142." : "Which work in Jira this is.", action: { label: target ? "Change" : "Pick", go: go("apps") } },
    ] as CheckItem[] : []),
    ...(stage === "launching" ? [
      { id: "teams", label: "Teams matched to Jira projects", state: !target ? "waiting" : resolvedTeams ? "done" : "todo", detail: target ? `${target.projects.filter((t) => t.match !== "unresolved" || choices[t.team]).length} of ${target.projects.length} teams matched` : "After the epic.", action: { label: resolvedTeams ? "Check" : "Match", go: go("apps") } },
    ] as CheckItem[] : []),
    { id: "review", label: "Review", state: canResults ? "done" : reviewReady ? "todo" : "waiting",
      detail: canResults ? (summary?.detail ?? "Reviewed") : reviewReady ? "Everything it needs is here." : "After the steps above.",
      action: canResults ? { label: "Open", go: go("results") } : { label: RUN_LABEL[stage], go: () => void runReview() } },
  ];
  const firstTodo = items.find((i) => i.state === "todo");
  const next: NextUp = !stage ? { title: "Pick the stage", detail: "Where the project is decides what it asks for.", action: { label: "Pick the stage", go: go("start") } }
    : firstTodo ? (firstTodo.id === "review"
        ? { title: RUN_LABEL[stage], detail: "Everything this stage needs is in place.", action: { label: RUN_LABEL[stage], go: () => void runReview() } }
        : { title: { files: "Add your plan", read: "Read your files", jira: "Connect Jira", epic: "Pick the epic", teams: "Match each team to its Jira project" }[firstTodo.id] ?? firstTodo.label, detail: firstTodo.detail, action: firstTodo.action ? { label: firstTodo.action.label === "Read" ? "Read your files" : firstTodo.action.label, go: firstTodo.action.go } : undefined })
    : canResults ? (nextStage
        ? { title: "This stage is reviewed", detail: `Act on the review's next actions; re-run when the plan or the work changes. Move to ${STAGE_SHORT[nextStage].toLowerCase()} when the project gets there.`, action: { label: "Open the review", go: go("results") } }
        : { title: "Up to date", detail: "Act on the review's next actions, and re-run when the plan or the work changes.", action: { label: "Open the review", go: go("results") } })
    : { title: "Waiting on the steps below", detail: "Finish the checklist to run the review." };
  const latestRecord = canResults ? records.find((r) => r.id === currentRecord) ?? null : null;
  const earlierRecords = records.filter((r) => r.id !== latestRecord?.id).slice().reverse().slice(0, 3);

  const planIds = useMemo(() => (plan ? new Set(plan.items.map((i) => i.id)) : null), [plan]);

  return (
    <div>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand">
            {leave ? <button type="button" className="linkbtn home-link" onClick={() => void leave()}>‹ All projects</button> : <span className="name">Readiness Review</span>}
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
            {stage && <span className="stage-chip" data-testid="stage-chip">Stage: {STAGE_SHORT[stage]}</span>}
            <span className="tag">{live ? `Live · ${jira.site || "Jira"}` : "Sample data"}</span>
            {user && <span className="tag" data-testid="user-chip" title={user.email ?? undefined}>{user.name}</span>}
            {onSignOut && <button type="button" className="btn" style={{ minHeight: 32, padding: "0 12px", fontSize: 14 }} onClick={onSignOut}>Sign out</button>}
          </div>
        </div>
        {firstRun ? (
          <nav className="wrap steps setup-steps" aria-label="Setup">
            {steps.map((t, i) => (
              <button key={t.id} type="button" aria-current={t.active ? "step" : "false"} disabled={t.disabled} onClick={() => { if (!t.disabled && !t.active) setScreen(t.id); }}>
                <span className={"step-num" + (t.done && !t.active ? " done" : "")} aria-hidden="true">{t.done && !t.active ? "✓" : i + 1}</span>{t.label}
              </button>
            ))}
          </nav>
        ) : (
          <nav className="wrap steps" aria-label="Project">
            {tabs.map((t) => (
              <button key={t.id} type="button" aria-current={t.active ? "page" : "false"} disabled={t.disabled} onClick={() => { if (t.disabled) return; setOpenRecord(null); setScreen(t.id); }}>{t.label}</button>
            ))}
          </nav>
        )}
      </header>
      <main className="wrap page">
        {back && <button type="button" className="linkbtn back-link" onClick={() => setScreen(back.to)}>‹ {back.label}</button>}
        {screen === "start" && (
          <GetStarted stage={stage} onPick={(s) => { if (stage && s !== stage && !firstRun) { logEvent(`Moved from ${STAGE_SHORT[stage]} to ${STAGE_SHORT[s]}`); setCurrentRecord(null); setSummary(null); } if (stage && s !== stage && files.some((f) => f.via !== "directory")) setPlanNotice(`Stage changed to ${STAGE_SHORT[s]}. Your files are kept; check each file's "Read as" for this stage.`); setStageChoice(s); }} onContinue={() => { if (stage) setScreen(firstRun ? "plan" : "overview"); }} workspace={!firstRun} jiraOn={jiraState === "on"}
            directory={directoryState} live={live} {...directoryHandlers} />
        )}
        {screen === "plan" && stage && (
          <PlanDocuments eyebrow={firstRun ? undefined : "Plan"} backLabel={back?.label}
            stage={stage} files={files} plan={plan} planError={planError} planDates={planDates} signals={signals} signalsOff={signalsOff}
            notice={planNotice} onDismissNotice={() => setPlanNotice(null)}
            onAddFiles={(list) => { setPlanNotice(null); addFiles(list); }}
            onSetKind={(id, kind) => { setPlanNotice(null); setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, kind } : f))); }}
            onRemove={(id) => { setPlanNotice(null); setFiles((cur) => cur.filter((f) => f.id !== id)); }}
            onLoadSample={() => setFiles((cur) => { const replaced = cur.filter((f) => f.via !== "directory").length; setPlanNotice(replaced ? `Replaced ${replaced} file${replaced === 1 ? "" : "s"} with the sample set.` : null); return [...sampleFilesFor(stage), ...cur.filter((f) => f.via === "directory")]; })}
            onSetDate={(id, v) => setPlanDates((d) => ({ ...d, [id]: v }))}
            onToggleSignal={(id) => { setSignalsOff((s) => ({ ...s, [id]: !s[id] })); setConfirmed(false); }}
            agent={{ info: backend.agent, consent: agentConsent, setConsent: setAgentConsent, mode: agentMode, setMode: setAgentMode, stage: agentStage, progress: agentProgress, reading: planReading, read: agentRead, read_now: readFiles,
              folder: live && saved?.folder ? { path: saved.folder, use: () => readFiles(false, true) } : undefined }}
            onBack={() => setScreen(back?.to ?? "overview")}
            onConfirm={() => { setPlanConfirmed(true); setScreen("apps"); }}
          />
        )}
        {screen === "apps" && stage && plan && (
          <ConnectApps eyebrow={firstRun ? undefined : "Connections"} backLabel={back?.label}
            stage={stage}
            jira={jira} jiraState={jiraState} setJiraState={(s) => { setJiraState(s); if (s === "off") setConfirmed(false); }}
            directory={directoryState}
            agent={{ info: backend.agent, consent: agentConsent, setConsent: setAgentConsent, mode: agentMode, setMode: setAgentMode }}
            onConnectDirectory={connectDirectory} onDisconnectDirectory={disconnectDirectory}
            plan={plan} files={files} epic={epic} setEpic={(v) => { setEpic(v.toUpperCase()); setConfirmed(false); }} epicOk={epicOk}
            target={target} targetError={targetError} latestRun={runs.length ? runsById[runs[runs.length - 1].id] ?? null : null} runs={runs}
            launch={launch} setLaunch={setLaunch}
            choices={choices} setChoice={(team, c) => setChoices((cur) => { const n = { ...cur }; if (c === null) delete n[team]; else n[team] = c; return n; })}
            confirmed={confirmed} runError={runError}
            onBack={() => setScreen(back?.to ?? "overview")} onRun={runReview}
          />
        )}
        {screen === "running" && stage && (
          <Running stage={progress} projectStage={stage} plan={plan} epic={epicVal} latestRun={runId ? runsById[runId] : runs.length ? runsById[runs[runs.length - 1].id] : null} runs={runs}
            signalCount={signals.filter((g) => !signalsOff[g.id]).length} directoryGiven={hasTeamList} />
        )}
        {storeError && <div className="notice-grey" role="alert" style={{ marginBottom: 16 }}>{storeError}</div>}
        {screen === "overview" && stage && (
          <Overview name={name} stage={stage} nextStage={nextStage} onMove={moveTo} onChangeStage={go("start")}
            notice={planNotice} onDismissNotice={() => setPlanNotice(null)}
            next={next} items={items}
            latest={latestRecord} onOpenReview={go("results")}
            earlier={earlierRecords} onOpenRecord={(r) => { setScreen("history"); void showRecord(r); }}
            activity={events} onHistory={go("history")} />
        )}
        {screen === "results" && stage === "launching" && runId && target && (
          <Review onSummary={onSummary} eyebrow="Review"
            stage={stage} store={store} runs={runs} runsById={runsById} latestId={runId} target={target} launch={launch || target.release_window.end}
            planIds={planIds} planDates={planDates} plan={plan!} ownerSource={ownerSource}
            onChangeStage={() => setScreen("start")} onAddFiles={() => setScreen("plan")} onConnectApps={() => setScreen("apps")}
          />
        )}
        {screen === "results" && stage !== "launching" && starter && (
          <EarlyResults onSummary={onSummary} eyebrow="Review"
            starter={starter} signalsOff={signalsOff} store={store} launch={target?.epic.release_date ?? null}
            onChangeStage={() => setScreen("start")} onAddFiles={() => setScreen("plan")} onConnectApps={() => setScreen("apps")}
          />
        )}
        {screen === "history" && !openRecord && (
          <div className="flow stack">
            <header className="stack-sm" style={{ gap: 8 }}>
              <span className="eyebrow">History</span>
              <h1 className="flow-title">Everything this project has been through</h1>
              <p className="lead">Each review is kept as it was, at the stage it was run. Open one to see what it found then; the files added, readings and stage moves sit between them.</p>
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
                    <div><button type="button" className="btn" onClick={() => (item.rec!.id === currentRecord ? setScreen("results") : void showRecord(item.rec!))}>{item.rec.id === currentRecord ? "Open the overview" : "Open this review"}</button></div>
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
              <EarlyResults readOnly eyebrow="History" starter={openRecord.starter} signalsOff={openRecord.signalsOff ?? {}} store={store} launch={null}
                onChangeStage={() => {}} onAddFiles={() => {}} onConnectApps={() => {}} />
            )}
            {openRecord.launch && !recordRuns && !recordError && <p className="sm muted">Loading the run…</p>}
            {openRecord.launch && recordRuns && recordRuns.byId[openRecord.launch.runId] && (
              <Review readOnly eyebrow="History" stage="launching" store={store} runs={recordRuns.runs} runsById={recordRuns.byId} latestId={openRecord.launch.runId} target={openRecord.launch.target}
                launch={openRecord.launch.launch} planIds={new Set(openRecord.launch.plan.items.map((i) => i.id))} planDates={openRecord.launch.planDates} plan={openRecord.launch.plan} ownerSource={ownerSource}
                onChangeStage={() => {}} onAddFiles={() => {}} onConnectApps={() => {}} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
