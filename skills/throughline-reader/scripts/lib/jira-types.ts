/** Minimal Jira REST v3 shapes, as returned by the Atlassian MCP server's read tools. */
export interface RawProject {
  key: string;
  name: string;
  projectCategory?: { name: string } | null;
  description?: string | null;
  lead?: { displayName: string } | null;
}

export interface RawLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { key: string };
  outwardIssue?: { key: string };
}

export interface RawComment {
  author?: { displayName: string } | null;
  created: string;
  body: unknown; // string, or Atlassian Document Format object
}

export interface RawIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    issuetype?: { name: string };
    status?: { name: string };
    resolution?: { name: string } | null;
    project?: { key: string };
    assignee?: { displayName: string } | null;
    duedate?: string | null;
    created?: string;
    updated?: string;
    components?: { name: string }[];
    fixVersions?: { name: string; releaseDate?: string | null }[];
    parent?: { key: string };
    issuelinks?: RawLink[];
    comment?: { comments: RawComment[]; total?: number };
  };
}

/** Comment bodies may be ADF (Atlassian Document Format); flatten to text. */
export function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const parts: string[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type === "paragraph" || n.type === "hardBreak") parts.push("\n");
  };
  walk(body);
  return parts.join("").replace(/\n+/g, "\n").trim();
}

export interface JiraRequest {
  tool: "getVisibleJiraProjects" | "getJiraIssue" | "searchJiraIssuesUsingJql";
  args: Record<string, unknown>;
  save_as: string;
}
