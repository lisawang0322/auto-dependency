import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { FixtureBackend } from "./backend/fixtureBackend";
import { StubJiraConnection } from "./backend/stubJira";
import { LocalDecisionStore } from "./backend/decisionStore";

// ?fast=1 shortens the simulated delays (used by the end-to-end test).
const fast = new URLSearchParams(location.search).has("fast");
const backend = new FixtureBackend(fast ? 20 : 300);
const jira = new StubJiraConnection(fast ? 50 : 1200);
const store = new LocalDecisionStore();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App backend={backend} jira={jira} store={store} />
  </React.StrictMode>,
);
