---
name: throughline
description: Checks a project's plan against its Jira epic and says what is missing for launch. Works from plan files and a Jira epic key. You read the plan files yourself, in any format, and write the plan items (each with a quote the command checks where it can), the person confirms the plan and the team→project mapping, then the rules compare the plan with Jira. The one skill to invoke; it drives throughline-reader, throughline-analyzer and throughline-status through a single command and ends with a findings table and an HTML report. Jira is only ever read.
triggers: ["user"]
---

# Throughline

Use this when someone asks to check the project, for a release review or a readiness check, or
"what is missing for the <EPIC> launch". If they are earlier than that (a PRD but no team yet, or a
team forming around an epic and no launch date), use `throughline-starter` instead.

Two kinds of work, kept apart:

- **Reading is yours.** A plan of record is written for people, in whatever format they chose: a
  deck, a doc, a PDF, a spreadsheet. You open the files with your own tools and write down every plan
  item, each with a quote. The command then checks the quotes against every file it can read itself
  and adds the structured parts it can parse (checklist rows, team lists). An item whose quote is not
  in a readable file is dropped, so you cannot add anything the document does not say; an item from a
  file the command cannot read is kept but marked unchecked, so the person knows to confirm it.
- **Judging is the rules'.** Which items are gaps, how strong the evidence is, each team's status and
  the next actions come from `throughline-analyzer` and `throughline-status`. You run them, show them and
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

You read the plan files first, with your own tools, in whatever format they come: a `.pptx` or Google
Slides export, a PDF, a Word file, a Keynote or Pages export, a spreadsheet, markdown. Open every file
start to finish: every slide, its speaker notes and tables, every section of a doc. If you cannot open
a format directly, convert it (for example `soffice --headless --convert-to pdf`) and say so in chat.
Never substitute another file for the one the person gave, and never skip a file because the command
can read it on its own.

Write `runs/<EPIC>/<date>/agent-items.json` with every plan item in the files:

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
- `source.file` is the file's name exactly as given; `locator` is `§4`, `slide 9`, `slide 9 (notes)`
  or `page 3`; `quote` is one sentence or one table row copied word for word (only whitespace and
  curly quotes are ignored). For a deck the quote must be on that slide.
- One item per commitment. If the same commitment appears twice (a summary slide and a detail slide),
  quote the more specific one.

Then run Stage A with your items:

```
npm run review -- --files in/<EPIC>/* --epic <EPIC> --source rest --stop-after plan --agent-items runs/<EPIC>/<date>/agent-items.json
```
The command adds what it can parse on its own (checklist rows, the team list, sections it recognises;
an item it finds with the same quote as yours is kept once) and checks your quotes against every file
it can read. Three outcomes per item:

- kept, quote checked: the normal case for markdown, `.pptx`, PDF, Word, csv, yaml;
- kept, quote **not** checked (`~` in the table, `quote_verified: false` in the file): the command could
  not read that file's format. The item rests on your reading, so the person must confirm it;
- dropped with a `Dropped agent item` warning: the quote is not in a file the command could read.
  Fix the quote or leave the item out. Never work around the check by writing the item into
  `plan-draft.json` yourself.

**Checkpoint 1.** Show the plan table the command prints (id, kind, owner, due, text; `?` marks an
inferred date, `~` a quote the command could not check) and the warnings. Say which files you read
and how (directly, or converted), how many items came from your reading and how many the command
added on its own, and which items the command could not check. Ask the person to confirm or correct
the table. Apply corrections by editing `runs/<EPIC>/<date>/plan-draft.json` (due dates, owners,
wrong items removed; an item the person asks for added with a verbatim quote from the file as
`source.quote`). Never add an item you cannot quote.

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
many plan items came from your reading, how many the command added on its own, and how many quotes
it could not check, so the person knows what the findings rest on.

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
