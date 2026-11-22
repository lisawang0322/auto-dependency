import { useState } from "react";
import type { JiraConnection, JiraCredentials, JiraState } from "../backend/types";
import { Scopes } from "./DirectoryDialog";
import { Info } from "./Info";

/** Connecting Jira, read-only: Sign in with Atlassian when the server has it, else a site, email and API token; the sample
 *  backend asks for consent only. Used wherever Jira can be connected (step 1, and the connections page). */
export function JiraConnect(p: { jira: JiraConnection; setJiraState: (s: JiraState) => void; onDone: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<JiraCredentials>({ site: "", email: "", token: "" });
  const [connectError, setConnectError] = useState<string | null>(null);
  const oauth = p.jira.oauthAvailable;
  const live = p.jira.credentialsNeeded || oauth;

  const acceptJira = async () => {
    setBusy(true);
    p.setJiraState("connecting");
    const s = await p.jira.accept();
    p.setJiraState(s);
    setBusy(false);
    p.onDone();
  };
  const signInAtlassian = async () => {
    setBusy(true);
    setConnectError(null);
    p.setJiraState("connecting");
    try {
      const s = await p.jira.startOAuth();
      p.setJiraState(s);
      if (s === "on") p.onDone();
      else setConnectError("The Atlassian window was closed before access was granted.");
    } catch (err) {
      setConnectError(String((err as Error).message ?? err));
      p.setJiraState("consent");
    }
    setBusy(false);
  };
  const connectJira = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setConnectError(null);
    p.setJiraState("connecting");
    try {
      const s = await p.jira.connect({ ...creds, site: creds.site.trim(), email: creds.email.trim() });
      p.setJiraState(s);
      if (s === "on") { setCreds((c) => ({ ...c, token: "" })); p.onDone(); }
    } catch (err) {
      setConnectError(String((err as Error).message ?? err));
      p.setJiraState("consent");
    }
    setBusy(false);
  };

  return (
    <>
      {oauth && (
        <div className="consent accent" role="dialog" aria-labelledby="atl-title">
          <span className="eyebrow">Jira · Sign in with Atlassian</span>
          <h2 id="atl-title">Throughline wants read-only access to Jira</h2>
          <p className="sm muted" style={{ margin: 0 }}>Opens Atlassian's sign-in in a new window.<Info>You sign in there, approve the access below, and come back here. No token to paste; access can be withdrawn from your Atlassian account at any time.</Info></p>
          <Scopes can={p.jira.scopes.can} cannot={p.jira.scopes.cannot} />
          {connectError && <div className="notice-grey" role="alert">{connectError}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" className="btn primary" disabled={busy} onClick={signInAtlassian}>{busy ? "Waiting for Atlassian…" : "Continue to Atlassian"}</button>
            <button type="button" className="btn" onClick={p.onCancel}>Cancel</button>
          </div>
        </div>
      )}
      {live && !oauth && (
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
            <span className="small muted">From id.atlassian.com → Security → API tokens<Info>Sent once to the local server and kept in memory only.</Info></span>
          </div>
          <Scopes can={p.jira.scopes.can} cannot={p.jira.scopes.cannot} />
          {connectError && <div className="notice-grey" role="alert">{connectError}</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="submit" className="btn primary" disabled={busy}>Connect</button>
            <button type="button" className="btn" onClick={p.onCancel}>Cancel</button>
          </div>
        </form>
      )}
      {!live && !oauth && (
        <div className="consent accent" role="dialog" aria-labelledby="consent-title">
          <span className="eyebrow">Jira · sample sign-in</span>
          <h2 id="consent-title">Throughline wants read-only access to Jira</h2>
          <div className="stack-sm" style={{ gap: 4 }}><span className="label">Site</span><span className="mono" style={{ fontSize: 14 }}>{p.jira.site}</span></div>
          <Scopes can={p.jira.scopes.can} cannot={p.jira.scopes.cannot} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" className="btn primary" disabled={busy} onClick={acceptJira}>Accept</button>
            <button type="button" className="btn" onClick={p.onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
