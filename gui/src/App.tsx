import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanDraft, ReleaseTarget, Run, Signal, Starter } from "@rrr/schemas";
import { PLAN_KINDS, type ReviewBackend, type JiraConnection, type DecisionStore, type UploadedFile, type FileKind, type JiraState, type RunSummary, type ProgressStage, type Stage, type AgentConsent, type AgentRead, type AgentReadStage, type ReadProgress, type UserInfo, type DirectoryInfo, type DirectorySourceId, type ProjectRecord, type ProjectStore, type ProjectData, type ProjectEvent, type ProjectSummary } from "./backend/types";
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

/** Setting a project up: get started → your plan → connect apps → overview (running sits between 3 and 4). Once it has
 *  results the same screens become the project's workspace: overview, files, connections, stage, history. */
export type Screen = "start" | "plan" | "apps" | "running" | "results" | "history";

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
  const [screen, setScreen] = useState<Screen>(restoredResults ? "results" : d.planConfirmed && d.plan ? "apps" : d.stage ? "plan" : "start");
  const [name, setName] = useState(saved?.name ?? "New project");
  const [events, setEvents] = useState<ProjectEvent[]>(d.events ?? []);
  const [summary, setSummary] = useState<ProjectSummary | null>(d.summary ?? null);
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

  /** The deliberate step: read the files as they stand now, with Devin (which spends credits) or the rules alone. */
  const readFiles = useCallback((withAgent: boolean) => {
    if (!hasReadable || !stage) return;
    const useAgent = withAgent && backend.agent.available;
    lastRead.current = useAgent;
    const my = ++seq.current;
    setAgentRead(null);
    setAgentStage(useAgent ? 0 : null);
    setAgentProgress(null);
    setPlanReading(true);
    setConfirmed(false);
    backend.extractPlan(files, stage, { agent: useAgent, onProgress: (st, pr) => { if (my === seq.current) { setAgentStage(st); if (pr) setAgentProgress(pr); } } }).then((r) => {
      if (my !== seq.current) return;
      setPlan(r.plan); setSignals(r.signals); setProject(r.project); setPlanError(null);
      setAgentRead(r.agent ?? null); setAgentStage(null); setAgentProgress(null); setPlanReading(false);
      if (r.plan.launch_date) setLaunch(r.plan.launch_date);
      logEvent(useAgent ? `${backend.agent.name} read ${files.filter((f) => f.kind !== "other").length} file${files.length === 1 ? "" : "s"}${r.agent?.cached ? " (an earlier reading)" : ""}` : "Read the files with the built-in rules");
    }).catch((e) => { if (my === seq.current) { setPlan(null); setSignals([]); setAgentStage(null); setPlanReading(false); setPlanError(String(e.message ?? e)); } });
  }, [backend, files, stage, hasReadable]);
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
        logEvent(stage === "starting" ? `Found ${result.teams.length} teams to involve` : `Checked team coverage and approvals for ${epicVal}`);
      }
      setScreen("results");
    } catch (e) {
      setRunError(String((e as Error).message ?? e));
      setConfirmed(false);
      setScreen("apps");
    }
  }, [backend, stage, plan, target, launch, planDates, choices, runsById, signals, signalsOff, files, epicVal]);

  // The project saves itself as it changes (shortly after, so typing does not write on every key).
  const snapshot: ProjectData = useMemo(() => ({
    stage, files: storableFiles(files), plan, signals, signalsOff, project, planDates, planConfirmed, epic, launch, choices: choices as Record<string, string>,
    confirmed, runId, starter, agentRead, lastRead: lastRead.current, jiraOn: jiraState === "on", events, summary,
  }), [stage, files, plan, signals, signalsOff, project, planDates, planConfirmed, epic, launch, choices, confirmed, runId, starter, agentRead, jiraState, events, summary]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">("saved");
  const firstSave = useRef(true);
  useEffect(() => {
    if (!saved || !projectStore) return;
    if (firstSave.current) { firstSave.current = false; return; }
    setSaveState("saving");
    const t = setTimeout(() => { projectStore.save(saved.id, name.trim() || "Untitled project", snapshot).then(() => setSaveState("saved")).catch(() => setSaveState("failed")); }, 400);
    return () => clearTimeout(t);
  }, [snapshot, name]); // eslint-disable-line react-hooks/exhaustive-deps
  const onSummary = useCallback((s: Omit<ProjectSummary, "at">) => setSummary((cur) => (cur && cur.status === s.status && cur.open === s.open && cur.detail === s.detail ? cur : { ...s, at: new Date().toISOString() })), []);

  /** Moving the project along its life: the files and connections stay; the new stage asks for what it needs next. */
  const nextStage = stage ? LIFECYCLE[LIFECYCLE.findIndex((l) => l.id === stage) + 1]?.id ?? null : null;
  const moveTo = (s: Stage) => {
    logEvent(`Moved from ${STAGE_SHORT[stage!]} to ${STAGE_SHORT[s]}`);
    setStageChoice(s);
    setSummary(null);
    setPlanNotice(`Now ${STAGE_SHORT[s].toLowerCase()}. Your files and connections are kept. Check each file's "Read as", add anything this stage needs, and read again.`);
    setScreen("plan");
  };

  const headerEpic = target?.epic.key ?? plan?.epic_keys_mentioned[0] ?? null;
  const headerLaunch = stage === "launching" ? launch || plan?.launch_date || null : null;
  const projectName = project ?? target?.epic.summary ?? (plan ? "Your plan" : "New project");
  const canResults = confirmed && (stage === "launching" ? !!runId : !!starter);
  /** Once a project has been reviewed it is a workspace: its overview first, the rest as places to keep it current. */
  const [workspace, setWorkspace] = useState(restoredResults);
  useEffect(() => { if (canResults) setWorkspace(true); }, [canResults]);
  const tabs: { id: Screen; label: string; disabled: boolean; active: boolean }[] = workspace ? [
    { id: "results", label: "Overview", disabled: !canResults && screen !== "running", active: screen === "results" || screen === "running" },
    { id: "plan", label: "Files and plan", disabled: !stage, active: screen === "plan" },
    { id: "apps", label: "Connections", disabled: !plan, active: screen === "apps" },
    { id: "start", label: "Stage and organisation", disabled: false, active: screen === "start" },
    { id: "history", label: "History", disabled: false, active: screen === "history" },
  ] : [
    { id: "start", label: "1. Get started", disabled: false, active: screen === "start" },
    { id: "plan", label: "2. Your plan", disabled: !stage, active: screen === "plan" },
    { id: "apps", label: "3. Connect apps", disabled: !planConfirmed, active: screen === "apps" },
    { id: "results", label: "4. Overview", disabled: !canResults, active: screen === "results" || screen === "running" },
  ];

  const planIds = useMemo(() => (plan ? new Set(plan.items.map((i) => i.id)) : null), [plan]);

  return (
    <div>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand">
            {onHome ? <button type="button" className="linkbtn home-link" onClick={onHome}>‹ All projects</button> : <span className="name">Readiness Review</span>}
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
        <nav className="wrap steps" aria-label={workspace ? "Project" : "Steps"}>
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={t.active ? "page" : "false"} disabled={t.disabled} onClick={() => !t.disabled && setScreen(t.id)}>{t.label}</button>
          ))}
        </nav>
      </header>
      <main className="wrap page">
        {screen === "start" && (
          <GetStarted stage={stage} onPick={(s) => { if (stage && s !== stage && workspace) logEvent(`Moved from ${STAGE_SHORT[stage]} to ${STAGE_SHORT[s]}`); if (stage && s !== stage && files.some((f) => f.via !== "directory")) setPlanNotice(`Stage changed to ${STAGE_SHORT[s]}. Your files are kept; check each file's "Read as" for this stage.`); setStageChoice(s); }} onContinue={() => { if (stage) setScreen("plan"); }} workspace={workspace}
            directory={directoryState} live={live} {...directoryHandlers} />
        )}
        {screen === "plan" && stage && (
          <PlanDocuments eyebrow={workspace ? "Files and plan" : undefined}
            stage={stage} files={files} plan={plan} planError={planError} planDates={planDates} signals={signals} signalsOff={signalsOff}
            notice={planNotice} onDismissNotice={() => setPlanNotice(null)}
            onAddFiles={(list) => { setPlanNotice(null); addFiles(list); }}
            onSetKind={(id, kind) => { setPlanNotice(null); setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, kind } : f))); }}
            onRemove={(id) => { setPlanNotice(null); setFiles((cur) => cur.filter((f) => f.id !== id)); }}
            onLoadSample={() => setFiles((cur) => { const replaced = cur.filter((f) => f.via !== "directory").length; setPlanNotice(replaced ? `Replaced ${replaced} file${replaced === 1 ? "" : "s"} with the sample set.` : null); return [...sampleFilesFor(stage), ...cur.filter((f) => f.via === "directory")]; })}
            onSetDate={(id, v) => setPlanDates((d) => ({ ...d, [id]: v }))}
            onToggleSignal={(id) => { setSignalsOff((s) => ({ ...s, [id]: !s[id] })); setConfirmed(false); }}
            agent={{ info: backend.agent, consent: agentConsent, setConsent: setAgentConsent, mode: agentMode, setMode: setAgentMode, stage: agentStage, progress: agentProgress, reading: planReading, read: agentRead, read_now: readFiles }}
            onBack={() => setScreen("start")}
            onConfirm={() => { setPlanConfirmed(true); setScreen("apps"); }}
          />
        )}
        {screen === "apps" && stage && plan && (
          <ConnectApps eyebrow={workspace ? "Connections" : undefined}
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
            onBack={() => setScreen("plan")} onRun={runReview}
          />
        )}
        {screen === "running" && stage && (
          <Running stage={progress} projectStage={stage} plan={plan} epic={epicVal} latestRun={runId ? runsById[runId] : runs.length ? runsById[runs[runs.length - 1].id] : null} runs={runs}
            signalCount={signals.filter((g) => !signalsOff[g.id]).length} directoryGiven={hasTeamList} />
        )}
        {storeError && <div className="notice-grey" role="alert" style={{ marginBottom: 16 }}>{storeError}</div>}
        {screen === "results" && stage && canResults && saved && (
          <section className="lifecycle" aria-label="Project stage" data-testid="lifecycle">
            <ol className="life-steps">
              {LIFECYCLE.map((l, i) => {
                const at = LIFECYCLE.findIndex((x) => x.id === stage);
                return <li key={l.id} className={i < at ? "past" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}><span className="life-num" aria-hidden="true">{i < at ? "✓" : i + 1}</span>{l.label}</li>;
              })}
            </ol>
            {nextStage ? (
              <div className="life-next">
                <span className="sm muted">{nextStage === "building" ? "When people are on board and work is tracked in Jira:" : "When there's a launch date and a go/no-go coming up:"}</span>
                <button type="button" className="btn" onClick={() => moveTo(nextStage)}>Move to {STAGE_SHORT[nextStage].toLowerCase()}</button>
              </div>
            ) : <span className="sm muted">Final stage. Re-run the review as the work changes; each run is kept in History.</span>}
          </section>
        )}
        {screen === "results" && stage === "launching" && runId && target && (
          <Review onSummary={onSummary} eyebrow={workspace ? "Overview" : undefined}
            stage={stage} store={store} runs={runs} runsById={runsById} latestId={runId} target={target} launch={launch || target.release_window.end}
            planIds={planIds} planDates={planDates} plan={plan!} ownerSource={ownerSource}
            onChangeStage={() => setScreen("start")} onAddFiles={() => setScreen("plan")} onConnectApps={() => setScreen("apps")}
          />
        )}
        {screen === "results" && stage !== "launching" && starter && (
          <EarlyResults onSummary={onSummary} eyebrow={workspace ? "Overview" : undefined}
            starter={starter} signalsOff={signalsOff} store={store} launch={target?.epic.release_date ?? null}
            onChangeStage={() => setScreen("start")} onAddFiles={() => setScreen("plan")} onConnectApps={() => setScreen("apps")}
          />
        )}
        {screen === "history" && (
          <div className="flow stack">
            <header className="stack-sm" style={{ gap: 8 }}>
              <span className="eyebrow">{name}</span>
              <h1 className="flow-title">History</h1>
              <p className="lead">What happened to this project and when: files added, readings, reviews and stage moves. Decisions on findings are kept with each review.</p>
            </header>
            {events.length === 0 ? <p className="sm muted">Nothing yet.</p> : (
              <ol className="history" data-testid="history">
                {[...events].reverse().map((e, i) => (
                  <li key={i}><span className="small muted mono">{fmtDate(e.at.slice(0, 10))} {e.at.slice(11, 16)}</span><span>{e.text}</span></li>
                ))}
              </ol>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
