---
name: release-reader
description: Reads a release's plan documents (POR, launch checklist, team list) and its Jira epic, one hop out, plus a scoped search per team, and writes the facts the release-analyzer needs. Read-only in Jira. Three stages, each runnable alone; the person confirms stages A and B.
triggers: ["user"]
allowed-tools: ["getAccessibleAtlassianResources", "getVisibleJiraProjects", "getJiraIssue", "searchJiraIssuesUsingJql"]
---

# release-reader

You gather and organize facts. You do not judge gaps, strengths or status; that is the
analyzer's job. Everything you output must trace to a plan file or a Jira read.

## Rules for every stage

1. **Read-only in Jira.** Use only the Atlassian MCP server's read tools: list visible projects,
   get an issue, search by JQL. Never create, edit, comment on, transition, link or assign anything.
   If a tool you are about to call is not a read, stop. See `reference/mcp-tools.md` for the
   tool names and how to confirm them on your server.
2. **No source, no item.** Every plan item carries a verbatim quote from one of the input files.
   The assembler drops anything else and says so in `warnings`.
3. **Never guess silently.** A team with two plausible projects stays `unresolved` with candidates.
   A relative date ("the week before launch") is resolved against the launch date and marked
   `due_is_inferred: true`.
4. **Errors become warnings.** A failed or forbidden Jira call is a line in `warnings`, never a crash.
5. **Page through everything.** The helper scripts set `maxResults`; when the MCP server pages,
   fetch every page before saving a response.
6. **Dates are ISO strings** (`YYYY-MM-DD`, timestamps as returned by Jira).
7. **Same code path for fixtures and Jira.** Every stage takes `--source fixture|mcp`. Fixture mode
   reads a snapshot folder; MCP mode reads a cache folder you fill with raw MCP responses.

All helpers run with `npx tsx` from the repository root (run `npm install` once).

## Stage A — extract-plan (no Jira)

**Input:** one or more plan files (md, txt, pdf, docx, xlsx, csv, yaml, json). A POR is required.
A launch checklist and a team list are optional. Files are not labelled; the helper works out what
each contains (`read_as`), and you can override it.

```
npx tsx skills/release-reader/scripts/extract-plan.ts \
  --files <POR> [<checklist>] [<team list>] \
  [--read-as <file>=plan_items|launch_checks|teams_and_owners] \
  [--launch-date YYYY-MM-DD] [--agent-items items.json] --out plan-draft.json
```

What the helper does on its own:
- Finds the launch date ("Launch date: 2026-11-20", "launch on Nov 20, 2026").
- Finds teams from the team list, or from a "teams involved" sentence in the POR.
- In sections headed Deliverables / Dependencies / Approvals / Readiness / Milestones, turns each
  bullet or sentence owned by a known team into an item, with the sentence as the quote and the
  section as the locator (`§4`). Dates in the sentence are parsed; relative ones are inferred.
- Keeps only checklist rows that apply to this release: "All launches", or every word of the
  row's "Applies to" appears in the POR overview. Each becomes `kind: "checklist"`, locator `#6`.
- Records a team's Jira key, owners and components from the team list (`jira_project_hint`).

**When the POR is prose the helper cannot parse** (run it first; if `items` is short or
`warnings` say sentences were skipped), read the document yourself and write `items.json`:

```json
[{ "text": "Security review approved", "kind": "approval", "owner_team": "Security",
   "due_text": "by Nov 14",
   "source": { "file": "Ingestion-service-POR-v3.pdf", "locator": "§4",
               "quote": "Security will have the security review approved by Nov 14." } }]
```

Then re-run with `--agent-items items.json`. The quote must appear in the named file word for
word (whitespace and curly quotes are ignored); otherwise the item is dropped with a warning.
`kind` is one of `deliverable`, `dependency`, `approval`, `checklist`. Leave `due_text` null when
the text gives no date; do not invent one.

**Checkpoint.** Show the person `plan-draft.json` as a table (item, kind, owner, due, inferred?,
source) and the warnings. Wait for their corrections and confirmation before Stage B. If they edit
the file, use the edited file from here on.

## Stage B — resolve-release (Jira)

**Input:** the confirmed plan, and optionally the epic key the person chose.

```
npx tsx skills/release-reader/scripts/resolve-release.ts --plan plan-draft.json \
  --source mcp --dir .mcp-cache/<label> --cloud-id <cloudId> \
  [--epic INGEST-142] [--no-search <team>] --out release-target.json
```

