import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { FixtureBackend, loadLocalConsent } from "./backend/fixtureBackend";
import { StubJiraConnection } from "./backend/stubJira";
import { LiveBackend, LiveJiraConnection, probeServer, signOut } from "./backend/liveBackend";
import { LocalDecisionStore, ServerDecisionStore } from "./backend/decisionStore";
import { SignIn } from "./screens/SignIn";

// ?backend=live|sample picks the mode; by default live when the local server (npm run server) answers,
// sample data otherwise. ?fast=1 shortens the sample mode's simulated delays (used by the end-to-end test).
const params = new URLSearchParams(location.search);
const fast = params.has("fast");
const want = params.get("backend");

async function boot() {
  const health = want === "sample" ? null : await probeServer();
  const live = !!health;
  if (want === "live" && !live) console.warn("backend=live requested but the server did not answer on /api/health; using sample data.");
  const root = createRoot(document.getElementById("root")!);
  // With sign-in on, nothing else is shown until the person has signed in.
  if (live && health!.auth && health!.auth.mode !== "none" && !health!.auth.user) {
    root.render(<React.StrictMode><SignIn loginUrl={health!.auth.login_url ?? "/auth/login"} next={location.pathname + location.search} demo={health!.auth.mode === "demo"} /></React.StrictMode>);
    return;
  }
  const backend = live ? new LiveBackend(health) : new FixtureBackend(fast ? 20 : 300);
  const jira = live ? new LiveJiraConnection(health!.jira) : new StubJiraConnection(fast ? 50 : 1200);
  const store = live ? new ServerDecisionStore() : new LocalDecisionStore();
  const initialConsent = live ? (health!.settings?.agent_consent ?? "unknown") : loadLocalConsent();
  const initialMode = live ? (health!.settings?.agent_mode ?? null) : null;
  const user = live ? (health!.auth?.user ?? null) : null;
  root.render(
    <React.StrictMode>
      <App backend={backend} jira={jira} store={store} user={user} initialConsent={initialConsent} initialMode={initialMode} onSignOut={live && health!.auth && health!.auth.mode !== "none" ? signOut : undefined} />
    </React.StrictMode>,
  );
}
boot();
