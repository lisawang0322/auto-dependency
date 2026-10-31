---
name: release-starter
description: The early stages of a project. Just starting (PRD R17) reads a PRD or one-pager for signals and suggests the teams to involve, a likely contact per team from an employee directory, a stakeholder map, the approvals to plan for, and first actions. Building (R18) adds a read-only look at the Jira epic to say which needed teams are missing from the work and which approvals have no ticket or no owner. Rules and templates only; Jira is only ever read.
triggers: ["user"]
---

# release-starter

Use this when someone has a PRD, one-pager or brief and asks who they need to involve, which approvals
they will need, or whether the team forming around a Jira epic covers what the plan needs. For a
launch review (a POR, a launch date, a go/no-go) use `release-review` instead.

Everything here is a rule: a sentence of the PRD that matches a pattern in `templates/signals.yaml`
is a *signal*; the rule says which teams and approvals it implies, with the role, why, when and a
first action. The building stage matches people on Jira tickets to teams through the directory, and
approvals to tickets by keyword. Nothing is rated or guessed. Same input, same output.

## What you need from the person

1. **The PRD** (markdown, Word, PDF, slides). Save it under `in/<project>/`.
2. **A directory or team list** (yaml, json, csv: teams, their Jira project, the people on them),
   optional but recommended: it turns team suggestions into names. Without it, teams come back
   without contacts and the building stage matches by Jira project only.
3. **Building stage only**: the epic key and read-only Jira access (`JIRA_SITE`, `JIRA_EMAIL`,
   `JIRA_API_TOKEN` in the environment). Do not ask for a token in chat.

Ask which stage they are at if it is not clear: *just starting* (no team yet, maybe no Jira) or
*building* (people are on board and work is tracked in Jira).

## Commands

```
npm run starter -- --stage starting --files in/<project>/<prd> [in/<project>/<directory>]
```
Prints the signals it read, the teams (role, when, contact), the approvals and the first actions, and
writes `runs/<project-slug>/<date>.starting.json`.

**Checkpoint.** Show the person the signals (`signals[]`: quote, where it was found, the teams it
points to) and ask which are wrong. Re-run with `--exclude g2,g5` for the ones they untick; the
teams, approvals and actions only those signals implied drop out.

```
npm run starter -- --stage building --files in/<project>/<prd> in/<project>/<directory> --epic <EPIC> --source rest
```
Reads the epic, its links one hop out, and one scoped search per approval (same reader, same cache
as `release-review`), then prints team coverage (covered / unclear / missing, with who was found)
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

## Rules

- Jira is read-only; the commands cannot write.
- Company-specific wording lives in `templates/signals.yaml`. If the person's company has its own
  copy, pass it with `--rules <file>`; never edit the wording in your answer.
- Do not commit anything unless asked.
- The GUI (`npm start`) runs the same code behind the "Just starting" and "Team forming" stages.
