# Atlassian MCP read tools used by release-reader

The skill uses only read tools. Names below are those of Atlassian's Rovo MCP server as documented
in 2026; **confirm them against your server's tool list before the first call** (in Devin: the MCP
server's tool listing; in Claude Code: `/mcp`). If a name differs, use the server's name for the
same read operation and do not use any tool whose description mentions create, update, edit,
transition, assign, comment or delete.

| Purpose | Tool | Arguments the helpers emit | Save the raw response at |
|---|---|---|---|
| Find the site id | `getAccessibleAtlassianResources` | none | (not saved; pass its `id` as `--cloud-id`) |
| List visible projects | `getVisibleJiraProjects` | `cloudId`, `maxResults` | `projects.json` |
| Read one issue | `getJiraIssue` | `cloudId`, `issueIdOrKey`, `fields` | `issues/<KEY>.json` |
| Search | `searchJiraIssuesUsingJql` | `cloudId`, `jql`, `maxResults`, `fields` | `searches/<hash>.json` (named in `requests.json`) |

Response shapes are Jira REST v3: an issue is `{ key, fields: { summary, status: {name}, issuelinks: [...],
comment: { comments: [...] }, ... } }`; a search is `{ issues: [...] }` (a bare array is accepted
too); projects are an array or `{ values: [...] }`. Comment bodies may be Atlassian Document
Format; the helpers flatten them to text.

## Paging

`getVisibleJiraProjects` and `searchJiraIssuesUsingJql` page. Fetch every page and save one file
containing all results. The helpers ask for `maxResults: 500` for an epic's stories and `20` for
scoped searches (the cap from the PRD); if a scoped search returns 20, the helper warns that the
list may be incomplete.

## JQL forms the helpers build

- Children of the epic: `parent = INGEST-142`. On sites that still use the Epic Link field, use
  `"Epic Link" = INGEST-142` for the same request and save the response under the same file name.
- Scoped search: `project = SRE AND updated >= 2026-09-15 AND text ~ "capacity on-call"`.
  Jira's `text ~` with several words matches issues containing any of them (default OR). The
  fixture evaluator uses the same rule. If your site is configured for AND semantics, note it in
  the run's warnings; results will be narrower, not wrong.

## Errors

Save `{"error": "<message from the tool>"}` for a failed or forbidden call. The helper turns it into a
warning and continues. Never retry a write; there are none.
