import { useEffect, useRef, useState } from "react";
import type { Stage } from "../backend/types";
import type { DirectoryState, DirectoryHandlers } from "./ConnectApps";
import { DirectoryDialog } from "./DirectoryDialog";

export interface StageDef { id: Stage; title: string; desc: string; gets: string; built: boolean; note: string }

export const STAGES: StageDef[] = [
  { id: "starting", title: "Just starting", desc: "An idea or a PRD, but no team yet, and maybe no Jira.", gets: "Who to involve, who to contact, and the approvals you'll need.", built: true, note: "" },
  { id: "building", title: "Team forming, work underway", desc: "Some people are on board and work is tracked, in Jira or similar.", gets: "Which teams are missing, which approvals haven't started, and what to do next.", built: true, note: "" },
  { id: "launching", title: "Preparing to launch", desc: "There's a launch date and a go/no-go coming up.", gets: "What blocks launch, with evidence and owners, and your next actions.", built: true, note: "" },
];

export const STAGE_SHORT: Record<Stage, string> = { starting: "Just starting", building: "Building", launching: "Preparing to launch" };

type Need = "Required" | "Recommended" | "Optional";
/** What to have ready, per stage. "plan" rows say what counts as a plan; the "directory" row shows the connection above. */
interface PrepItem { label: string; why: string; need: Need; kind?: "plan" | "directory" }
const PREP: Record<Stage, PrepItem[]> = {
  starting: [
    { label: "Your PRD or one-pager", why: "What you're building and for whom", need: "Required", kind: "plan" },
    { label: "Employee directory or org chart", why: "Turns team suggestions into names", need: "Recommended", kind: "directory" },
    { label: "Company launch checklist", why: "The approvals your company expects", need: "Optional" },
  ],
  building: [
    { label: "Your plan (PRD, POR or brief)", why: "What should be happening", need: "Required", kind: "plan" },
    { label: "Access to your work tracker", why: "Who is actually working on it", need: "Required" },
    { label: "Employee directory or org chart", why: "Names for the teams you're missing", need: "Recommended", kind: "directory" },
    { label: "Company launch checklist", why: "Approvals your company expects", need: "Optional" },
  ],
  launching: [
    { label: "Plan of record (doc or slides)", why: "Dates, owners, dependencies, approvals", need: "Required", kind: "plan" },
    { label: "Access to Jira and the release epic", why: "The work to check against the plan", need: "Required" },
    { label: "Launch checklist", why: "Standard launch items", need: "Recommended" },
    { label: "Employee directory or team list", why: "Exact owners for each gap", need: "Recommended", kind: "directory" },
  ],
};

interface Props {
  stage: Stage | null; onPick: (s: Stage) => void; onContinue: () => void;
  /** The employee directory comes first: it grounds every team the reading names in the real org. */
  directory: DirectoryState; live: boolean;
}

