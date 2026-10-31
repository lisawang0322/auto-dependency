---
name: release-review
description: Runs a complete release readiness review from plan files and a Jira epic key. You read the plan files and add the plan items the rules miss (each with a quote), the person confirms the plan and the team→project mapping, then the rules compare the plan with Jira. The one skill to invoke; it drives release-reader, release-analyzer and release-status through a single command and ends with a findings table and an HTML report. Jira is only ever read.
triggers: ["user"]
---

# release-review

Use this when someone asks for a release review, a readiness check, or "what is missing for the
<EPIC> launch". If they are earlier than that (a PRD but no team yet, or a team forming around an
epic and no launch date), use `release-starter` instead.

Two kinds of work, kept apart:

- **Reading is yours.** A plan of record is written for people: a deck, a doc, a one-pager. The
  command's rules read only the structured parts (sections headed Deliverables, Dependencies,
  Approvals, Readiness or Milestones; checklist tables; team lists) and miss the rest. You read the
  whole document and add every plan item the rules missed, each with a quote from the file. An item
  whose quote is not in the file is dropped, so you cannot add anything the document does not say.
- **Judging is the rules'.** Which items are gaps, how strong the evidence is, each team's status and
  the next actions come from `release-analyzer` and `release-status`. You run them, show them and
  report them; you never add, remove, rank, reword or rate a finding.

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

### 1. Read the plan

```
npm run review -- --files in/<EPIC>/* --epic <EPIC> --source rest --stop-after plan
```
This writes `runs/<EPIC>/<date>/plan-draft.json` and prints the plan table the rules found. Now read
every plan file yourself from start to finish: every slide, its speaker notes and tables, every
section of a doc. Write `runs/<EPIC>/<date>/agent-items.json` with every plan item the table does
not already have:

```json
[{ "text": "Rollback rehearsed",
   "kind": "deliverable",
   "owner_team": "SRE",
   "due_text": "the week before launch",
   "source": { "file": "Launch-plan.pptx", "locator": "slide 9",
               "quote": "SRE to rehearse the rollback the week before launch." } }]
```

A plan item is something a team must deliver, a dependency on another team, an approval or review
that must happen, or a readiness check, dated or not. Goals, context, assumptions and things the
document says are out of scope are not items.

- `kind` is `deliverable`, `dependency`, `approval` or `checklist`.
- `owner_team` is the team the document names for it, spelled as the document or the team list spells
  it; `null` when it names none. Never guess a team.
- `due_text` is the document's own words for the date ("by Nov 14", "the week before launch"); `null`
  when it gives none. Never invent or infer a date; the command resolves relative ones itself.
- `source.file` is the file's name exactly as given; `locator` is `§4`, `slide 9` or `slide 9 (notes)`;
  `quote` is one sentence or one table row copied word for word (only whitespace and curly quotes are
  ignored). For a deck the quote must be on that slide.
- Do not repeat an item the table already has, even reworded.

Then run Stage A again with your items. No `--resume`: Stage A is recomputed and the file rewritten.

```
npm run review -- --files in/<EPIC>/* --epic <EPIC> --source rest --stop-after plan --agent-items runs/<EPIC>/<date>/agent-items.json
```
A `Dropped agent item` warning means a quote is not in the file: fix the quote or leave the item out.
Never work around the check by writing the item into `plan-draft.json` yourself.

**Checkpoint 1.** Show the plan table the command prints (id, kind, owner, due, text; `?` marks an
inferred date) and the warnings, and say how many items the rules found and how many you added. Ask
the person to confirm or correct it. Apply corrections by editing `runs/<EPIC>/<date>/plan-draft.json`
(due dates, owners, wrong items removed; an item the person asks for added with a verbatim quote from
the file as `source.quote`). Never add an item you cannot quote.

### 2. Resolve the teams

```
npm run review -- --epic <EPIC> --source rest --resume --stop-after target
```
**Checkpoint 2.** Show the team → Jira project table with how each was matched and the warnings. Any
team shown as `unresolved` needs the person's choice: edit `runs/<EPIC>/<date>/release-target.json`
and set `jira_project` (and `match: "name"`), or set `search: false` to skip that team. Also confirm
the epic and launch date shown.

### 3. Compare with Jira and report

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
If the run compared with an earlier one (the `status` line says so), say what changed first. Say how
many plan items came from the rules and how many from your reading, so the person knows what the
findings rest on.

## Rules

- Jira is read-only. The commands cannot write; neither do you.
- Same input, same output for the rules. Your reading can differ from one session to the next; that is
  why every item you add carries a quote and the person confirms the table before Jira is read. If a
  re-run of the rules differs from the last one, the data changed; say so, do not smooth it over.
- Never add a plan item you cannot quote; never add, remove, reword or rate a finding.
- Do not commit anything unless asked. `runs/` holds the person's results; `in/` holds their files.
- The GUI (`npm start`, http://localhost:8787) is for the person to click through; use it when they
  ask for the interactive view, otherwise the report file is the deliverable.
- Sample data: `--source fixture --dir fixtures/ingest-142/jira/2026-11-13 --epic INGEST-142` with the
  files in `fixtures/ingest-142/docs/` runs the whole thing without Jira.
