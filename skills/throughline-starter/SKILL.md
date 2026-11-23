---
name: throughline-starter
description: The early stages of a project. Just starting (PRD R17) reads a PRD or one-pager for signals and suggests the teams to involve, a likely contact per team from an employee directory, a stakeholder map, the approvals to plan for, and first actions. Building (R18) adds a read-only look at the Jira epic to say which needed teams are missing from the work and which approvals have no ticket or no owner. You read the PRD and say which sentences are signals; the rules say what each signal implies. Jira is only ever read.
triggers: ["user"]
---

# throughline-starter

Use this when someone has a PRD, one-pager or brief and asks who they need to involve, which approvals
they will need, or whether the team forming around a Jira epic covers what the plan needs. For a
launch review (a POR, a launch date, a go/no-go) use `throughline` instead.

Two kinds of work, kept apart:

- **Reading is yours.** A *signal* is a sentence of the PRD that implies a team or an approval
  (customer data, a public API, peak load, a user-facing screen, enterprise GA, the shared platform).
  You open the PRD with your own tools, in whatever format it comes, and write down every such
  sentence with its quote and the rule it is an instance of. The command's patterns in
  `templates/signals.yaml` add the obvious wording on their own and check your quotes where it can
  read the file.
- **Implying is the rules'.** Which teams and approvals a signal implies, with the role, why, when and
  the first action, comes from the rule, never from you. The building stage matches people on Jira
  tickets to teams through the directory and approvals to tickets by keyword. Nothing is rated or
  guessed; the person unticks any signal that is wrong.

## What you need from the person

1. **The PRD** (markdown, Word, PDF, slides). Save it under `in/<project>/`.
2. **A directory or team list** (yaml, json, csv: teams, their Jira project, the people on them),
   optional but recommended: it turns team suggestions into names. Without it, teams come back
   without contacts and the building stage matches by Jira project only.
3. **Building stage only**: the epic key and read-only Jira access (`JIRA_SITE`, `JIRA_EMAIL`,
   `JIRA_API_TOKEN` in the environment). Do not ask for a token in chat.

Ask which stage they are at if it is not clear: *just starting* (no team yet, maybe no Jira) or
*building* (people are on board and work is tracked in Jira).

## Steps

### 1. Read the PRD

First open `templates/signals.yaml` and read each rule's `id`, `teams` and `approvals`: that is the
meaning of each kind of signal. Then read the whole PRD with your own tools, in whatever format it
comes (markdown, Word, PDF, a deck, a Pages or Keynote export), every section and slide. If you cannot
open a format directly, convert it and say so. Never substitute another file for the one given.

Write `runs/<project-slug>/<date>.agent-signals.json` (the slug is the project's name in lower case
with dashes; for the building stage use `runs/<EPIC>/<date>.agent-signals.json`) with every sentence
that is an instance of a rule's meaning:

```json
[{ "quote": "Aggregates are kept indefinitely.",
   "file": "ingestion-service-PRD.md",
   "locator": "§3 Data",
   "rule_ids": ["customer_data"] }]
```

- `quote` is one sentence copied word for word (only whitespace and curly quotes are ignored).
- `file` is the file's name exactly as given; `locator` is optional (`§3 Data`, `slide 4`, `page 2`);
  the command finds the section itself when it can read the file.
- `rule_ids` are ids from `templates/signals.yaml`. A sentence can be an instance of several rules.
  An id that is not in the file is ignored with a warning; a signal with no known id is dropped.
- A sentence that implies a team no rule covers is not a signal. Do not invent a rule or a team: say
  in chat that the sentence is not covered by the rules, so the company can extend `signals.yaml`.
- Sentences that say what is *not* in scope, or describe something that already exists, are not signals.

Then run the command with your signals:

```
npm run starter -- --stage starting --files in/<project>/<prd> [in/<project>/<directory>] --agent-signals runs/<project-slug>/<date>.agent-signals.json
```
It adds the sentences its own patterns match (a sentence you both found is kept once), checks your
quotes against the PRD when it can read the file, and prints the signals, the teams (role, when,
contact), the approvals and the first actions; it writes `runs/<project-slug>/<date>.starting.json`.
A signal from a file the command cannot read is kept with `quote_verified: false` and a warning; a
`Dropped agent signal` warning means a quote is not in a readable file or the rule id does not exist.
Fix it or leave the signal out. Never edit the saved run to add a signal.

**Checkpoint.** Show the person the signals (`signals[]`: quote, where it was found, the teams it
points to), say which you read and which the patterns added, which quotes the command could not
check, and ask which are wrong. Re-run with `--exclude g2,g5` (keeping `--agent-signals`) for the
ones they untick; the teams, approvals and actions only those signals implied drop out.

### 2. Just starting: report

Nothing more to run. Report as below.

### 3. Building: compare with the Jira work

```
npm run starter -- --stage building --files in/<project>/<prd> in/<project>/<directory> --epic <EPIC> --source rest --agent-signals runs/<EPIC>/<date>.agent-signals.json [--exclude g2,g5]
```
Reads the epic, its links one hop out, and one scoped search per approval (same reader, same cache
as `throughline`), then prints team coverage (covered / unclear / missing, with who was found)
and approval status (done / started / no owner / not started, with the ticket), and writes
`runs/<EPIC>/<date>.building.json`. Teams the directory gives no Jira project are checked by
assignee only.

Sample data, no Jira needed:
```
npm run starter -- --stage starting --files fixtures/ingest-142/docs/ingestion-service-PRD.md fixtures/ingest-142/docs/directory.yaml
npm run starter -- --stage building --files fixtures/ingest-142/docs/ingestion-service-PRD.md fixtures/ingest-142/docs/directory.yaml \
    --epic INGEST-142 --source fixture --dir fixtures/ingest-142/jira/2026-11-13
```

## What to report in chat

- **Just starting**: the teams grouped by role (work with closely, consult, approves, keep informed),
  each with why, when and the contact; the approvals with when to start; then the next actions
  (`next_actions[]`: text, who, when, why). Quote the file's wording; do not add teams the rules did
  not name, and say "no directory given" when contacts are missing.
- **Building**: the coverage table (team, state, what was found, contact), the approvals table (name,
  state, detail), then the next actions. Say which teams had no Jira project and were checked by
  assignee only (the `warnings`).
- Both: how many signals the patterns found and how many you added, and any sentence you judged
  relevant that no rule covers.

## Rules

- Jira is read-only; the commands cannot write.
- Company-specific wording lives in `templates/signals.yaml`. If the person's company has its own
  copy, pass it with `--rules <file>` and read that copy for the rule ids; never edit the wording in
  your answer.
- Same input, same output for the rules. Your reading can differ between sessions; that is why every
  signal you add carries a quote and a rule id and the person can untick it.
- Do not commit anything unless asked.
- The GUI (`npm start`) runs the same code behind the "Just starting" and "Team forming" stages.
