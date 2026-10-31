import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { FixtureBackend } from "./backend/fixtureBackend";
import { StubJiraConnection } from "./backend/stubJira";
import { LiveBackend, LiveJiraConnection, probeServer } from "./backend/liveBackend";
import { LocalDecisionStore } from "./backend/decisionStore";

// ?backend=live|sample picks the mode; by default live when the local server (npm run server) answers,
// sample data otherwise. ?fast=1 shortens the sample mode's simulated delays (used by the end-to-end test).
const params = new URLSearchParams(location.search);
const fast = params.has("fast");
const want = params.get("backend");

async function boot() {
  const health = want === "sample" ? null : await probeServer();
  const live = !!health;
  if (want === "live" && !live) console.warn("backend=live requested but the server did not answer on /api/health; using sample data.");
  const backend = live ? new LiveBackend() : new FixtureBackend(fast ? 20 : 300);
  const jira = live ? new LiveJiraConnection(health!.jira) : new StubJiraConnection(fast ? 50 : 1200);
  const store = new LocalDecisionStore();
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App backend={backend} jira={jira} store={store} />
    </React.StrictMode>,
  );
}
boot();