/** Step 1 (PRD R14): who you are in the org (the directory, usually connected by the sign-in), where the project is, and what that stage needs. One column, read top to bottom. */
export function GetStarted(p: Props & DirectoryHandlers) {
  const picked = STAGES.find((s) => s.id === p.stage) ?? null;
  const info = p.directory.info;
  const serverOn = !!(info?.entra.connected || info?.jira.connected);
  /** An export file is connected when the directory file is not one the server holds. */
  const exportOn = p.directory.connected && !serverOn;
  const dirOn = p.directory.connected || !!p.directory.fromFiles;
  const dirState = p.directory.connected ? `Connected · read-only · ${p.directory.name}` : p.directory.fromFiles ? `Covered by ${p.directory.fromFiles} from your files` : "Not connected";
  const people = (info?.entra.connected?.people ?? 0) + (info?.jira.connected?.people ?? 0);
  const teams = Math.max(info?.entra.connected?.teams ?? 0, info?.jira.connected?.teams ?? 0);
  // The sources stay folded once something is connected (usually by the sign-in); open when there is nothing yet. The status
  // arrives after the first render, so the list folds itself when a connection shows up that the person did not make here.
  const [showSources, setShowSources] = useState(!dirOn);
  const touched = useRef(false);
  useEffect(() => { if (dirOn && !touched.current) setShowSources(false); if (!dirOn) setShowSources(true); }, [dirOn]);
  const [dirOpen, setDirOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<void>) => { touched.current = true; setBusy(what); setDirError(null); try { await fn(); } catch (e) { setDirError(String((e as Error).message ?? e)); } finally { setBusy(null); } };
  const blocked = busy !== null || !!p.directory.fromFiles;

  return (
    <div className="start stack">
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">Step 1 of 4</span>
        <h1 className="start-title">Let's set up your review</h1>
        <p className="lead">Readiness Review reads your plan and the tools your teams use, then tells you who to involve, what's missing and what to do next. Bring whatever you have; there's no template.</p>
      </header>

      <section className={"card org-card" + (dirOn ? " on" : "")} data-testid="start-directory" aria-labelledby="org-title">
        <div className="org-head">
          <span className={"org-dot" + (dirOn ? " on" : "")} aria-hidden="true">{dirOn ? "✓" : ""}</span>
          <div className="stack-sm" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <h2 id="org-title" className="h3">{dirOn ? "Your organisation is connected" : "Connect your organisation"}</h2>
            <span className="sm muted" data-testid="start-directory-state">{dirState}</span>
            {serverOn && <span className="small muted">{teams} teams, {people} people. Owners in your plan are matched to these teams.</span>}
            {!dirOn && <span className="small muted">Do this before adding documents: owners are then matched to real teams and people, not guessed from the wording.</span>}
          </div>
          <button type="button" className="linkbtn" aria-expanded={showSources} aria-controls="directory-sources" onClick={() => { touched.current = true; setShowSources((v) => !v); }}>{showSources ? "Hide sources" : "Manage sources"}</button>
        </div>
        {dirError && <div className="notice-grey" role="alert">{dirError}</div>}
        {showSources && (
          dirOpen ? (
            <DirectoryDialog live={p.live} onAccept={(f) => { p.onConnectDirectory(f); setDirOpen(false); }} onCancel={() => setDirOpen(false)} />
          ) : (
            <div className="source-list" id="directory-sources" data-testid="directory-sources">
              {info?.entra.available && (
                <div className="plain-row" data-testid="source-entra">
                  <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>Microsoft Entra ID</span><span className="small muted">{info.entra.connected ? "Names, titles, departments and managers, read with your sign-in." : "Names, titles, departments and managers. Asks your sign-in for directory access once."}</span></span>
                  {info.entra.connected
                    ? <span className="source-act"><span className="small ok">{info.entra.connected.teams} teams, {info.entra.connected.people} people</span><button type="button" className="linkbtn" disabled={busy !== null} onClick={() => run("entra-off", () => p.onDisconnectSource("entra"))}>Disconnect</button></span>
                    : <button type="button" className="btn" disabled={blocked} onClick={() => run("entra", p.onConnectEntra)}>{busy === "entra" ? "Connecting…" : "Use Microsoft Entra ID"}</button>}
                </div>
              )}
              {info?.jira.available && (
                <div className="plain-row" data-testid="source-jira">
                  <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>Jira projects</span><span className="small muted">Teams as Jira knows them: each project, its lead and who works on it.</span></span>
                  {info.jira.connected
                    ? <span className="source-act"><span className="small ok">{info.jira.connected.teams} teams, {info.jira.connected.people} people</span><button type="button" className="linkbtn" disabled={busy !== null} onClick={() => run("jira-off", () => p.onDisconnectSource("jira"))}>Disconnect</button></span>
                    : <button type="button" className="btn" disabled={blocked} onClick={() => run("jira", p.onConnectJira)}>{busy === "jira" ? "Connecting…" : "Use Jira projects"}</button>}
                </div>
              )}
              <div className="plain-row" data-testid="source-export">
                <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>A file</span><span className="small muted">A team list or org chart export: YAML, CSV or a spreadsheet.</span></span>
                {exportOn
                  ? <button type="button" className="linkbtn" onClick={p.onDisconnectDirectory}>Remove</button>
                  : <button type="button" className="btn" disabled={blocked} onClick={() => { touched.current = true; setDirOpen(true); }}>Upload an export</button>}
              </div>
            </div>
          )
        )}
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <h2 id="stage-q">Where is your project right now?</h2>
        <div role="radiogroup" aria-labelledby="stage-q" className="stage-grid">
          {STAGES.map((s) => (
            <label key={s.id} className={"stage-tile" + (p.stage === s.id ? " picked" : "")}>
              <span className="stage-tile-head">
                <input type="radio" name="stage" value={s.id} checked={p.stage === s.id} disabled={!s.built} onChange={() => s.built && p.onPick(s.id)} />
                <span style={{ fontWeight: 600 }}>{s.title}</span>
              </span>
              <span className="sm text2">{s.desc}</span>
            </label>
          ))}
        </div>

        {picked ? (
          <div className="card prep-panel" data-testid="prep">
            <p className="prep-gets"><span className="eyebrow">You'll get</span><span>{picked.gets}</span></p>
            <span className="eyebrow">Have these ready</span>
            {PREP[picked.id].map((it) => {
              const done = it.kind === "directory" && dirOn;
              return (
                <div key={it.label} className="prep-row">
                  <span className={"prep-mark" + (done ? " done" : "")} aria-hidden="true">{done ? "✓" : ""}</span>
                  <span className="prep-text">
                    <span style={{ fontWeight: 500 }}>{it.label}</span>
                    <span className="small muted">{it.why}{it.kind === "plan" ? ". Any format: a PRD, one-pager, POR deck, brief or roadmap export; no template" : ""}</span>
                  </span>
                  <span className={"prep-need " + (done ? "done" : it.need.toLowerCase())}>{done ? "Connected" : it.need}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="sm muted">Pick one, and we'll ask only for what that stage needs. You can change it later.</p>
        )}
      </section>

      <div className="between actions" style={{ gap: 16 }}>
        <span className="sm muted">{!picked ? "Pick where your project is to continue." : dirOn ? "Next: add your plan." : "You can continue without your organisation; teams will be inferred from your documents, without names."}</span>
        <button type="button" className="btn primary" style={{ padding: "0 22px" }} disabled={!picked} onClick={p.onContinue}>Continue</button>
      </div>
    </div>
  );
}
