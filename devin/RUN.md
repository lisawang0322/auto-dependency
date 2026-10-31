# Devin run: release-reader against a sandbox Jira through the Atlassian MCP

One run of the reader, stages A → B → C, in Devin, reading a sandbox Jira Cloud site that holds the
fixture's Nov 13 snapshot. The result is recorded next to the fixture-mode output. Jira is read-only
for Devin; the only writes are the seed script, which you run yourself.

Everything below is a checkbox. Do them in order.

## 1. Setup (once, about an hour)

### 1a. A free Jira Cloud sandbox

- [ ] Create a free Jira Software Cloud site (atlassian.com → Jira → free plan) with a throwaway name,
      for example `rrr-sandbox-<you>.atlassian.net`. Use a personal Atlassian account, not a work one.
- [ ] Create an API token: id.atlassian.com → Security → API tokens → Create. Keep it in a password
      manager; it is never committed.
- [ ] Check you are a site admin (Settings → Products): the seed script creates projects.

### 1b. Seed the snapshot

- [ ] Python once: `make py-setup` (creates `.venv` from `requirements.txt`).
- [ ] Dry run first; it calls nothing and shows what will be created:

```
export JIRA_SANDBOX=yes
export JIRA_SITE=https://rrr-sandbox-<you>.atlassian.net
export JIRA_EMAIL=<your atlassian email>
export JIRA_API_TOKEN=<token>
.venv/bin/python scripts/seed_jira.py --dry-run
```

- [ ] Real run (6 projects, 36 issues, 6 links, 43 comments; takes a few minutes):

```
.venv/bin/python scripts/seed_jira.py --out out/key-map.json
```

- [ ] Copy `out/key-map.json` to `devin/results/<date>/key-map.json`. It maps fixture keys to the
      keys Jira assigned (the epic is probably `INGEST-1`, not `INGEST-142`) and lists any status the
      sandbox workflow could not reproduce (`status_fallbacks`).
- [ ] Open the site and spot-check: project INGEST has an epic "Ingestion service launch" with 25
      child stories; SEC-881's equivalent is "In Review" or its fallback and is linked to the epic as
      "is blocked by"; SRE-412's equivalent "Capacity for ingestion service" has due date 2026-11-22
      and no links; the decoy projects SRETOOLS and SECOPS exist.
- [ ] If the site already had those project keys (a second seed), rerun with `--key-prefix T2` and
      make a copy of `fixtures/ingest-142/docs/team-list.yaml` with the prefixed keys for Stage A.

Known differences from the fixture, by design: Jira sets created/updated timestamps and comment
dates to the seed time; the fictional assignees are not users, so issues are unassigned; the
default workflow may map "Open" to "To Do", "In Review" to "In Progress" and "Closed" to "Done".
`scripts/compare_runs.py` accounts for all of these.

### 1c. Devin

- [ ] In Devin: Customize → MCPs → Atlassian → connect, and authorize the **sandbox** site only.
      Note the MCP's tool names for: list accessible sites, list projects, get issue, JQL search
      (expected: `getAccessibleAtlassianResources`, `getVisibleJiraProjects`, `getJiraIssue`,
      `searchJiraIssuesUsingJql`). If they differ, write the real names in `devin/results/<date>/NOTES.md`.
- [ ] Add this repository to Devin (Settings → Repositories). In the repo setup, the install
      command is `npm install`; Node 22+. Python is not needed for the run (the POR is passed as
      markdown).
- [ ] `make devin-skills` and commit `.agents/` so Devin sees `.agents/skills/release-reader/SKILL.md`.
- [ ] Confirm Devin lists the `release-reader` skill (it is `triggers: ["user"]`, so you invoke it
      by name).

## 2. The prompt

Paste this into a new Devin session. Replace `<EPIC>` with the sandbox key of INGEST-142 from
`key-map.json`, and `<label>` with a run label such as `sandbox-2026-11-02-run1`.

