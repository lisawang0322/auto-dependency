import { useEffect, useRef, useState } from "react";
import type { Stage, JiraConnection, JiraState } from "../backend/types";
import { JiraConnect } from "./JiraConnect";
import { Info } from "./Info";
import type { DirectoryState, DirectoryHandlers } from "./ConnectApps";
import { DirectoryDialog } from "./DirectoryDialog";

/** The phase a project is in, in words. It is never chosen: it describes what the project's files and connections show
 *  (a plan of record: preparing to launch; work tracked in Jira: building; otherwise just starting). */
export const STAGE_SHORT: Record<Stage, string> = { starting: "Just starting", building: "Building", launching: "Preparing to launch" };



interface Props {
  onContinue: () => void;
  /** The employee directory comes first: it grounds every team the reading names in the real org. */
  directory: DirectoryState; live: boolean;
  /** Opened from a project's workspace rather than while setting it up. */
  workspace?: boolean;
  jira: JiraConnection; jiraState: JiraState; setJiraState: (s: JiraState) => void;
}

/** Step 1 (PRD R14): who you are in the org (the directory, usually connected by the sign-in), and what the review can check
 *  from what you bring. One column, read top to bottom. */
export function GetStarted(p: Props & DirectoryHandlers) {
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
  const jiraOn = p.jiraState === "on";
  const [jiraOpen, setJiraOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<void>) => { touched.current = true; setBusy(what); setDirError(null); try { await fn(); } catch (e) { setDirError(String((e as Error).message ?? e)); } finally { setBusy(null); } };
  const blocked = busy !== null || !!p.directory.fromFiles;

  return (
    <div className="start stack">
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">{p.workspace ? "Organisation" : "Step 1 of 3"}</span>
        <h1 className="start-title">{p.workspace ? "Your organisation" : "Set up your project"}</h1>
        <p className="lead">{p.workspace ? "Where team names and contacts come from." : "Connect what you can. Both are optional."}</p>
      </header>

      <section className={"card org-card" + (dirOn ? " on" : "")} data-testid="start-directory" aria-labelledby="org-title">
        <div className="org-head">
          <span className={"org-dot" + (dirOn ? " on" : "")} aria-hidden="true">{dirOn ? "✓" : ""}</span>
          <div className="stack-sm" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <h2 id="org-title" className="h3">{dirOn ? "Your organisation is connected" : "Connect your organisation"}
              <Info>Matches the teams your files name to real teams and people, instead of guessing from the wording.</Info></h2>
            <span className="sm muted" data-testid="start-directory-state">{dirState}</span>
            {serverOn && <span className="small muted">{teams} teams, {people} people</span>}
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
                  <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>Microsoft Entra ID</span><span className="small muted">{info.entra.connected ? "Names, titles, departments, managers · read with your sign-in" : "Names, titles, departments, managers"}</span></span>
                  {info.entra.connected
                    ? <span className="source-act"><span className="small ok">{info.entra.connected.teams} teams, {info.entra.connected.people} people</span><button type="button" className="linkbtn" disabled={busy !== null} onClick={() => run("entra-off", () => p.onDisconnectSource("entra"))}>Disconnect</button></span>
                    : <button type="button" className="btn" disabled={blocked} onClick={() => run("entra", p.onConnectEntra)}>{busy === "entra" ? "Connecting…" : "Use Microsoft Entra ID"}</button>}
                </div>
              )}
              {info?.jira.available && (
                <div className="plain-row" data-testid="source-jira">
                  <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>Jira projects</span><span className="small muted">Each project, its lead and who works on it</span></span>
                  {info.jira.connected
                    ? <span className="source-act"><span className="small ok">{info.jira.connected.teams} teams, {info.jira.connected.people} people</span><button type="button" className="linkbtn" disabled={busy !== null} onClick={() => run("jira-off", () => p.onDisconnectSource("jira"))}>Disconnect</button></span>
                    : <button type="button" className="btn" disabled={blocked} onClick={() => run("jira", p.onConnectJira)}>{busy === "jira" ? "Connecting…" : "Use Jira projects"}</button>}
                </div>
              )}
              <div className="plain-row" data-testid="source-export">
                <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}><span style={{ fontWeight: 500 }}>A file</span><span className="small muted">A team list or org chart (YAML, CSV, spreadsheet)</span></span>
                {exportOn
                  ? <button type="button" className="linkbtn" onClick={p.onDisconnectDirectory}>Remove</button>
                  : <button type="button" className="btn" disabled={blocked} onClick={() => { touched.current = true; setDirOpen(true); }}>Upload an export</button>}
              </div>
            </div>
          )
        )}
      </section>

      {/* Where the work is tracked: optional, like the organisation. Skipped now, it is offered again once there is a review. */}
      <section className={"card org-card" + (jiraOn ? " on" : "")} data-testid="start-jira" aria-labelledby="jira-title">
        <div className="org-head">
          <span className={"org-dot" + (jiraOn ? " on" : "")} aria-hidden="true">{jiraOn ? "✓" : ""}</span>
          <div className="stack-sm" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <h2 id="jira-title" className="h3">{jiraOn ? "Jira is connected" : "Connect Jira"}
              <Info>Shows who is actually on the work. A plan of record's launch check needs it. You can connect it later from the project.</Info></h2>
            <span className="sm muted" data-testid="start-jira-state">{jiraOn ? `Connected · read-only · ${p.jira.site || "Jira"}` : "Not connected"}</span>
          </div>
          {jiraOn
            ? <button type="button" className="linkbtn" onClick={() => p.setJiraState(p.jira.disconnect())}>Disconnect</button>
            : !jiraOpen && <button type="button" className="btn" onClick={() => { p.setJiraState(p.jira.start()); setJiraOpen(true); }}>Connect Jira</button>}
        </div>
        {jiraOpen && !jiraOn && <JiraConnect jira={p.jira} setJiraState={p.setJiraState} onDone={() => setJiraOpen(false)} onCancel={() => { p.setJiraState(p.jira.cancel()); setJiraOpen(false); }} />}
      </section>

      <div className="between actions" style={{ gap: 16 }}>
        <span className="sm muted" data-testid="start-next">Next: your files</span>
        <button type="button" className="btn primary" style={{ padding: "0 22px" }} onClick={p.onContinue}>Continue</button>
      </div>
    </div>
  );
}
