---
name: throughline-status
description: Rolls the throughline-analyzer's findings up per team (on track, at risk, late), one line per plan item, and names what moved since the previous run. Never calls Jira; reads the reader's and analyzer's files only.
triggers: ["user"]
---

# throughline-status

You turn `findings.json` into the per-team view the review screen shows: one row per team, one
line per plan item, and a change note against the previous run. Every value is a rule in
`scripts/lib/status.ts`; nothing is rated. Same input, same output.

## Input and command

```
npx tsx skills/throughline-status/scripts/status.ts --plan plan-draft.json --target release-target.json \
  --release release.json --findings findings.json [--previous runs/<epic>/<earlier>.json] --out status.json
```

`--previous` is an earlier saved run; without it every team gets an empty change note (first run).
The orchestrator (`scripts/review.ts`, `server/index.ts`) picks the newest earlier run automatically.

## Rules

- **Teams** are the resolved rows of `release-target.json`, in that order. A team without a Jira
  project gets a warning instead of a row; its plan items are listed under the service team (the
  epic's own project).
- **Items** are the plan items the team owns (`owner_team`), in plan order. Items with no owner go to
  the service team.
- **Result per item**, from the analyzer's finding for that item (the first one when several):
  `late` for a cross-team date finding, `weak` for a weak finding, `gap` for any other finding, `ok`
  when there is none.
- **Team status**: `late` if any item is late, `at_risk` if any item is a gap, else `on_track`. Weak
  items never change a status, matching the review screen's own roll-up.
- **Ticket column**: the analyzer's matched ticket. Its status line says how it was reached
  (`in the epic`, `linked`, `not linked to epic`, `comment only`), the epic shows `N of M stories done`,
  and an odd resolution (Duplicate, Won't Do) is shown in brackets.
- **Note**: `On track` / `Done` (with `· linkage gap` when a separate linkage gap points at the ticket),
  `Approval still open`, `Not done`, `No ticket`, `Weak evidence`, or `Due N days after launch` /
  `after the plan date`.
- **Change note**: for each ticket behind the team's items, a status move (`SEC-881 moved to In
  Review`), a due-date move (`SRE-412 due date moved Nov 13 → Nov 22`), and a ticket that no longer
  counts for an item or newly covers one. Joined with `; `.

## Output

`status.json`: `{schema_version, snapshot_label, epic, compared_with, teams[], warnings[]}` where
`teams[]` is the `Team` schema the GUI already loads (`packages/schemas`). The saved run
`runs/<epic>/<label>.json` carries `teams` from here.
