import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanDraft, ReleaseTarget, Run, Signal, Starter } from "@rrr/schemas";
import { PLAN_KINDS, type ReviewBackend, type JiraConnection, type DecisionStore, type UploadedFile, type FileKind, type JiraState, type RunSummary, type ProgressStage, type Stage, type AgentConsent, type AgentRead, type AgentReadStage, type UserInfo } from "./backend/types";
import { sampleFilesFor, SAMPLE_DIRECTORY } from "./backend/fixtureBackend";
import { fmtDate } from "./model/dates";
import { applyChoices, type TeamChoice } from "./model/review";
import { GetStarted, STAGE_SHORT } from "./screens/GetStarted";
import { PlanDocuments } from "./screens/PlanDocuments";
import { ConnectApps } from "./screens/ConnectApps";
import { Running } from "./screens/Running";
import { Review, type OwnerSource } from "./screens/Review";
import { EarlyResults } from "./screens/EarlyResults";

/** The four steps of the prototype: get started → your plan → connect apps → next steps (running sits between 3 and 4). */
export type Screen = "start" | "plan" | "apps" | "running" | "results";

export interface AppProps { backend: ReviewBackend; jira: JiraConnection; store: DecisionStore; user?: UserInfo | null; initialConsent?: AgentConsent; initialMode?: string | null; onSignOut?: () => void }

export function guessKind(name: string, files: UploadedFile[]): FileKind {
  const n = name.toLowerCase();
  if (/check|readiness|gate/.test(n)) return "checks";
  if (/org|team|owner|raci|roster|directory/.test(n)) return "teams";
  if (/prd|one.?pager|brief|spec|requirements/.test(n)) return "prd";
  if (/por|plan.?of.?record|\.pptx?$|\.key$|deck|slides/.test(n)) return "plan";
  if (!files.some((f) => PLAN_KINDS.includes(f.kind))) return "plan";
  return "other";
}

