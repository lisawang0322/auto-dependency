import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanDraft, ReleaseTarget, Run } from "@rrr/schemas";
import type { ReviewBackend, JiraConnection, DecisionStore, UploadedFile, FileKind, JiraState, RunSummary, ProgressStage } from "./backend/types";
import { SAMPLE_FILES } from "./backend/fixtureBackend";
import { fmtDate } from "./model/dates";
import { applyChoices, type TeamChoice } from "./model/review";
import { PlanDocuments } from "./screens/PlanDocuments";
import { ConnectJira } from "./screens/ConnectJira";
import { Running } from "./screens/Running";
import { Review } from "./screens/Review";

export type Screen = "docs" | "jira" | "running" | "review";

export interface AppProps { backend: ReviewBackend; jira: JiraConnection; store: DecisionStore }

export function guessKind(name: string, files: UploadedFile[]): FileKind {
  const n = name.toLowerCase();
  if (/check|readiness|gate/.test(n)) return "checks";
  if (/org|team|owner|raci|roster/.test(n)) return "teams";
  if (!files.some((f) => f.kind === "plan")) return "plan";
  return "other";
}

export function App({ backend, jira, store }: AppProps) {
  const [screen, setScreen] = useState<Screen>("docs");
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [plan, setPlan] = useState<PlanDraft | null>(null);
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
  const [stage, setStage] = useState<ProgressStage>(0);
  const [runId, setRunId] = useState<string | null>(null);
  const seq = useRef(0);

  const hasPlanFile = files.some((f) => f.kind === "plan");
  const hasTeamList = files.some((f) => f.kind === "teams");
  const live = backend.mode === "live";

  // Live mode may already be connected (credentials from the server's environment).
  useEffect(() => { let on = true; jira.initialState().then((s) => { if (on) setJiraState(s); }); return () => { on = false; }; }, [jira]);

  // Stage A: re-extract whenever the files or their "read as" change.
  useEffect(() => {
    const my = ++seq.current;
    setPlanConfirmed(false);
    setConfirmed(false);
    setTarget(null);
    setChoices({});
    if (!hasPlanFile) { setPlan(null); setPlanError(null); return; }
    backend.extractPlan(files).then((p) => {
      if (my !== seq.current) return;
      setPlan(p);
      setPlanError(null);
      if (p.launch_date) setLaunch(p.launch_date);
    }).catch((e) => { if (my === seq.current) { setPlan(null); setPlanError(String(e.message ?? e)); } });
  }, [files, backend, hasPlanFile]);

  const epicVal = epic.trim();
  const epicOk = /^[A-Z][A-Z0-9]+-\d+$/.test(epicVal);

  // Stage B: resolve once connected and the epic key is valid.
  useEffect(() => {
    if (!plan || jiraState !== "on" || !epicOk) { setTarget(null); setTargetError(null); return; }
    let live = true;
    backend.resolveRelease(plan, epicVal, hasTeamList).then(async (t) => {
      if (!live) return;
      setTarget(t);
      setTargetError(null);
      setChoices({});
      const list = await backend.listRuns(t.epic.key);
      const loaded: Record<string, Run> = {};
      for (const r of list) loaded[r.id] = await backend.loadRun(t.epic.key, r.id);
      if (!live) return;
      setRuns(list);
      setRunsById(loaded);
    }).catch((e) => { if (live) { setTarget(null); setTargetError(String(e.message ?? e)); } });
    return () => { live = false; };
  }, [plan, jiraState, epicOk, epicVal, hasTeamList, backend]);

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

  const [runError, setRunError] = useState<string | null>(null);
  const runReview = useCallback(async () => {
    if (!plan || !target) return;
    setScreen("running");
    setStage(0);
    setConfirmed(true);
    setRunError(null);
    // What the person confirmed: edited due dates, the launch date, and their team → project choices.
    const confirmedPlan: PlanDraft = {
      ...plan,
      launch_date: launch || plan.launch_date,
      items: plan.items.map((i) => (planDates[i.id] && planDates[i.id] !== i.due ? { ...i, due: planDates[i.id], due_text: planDates[i.id], due_is_inferred: false } : i)),
    };
    const confirmedTarget: ReleaseTarget = { ...target, projects: applyChoices(target.projects, choices) };
    try {
      const id = await backend.runReview(confirmedPlan, confirmedTarget, setStage);
      const list = await backend.listRuns(confirmedTarget.epic.key);
      const loaded: Record<string, Run> = {};
      for (const r of list) loaded[r.id] = runsById[r.id] && r.id !== id ? runsById[r.id] : await backend.loadRun(confirmedTarget.epic.key, r.id);
      setRuns(list);
      setRunsById(loaded);
      setRunId(id);
      setScreen("review");
    } catch (e) {
      setRunError(String((e as Error).message ?? e));
      setConfirmed(false);
      setScreen("jira");
    }
  }, [backend, plan, target, launch, planDates, choices, runsById]);

  const headerEpic = target?.epic.key ?? plan?.epic_keys_mentioned[0] ?? null;
  const headerLaunch = launch || plan?.launch_date || null;
  const tabs: { id: Screen; label: string; disabled: boolean; active: boolean }[] = [
    { id: "docs", label: "1. Plan documents", disabled: false, active: screen === "docs" },
    { id: "jira", label: "2. Connect Jira", disabled: !planConfirmed, active: screen === "jira" },
    { id: "review", label: "3. Review", disabled: !confirmed, active: screen === "review" || screen === "running" },
  ];

  const planIds = useMemo(() => (plan ? new Set(plan.items.map((i) => i.id)) : null), [plan]);

  return (
    <div>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand">
            <span className="name">Release Readiness Review</span>
            {headerEpic && (
              <span className="muted">{target?.epic.summary ? `${target.epic.summary} · ` : ""}<span className="mono">{headerEpic}</span>{headerLaunch ? ` · launch ${fmtDate(headerLaunch)}` : ""}</span>
            )}
          </div>
          <span className="tag">{live ? `Live · ${jira.site || "Jira"}` : "Sample data"}</span>
        </div>
        <nav className="wrap steps" aria-label="Review steps">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={t.active ? "page" : "false"} disabled={t.disabled} onClick={() => !t.disabled && setScreen(t.id)}>{t.label}</button>
          ))}
        </nav>
      </header>
      <main className="wrap page">
        {screen === "docs" && (
          <PlanDocuments
            files={files} plan={plan} planError={planError} planDates={planDates}
            onAddFiles={addFiles}
            onSetKind={(id, kind) => setFiles((cur) => cur.map((f) => (f.id === id ? { ...f, kind } : f)))}
            onRemove={(id) => setFiles((cur) => cur.filter((f) => f.id !== id))}
            onLoadSample={() => setFiles(SAMPLE_FILES)}
            onSetDate={(id, v) => setPlanDates((d) => ({ ...d, [id]: v }))}
            onConfirm={() => { setPlanConfirmed(true); setScreen("jira"); }}
          />
        )}
        {screen === "jira" && plan && (
          <ConnectJira
            jira={jira} jiraState={jiraState} setJiraState={(s) => { setJiraState(s); if (s === "off") setConfirmed(false); }}
            plan={plan} files={files} epic={epic} setEpic={(v) => { setEpic(v.toUpperCase()); setConfirmed(false); }} epicOk={epicOk}
            target={target} targetError={targetError} latestRun={runs.length ? runsById[runs[runs.length - 1].id] ?? null : null} runs={runs}
            launch={launch} setLaunch={setLaunch}
            choices={choices} setChoice={(team, c) => setChoices((cur) => { const n = { ...cur }; if (c === null) delete n[team]; else n[team] = c; return n; })}
            confirmed={confirmed} runError={runError}
            onBack={() => setScreen("docs")} onRun={runReview}
          />
        )}
        {screen === "running" && <Running stage={stage} plan={plan} latestRun={runId ? runsById[runId] : runs.length ? runsById[runs[runs.length - 1].id] : null} runs={runs} />}
        {screen === "review" && runId && target && (
          <Review
            store={store} runs={runs} runsById={runsById} latestId={runId} target={target} launch={launch || target.release_window.end}
            planIds={planIds} planDates={planDates} plan={plan!} hasTeamList={hasTeamList}
          />
        )}
      </main>
    </div>
  );
}
