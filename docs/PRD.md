# PRD — Release Readiness Review Skills

Oct 25, 2026 · @Lisa

## Summary

An agent that reads a project's plan and the tools its teams already use, then tells the owner who to involve, what's missing and what to do next. It adapts to the project's stage: just starting, building, or preparing to launch. Its core, and this semester's MVP, is the launch review: it checks a release's Jira work against its plan of record (POR) and launch checklist, lists the gaps with owners and evidence, gives a next action for each, and tracks each team's status across review runs. This semester: a working prototype on sample data. The completed prototype is the deliverable; there is no usability testing.

**Revised Oct 25** after Professor Prayaga's review of the prototype: added onboarding, plan files in any format, "Connect your apps" in place of Jira-only, a stage-aware flow, and next actions on every result.

**Revised Oct 30** (repo copy): the early-stage path (R17) and the building-stage path (R18) were built ahead of plan as the `release-starter` skill, on placeholder sample data (a PRD, a directory export) with their own answer key. Both are rule-based (`skills/release-starter/templates/signals.yaml`); the employee directory is a file export, not a live connector.

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

**Earlier stages too:** many PMs start with no team, no Jira and no contacts. Example from the advisor review: a PM assigned to four evaluations with no existing team. They need to know who to involve and which approvals they'll need long before any launch review. Plans also vary widely: a POR is often a slide deck, not a structured doc.

## 2. Job to be done

**When** a launch review is a week out and I have to tell leadership whether we're on track, **I want to** see every gap between the plan and the actual work, with owners and sources, **so I can** chase the right people while there's still time and give a status I can defend. **But first** I need to trust the list: every item shows its source, and nothing is filler.

- **Functional:** done in minutes, not an afternoon; each gap goes to the right owner.
- **Emotional:** no surprise blockers in the meeting.
- **Social:** credible with the director; no false alarms sent to engineering leads.

## User flow

1. The TPM opens the tool, reads what it does, connects the employee directory (read-only), and picks "Preparing to launch". They add the POR (a slide deck) and launch checklist, read them with Devin, see who the plan involves, confirm the plan, correcting one date, and connect Jira.
2. Four findings appear:
   - Security approval still open (process, strong).
   - A database permissions review promised in a comment, with no ticket (commitment, moderate).
   - SRE capacity due two days after launch (cross-team date, moderate).
   - No rollback plan (process, moderate).
3. They open a finding and see the plan line next to the Jira evidence.
4. They dismiss one item that doesn't apply.
5. They see team status on the same screen: Security and Data Platform are at risk, SRE is late and slipped since the last run. They go into the go/no-go at amber, with two named owners and a list of next actions.

Known miss: anything agreed only in meetings or Slack.

The same flow adapts to earlier stages:

| Stage | User adds | They get |
|---|---|---|
| Just starting | A PRD or one-pager; the employee directory | Teams to involve, with why and when; a likely contact per team; a stakeholder map; approvals they'll need; first actions |
| Building | Their plan; Jira; a team list or directory | Teams missing from the work; approvals not started or without an owner; next actions |
| Preparing to launch | POR and launch checklist; Jira and the release epic | The launch review above: findings with evidence, team status across runs, next actions |

## Scope

**MVP (locked by Nov 4):** the launch review. Onboarding that explains the tool, what counts as a plan, and asks the project's stage; plan files in any format (doc, slides, spreadsheet, PDF), with a POR required and a launch checklist and team list optional; "Connect your apps", where apps the company allows can be connected and the rest are greyed out (Jira works; others are shown only); process, cross-team date and commitment gaps; linkage gaps between the epic and other teams' tickets; evidence, strength and a next action on every finding; one review screen over saved runs that combines findings and team status, with history across runs; an answer key for each sample release.

**Built Oct 30, ahead of the Nov 16–22 slot:** the early-stage path — suggest teams, contacts and approvals from a PRD plus an employee directory — and the building-stage path (teams missing from the Jira work; approvals not started or without an owner). Nov 16–22 now goes to evaluating both on a second sample release and fixing what the evaluation finds.

**Designed only (prototype):** connectors other than Jira and the employee directory (shown in the gallery, not connectable).

