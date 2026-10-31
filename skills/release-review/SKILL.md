---
name: release-review
description: Runs a complete release readiness review from plan files and a Jira epic key, with the person confirming the extracted plan and the team→project mapping before Jira is compared. The one skill to invoke; it drives release-reader, release-analyzer and release-status through a single command and ends with a findings table and an HTML report. Jira is only ever read.
triggers: ["user"]
---

# release-review

Use this when someone asks for a release review, a readiness check, or "what is missing for the
<EPIC> launch". If they are earlier than that (a PRD but no team yet, or a team forming around an
epic and no launch date), use `release-starter` instead. You run one command in stages and show the
person each checkpoint. You never judge
anything yourself: the findings come from rules, and your job is to run them, show them, and report.

## What you need from the person

1. **Plan files**: the plan of record (markdown, `.pptx`, PDF, Word), optionally a launch checklist
   (csv, xlsx, markdown) and a team list (yaml, json, csv). Save attachments under `in/<EPIC>/`
   with their original names. If a link is given instead, download it there first.
2. **The epic key** (`PROJ-123`). If it is not given, Stage A finds keys in the plan; ask which one.
3. **Jira access**: `JIRA_SITE`, `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment (secrets manager),
   read-only. If they are missing, say so and stop; do not ask the person to paste a token into chat.

## Steps

```
npm run doctor -- --epic <EPIC>
```
Every line must be `ok` or `warn`. On `FAIL` stop and tell the person what the line says. Do not try
to repair credentials or install things beyond what the line suggests (`npm install`, `make py-setup`).

```
npm run review -- --files in/<EPIC>/* --epic <EPIC> --source rest --stop-after plan
```
**Checkpoint 1.** Show the plan table the command prints (id, kind, owner, due, text; `?` marks an
inferred date) and the warnings. Ask the person to confirm or correct it. Apply corrections by editing
`runs/<EPIC>/<date>/plan-draft.json` (due dates, owners, wrong items removed, missing items added with
a verbatim quote from the file as `source.quote`). Never add an item you cannot quote.

```
npm run review -- --epic <EPIC> --source rest --resume --stop-after target
```
**Checkpoint 2.** Show the team → Jira project table with how each was matched and the warnings. Any
team shown as `unresolved` needs the person's choice: edit `runs/<EPIC>/<date>/release-target.json`
and set `jira_project` (and `match: "name"`), or set `search: false` to skip that team. Also confirm
the epic and launch date shown.

```
npm run review -- --epic <EPIC> --source rest --resume
npm run report -- runs/<EPIC>/<date>.json
```
The first prints the shown findings and the saved run; the second writes
`runs/<EPIC>/<date>/report.html`. Attach the report.

## What to report in chat

A short table of the shown findings: title, gap type, strength, owner, next action (`who`, `by_when`,
`action` from `findings.json`). Then the team statuses with their change notes, the hidden weak
findings as one line ("N weak findings hidden: …"), and the separate linkage gaps. Quote titles and
actions as the files have them; do not reword, rank, or add findings, and do not state a confidence.
If the run compared with an earlier one (the `status` line says so), say what changed first.

## Rules

- Jira is read-only. The commands cannot write; neither do you.
- Same input, same output. If a re-run differs from the last one, the data changed; say so, do not smooth it over.
- Do not commit anything unless asked. `runs/` holds the person's results; `in/` holds their files.
- The GUI (`npm start`, http://localhost:8787) is for the person to click through; use it when they
  ask for the interactive view, otherwise the report file is the deliverable.
- Sample data: `--source fixture --dir fixtures/ingest-142/jira/2026-11-13 --epic INGEST-142` with the
  files in `fixtures/ingest-142/docs/` runs the whole thing without Jira.
