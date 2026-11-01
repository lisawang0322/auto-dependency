import { useState } from "react";
import type { Stage } from "../backend/types";
import type { DirectoryState, DirectoryHandlers } from "./ConnectApps";
import { DirectoryDialog } from "./DirectoryDialog";

/** Step 1 (PRD R14): what the tool does, what counts as a plan, which stage the project is at, what to have ready. */

export interface StageDef { id: Stage; title: string; desc: string; gets: string; built: boolean; note: string }

export const STAGES: StageDef[] = [
  { id: "starting", title: "Just starting", desc: "You have an idea, a PRD or a one-pager — but no team yet, and maybe no Jira.", gets: "You get: who to involve, who to contact, and the approvals you’ll need.", built: true, note: "" },
  { id: "building", title: "Team forming, work underway", desc: "Some people are on board and work is tracked somewhere, like Jira.", gets: "You get: which teams are missing, which approvals haven’t started, and what to do next.", built: true, note: "" },
  { id: "launching", title: "Preparing to launch", desc: "There’s a launch date and a go/no-go coming up.", gets: "You get: what blocks launch, with evidence and owners, and your next actions.", built: true, note: "" },
];

export const STAGE_SHORT: Record<Stage, string> = { starting: "Just starting", building: "Building", launching: "Preparing to launch" };

/** What to have ready, per stage: label, why, required / recommended / optional. */
const PREP: Record<Stage, [string, string, string][]> = {
  starting: [
    ["Your PRD or one-pager", "What you’re building and for whom", "Required"],
    ["Employee directory or org chart", "Turns team suggestions into names", "Recommended"],
    ["Company launch checklist", "Shows the approvals your company expects", "Optional"],
  ],
  building: [
    ["Your plan (PRD, POR or brief)", "What should be happening", "Required"],
    ["Access to your work tracker", "Who is actually working on it", "Required"],
    ["Employee directory or org chart", "Names for the teams you’re missing", "Recommended"],
    ["Company launch checklist", "Approvals your company expects", "Optional"],
  ],
  launching: [
    ["Plan of record (doc or slides)", "Dates, owners, dependencies, approvals", "Required"],
    ["Access to Jira and the release epic", "The work to check against the plan", "Required"],
    ["Launch checklist", "Standard launch items", "Recommended"],
    ["Employee directory or team list", "Exact owners for each gap", "Recommended"],
  ],
};

const PLAN_KINDS = ["PRD", "One-pager", "POR slide deck", "Project brief", "Launch checklist", "Roadmap export"];

interface Props {
  stage: Stage | null; onPick: (s: Stage) => void; onContinue: () => void;
  /** The employee directory comes first: it grounds every team the reading names in the real org. */
  directory: DirectoryState; live: boolean;
}

type Props2 = Props & DirectoryHandlers;