**Out this semester:** usability testing; meeting notes, Slack and email; follow-up chat; other gap types (coverage, ownership, assumption drift); briefs for other roles; launch reviews without a POR; writing to Jira; multi-release rollup; plugin packaging; Glean and Asana; real company data.

## Requirements

| ID | Requirement |
|---|---|
| R1 | Extract a plan from the POR in any format, including slide decks: deliverables, owners, dates, dependencies, approvals, each with its source quote |
| R2 | TPM confirms or edits the plan before seeing findings |
| R3 | Load the launch checklist |
| R4 | Read the epic (stories, links, components, comments, due dates), then follow its issue links and comment-mentioned keys one hop into other teams' projects (status, due date, assignee), then run a scoped search of each POR team's project for unlinked matches to plan items within the release window |
| R5 | Report process, cross-team date and commitment gaps, each with an owner from a team list or directory when one is provided, otherwise inferred from Jira and marked as inferred |
| R6 | Each finding shows the expected item and the evidence found, or "none found" |
| R7 | Evidence strength: **strong** = plan or checklist item matched to a linked ticket; **moderate** = owner or match inferred; **weak** = comment text only |
| R8 | Hide weak findings by default; show at most 10 |
| R9 | Team status, on the review screen: one row per team and Jira project with status (on track / at risk / late), open gaps, next plan date and change since the last run, expandable to plan items next to their tickets; plus release status, status history across runs, and what the tool can't see |
| R10 | GUI: onboarding (R14), plan upload and confirmation, Connect your apps (R15), and one review screen with findings, keep/dismiss (logged), team status (R9) and next actions (R16) |
| R11 | Three skills (reader, analyzer, status) plus an orchestrator; each skill usable alone. The status skill rolls findings up per team and compares them with the previous run |
| R12 | Sample data and answer key: someone else writes the sample POR, checklist, org map and Jira projects, including known gaps (one is an unlinked cross-team blocker) and an answer key listing them. Each sample release has at least two dated snapshots, with known status changes between them. Devin runs each snapshot 3 times, and the output is checked against the key |
| R13 | Surface linkage gaps found in R4: a matching ticket in another team's project that isn't linked to the epic, or an issue key mentioned in a comment with no link. Each shows both tickets and the suggested link type. A linkage gap behind a finding is shown on that finding; the rest are listed in a separate "Linkage gaps" section that does not count toward the 10-finding cap |
| R14 | Onboarding: say what the tool does and what counts as a plan (PRD, one-pager, POR deck, brief, checklist; any format, no template), ask the project's stage, and list what to have ready for that stage before upload |
| R15 | Connect your apps: a gallery grouped by kind (work tracking, docs, product planning, people and org, chat); apps the company allows can be connected read-only, others are greyed out; required and recommended apps marked per stage. Jira and the employee directory work; others are shown only |
| R16 | Next actions: every finding carries one (who, what, by when, why), and every result opens with the user's next actions for their stage, which they can tick off |
| R17 | Early stage: from a PRD, list the signals that imply a team (with the quote), suggest teams to involve with why and when, a likely contact per team from the directory, a stakeholder map, and the approvals to plan for |
| R18 | Building stage: compare the teams the plan needs with the people on the Jira work, and show approvals not started or without an owner |

Constraints: sample data only. The review screen states what the tool can't see: meetings, chat and email, approvals tracked in apps that aren't connected, and whether technical work is adequate.

## Identity and connections (direction, Oct 31)

The product is built so that every action stays in the GUI and the company's accounts do the work behind it:

1. **Sign in** with the company identity provider (OpenID Connect; Microsoft Entra ID first). The server keeps a session cookie and a small store of users, connections, runs and decisions, so decisions leave the browser's local storage. A no-sign-in mode keeps the demo and the tests working.
2. **Jira through Sign in with Atlassian** (built Oct 31): OAuth 2.0 with read-only scopes instead of an API token; Atlassian's consent page opens in a popup, the tokens are stored per user encrypted at rest, refreshed before expiry, and deleted on disconnect; Jira is read through Atlassian's gateway. The API-token form remains only where no app is registered.
3. **Devin behind the upload step** (built Oct 31). A Devin service-user key held by the server, never by the person. On the Your plan step the person is asked once whether Devin may read their files; if so, each plan document is uploaded to Devin and one short session reads it with the reader skill's instructions and returns the items as structured output, which go through Stage A's quote check. Reading is cached per document, capped in ACUs per session, and falls back to the rules with the error shown. Sessions are attributed to the signed-in person once sign-in exists.
4. **Hardening** a multi-user server needs: HTTPS, an encryption key for stored tokens, OAuth state and CSRF checks, a connection audit log.