```
Use the release-reader skill (.agents/skills/release-reader/SKILL.md) in this repository.

Jira is READ-ONLY. Use only these Atlassian MCP tools: getAccessibleAtlassianResources,
getVisibleJiraProjects, getJiraIssue, searchJiraIssuesUsingJql. Never create, edit, comment on,
transition, link or assign anything in Jira, and do not use any other Atlassian tool.

Setup: run `npm install`, then `mkdir -p out .mcp-cache/<label>`. Keep a log of every MCP tool call
you make (tool, arguments, whether it succeeded, the error text if not) in out/mcp-calls.md.

Stage A (no Jira):
  npx tsx skills/release-reader/scripts/extract-plan.ts \
    --files fixtures/ingest-142/docs/Ingestion-service-POR-v3.md \
            fixtures/ingest-142/docs/launch-checklist.csv \
            fixtures/ingest-142/docs/team-list.yaml \
    --out out/plan-draft.json
Show me the items as a table (id, kind, owner, due, inferred, source) and the warnings.
Then STOP and wait for me to say "ok".

Stage B (Jira, read-only):
  Call getAccessibleAtlassianResources once and take the cloudId of the sandbox site.
  npx tsx skills/release-reader/scripts/resolve-release.ts --plan out/plan-draft.json \
    --source mcp --dir .mcp-cache/<label> --cloud-id <cloudId> --epic <EPIC> \
    --out out/release-target.json
  When it exits with code 3, open .mcp-cache/<label>/requests.json: for each entry call that tool
  with those arguments and save the tool's raw JSON response at .mcp-cache/<label>/<save_as>. If a
  call fails, save {"error": "<message>"} there instead. Re-run the same command. Repeat until it
  writes the output. Never edit a saved response.
Show me the teams → projects table (team, project, match, evidence) and the warnings.
Then STOP and wait for "ok".

Stage C (Jira, read-only):
  npx tsx skills/release-reader/scripts/read-jira.ts --plan out/plan-draft.json \
    --target out/release-target.json --source mcp --dir .mcp-cache/<label> \
    --cloud-id <cloudId> --label <label> --out out/release.json
  Same request loop as Stage B.
When done, report: number of stories and how many are Done; the links; every related issue with
how it was reached; every search candidate with its plan item id; the warnings; and how many
request rounds each stage took. Then commit nothing; leave out/ and .mcp-cache/<label>/ in the
workspace so I can download them.
```

- [ ] At each STOP, check the output against `fixtures/ingest-142/plan-draft.json` and
      `release-target.json` (project keys will carry your prefix if you used one), then say "ok".
- [ ] If Devin asks to use a tool that is not one of the four reads, say no and note it.

## 3. After the run

- [ ] Download `out/plan-draft.json`, `out/release-target.json`, `out/release.json`,
      `out/mcp-calls.md` and the whole `.mcp-cache/<label>/` folder into `devin/results/<date>/`.
- [ ] Compare with fixture mode:

```
python3 scripts/compare_runs.py --devin devin/results/<date>/release.json \
  --fixture fixtures/ingest-142/release.2026-11-13.json \
  --key-map devin/results/<date>/key-map.json
```

### What "pass" means

- [ ] `compare_runs.py` prints `PASS`: Stage C's output matches the fixture-mode output after
      mapping keys, apart from timestamps, assignees and JQL text. Status differences covered by
      `status_fallbacks` do not count.
- [ ] The line `SRE-412 (sandbox SRE-n) in search_candidates: YES` is printed: the unlinked SRE
      blocker was found by the scoped search, matched to plan item p4.
- [ ] Devin made only read calls (check `out/mcp-calls.md`; the four tool names only).
- [ ] Stages A and B stopped for your confirmation.

Expected on the fixture: 25 stories (21 Done), 6 links, related = SEC-881, DATA-240, SRE-398,
DATA-221, SEC-890 by link and DATA-233 by a comment mention on INGEST-150, search candidates =
SRE-412 (p4) and DATA-251 (p6), 4 projects searched, 0 warnings.

A difference in `search_candidates` only (extra or missing hits) is a partial pass: it means the
sandbox's `text ~` search ranks differently from the fixture evaluator. Record it as such.

### What to record if it fails

Write `devin/results/<date>/RESULT.md` with:

- The Devin session link, the date, and the run label.
- Which stage failed (A, B or C) and which request round.
- **Which tool call failed:** the tool name and the exact arguments (from `requests.json` and
  `out/mcp-calls.md`), and **the error text** Devin got back, verbatim.
- Whether Devin did something other than the four read tools (and what).
- The `compare_runs.py` output in full, if Stage C produced a file.
- Any difference between the MCP tool names Devin saw and the four expected names.
- What you changed before trying again (for instance a tool name in `reference/mcp-tools.md`).

Keep `.mcp-cache/<label>/` in the results folder either way: it is the raw evidence, and a later
run can be compared against it.
