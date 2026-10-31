import { useState } from "react";
import type { PlanDraft, ReleaseTarget, Run } from "@rrr/schemas";
import type { JiraConnection, JiraState, UploadedFile, RunSummary, JiraCredentials } from "../backend/types";
import { fmtDate } from "../model/dates";
import { allTeamsResolved, isResolved, type TeamChoice } from "../model/review";

interface Props {
  jira: JiraConnection; jiraState: JiraState; setJiraState: (s: JiraState) => void;
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

export function ConnectJira(p: Props) {
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<JiraCredentials>({ site: "", email: "", token: "" });
  const [connectError, setConnectError] = useState<string | null>(null);
  const live = p.jira.credentialsNeeded;
  const on = p.jiraState === "on";
  const hasPor = p.files.some((f) => f.kind === "plan");
  const hasChecklist = p.files.some((f) => f.kind === "checks");
  const hasOrg = p.files.some((f) => f.kind === "teams");
  const suggested = p.plan.epic_keys_mentioned[0] ?? null;
  const epicVal = p.epic.trim();
  const resolved = p.target ? allTeamsResolved(p.target.projects, p.choices) : false;
  const runNotReady = !on || !p.epicOk || !p.target || !resolved;
  const rel = p.latestRun?.release ?? null;
  const linkedProjects = rel ? [...new Set(rel.related.map((r) => r.project))].sort() : [];
  const commentCount = rel ? rel.stories.reduce((n, s) => n + s.comments.length, 0) + (rel.stories.length ? 3 : 0) : 0;
  const prevRun = p.runs.length > 1 ? p.runs[p.runs.length - 2] : null;
  const searched = p.target ? p.target.projects.filter((t) => { const c = p.choices[t.team]; return c !== "skip" && (c || (t.match !== "unresolved" && t.jira_project)); }) : [];
  const searchedKeys = searched.map((t) => p.choices[t.team] && p.choices[t.team] !== "skip" ? p.choices[t.team] : t.jira_project);
  const checkCount = p.plan.items.filter((i) => i.kind === "checklist").length;
  const onStyle = "ok", offStyle = "warn";
  const coverage = p.target ? [
    { label: "Linkage gaps", source: "Jira", state: "Checked", cls: onStyle },
    { label: "Cross-team dates after launch", source: "Jira", state: "Checked", cls: onStyle },
    { label: "Promises in comments with no ticket", source: "Jira", state: "Checked", cls: onStyle },
    { label: "Process gaps and approvals", source: "Plan items", state: hasPor ? "Checked" : "Needs plan items", cls: hasPor ? onStyle : offStyle },
    { label: "Teams searched for unlinked work", source: "Plan items, teams", state: searched.length === p.target.projects.length ? `All ${searched.length} teams: ${searchedKeys.join(", ")}` : `${searched.length} of ${p.target.projects.length} teams: ${searchedKeys.join(", ") || "none"}`, cls: searched.length === p.target.projects.length ? onStyle : offStyle },
    { label: "Standard launch items", source: "Launch checks", state: hasChecklist ? `Checked (${checkCount} items)` : "Not checked — no launch checks found", cls: hasChecklist ? onStyle : offStyle },
    { label: "Owners", source: "Teams and owners", state: hasOrg ? "From your files" : "Inferred from Jira assignees", cls: hasOrg ? onStyle : offStyle },
  ] : [];
  const coverageOn = coverage.filter((c) => c.cls === onStyle).length;

  const accept = async () => {
    setBusy(true);
    p.setJiraState("connecting");
    const s = await p.jira.accept();
    p.setJiraState(s);
    setBusy(false);
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setConnectError(null);
    p.setJiraState("connecting");
    try {
      const s = await p.jira.connect({ ...creds, site: creds.site.trim(), email: creds.email.trim() });
      p.setJiraState(s);
      if (s === "on") setCreds((c) => ({ ...c, token: "" }));
    } catch (err) {
      setConnectError(String((err as Error).message ?? err));
      p.setJiraState("consent");
    }
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="stack-sm">
        <span className="small muted">Step 2 · Jira</span>
        <h1>Connect Jira</h1>
        <p className="lead">{live ? "The review reads Jira Cloud with an API token from your own Atlassian account. Access is read-only — nothing in Jira is created or changed, and the token stays on this machine." : "The review reads Jira through the Atlassian MCP server, signed in with your own Atlassian account. Access is read-only — nothing in Jira is created or changed."}</p>
      </div>

      <section className="card">
        {p.jiraState === "off" && (
          <div className="between">
            <div className="stack-sm" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600 }}>Atlassian (Jira)</span>
              <span className="sm muted">{live ? "Not connected · read-only API token" : "Not connected · OAuth via the Atlassian MCP server"}</span>
            </div>
            <button type="button" className="btn primary" onClick={() => p.setJiraState(p.jira.start())}>{live ? "Connect to Jira" : "Connect with Atlassian"}</button>
          </div>
        )}
        {p.jiraState === "consent" && live && (
          <form className="consent" aria-labelledby="connect-title" onSubmit={connect}>
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
            <div className="stack-sm sm">
              <span style={{ fontWeight: 500 }}>The review will</span>
              <ul className="list">{p.jira.scopes.can.map((s) => <li key={s}>{s}</li>)}</ul>
              <span style={{ fontWeight: 500, marginTop: 4 }}>It will not</span>
              <ul className="list">{p.jira.scopes.cannot.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
            {connectError && <div className="notice-grey" role="alert">{connectError}</div>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <button type="submit" className="btn primary" disabled={busy}>Connect</button>
              <button type="button" className="btn" onClick={() => p.setJiraState(p.jira.cancel())}>Cancel</button>
            </div>
          </form>
        )}
        {p.jiraState === "consent" && !live && (
          <div className="consent" role="dialog" aria-labelledby="consent-title">
            <span className="eyebrow">Atlassian · authorization (simulated)</span>
            <h2 id="consent-title">Release Readiness Review wants access to your Atlassian account</h2>
            <div className="stack-sm" style={{ gap: 4 }}><span className="label">Site</span><span className="mono" style={{ fontSize: 14 }}>{p.jira.site}</span></div>
            <div className="stack-sm sm">
              <span style={{ fontWeight: 500 }}>It will be able to</span>
              <ul className="list">{p.jira.scopes.can.map((s) => <li key={s}>{s}</li>)}</ul>
              <span style={{ fontWeight: 500, marginTop: 4 }}>It won't be able to</span>
              <ul className="list">{p.jira.scopes.cannot.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <button type="button" className="btn primary" disabled={busy} onClick={accept}>Accept</button>
              <button type="button" className="btn" onClick={() => p.setJiraState(p.jira.cancel())}>Cancel</button>
            </div>
            <span className="small muted">In the product this is Atlassian's own consent page, opened in a new window.</span>
          </div>
        )}
        {p.jiraState === "connecting" && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 44 }} role="status"><span className="dot lg" aria-hidden="true" /><span>Connecting to {p.jira.site || creds.site.replace(/^https?:\/\//, "")}…</span></div>
        )}
        {on && (
          <div className="between">
            <div className="stack-sm" style={{ gap: 2 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}><span className="dot" aria-hidden="true" />Connected to Jira</span>
              <span className="sm muted">{p.jira.site} · {live ? "read-only API token" : "via Atlassian MCP · read-only"}</span>
            </div>
            <button type="button" className="btn" onClick={() => p.setJiraState(p.jira.disconnect())}>Disconnect</button>
          </div>
        )}
      </section>

      {on && (
        <section className="card">
          <h2>Release epic</h2>
          {suggested && epicVal !== suggested && (
            <div className="between notice" style={{ gap: 10 }}>
              <span>Your plan file names epic <span className="mono" style={{ fontSize: 14 }}>{suggested}</span>.</span>
              <button type="button" className="btn outline-accent" style={{ padding: "0 14px" }} onClick={() => p.setEpic(suggested)}>Use {suggested}</button>
            </div>
          )}
          <div className="stack-sm" style={{ gap: 4, maxWidth: 360 }}>
            <label htmlFor="epic-key" className="label">Epic key</label>
            <input id="epic-key" type="text" className={"input mono" + (epicVal && !p.epicOk ? " err" : "")} value={p.epic} placeholder="e.g. INGEST-142" onChange={(e) => p.setEpic(e.target.value)} />
            <span className="small" style={{ color: epicVal && !p.epicOk ? "var(--late)" : p.target ? "var(--green)" : p.targetError ? "var(--late)" : "var(--muted)" }}>
              {!epicVal ? "Start here — the epic the release is tracked under" : !p.epicOk ? "Use a Jira key like INGEST-142" : p.targetError ? p.targetError : p.target ? (live ? "Found in Jira" : "Found in Jira (sample data)") : "Looking up the epic…"}
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
          {p.target && p.target.warnings.length > 0 && <div className="notice-grey">{p.target.warnings.join(" ")}</div>}
        </section>
      )}

      {on && p.target && (
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

      {on && p.target && resolved && (
        <section className="card" style={{ gap: 10 }}>
          <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
            <h2>What this review will check</h2>
            <span className="small muted">{coverageOn} of {coverage.length} checks at full strength</span>
          </div>
          {coverage.map((c) => (
            <div key={c.label} className="coverage">
              <span style={{ fontWeight: 500 }}>{c.label}</span>
              <span className="small muted">{c.source}</span>
              <span className={"sm " + c.cls}>{c.state}</span>
            </div>
          ))}
        </section>
      )}

      {p.runError && <div className="notice-grey" role="alert">The review did not finish: {p.runError}</div>}
      <div className="between" style={{ gap: 16 }}>
        <span className="sm muted" style={{ maxWidth: 640 }}>
          {!on ? "Connect Jira to continue." : !p.epicOk ? "Pick the release epic to continue." : !p.target ? (p.targetError ?? "Looking up the epic…") : !resolved ? "Pick a Jira project for each team, or mark it \"don't search\", to continue." : `Ready to read ${epicVal} and compare it with your confirmed plan.`}
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn" onClick={p.onBack}>Back to plan</button>
          <button type="button" className="btn primary" style={{ padding: "0 20px" }} disabled={runNotReady} onClick={p.onRun}>{p.confirmed ? "Re-run review" : "Run review"}</button>
        </div>
      </div>
    </div>
  );
}