This reverses three earlier "out this semester" lines (a live GUI connected to Devin, a multi-user server, credentials beyond an API token). The Devin piece is what "agentic reading contained in the GUI" means in practice; the reading happens on Devin's credits and the product holds no model API key.

## Review feedback (Nov 2026)

Three points from the professor's review of the demo, and what changed for each:

1. **The employee directory comes first, before any document.** The tool needs the org upfront to map stakeholders from the document; without it the reading infers teams instead of grounding them in the real structure. Built: the directory connects on Get started, and its team names go into Devin's reading instructions, so owners are spelled as the company spells them (a reading is cached per directory as well as per file).
2. **A stakeholder map right after the reading.** Which teams to involve (engineering, legal, data, compliance, TPM, vendors), drawn from org charts, Confluence and wikis to surface processes the person might miss. Built: "Who this involves" follows the reading on the plan step, listing every team the plan, the checklist or the PRD's signals name, what each owns, its people, and whether a directory or team list grounds it. Confluence and wiki pages are a connector still marked not available.
3. **A progress bar while Devin reads.** Loading anxiety was visible in the demo; people need visibility into status. Built: the reading job reports a percentage and a line of status (uploading, a rise with time while the session works, the quote check), and the plan step shows them as a bar.

## Employee directory sources (research, Nov 2026)

An HR org chart and the team list the tool needs are different things. HR systems give people, titles, departments and manager chains; the tool needs teams with a Jira project, a role in the release (service team, approver, shared platform) and components. No single source holds both, so the connector is two layers, people and teams, with the file export as the fallback. Ranked by fit:

1. **Microsoft Entra ID through Microsoft Graph** (the sign-in the product already has). `User.Read.All` reads every user's profile and manager link; the user list carries `jobTitle` and `department`, and `$expand=manager` adds the manager per user, so a reporting tree is a few calls. Tenant-wide application permissions need an admin; delegated consent for the signed-in person is the realistic route, and department plus manager is usually enough to group people into teams.
2. **Google Workspace Directory API** for Google shops: `orgUnitPath` per user and a `relations` array holding the employee's `manager`. Needs an admin-granted scope, like Graph.
3. **Atlassian Teams and Jira project roles** (the Atlassian sign-in the product already has). Atlassian exposes teams through a public Teams API and a public REST API for Jira's Team field; with project leads and components from the Jira API already in use, this is the closest thing to team → Jira project → people that exists, and needs no new sign-in. Team IDs have changed over time and plan-only teams are not exposed; verify against current docs.
4. **An HRIS through a unified API** (Merge, Finch) or a native one (Workday, BambooHR, Rippling, HiBob). Merge models an Employee with a `manager` reference and Groups typed DEPARTMENT or TEAM, with webhooks for manager changes. Real products connect "the HRIS" this way, but it costs money and an HR admin's consent, which a TPM rarely has.
5. **SCIM and the identity provider** (Okta): department and manager live in the SCIM enterprise extension. Relevant mainly if the product were provisioned into the company, so lower priority.
6. **Exports and org-chart tools**: a CSV or YAML export (built), or a tool such as ChartHop or Pingboard. Always available, never fresh, the one path that needs no admin.

Phasing: directory export (built) → Jira projects as teams, through the Jira connection (built Nov 2026: each project, its lead and assignees) → Microsoft Graph delegated read for names, titles, departments and managers through the Entra sign-in (built Nov 2026: a second consent in a popup, a team per department, the snapshot stored per person) → Atlassian Teams, Google Workspace and a unified HRIS API as later options. The two built layers merge by team name into one team list the reader takes as a file. Not confirmed: Slack profile fields as a people source; whether Confluence exposes a people directory.

## A portal across the project's life (Nov 2026)

