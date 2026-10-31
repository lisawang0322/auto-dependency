import { useState } from "react";
import type { PlanDraft, ReleaseTarget, Run } from "@rrr/schemas";
import type { JiraConnection, JiraState, UploadedFile, RunSummary, JiraCredentials, Stage } from "../backend/types";
import { fmtDate } from "../model/dates";
import { allTeamsResolved, isResolved, type TeamChoice } from "../model/review";

/**
 * Step 3 (PRD R15): a gallery of the apps a company's teams use, grouped by kind. Apps the company allows
 * can be connected read-only; the rest are greyed out. Jira and the employee directory work; the others
 * are shown for the design and say so. Then the release epic and the team → project resolution.
 */

export type AppId = "jira" | "linear" | "asana" | "confluence" | "gdrive" | "sharepoint" | "aha" | "productboard" | "directory" | "hris" | "slack";

interface AppDef { group: string; id: AppId; name: string; mono: string; desc: string; allowed: boolean; works: boolean; scopes: string[] }

export const APPS: AppDef[] = [
  { group: "Work tracking", id: "jira", name: "Jira", mono: "Ji", desc: "Epics, issues, links and due dates", allowed: true, works: true, scopes: [] },
  { group: "Work tracking", id: "linear", name: "Linear", mono: "Li", desc: "Projects, issues and cycles", allowed: true, works: false, scopes: [] },
  { group: "Work tracking", id: "asana", name: "Asana", mono: "As", desc: "Projects and tasks", allowed: false, works: false, scopes: [] },
  { group: "Docs and wikis", id: "confluence", name: "Confluence", mono: "Co", desc: "Plans, specs and decision pages", allowed: true, works: false, scopes: [] },
  { group: "Docs and wikis", id: "gdrive", name: "Google Drive", mono: "GD", desc: "Docs, Slides and Sheets — including POR decks", allowed: true, works: false, scopes: [] },
  { group: "Docs and wikis", id: "sharepoint", name: "SharePoint", mono: "SP", desc: "Sites and documents", allowed: false, works: false, scopes: [] },
  { group: "Product planning", id: "aha", name: "Aha!", mono: "Ah", desc: "Roadmaps, features and releases", allowed: true, works: false, scopes: [] },
  { group: "Product planning", id: "productboard", name: "Productboard", mono: "Pb", desc: "Features and roadmaps", allowed: false, works: false, scopes: [] },
  { group: "People and org", id: "directory", name: "Employee directory", mono: "ED", desc: "Names, titles, teams and managers — powers who-to-involve", allowed: true, works: true, scopes: ["Read names, titles, teams and reporting lines"] },
  { group: "People and org", id: "hris", name: "HR system org chart", mono: "HR", desc: "Full org chart", allowed: false, works: false, scopes: [] },
  { group: "Chat", id: "slack", name: "Slack", mono: "Sl", desc: "Channels and threads", allowed: false, works: false, scopes: [] },
];

export function appBadge(id: AppId, stage: Stage): "Required" | "Recommended" | "" {
  if (id === "jira" && stage !== "starting") return "Required";
  if (id === "directory") return "Recommended";
  return "";
}

export interface DirectoryState { connected: boolean; name: string | null; fromFiles: string | null }

interface Props {
  stage: Stage;
  jira: JiraConnection; jiraState: JiraState; setJiraState: (s: JiraState) => void;
  directory: DirectoryState; onConnectDirectory: (file: File | null) => void; onDisconnectDirectory: () => void;
  plan: PlanDraft; files: UploadedFile[];
  epic: string; setEpic: (v: string) => void; epicOk: boolean;
  target: ReleaseTarget | null; targetError: string | null; latestRun: Run | null; runs: RunSummary[];
  launch: string; setLaunch: (v: string) => void;
  choices: Record<string, TeamChoice>; setChoice: (team: string, c: TeamChoice | null) => void;
  confirmed: boolean; runError?: string | null; onBack: () => void; onRun: () => void;
}

const MATCH_LABEL: Record<string, string> = {
  team_list: "From your team list", explicit: "Named in the plan", linked: "Linked from the epic", name: "Name match", unresolved: "Unresolved — pick one",
};

export const RUN_LABEL: Record<Stage, string> = { starting: "Find who to involve", building: "Check my team and approvals", launching: "Run readiness review" };

