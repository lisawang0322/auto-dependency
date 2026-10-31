---
name: release-analyzer
description: Compares a release's confirmed plan with the facts the release-reader gathered from Jira and writes findings.json, the gaps between plan and reality, each with evidence, an owner, a rule-set evidence strength and one next action. Never calls Jira; reads the reader's files only.
triggers: ["user"]
---

# release-analyzer

You compare expected (the confirmed plan and checklist) with found (the reader's `release.json`)
and write `findings.json`. Every judgement here is a rule in `scripts/lib/analyze.ts`; you do not
rate anything yourself, and you never call Jira. Same input, same output (apart from `analyzed_at`).

## Input

- `plan-draft.json` after the person confirmed it (Stage A of the reader);
- `release-target.json` (Stage B, confirmed);
- `release.json` (Stage C);
- optionally a team list (`--teams team-list.yaml`), when the plan was extracted without one.

```
npx tsx skills/release-analyzer/scripts/analyze.ts --plan plan-draft.json --target release-target.json \
  --release release.json [--teams team-list.yaml] [--go-no-go YYYY-MM-DD] --out findings.json
```

`--go-no-go` defaults to the Friday before the launch date. Wording lives in
`templates/next_actions.yaml` (titles and next actions) and `rules/phrases.yaml` (the comment
phrases that count as a promise or a claim); edit those, not the code, to change wording.

## Matching plan items to tickets

For each plan item, in this order; the first hit wins and is recorded in `matches[]` as `way`:

1. `linked_key`: the item's text names an issue key that is the epic, a story in it, or linked from it.
2. `linked_keywords`: the item's keywords match the summary of such a ticket.
3. `search`: a `search_candidates` entry for this item matches.
4. `comment`: a ticket mentioned in a comment matches, or comment text matches the item (no ticket).
5. `none`.

Keywords are the reader's search terms (same stop list, team name removed; the first is the lead
term). A summary or comment matches when at least half the keywords occur and the lead term is one
of them; a keyword matches a word that equals it or shares a prefix of three or more letters
("prod" ~ "production", "DBA" ~ "db"). The service team's items are looked for in the epic and its
stories; another team's items are looked for in that team's project, reached by a link, because
the epic's stories are the service team's work. The service team is the team whose Jira project is
the epic's. A ticket closed without being done (resolution Duplicate, Won't Do, Cancelled, …) never
counts as a match; it is shown as evidence with "closed without being done". Search candidates that
do not match well enough are named in `warnings` with their score.

## Gap types (R5), one finding per plan item at most, in this precedence

- **cross_team_date**: the item is owned by another team and its matched ticket is due after the
  plan date or after launch.
- **process**: an approval or checklist item with no matching ticket (and no promise in a comment),
  or with a matching ticket that is not done: any open approval counts; a checklist ticket counts
  when the snapshot date is past the plan date or the ticket is due after it.
- **commitment**: no ticket, and a comment promises the item ("will … before", "we'll",
  "promised", "by launch", "before launch"); or the ticket is still open and a comment claims the
  item is handled ("looks fine", "is done", "will attach", "passed").
- **Linkage gaps (R13)**, listed in `linkage_gaps[]`: every matched search candidate and every
  comment-mentioned ticket that is not linked to the epic, with both keys and a suggested link type
  ("is blocked by" when the ticket belongs to another team, else "relates to"). A gap behind a
  finding is attached to it (`finding.linkage`, `gap.finding_id`); the rest are separate and do not
  count toward the cap.

Not reported, by design: deliverables or dependencies that have no ticket and no promise (no gap
type covers them); anything agreed only in meetings or Slack.

## Evidence strength (R7), set by rule

- **strong**: the finding's ticket is in the epic or linked from it (`linked_key`, `linked_keywords`).
- **moderate**: the ticket came from a search or a comment mention, or nothing was found (the item
  has no ticket; a promise in a comment, if any, is the only trace).
- **weak**: comment text only: the ticket exists and is open, and only a comment says the item is
  handled. Hidden by default.

The owner comes from the team list when one was given (`owner_source: team_list`) and is otherwise
inferred from the plan text (`jira_inferred`, and the next action's `who` says "owner inferred").
Owner inference never changes the strength of a linked match. `strength_rule` says which rule applied.

## Evidence or drop

Every finding carries the plan quote and source (`plan_quote`, `plan_source`) and either Jira
evidence (`evidence[]`: key, text, meta) or `none_found` with the projects and JQL that were
searched. A finding with neither is a bug, not something to hand-fix.

## Next action

Every finding has `next_action`: `action` (one sentence from the template for its case), `who`
(owner team plus the first person in the team list), `by_when` (the plan date, or
"before go/no-go (date)" when that is earlier) and `why` (the finding title). `ask` repeats the
action for the GUI.

## Output

`findings.json` (schema `Findings` in `packages/schemas/src/index.ts`): findings sorted by strength
then plan date, ids `f1…`; the first 10 non-weak findings have `shown: true` (R8); weak ones have
`hidden_by_default: true`; `linkage_gaps[]`; `matches[]` (how every plan item matched); `warnings[]`.

## Checkpoint

Show the person the shown findings as a table (title, type, strength, owner, next action), the
hidden weak ones as a count, and the separate linkage gaps. They keep or dismiss findings in the GUI;
you do not change the file.

## Worked example

`fixtures/ingest-142/findings.2026-11-13.json` (4 shown findings, 1 hidden, 2 linkage gaps) and
`findings.2026-11-10.json` (2 findings), from the reader's fixture-mode files in the same folder.