Steps the helper performs:
1. Picks the epic: `--epic`, else the plan's `epic_keys_mentioned`, and confirms it exists and is
   an Epic.
2. Reads its fix version and release date; warns if the date differs from the plan's launch date.
3. Lists visible projects (key, name, category, description, lead).
4. Matches each plan team to a project, trying in order and recording which source matched:
   `team_list` (the team list gives the key) → `explicit` (the plan names a project next to the
   team) → `linked` / `name` → `unresolved`. An exact key or name match beats partial matches.
   Two plausible projects always means `unresolved` with both as `candidates`, even if one of them
   is linked from the epic; the link is shown as evidence on that candidate.
5. Sets the release window: ends on the launch date, starts at the earlier of the epic's creation
   date and the earliest plan date minus 30 days.

**Checkpoint.** Show the person the teams → projects table (team, project, match, evidence) and
ask them to pick a project for each `unresolved` team or say "don't search this team". Write their
choices into `release-target.json` (`jira_project`, `match: "team_list"` is not correct for a
manual pick; keep `match` as it was and set `evidence` to "chosen by <person>"; set
`"search": false` for teams not to search). Wait for confirmation before Stage C.

## Stage C — read-jira (Jira)

**Input:** the confirmed plan and the confirmed `release-target.json`.

```
npx tsx skills/release-reader/scripts/read-jira.ts --plan plan-draft.json \
  --target release-target.json --source mcp --dir .mcp-cache/<label> --cloud-id <cloudId> \
  [--label 2026-11-13] --out release.json
```

The helper reads the epic (summary, status, fix version, components, due date), every child story
(key, summary, status, assignee, due, components, comments with the keys they mention), and the
issue links of the epic and stories. Then one hop out: each link target and each key mentioned in
a comment is fetched once (project, summary, status, assignee, due, updated) and recorded with how
it was reached (`link` with the type, or `comment_mention` with the source issue and an excerpt).
Keys inside the epic and keys that do not exist are skipped. Their links are not followed.

Then, for each matched project the person did not exclude, one JQL search per plan item owned by
that team, capped at 20 results:

```
project = SRE AND updated >= 2026-09-15 AND text ~ "capacity on-call"
```

Keys already reached are dropped; the rest are `search_candidates` with the item id, the terms and
the JQL. Unresolved and excluded teams are skipped with a warning.

`snapshot_label` is `--label` or the cache folder's name; `read_at` is the wall clock.

## Running in MCP mode: the request loop

The helpers never call the MCP server themselves. They read raw responses from `--dir` and, when
something is missing, write `<dir>/requests.json` and exit with code 3:

```json
[{ "tool": "getJiraIssue", "args": { "cloudId": "…", "issueIdOrKey": "SEC-881", "fields": ["summary", "…"] },
   "save_as": "issues/SEC-881.json" }]
```

For each entry: call that tool with those arguments, and save the tool's raw JSON response at
`<dir>/<save_as>`. If the call fails or the issue is not visible, save `{"error": "<message>"}`
instead. Re-run the same command. It usually takes 3–5 rounds per stage. Never edit a saved
response. Get `cloudId` once from `getAccessibleAtlassianResources`.

Use one cache folder per snapshot (for example `.mcp-cache/2026-11-13`), so a later run can be
compared with it.

## Fixture mode

`--source fixture --dir fixtures/ingest-142/jira/2026-11-13` reads a snapshot folder with
`projects.json` and `issues/*.json` in Jira REST shapes; JQL is evaluated locally over those
issues. Sample plan files are in `fixtures/ingest-142/docs/`. Both are placeholders until the real
sample data exists (PRD R12).

## When the orchestrator calls you

Run the three stages in order. Stop at each checkpoint unless the orchestrator passes confirmed
files (`plan-draft.json`, `release-target.json`), in which case use them as given. Hand the
orchestrator `release.json` together with the two confirmed files; the analyzer needs all three.
Do not summarize, rank or label anything in them.

## Output files

- `plan-draft.json` (Stage A), `release-target.json` (Stage B), `release.json` (Stage C).
- Schemas: `packages/schemas/src/index.ts` (`PlanDraft`, `ReleaseTarget`, `Release`). The helpers
  validate before writing; a file that fails validation is a bug, not something to hand-fix.
- Worked example of all three outputs: `reference/worked-example.md`.