The tool is not a one-time review. It opens on the person's projects; each keeps its files, readings, epic, decisions and runs, so a return visit starts from where the project is and asks only for what changed. A project moves through its life (just starting → building → preparing to launch) from its overview, keeping its files and connections, and its history records what was added, read, reviewed and moved.

## How it works

Devin runs the orchestrator on each dated snapshot of a sample release (reader → analyzer → status) and saves each run as JSON; the GUI loads the runs in order, so the review screen shows the latest status and how it changed. The GUI asks the stage first and adapts what it asks for and what it shows; every stage ends in next actions. The agent reads the plan files itself, in any format (a POR deck, a PDF, a PRD in Word), and writes the plan items and signals, each with a quote; the command checks the quotes against every file it can read, marks the rest unchecked for the TPM to confirm, and adds the structured parts it can parse. Which items are gaps, and what a signal implies, stays rule-based. The reading runs on the agent's own model and credits (Devin's), so the product needs no model API key; from the GUI, the server starts the Devin session through the company's service-user key. Skills are plain `SKILL.md` files, so they can move to another agent. Details: Dependency Review Skills — Design (Devin + Jira) (`docs/skills-design.md`; where they disagree, this PRD wins).

## Success metrics

| Metric | Target |
|---|---|
| Known gaps found (vs. answer key) | ≥ 80% |
| Shown findings that are in the answer key (precision) | ≥ 70% |
| Unlinked cross-team blocker surfaced as a linkage gap | In all 3 runs |
| Run-to-run variation | Reported |
| Every sample release runs end to end and opens in the GUI | All releases |
| Status changes between snapshots shown correctly on the review screen | All known changes |
| Shown findings with a next action | 100% |
| Plan items extracted from the POR slide deck that match the markdown POR | All items |
| Early stage: suggested teams that are in the sample PRD's answer key | ≥ 80% |
| Building stage: team coverage and approval states as in the answer key | All |

## Milestones

The MVP is locked Nov 4, before the break, and final deliverables are due Dec 4. The GUI and the stage-aware prototype came first (Oct 12–18), so the old GUI week (Nov 16–22) now builds the early-stage path and fixes what the evaluation finds. Nov 2–4 evaluates the launch review against the answer key and freezes the saved runs; no work Nov 5–14 (away). The Phase 0 check (Devin + Atlassian MCP) runs with the reader in the Oct 19–25 week; the build runs on sample data either way.

Timeline: Oct 12 to Dec 4, MVP locked Nov 4, away Nov 5–14.

## Risks

| Risk | Mitigation |
|---|---|
| Scope cuts weaken the link to the survey's top finding and to RQ2's conversational question | Say so in the report; reword RQ2 with Shyamala |
| No second person to write the test data | Recruit this week; otherwise note the limitation |
| Results vary between runs | Report it as a finding |
| Atlassian Rovo already does this | Re-check in Week 6 |
| Few TPMs in the survey | Validate the problem with 2–3 TPM interviews; note the limitation in the report |
| Dropping usability testing leaves RQ3 and the proposal's evaluation objective unanswered | Agree the change with Shyamala; report evaluation as future work |
| The dashboard and run history add scope, against the professor's advice to keep an achievable MVP | Build the dashboard from saved runs only; if time is short, ship the latest status first and add history after the MVP |
| The stage-aware direction roughly doubles the build | Lock the MVP to the launch review by Nov 4. (Oct 30: both early paths were built as one rule-based skill; the risk is now that their sample data is the tool author's, so the second sample release matters more.) |
| Connectors beyond Jira look like promises | Build only Jira and the employee directory; show others in the gallery and say so in the report |
| POR formats vary widely (slides, docs, spreadsheets) | Read slide decks first, test them against the markdown POR, and keep every plan item tied to a source quote the TPM confirms |

## Open questions

- [ ] Who writes the sample POR, checklist and org map?
- [ ] How should RQ2 be reworded?
- [ ] GUI host: existing program-management-tool codebase or a new page?
- [ ] One adaptive flow for the three stages, or separate entry points? (Designed as one flow; confirm with Professor Prayaga.)
- [ ] Which employee directory source is realistic for the early-stage path, and is a sample directory enough for this semester? (Answered Nov 2026, see Employee directory sources: a sample export this semester; then Atlassian Teams and Microsoft Graph, both behind sign-ins the product already has.)
