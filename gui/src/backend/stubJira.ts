import type { JiraConnection, JiraState } from "./types";

/** Simulated OAuth with the Atlassian MCP server. The product opens Atlassian's own consent page. */
export class StubJiraConnection implements JiraConnection {
  readonly site = "sample-company.atlassian.net";
  readonly scopes = {
    can: ["Read Jira issues, comments, links and due dates", "Read projects, components and fix versions", "Read user names, to find owners"],
    cannot: ["Create, edit, comment on or move issues"],
  };
  readonly credentialsNeeded = false;
  constructor(private delayMs = 1200) {}
  async initialState(): Promise<JiraState> { return "off"; }
  start(): JiraState { return "consent"; }
  accept(): Promise<JiraState> { return new Promise((r) => setTimeout(() => r("on"), this.delayMs)); }
  connect(): Promise<JiraState> { return this.accept(); }
  cancel(): JiraState { return "off"; }
  disconnect(): JiraState { return "off"; }
}
