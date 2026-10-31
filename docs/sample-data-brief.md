# Brief: write one sample release for the Release Readiness Review

Thank you for helping. This takes an afternoon. You are writing a small, fictional software release
that a tool will review for gaps between what the plan says and what Jira shows. The tool's author
must not write this data, otherwise the tool is tested against its author's own habits. You do not
need to know how the tool works, and you should not look at its code before you write.

## What the tool does, in one paragraph

A technical program manager owns a launch that four teams contribute to. There is a plan of record
(a slide deck), a launch checklist (a table of things every launch must do) and a Jira epic with
stories. A week before launch the tool reads the plan and the Jira epic and lists the gaps: an
approval still open, a promise someone made in a comment that never became a ticket, another team's
ticket due after the plan date. The tool only reads Jira, follows links and comment mentions one hop
into other teams' projects, and searches each team's project for unlinked work.

## What to write

**One fictional release.** Pick any product (a payments feature, a mobile onboarding flow, a data
pipeline). Four teams: the team that ships it, plus three it depends on, for example a platform
team, an approver (security, privacy, legal) and an operations team. Invent all names: company,
people, products, Jira project keys. **No real company data, no real people.**

1. **The plan of record, as slides** (`.pptx`, about 8 to 12 slides). Include: a title slide with
   the epic key and the launch date written out ("Launch date: 2027-03-12"); an overview slide that
   says what kind of launch it is (new service, customer-facing UI, personal data, and so on) and
   names the four teams in one sentence ("Four teams are involved: …"); a timeline table; a
   dependencies slide with one bullet per dependency, each naming the owning team and a date; an
   approvals slide. **Put at least one approval only in the speaker notes.** Dates can be absolute
   ("by Mar 5") or relative ("the week before launch"). One slide may be a picture only.
   Export the deck to PDF too, with speaker notes included.
2. **A launch checklist** (CSV, columns `#, Check, Owner, Applies to, Due`), 8 to 12 rows. Some
   rows apply to every launch ("All launches"), some only to certain kinds ("Customer-facing UI",
   "Personal data"), so that only 3 to 5 rows apply to your release. The owner of a row can be a
   team name or "Service team".
3. **A team list** (YAML): for each team, `name`, `role`, `jira_project`, `owners` (two or three
   people with roles) and `components`.
4. **Jira content for the four teams across two dated snapshots.** Write it as the generator does
   for the existing sample (`fixtures/ingest-142/jira/generate.ts`) or as plain JSON files, one per
   issue, in Jira's shape: key, summary, type, status, resolution, assignee, due date, components,
   fix version, parent (for stories under the epic), issue links, comments with dates. One epic with
   15 to 30 stories; 4 to 8 tickets in the other three teams' projects; **two decoy projects** with
   similar names (for example `SRETOOLS` next to `SRE`) holding one or two unrelated tickets each.
   Two snapshots, for example the Monday and the Thursday of the week before launch, with
   **at least one status change between them** that changes a finding (a ticket closed, a due date
   moved, a comment added).

**Seeded gaps: 6 to 10.** Decide them before you write the Jira content, and cover all three kinds:

- **process**: an approval or checklist item with no ticket at all, or with a ticket that is not
  done by the plan date. Example: the security review ticket is linked to the epic but still "In
  Review".
- **cross_team_date**: another team's ticket for a plan item is due after the plan date or after
  launch. Example: the capacity ticket slipped to two days after launch.
- **commitment**: someone promises the work in a comment ("we'll do the permissions review before
  launch", "will attach the report") and no ticket backs it. Make at least one of these a ticket
  that was closed as a duplicate, so the promise is all that is left.
- **At least one unlinked cross-team blocker**: a ticket in another team's project that the launch
  depends on, with **no link to the epic and no mention in any comment**, so only a search of that
  project finds it. This is the one the PRD cares about most.
- **At least one linkage gap by comment**: a ticket mentioned in a comment on a story but never linked.

**Plausible noise**, so the tool has to be right, not lucky: tickets that look related but are not.
A permissions review for a different service in the same project. A ticket in a decoy project whose
summary contains the same words. A story whose comment thanks everyone and says "looks good for
launch". A done ticket for last quarter's version of the same work. Also write ordinary traffic:
"Picked this up" comments, stories that are simply done.

**Two things to keep honest.** Every plan item's wording should match its ticket the way real people
write: not identical, but sharing the key nouns ("Capacity for ingestion service" for "SRE capacity
and on-call in place"). And do not make every plan item a gap; most things should be fine.

## The answer key

Fill in `eval/answer-key.schema.json` for the later snapshot; `eval/answer-key.ingest-142.json` is a
complete example. For each seeded gap: which plan item (quote a distinctive phrase from the plan),
which gap type, the strength you expect (**strong** when the plan item has a ticket linked to the
epic; **moderate** when the ticket was found by search or nothing was found; **weak** when only a
comment says anything), the ticket it should cite or `null`, and one sentence saying what you
seeded. List the linkage gaps with the blocker marked, the noise tickets with why they are noise,
and the status changes between the snapshots with the effect you expect.

Hand over: the deck and its PDF, the checklist, the team list, the Jira content for both snapshots,
and the answer key. A short note on anything you found ambiguous while writing is very welcome; those
are usually the interesting cases.

## Rules

- No real company data, no real names, no real ticket text.
- Do not read the tool's matching rules or the existing findings before you write. Afterwards, feel
  free to.
- Keep the whole thing small enough to review by hand in twenty minutes.
