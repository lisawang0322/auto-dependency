# PRD — Release Readiness Review Skills

Oct 6, 2026 · @Lisa

## Summary

An agent that checks a release's Jira work against its plan of record (POR) and launch checklist, lists the gaps with owners and evidence, and tracks each team's status on a dashboard across review runs. This semester: a working prototype on sample data. The completed prototype is the deliverable; there is no usability testing.

## Problem

Cross-team launch blockers are found too late. From our survey (n=16):

- 62.5% find dependency problems during implementation.
- 75% say the warning sign was mentioned somewhere but never tracked.
- 68.8% stop trusting a tool that sends irrelevant alerts.

Current tools (Jira, Asana, Linear, Planview) don't track business-process dependencies such as approvals and reviews.

## 1. Customer and moment

**Who:** a TPM at a large company who owns a cross-team launch. Example: a new ingestion service on the shared data platform, with 4 teams (service team, Data Platform, Security, SRE), one Jira epic and about 25 stories.

**When:** the day after QA signs off, a week before launch, preparing for Friday's go/no-go. The director asks: "Are we good for the 20th?"

**Today:** they click through stories, reread sync notes, message each lead, and call it green with a doubt they can't name.

**Evidence:** two survey respondents described this. In one, production had stricter database permissions than QA, forcing an unplanned review and a one-day slip. In the other, undocumented cluster limits caused a late redesign. To be validated with 2–3 TPM interviews.

## 2. Job to be done

**When** a launch review is a week out and I have to tell leadership whether we're on track, **I want to** see every gap between the plan and the actual work, with owners and sources, **so I can** chase the right people while there's still time and give a status I can defend. **But first** I need to trust the list: every item shows its source, and nothing is filler.

- **Functional:** done in minutes, not an afternoon; each gap goes to the right owner.
- **Emotional:** no surprise blockers in the meeting.
- **Social:** credible with the director; no false alarms sent to engineering leads.

## User flow

1. The TPM opens the release and confirms the plan extracted from the POR, correcting one date.
2. Four findings appear:
   - Security approval still open (process, strong).
   - A database permissions review promised in a comment, with no ticket (commitment, moderate).
   - SRE capacity due two days after launch (cross-team date, moderate).
   - No rollback plan (process, moderate).
3. They open a finding and see the plan line next to the Jira evidence.
4. They dismiss one item that doesn't apply.
5. They open the dashboard: Security and Data Platform are at risk, SRE is late and slipped since the last run. They go into the go/no-go at amber, with two named owners.

Known miss: anything agreed only in meetings or Slack.

## Scope

**In:** POR, launch checklist and Jira as inputs; process, cross-team date and commitment gaps; linkage gaps between the epic and other teams' tickets; evidence and strength on every finding; a GUI over saved runs: findings plus a project status dashboard with history across runs; an answer key for each sample release.

**Out this semester:** usability testing; meeting notes, Slack and email; follow-up chat; a live GUI connected to Devin; other gap types (coverage, ownership, assumption drift); briefs for other roles; releases without a POR; writing to Jira; multi-release rollup; plugin packaging; Glean and Asana; real company data.

## Requirements

| ID | Requirement |
| --- | --- |
| R1 | Extract a plan from the POR: deliverables, owners, dates, dependencies, approvals |
| R2 | TPM confirms or edits the plan before seeing findings |
| R3 | Load the launch checklist |
| R4 | Read the epic (stories, links, components, comments, due dates), then follow its issue links and comment-mentioned keys one hop into other teams' projects (status, due date, assignee), then run a scoped search of each POR team's project for unlinked matches to plan items within the release window |
| R5 | Report process, cross-team date and commitment gaps, each with an owner from the org map (team → owners, Jira project keys, components) |
| R6 | Each finding shows the expected item and the evidence found, or "none found" |
| R7 | Evidence strength: **strong** = plan or checklist item matched to a linked ticket; **moderate** = owner or match inferred; **weak** = comment text only |
| R8 | Hide weak findings by default; show at most 10 |
| R9 | Project status dashboard: one row per team and Jira project with status (on track / at risk / late), open gaps, next plan date and change since the last run, expandable to plan items next to their tickets; plus release status, status history across runs, and what the tool can't see |
| R10 | GUI: plan confirmation, findings list, accept/dismiss (logged), and the dashboard (R9) |
| R11 | Three skills (reader, analyzer, status) plus an orchestrator; each skill usable alone. The status skill rolls findings up per team and compares them with the previous run |
| R12 | Sample data and answer key: someone else writes the sample POR, checklist, org map and Jira projects, including known gaps (one is an unlinked cross-team blocker) and an answer key listing them. Each sample release has at least two dated snapshots, with known status changes between them. Devin runs each snapshot 3 times, and the output is checked against the key |
| R13 | Surface linkage gaps found in R4: a matching ticket in another team's project that isn't linked to the epic, or an issue key mentioned in a comment with no link. Each shows both tickets and the suggested link type. A linkage gap behind a finding is shown on that finding; the rest are listed in a separate "Linkage gaps" section that does not count toward the 10-finding cap |

Constraints: sample data only. The dashboard states what the tool can't see: meetings, Slack, and whether technical work is adequate.

## How it works

Devin runs the orchestrator on each dated snapshot of a sample release (reader → analyzer → status) and saves each run as JSON; the GUI loads the runs in order, so the dashboard shows the latest status and how it changed. Skills are plain `SKILL.md` files, so they can move to another agent. Details: Dependency Review Skills — Design (Devin + Jira).

## Success metrics

| Metric | Target |
| --- | --- |
| Known gaps found (vs. answer key) | ≥ 80% |
| Shown findings that are in the answer key (precision) | ≥ 70% |
| Unlinked cross-team blocker surfaced as a linkage gap | In all 3 runs |
| Run-to-run variation | Reported |
| Every sample release runs end to end and opens in the GUI | All releases |
| Status changes between snapshots shown correctly on the dashboard | All known changes |

## Milestones

Four one-week milestones, starting Oct 12. Nov 2–4 is catch-up and freezing the saved runs; no work Nov 5–14 (away); the GUI milestone runs Nov 16–22, when the prototype is complete. Phase 0 checks (approvals, Devin + Atlassian MCP, skill-calls-skill) happen in week 1 alongside the reader; the build runs on sample data either way.

_[Milestone chart not included in this export: Oct 12 to Nov 22, one week each, away Nov 5–14.]_

## Risks

| Risk | Mitigation |
| --- | --- |
| Scope cuts weaken the link to the survey's top finding and to RQ2's conversational question | Say so in the report; reword RQ2 with Shyamala |
| No second person to write the test data | Recruit this week; otherwise note the limitation |
| Results vary between runs | Report it as a finding |
| Atlassian Rovo already does this | Re-check in Week 6 |
| Few TPMs in the survey | Validate the problem with 2–3 TPM interviews; note the limitation in the report |
| Dropping usability testing leaves RQ3 and the proposal's evaluation objective unanswered | Agree the change with Shyamala; report evaluation as future work |
| The dashboard and run history add scope, against the professor's advice to keep an achievable MVP | Build the dashboard from saved runs only; if time is short, ship the latest status first and add history after the MVP |

## Open questions

- [ ] Who writes the sample POR, checklist and org map?
- [ ] How should RQ2 be reworded?
- [ ] GUI host: existing program-management-tool codebase or a new page?
