# Worked example: the INGEST-142 sample release

Inputs: `fixtures/ingest-142/docs/` (POR markdown, launch checklist CSV, team list YAML) and the
Jira snapshot `fixtures/ingest-142/jira/2026-11-13/`.

```
D=fixtures/ingest-142
npx tsx skills/throughline-reader/scripts/extract-plan.ts --files $D/docs/Ingestion-service-POR-v3.md $D/docs/launch-checklist.csv $D/docs/team-list.yaml --out plan-draft.json
npx tsx skills/throughline-reader/scripts/resolve-release.ts --plan plan-draft.json --source fixture --dir $D/jira/2026-11-13 --out release-target.json
npx tsx skills/throughline-reader/scripts/read-jira.ts --plan plan-draft.json --target release-target.json --source fixture --dir $D/jira/2026-11-13 --out release.json
```

## Stage A → `plan-draft.json`

7 items. Four from the POR (§2 deliverable, §3 dependency, §4 approval and dependency), three
from the checklist (#4, #6, #9 apply; the other six do not). The SRE item's date comes from "the
week before launch", so `due_is_inferred: true`. Full output: `fixtures/ingest-142/plan-draft.json`.

Without the team list (`plan-draft.no-team-list.json`) the same items are found; teams come from
the POR's "Four teams are involved: …" sentence and have no project hints or owners.

## Stage B → `release-target.json`

With the team list every team is `team_list`. Without it:

| Team | Project | Match | Why |
|---|---|---|---|
| Ingestion team | INGEST | explicit | the POR says "Jira project INGEST" |
| Data Platform | DATA | linked | project name equals the team name, and DATA-240 / DATA-221 are linked |
| Security | — | unresolved | SEC "Security Engineering" and SECOPS "Security Operations" both fit; SEC is listed first with its link evidence |
| SRE | SRE | linked | key equals the team name, and SRE-398 is linked; SRETOOLS loses to the exact match |

Window: 2026-09-15 (epic created) to 2026-11-20 (launch).

## Stage C → `release.json`

- 25 stories (21 Done on Nov 13), 6 links, 41 comments including the epic's.
- `related`: SEC-881, DATA-240, SRE-398, DATA-221, SEC-890 by link; DATA-233 by a comment mention on INGEST-150.
- `search_candidates`: SRE-412 (SRE, item p4, terms capacity on-call, due 2026-11-22) and DATA-251 (DATA, item p6, a permissions ticket for another service). Neither is linked to the epic.
- Nothing in INGEST comes back from search because every hit is already a story.

The Nov 10 snapshot differs where the prototype says it does: SEC-881 Open, DATA-240 To Do,
DATA-233 In Progress, SRE-412 due 2026-11-13, 18 stories Done, and no "load test looks fine" comment yet.