export function App({ backend, jira, store, user = null, initialConsent = "unknown", initialMode = null, onSignOut }: AppProps) {
  const [screen, setScreen] = useState<Screen>("start");
  const [stage, setStageChoice] = useState<Stage | null>(null);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [plan, setPlan] = useState<PlanDraft | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [signalsOff, setSignalsOff] = useState<Record<string, boolean>>({});
  const [project, setProject] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planDates, setPlanDates] = useState<Record<string, string>>({});
  const [planConfirmed, setPlanConfirmed] = useState(false);
  const [jiraState, setJiraState] = useState<JiraState>("off");
  const [epic, setEpic] = useState("");
  const [target, setTarget] = useState<ReleaseTarget | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<string>("");
  const [choices, setChoices] = useState<Record<string, TeamChoice>>({});
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsById, setRunsById] = useState<Record<string, Run>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState<ProgressStage>(0);
  const [runId, setRunId] = useState<string | null>(null);
  const [starter, setStarter] = useState<Starter | null>(null);
  // The agent (Devin) reading uploads: asked once, remembered; progress while it reads; what it read.
  const [agentConsent, setAgentConsentState] = useState<AgentConsent>(initialConsent);
  const setAgentConsent = useCallback((c: AgentConsent) => { setAgentConsentState(c); void backend.saveSettings({ agent_consent: c }).catch(() => {}); }, [backend]);
  // The Devin tier that reads the files: null means the company default. Changing it re-reads (a different tier may read differently).
  const [agentMode, setAgentModeState] = useState<string | null>(initialMode);
  const setAgentMode = useCallback((m: string | null) => { setAgentModeState(m); void backend.saveSettings({ agent_mode: m }).catch(() => {}); }, [backend]);
  const [agentStage, setAgentStage] = useState<AgentReadStage | null>(null);
  const [agentRead, setAgentRead] = useState<AgentRead | null>(null);
  const seq = useRef(0);

  const hasPlanFile = files.some((f) => PLAN_KINDS.includes(f.kind));
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
  useEffect(() => { let on = true; jira.initialState().then((s) => { if (on) setJiraState(s); }); return () => { on = false; }; }, [jira]);

  // Stage A: re-extract whenever the files, their "read as" or the stage change. A directory connected on
  // step 3 is a file too, but it does not send the person back to confirm the plan.
  const uploadKey = files.filter((f) => f.via !== "directory").map((f) => `${f.id}:${f.kind}`).join("|") + `@${stage}`;
  const prevUploadKey = useRef(uploadKey);
  useEffect(() => {
    const my = ++seq.current;
    if (prevUploadKey.current !== uploadKey) { setPlanConfirmed(false); prevUploadKey.current = uploadKey; }
    setConfirmed(false);
    setTarget(null);
    setChoices({});
    setStarter(null);
    // The rules read for free on every change; the agent (which spends credits) only reads on "Read with Devin" below,
    // so the person can first fix what each file is read as. A change here makes any earlier agent reading stale.
    setAgentRead(null);
    setAgentStage(null);
    if (!hasPlanFile || !stage) { setPlan(null); setSignals([]); setProject(null); setPlanError(null); return; }
    backend.extractPlan(files, stage, { agent: false }).then((r) => {
      if (my !== seq.current) return;
      setPlan(r.plan);
      setSignals(r.signals);
      setProject(r.project);
      setPlanError(null);
      if (r.plan.launch_date) setLaunch(r.plan.launch_date);
    }).catch((e) => { if (my === seq.current) { setPlan(null); setSignals([]); setPlanError(String(e.message ?? e)); } });
  }, [files, backend, hasPlanFile, uploadKey, stage]);

  /** The deliberate step: the agent opens the plan documents, with the kinds and mode as they stand now. */
  const readWithAgent = useCallback(() => {
    if (!hasPlanFile || !stage || agentConsent !== "yes" || !backend.agent.available) return;
    const my = ++seq.current;
    setAgentRead(null);
    setAgentStage(0);
    setConfirmed(false);
    backend.extractPlan(files, stage, { agent: true, onProgress: (s) => { if (my === seq.current) setAgentStage(s); } }).then((r) => {
      if (my !== seq.current) return;
      setPlan(r.plan);
      setSignals(r.signals);
      setProject(r.project);
      setPlanError(null);
      setAgentRead(r.agent ?? null);
      setAgentStage(null);
      if (r.plan.launch_date) setLaunch(r.plan.launch_date);
    }).catch((e) => { if (my === seq.current) { setAgentStage(null); setPlanError(String(e.message ?? e)); } });
  }, [backend, files, stage, hasPlanFile, agentConsent]);

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
      setChoices({});
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

  const addFiles = useCallback((list: FileList | File[] | null) => {
    if (!list) return;
    const picked = Array.from(list); // copy now: the input's FileList is cleared after the handler returns
    setFiles((cur) => {
      const next = [...cur];
      picked.forEach((file) => {
        const kb = Math.max(1, Math.round(file.size / 1024));
        next.push({ id: `u${Date.now()}-${next.length}`, name: file.name, size: `${kb} KB`, kind: guessKind(file.name, next), sample: false, file });
      });
      return next;
    });
  }, []);

  // The employee directory (R15): a connector that, for now, is a team list read the same way as an uploaded one.
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
  const disconnectDirectory = useCallback(() => setFiles((cur) => cur.filter((f) => f.via !== "directory")), []);

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
      } else {
        const exclude = signals.filter((g) => signalsOff[g.id]).map((g) => g.id);
        const result = await backend.runStarter({ stage, files, excludeSignals: exclude, epic: stage === "building" ? epicVal : null }, setProgress);
        setStarter(result);
      }
      setScreen("results");
    } catch (e) {
      setRunError(String((e as Error).message ?? e));
      setConfirmed(false);
      setScreen("apps");
    }
  }, [backend, stage, plan, target, launch, planDates, choices, runsById, signals, signalsOff, files, epicVal]);

  const headerEpic = target?.epic.key ?? plan?.epic_keys_mentioned[0] ?? null;
  const headerLaunch = stage === "launching" ? launch || plan?.launch_date || null : null;
  const projectName = project ?? target?.epic.summary ?? (plan ? "Your plan" : "New project");
  const canResults = confirmed && (stage === "launching" ? !!runId : !!starter);
  const tabs: { id: Screen; label: string; disabled: boolean; active: boolean }[] = [
    { id: "start", label: "1. Get started", disabled: false, active: screen === "start" },
    { id: "plan", label: "2. Your plan", disabled: !stage, active: screen === "plan" },
    { id: "apps", label: "3. Connect apps", disabled: !planConfirmed, active: screen === "apps" },
    { id: "results", label: "4. Next steps", disabled: !canResults, active: screen === "results" || screen === "running" },
  ];

  const planIds = useMemo(() => (plan ? new Set(plan.items.map((i) => i.id)) : null), [plan]);

  return (
    <div>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand">
            <span className="name">Readiness Review</span>
            <span className="muted">{projectName}{headerEpic ? <> · <span className="mono">{headerEpic}</span></> : null}{headerLaunch ? ` · launch ${fmtDate(headerLaunch)}` : ""}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            {stage && <span className="stage-chip" data-testid="stage-chip">Stage: {STAGE_SHORT[stage]}</span>}
            <span className="tag">{live ? `Live · ${jira.site || "Jira"}` : "Sample data"}</span>
            {user && <span className="tag" data-testid="user-chip" title={user.email ?? undefined}>{user.name}</span>}
            {onSignOut && <button type="button" className="btn" style={{ minHeight: 32, padding: "0 12px", fontSize: 14 }} onClick={onSignOut}>Sign out</button>}
          </div>
        </div>
        <nav className="wrap steps" aria-label="Steps">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={t.active ? "page" : "false"} disabled={t.disabled} onClick={() => !t.disabled && setScreen(t.id)}>{t.label}</button>
          ))}
        </nav>
      </header>
      <main className="wrap page">
        {screen === "start" && (
          <GetStarted stage={stage} onPick={(s) => { if (stage && s !== stage && files.some((f) => f.via !== "directory")) setPlanNotice(`Stage changed to ${STAGE_SHORT[s]}. Your files are kept; check each file's "Read as" for this stage.`); setStageChoice(s); }} onContinue={() => { if (stage) setScreen("plan"); }} />
        )}
        {screen === "plan" && stage && (
          <PlanDocuments
            stage={stage} files={files} plan={plan} planError={planError} planDates={planDates} signals={signals} signalsOff={signalsOff}
            notice={planNotice} onDismissNotice={() => setPlanNotice(null)}
            onAddFiles={(list) => { setPlanNotice(null); addFiles(list); }}
            onSetKind={(id, kind) => { setPlanNotice(null); setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, kind } : f))); }}
            onRemove={(id) => { setPlanNotice(null); setFiles((cur) => cur.filter((f) => f.id !== id)); }}
            onLoadSample={() => setFiles((cur) => { const replaced = cur.filter((f) => f.via !== "directory").length; setPlanNotice(replaced ? `Replaced ${replaced} file${replaced === 1 ? "" : "s"} with the sample set.` : null); return [...sampleFilesFor(stage), ...cur.filter((f) => f.via === "directory")]; })}
            onSetDate={(id, v) => setPlanDates((d) => ({ ...d, [id]: v }))}
            onToggleSignal={(id) => { setSignalsOff((s) => ({ ...s, [id]: !s[id] })); setConfirmed(false); }}
            agent={{ info: backend.agent, consent: agentConsent, setConsent: setAgentConsent, mode: agentMode, setMode: setAgentMode, stage: agentStage, read: agentRead, read_now: readWithAgent }}
            onBack={() => setScreen("start")}
            onConfirm={() => { setPlanConfirmed(true); setScreen("apps"); }}
          />
        )}
        {screen === "apps" && stage && plan && (
          <ConnectApps
            stage={stage}
            jira={jira} jiraState={jiraState} setJiraState={(s) => { setJiraState(s); if (s === "off") setConfirmed(false); }}
            directory={{ connected: !!directoryFile, name: directoryFile?.name ?? null, fromFiles: uploadedTeamList?.name ?? null }}
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
        {screen === "results" && stage === "launching" && runId && target && (
          <Review
            stage={stage} store={store} runs={runs} runsById={runsById} latestId={runId} target={target} launch={launch || target.release_window.end}
            planIds={planIds} planDates={planDates} plan={plan!} ownerSource={ownerSource}
            onChangeStage={() => setScreen("start")} onAddFiles={() => setScreen("plan")} onConnectApps={() => setScreen("apps")}
          />
        )}
        {screen === "results" && stage !== "launching" && starter && (
          <EarlyResults
            starter={starter} signalsOff={signalsOff} store={store} launch={target?.epic.release_date ?? null}
            onChangeStage={() => setScreen("start")} onAddFiles={() => setScreen("plan")} onConnectApps={() => setScreen("apps")}
          />
        )}
      </main>
    </div>
  );
}