export function GetStarted(p: Props2) {
  const picked = STAGES.find((s) => s.id === p.stage) ?? null;
  const [dirOpen, setDirOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const info = p.directory.info;
  const serverOn = !!(info?.entra.connected || info?.jira.connected);
  /** An export file is connected when the directory file is not one the server holds. */
  const exportOn = p.directory.connected && !serverOn;
  const dirOn = p.directory.connected || !!p.directory.fromFiles;
  const dirState = p.directory.connected ? `Connected · read-only · ${p.directory.name}` : p.directory.fromFiles ? `Covered by ${p.directory.fromFiles} from your files` : "Not connected";
  const run = async (what: string, fn: () => Promise<void>) => { setBusy(what); setDirError(null); try { await fn(); } catch (e) { setDirError(String((e as Error).message ?? e)); } finally { setBusy(null); } };
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="stack-sm" style={{ gap: 10, maxWidth: 760 }}>
        <span className="small muted">Step 1 · get started</span>
        <h1 style={{ fontSize: 32, lineHeight: 1.15 }}>Find out who your project needs and what's missing — before it's late.</h1>
        <p className="text2" style={{ fontSize: 16 }}>Readiness Review reads your plan and the tools your teams already use. Then it tells you who to involve, which approvals you'll need, what's at risk, and what to do next. Bring whatever you have — there's no template.</p>
      </div>

      <div className="row">
        <section className="stack" style={{ flex: "1.5 1 520px", minWidth: 0, gap: 12 }}>
          <h2 id="stage-q">Where is your project right now?</h2>
          <div role="radiogroup" aria-labelledby="stage-q" className="stack-sm" style={{ gap: 10 }}>
            {STAGES.map((s) => (
              <label key={s.id} className={"stage-card" + (p.stage === s.id ? " picked" : "") + (s.built ? "" : " off")}>
                <input type="radio" name="stage" value={s.id} checked={p.stage === s.id} disabled={!s.built} onChange={() => s.built && p.onPick(s.id)} />
                <span className="stack-sm" style={{ gap: 4 }}>
                  <span style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 16 }}>{s.title}</span>
                    {!s.built && <span className="chip-note">{s.note}</span>}
                  </span>
                  <span className="text2">{s.desc}</span>
                  <span className="sm" style={{ color: "var(--accent)" }}>{s.gets}</span>
                  {p.stage === s.id && (
                    <span className="prep" data-testid="prep">
                      <span className="small muted" style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em" }}>Have these ready</span>
                      {PREP[s.id].map(([label, why, req]) => (
                        <div key={label}>
                          <span><span style={{ fontWeight: 500 }}>{label}</span> <span className="small muted">· {why}</span></span>
                          <span className="small" style={{ whiteSpace: "nowrap", fontSize: 12, fontWeight: req === "Required" ? 600 : 400, color: req === "Required" ? "var(--ink)" : "var(--muted)" }}>{req}</span>
                        </div>
                      ))}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="stack" style={{ flex: "1 1 340px", minWidth: 0, gap: 12 }}>
          <div className={"card" + (dirOn ? " agent-done" : "")} style={{ gap: 10 }} data-testid="start-directory">
            <div className="between" style={{ gap: 8, alignItems: "baseline" }}>
              <h2 style={{ fontSize: 16 }}>Connect your employee directory first</h2>
              <span className="small muted">Recommended</span>
            </div>
            <p className="sm text2">Before any document: it tells the reading which teams exist, so each owner is matched to a real team and its people rather than guessed from the wording. Read-only, and two layers can combine: people from your sign-in, teams from Jira.</p>
            <span className={"sm " + (dirOn ? "ok" : "muted")} data-testid="start-directory-state">{dirState}</span>
            {dirError && <div className="notice-grey" role="alert">{dirError}</div>}
            {dirOpen ? (
              <DirectoryDialog live={p.live} onAccept={(f) => { p.onConnectDirectory(f); setDirOpen(false); }} onCancel={() => setDirOpen(false)} />
            ) : (
              <div className="stack-sm" style={{ gap: 8 }} data-testid="directory-sources">
                {info?.entra.available && (
                  <div className="plain-row" data-testid="source-entra">
                    <span className="stack-sm" style={{ gap: 2 }}><span style={{ fontWeight: 500 }}>Microsoft Entra ID</span><span className="small muted">Names, titles, departments and managers, through the sign-in you already have.</span></span>
                    {info.entra.connected
                      ? <span style={{ display: "flex", alignItems: "center", gap: 10 }}><span className="small ok">{info.entra.connected.teams} teams, {info.entra.connected.people} people</span><button type="button" className="linkbtn" disabled={busy !== null} onClick={() => run("entra-off", () => p.onDisconnectSource("entra"))}>Disconnect</button></span>
                      : <button type="button" className="btn" disabled={busy !== null || !!p.directory.fromFiles} onClick={() => run("entra", p.onConnectEntra)}>{busy === "entra" ? "Connecting…" : "Use Microsoft Entra ID"}</button>}
                  </div>
                )}
                {info?.jira.available && (
                  <div className="plain-row" data-testid="source-jira">
                    <span className="stack-sm" style={{ gap: 2 }}><span style={{ fontWeight: 500 }}>Jira projects</span><span className="small muted">Teams as Jira knows them: each project, its lead and who is assigned its work.</span></span>
                    {info.jira.connected
                      ? <span style={{ display: "flex", alignItems: "center", gap: 10 }}><span className="small ok">{info.jira.connected.teams} teams, {info.jira.connected.people} people</span><button type="button" className="linkbtn" disabled={busy !== null} onClick={() => run("jira-off", () => p.onDisconnectSource("jira"))}>Disconnect</button></span>
                      : <button type="button" className="btn" disabled={busy !== null || !!p.directory.fromFiles} onClick={() => run("jira", p.onConnectJira)}>{busy === "jira" ? "Connecting…" : "Use Jira projects"}</button>}
                  </div>
                )}
                <div className="plain-row" data-testid="source-export">
                  <span className="stack-sm" style={{ gap: 2 }}><span style={{ fontWeight: 500 }}>An export</span><span className="small muted">A team list or org chart file: YAML, CSV or a spreadsheet.</span></span>
                  {exportOn
                    ? <button type="button" className="linkbtn" onClick={p.onDisconnectDirectory}>Remove</button>
                    : <button type="button" className="btn" disabled={busy !== null || !!p.directory.fromFiles} onClick={() => setDirOpen(true)}>Upload an export</button>}
                </div>
              </div>
            )}
          </div>
          <div className="card" style={{ gap: 10 }}>
            <h2 style={{ fontSize: 16 }}>What counts as a plan?</h2>
            <p className="sm text2">Anything that says what you're building, for whom, and by when. Teams write these very differently — that's fine.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {PLAN_KINDS.map((k) => <span key={k} className="pill type" style={{ fontSize: 13, padding: "2px 8px", fontWeight: 400 }}>{k}</span>)}
            </div>
            <p className="small muted">Any format: documents, slides, spreadsheets, PDFs, exported pages or links from connected apps.</p>
          </div>

        </section>
      </div>

      <div className="between actions" style={{ gap: 16 }}>
        <span className="sm muted">{!picked ? "Pick where you are so we ask for the right things." : dirOn ? "You can change this later — results adapt to your stage." : "You can continue without a directory; teams are then inferred from your documents and get no names."}</span>
        <button type="button" className="btn primary" style={{ padding: "0 22px" }} disabled={!picked} onClick={p.onContinue}>Continue</button>
      </div>
    </div>
  );
}