export function ConnectApps(p: Props) {
  const [consentFor, setConsentFor] = useState<AppId | null>(null);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<JiraCredentials>({ site: "", email: "", token: "" });
  const [connectError, setConnectError] = useState<string | null>(null);
  const [dirFile, setDirFile] = useState<File | null>(null);
  const live = p.jira.credentialsNeeded;
  const on = p.jiraState === "on";
  const suggested = p.plan.epic_keys_mentioned[0] ?? null;
  const epicVal = p.epic.trim();
  const resolved = p.target ? allTeamsResolved(p.target.projects, p.choices) : false;
  const needsJira = p.stage !== "starting";
  const building = p.stage === "building";
  // Building: teams without a Jira project are expected (checked by assignee), so resolution is not a gate.
  const runNotReady = needsJira ? (!on || !p.epicOk || !p.target || (!building && !resolved)) : false;
  const rel = p.latestRun?.release ?? null;
  const linkedProjects = rel ? [...new Set(rel.related.map((r) => r.project))].sort() : [];
  const commentCount = rel ? rel.stories.reduce((n, s) => n + s.comments.length, 0) + (rel.stories.length ? 3 : 0) : 0;
  const prevRun = p.runs.length > 1 ? p.runs[p.runs.length - 2] : null;
  const dirOn = p.directory.connected || !!p.directory.fromFiles;
  const consentDef = consentFor ? APPS.find((a) => a.id === consentFor)! : null;
  // Building: needed teams without a Jira project are expected, and the "Teams your plan needs" box says so.
  const targetWarnings = (p.target?.warnings ?? []).filter((w) => !building || (!/: unresolved\. /.test(w) && !/in the team list but not in the plan/.test(w)));

  const openConsent = (id: AppId) => { setConnectError(null); setDirFile(null); setConsentFor(id); if (id === "jira") p.setJiraState(p.jira.start()); };
  const closeConsent = () => { if (consentFor === "jira") p.setJiraState(p.jira.cancel()); setConsentFor(null); };

  const acceptJira = async () => {
    setBusy(true);
    p.setJiraState("connecting");
    const s = await p.jira.accept();
    p.setJiraState(s);
    setBusy(false);
    setConsentFor(null);
  };
  const connectJira = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setConnectError(null);
    p.setJiraState("connecting");
    try {
      const s = await p.jira.connect({ ...creds, site: creds.site.trim(), email: creds.email.trim() });
      p.setJiraState(s);
      if (s === "on") { setCreds((c) => ({ ...c, token: "" })); setConsentFor(null); }
    } catch (err) {
      setConnectError(String((err as Error).message ?? err));
      p.setJiraState("consent");
    }
    setBusy(false);
  };
  const acceptDirectory = () => { p.onConnectDirectory(live ? dirFile : null); setConsentFor(null); };

  const groups: { title: string; apps: AppDef[] }[] = [];
  for (const a of APPS) {
    let g = groups.find((x) => x.title === a.group);
    if (!g) { g = { title: a.group, apps: [] }; groups.push(g); }
    g.apps.push(a);
  }

  const cardState = (a: AppDef): { state: string; cls: string; btn: string; blocked: boolean; onCls: boolean; act: () => void } => {
    if (!a.allowed) return { state: "Not enabled by your company", cls: "muted", btn: "Unavailable", blocked: true, onCls: false, act: () => {} };
    if (!a.works) return { state: "Shown for the design · not built yet", cls: "muted", btn: "Unavailable", blocked: true, onCls: false, act: () => {} };
    if (a.id === "jira") {
      if (on) return { state: `Connected · read-only · ${p.jira.site}`, cls: "ok", btn: "Disconnect", blocked: false, onCls: true, act: () => p.setJiraState(p.jira.disconnect()) };
      if (p.jiraState === "connecting") return { state: "Connecting…", cls: "muted", btn: "Connect", blocked: true, onCls: false, act: () => {} };
      return { state: "Not connected", cls: "muted", btn: "Connect", blocked: false, onCls: false, act: () => openConsent("jira") };
    }
    // directory
    if (p.directory.fromFiles) return { state: `Covered by ${p.directory.fromFiles} from your files`, cls: "ok", btn: "From your files", blocked: true, onCls: true, act: () => {} };
    if (p.directory.connected) return { state: `Connected · read-only · ${p.directory.name}`, cls: "ok", btn: "Disconnect", blocked: false, onCls: true, act: p.onDisconnectDirectory };
    return { state: "Not connected", cls: "muted", btn: "Connect", blocked: false, onCls: false, act: () => openConsent("directory") };
  };

  const runText = needsJira
    ? (!on ? "Connect Jira to continue — it's how we see who is doing the work." : !p.epicOk ? "Pick the epic for this work to continue." : !p.target ? (p.targetError ?? "Looking up the epic…") : !building && !resolved ? "Pick a Jira project for each team, or mark it \"don't search\", to continue." : (dirOn ? `Ready to read ${epicVal} and compare it with your ${building ? "plan" : "confirmed plan"}.` : `Ready. Connecting your directory adds names to every suggestion.`))
    : (dirOn ? "Ready." : "You can continue now. Connecting your directory turns team suggestions into names.");

  return (
    <div className="stack">
      <div className="stack-sm">
        <span className="small muted">Step 3 · connect your apps</span>
        <h1>Connect the tools your teams use</h1>
        <p className="lead" style={{ maxWidth: 720 }}>Connections are read-only — nothing is created or changed. Apps your company hasn't approved are greyed out; ask your admin to enable them. {needsJira ? "For your stage, Jira is required." : "Nothing is required at your stage — a directory makes suggestions much more useful."}</p>
      </div>

      {consentDef?.id === "jira" && live && (
        <form className="consent accent" aria-labelledby="connect-title" onSubmit={connectJira}>
          <span className="eyebrow">Jira Cloud · API token</span>
          <h2 id="connect-title">Connect to your Jira site</h2>
          <div className="stack-sm" style={{ gap: 4, maxWidth: 420 }}>
            <label htmlFor="jira-site" className="label">Site</label>
            <input id="jira-site" className="input mono" type="url" placeholder="https://your-company.atlassian.net" value={creds.site} onChange={(e) => setCreds({ ...creds, site: e.target.value })} required />
          </div>
          <div className="stack-sm" style={{ gap: 4, maxWidth: 420 }}>
            <label htmlFor="jira-email" className="label">Atlassian account email</label>
            <input id="jira-email" className="input" type="email" autoComplete="username" value={creds.email} onChange={(e) => setCreds({ ...creds, email: e.target.value })} required />
          </div>
          <div className="stack-sm" style={{ gap: 4, maxWidth: 420 }}>
            <label htmlFor="jira-token" className="label">API token</label>
            <input id="jira-token" className="input mono" type="password" autoComplete="current-password" value={creds.token} onChange={(e) => setCreds({ ...creds, token: e.target.value })} required />
            <span className="small muted">Create one at id.atlassian.com → Security → API tokens. It is sent once to the local server and kept in memory only.</span>
          </div>
          <Scopes can={p.jira.scopes.can} cannot={p.jira.scopes.cannot} />
          {connectError && <div className="notice-grey" role="alert">{connectError}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="submit" className="btn primary" disabled={busy}>Connect</button>
            <button type="button" className="btn" onClick={closeConsent}>Cancel</button>
          </div>
        </form>
      )}
      {consentDef?.id === "jira" && !live && (
        <div className="consent accent" role="dialog" aria-labelledby="consent-title">
          <span className="eyebrow">Jira · authorization (simulated)</span>
          <h2 id="consent-title">Readiness Review wants read-only access to Jira</h2>
          <div className="stack-sm" style={{ gap: 4 }}><span className="label">Site</span><span className="mono" style={{ fontSize: 14 }}>{p.jira.site}</span></div>
          <Scopes can={p.jira.scopes.can} cannot={p.jira.scopes.cannot} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" className="btn primary" disabled={busy} onClick={acceptJira}>Accept</button>
            <button type="button" className="btn" onClick={closeConsent}>Cancel</button>
          </div>
          <span className="small muted">In the product this is Atlassian's own consent page, opened in a new window.</span>
        </div>
      )}
      {consentDef?.id === "directory" && (
        <div className="consent accent" role="dialog" aria-labelledby="dir-title">
          <span className="eyebrow">Employee directory · {live ? "from a file" : "authorization (simulated)"}</span>
          <h2 id="dir-title">Readiness Review wants read-only access to your employee directory</h2>
          {live ? (
            <div className="stack-sm" style={{ gap: 4, maxWidth: 420 }}>
              <label htmlFor="directory-file" className="label">Directory export (a team list or org chart: YAML, CSV or spreadsheet)</label>
              <input id="directory-file" type="file" className="input" style={{ padding: "9px 12px" }} onChange={(e) => setDirFile(e.target.files?.[0] ?? null)} />
              <span className="small muted">No directory connector exists yet: an export stands in for it, and is read the same way as a team list.</span>
            </div>
          ) : (
            <div className="stack-sm" style={{ gap: 4 }}><span className="label">Source</span><span className="sm">Sample directory (the sample team list)</span></div>
          )}
          <Scopes can={consentDef.scopes} cannot={["Create, edit, delete or comment on anything"]} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" className="btn primary" disabled={live && !dirFile} onClick={acceptDirectory}>Accept</button>
            <button type="button" className="btn" onClick={closeConsent}>Cancel</button>
          </div>
          {!live && <span className="small muted">In the product this is the app's own sign-in and consent page.</span>}
        </div>
      )}

      {groups.map((g) => (
        <section key={g.title} className="stack" style={{ gap: 10 }}>
          <h2 style={{ fontSize: 16 }}>{g.title}</h2>
          <div className="app-grid">
            {g.apps.map((a) => {
              const s = cardState(a);
              const badge = a.allowed ? appBadge(a.id, p.stage) : "";
              return (
                <div key={a.id} className={"app-card" + (!a.allowed ? " off" : s.onCls ? " on" : "")} data-testid={`app-${a.id}`}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span aria-hidden="true" className={"app-mono" + (a.allowed ? "" : " off")}>{a.mono}</span>
                    <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                        <span style={{ fontWeight: 600 }}>{a.name}</span>
                        {badge && <span className={"app-badge " + badge.toLowerCase()}>{badge}</span>}
                      </span>
                      <span className="small muted">{a.desc}</span>
                    </div>
                  </div>
                  <div className="between" style={{ gap: 8 }}>
                    <span className={"small " + s.cls} data-testid="app-state">{s.state}</span>
                    <button type="button" className={"btn" + (s.btn === "Connect" ? " primary" : "")} aria-label={`${s.btn} ${a.name}`} disabled={s.blocked} onClick={s.act}>{s.btn}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {needsJira && on && (
        <section className="card">
          <h2>Which work in Jira is this?</h2>
          {suggested && epicVal !== suggested && (
            <div className="between notice" style={{ gap: 10 }}>
              <span>Your plan names epic <span className="mono" style={{ fontSize: 14 }}>{suggested}</span>.</span>
              <button type="button" className="btn outline-accent" style={{ padding: "0 14px" }} onClick={() => p.setEpic(suggested)}>Use {suggested}</button>
            </div>
          )}
          <div className="stack-sm" style={{ gap: 4, maxWidth: 360 }}>
            <label htmlFor="epic-key" className="label">Epic key</label>
            <input id="epic-key" type="text" className={"input mono" + (epicVal && !p.epicOk ? " err" : "")} value={p.epic} placeholder="e.g. INGEST-142" onChange={(e) => p.setEpic(e.target.value)} />
            <span className="small" style={{ color: epicVal && !p.epicOk ? "var(--late)" : p.target ? "var(--green)" : p.targetError ? "var(--late)" : "var(--muted)" }}>
              {!epicVal ? "The epic this work is tracked under" : !p.epicOk ? "Use a Jira key like INGEST-142" : p.targetError ? p.targetError : p.target ? (live ? "Found in Jira" : "Found in Jira (sample data)") : "Looking up the epic…"}
            </span>
          </div>
          {p.target && (
            <div className="found">
              <div className="stack-sm" style={{ gap: 2, flex: "1.4 1 240px" }}>
                <span style={{ fontWeight: 600 }}>{p.target.epic.summary}</span>
                {rel && <span className="sm text2">{rel.stories.length} stories · {commentCount} comments · links into {linkedProjects.join(", ")}</span>}
                <span className="small muted">Fix version {p.target.epic.fix_version ?? "—"}{rel ? ` · snapshot ${fmtDate(rel.snapshot_label)}` : ""}{prevRun ? `, compared with the ${prevRun.label} run` : ""}</span>
              </div>
              <div className="stack-sm" style={{ gap: 4, flex: "1 1 160px" }}>
                <label htmlFor="launch-date" className="label">Launch date (from fix version)</label>
                <input id="launch-date" type="date" className="input" value={p.launch} onChange={(e) => p.setLaunch(e.target.value)} />
              </div>
            </div>
          )}
          {p.target && targetWarnings.length > 0 && <div className="notice-grey">{targetWarnings.join(" ")}</div>}
        </section>
      )}

      {building && on && p.target && (
        <section className="card" style={{ gap: 8 }} data-testid="needed-teams">
          <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
            <h2>Teams your plan needs</h2>
            <span className="small muted">{p.target.projects.filter((t) => t.jira_project).length} of {p.target.projects.length} have a Jira project</span>
          </div>
          <p className="sm muted">From the signals in your PRD. A team with a Jira project is checked by project and assignee; the others by assignee only, through your directory.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {p.target.projects.map((t) => (
              <span key={t.team} className="pill type" style={{ fontSize: 13, padding: "3px 10px", fontWeight: 400 }}>{t.team} → {t.jira_project ? <span className="mono">{t.jira_project}</span> : <span className="muted">assignee only</span>}</span>
            ))}
          </div>
        </section>
      )}

      {needsJira && !building && on && p.target && (
        <section className="card">
          <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
            <h2>Teams → Jira projects</h2>
            <span className="small muted">{p.target.projects.filter((t) => isResolved(t, p.choices[t.team])).length} of {p.target.projects.length} teams resolved</span>
          </div>
          <p className="sm muted">Each team's project is searched for work that isn't linked to the epic. Unresolved teams need your choice.</p>
          <div className="table-wrap teams-table" style={{ border: 0 }}>
            <table>
              <thead><tr><th>Team</th><th>Jira project</th><th>How it was matched</th></tr></thead>
              <tbody>
                {p.target.projects.map((t) => {
                  const choice = p.choices[t.team];
                  const value = choice ?? t.jira_project ?? "";
                  const unresolved = t.match === "unresolved" && !choice;
                  const chosen = !!choice;
                  return (
                    <tr key={t.team}>
                      <td><div style={{ fontWeight: 500 }}>{t.team}</div>{unresolved && <div className="required">Choice required</div>}</td>
                      <td style={{ padding: "8px 16px" }}>
                        <label htmlFor={`proj-${t.team}`} className="sr-only">Jira project for {t.team}</label>
                        <select id={`proj-${t.team}`} className="input" style={{ minWidth: 240, borderColor: unresolved ? "var(--amber-input)" : undefined }} value={value}
                          onChange={(e) => { const v = e.target.value; p.setChoice(t.team, v === "" ? null : v === t.jira_project && t.match !== "unresolved" ? null : (v as TeamChoice)); }}>
                          {t.match === "unresolved" && <option value="">Choose a project…</option>}
                          {t.candidates.length > 0 && <optgroup label="Candidates">{t.candidates.map((c) => <option key={c.key} value={c.key}>{c.key} · {c.name}</option>)}</optgroup>}
                          <optgroup label={t.candidates.length ? "All visible projects" : "Visible projects"}>
                            {p.target!.visible_projects.filter((v) => !t.candidates.some((c) => c.key === v.key)).map((v) => <option key={v.key} value={v.key}>{v.key} · {v.name}</option>)}
                          </optgroup>
                          <option value="skip">Don't search this team</option>
                        </select>
                      </td>
                      <td>
                        <div className="sm" style={{ fontWeight: 500, color: unresolved ? "var(--amber-text)" : chosen ? "var(--accent)" : "var(--ink)" }}>
                          {choice === "skip" ? "Not searched (your choice)" : chosen ? "Chosen by you" : MATCH_LABEL[t.match]}
                        </div>
                        <div className="small muted">{choice ? (choice === "skip" ? `Was: ${t.evidence}` : t.candidates.find((c) => c.key === choice)?.evidence ?? t.evidence) : t.evidence}</div>
                        {unresolved && t.candidates.length > 0 && (
                          <ul className="list small muted" style={{ marginTop: 6 }}>
                            {t.candidates.map((c) => <li key={c.key}><span className="mono">{c.key}</span> {c.name}: {c.evidence}</li>)}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {p.runError && <div className="notice-grey" role="alert">The review did not finish: {p.runError}</div>}
      <div className="between" style={{ gap: 16 }}>
        <span className="sm muted" style={{ maxWidth: 640 }}>{runText}</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn" onClick={p.onBack}>Back</button>
          <button type="button" className="btn primary" style={{ padding: "0 20px" }} disabled={runNotReady} onClick={p.onRun}>{p.confirmed ? `Re-run: ${RUN_LABEL[p.stage].toLowerCase()}` : RUN_LABEL[p.stage]}</button>
        </div>
      </div>
    </div>
  );
}

function Scopes({ can, cannot }: { can: string[]; cannot: string[] }) {
  return (
    <div className="stack-sm sm">
      <span style={{ fontWeight: 500 }}>It will be able to</span>
      <ul className="list">{can.map((s) => <li key={s}>{s}</li>)}</ul>
      <span style={{ fontWeight: 500, marginTop: 4 }}>It won't be able to</span>
      <ul className="list">{cannot.map((s) => <li key={s}>{s}</li>)}</ul>
    </div>
  );
}
