# PRD — Throughline

Oct 25, 2026 · @Lisa

## Summary

An agent that reads a project's plan and the tools its teams already use, then tells the owner who to involve, what's missing and what to do next. It checks what the project's files and connections allow, with no stage to choose: who to involve from a PRD, who is actually on the work once Jira is connected, and whether each team is ready to launch: from the PRD's commitments and Jira, or against a plan of record and launch checklist when the company has them. Its core, and this semester's MVP, is the launch review: it checks a release's Jira work against its plan of record (POR) and launch checklist, lists the gaps with owners and evidence, gives a next action for each, and tracks each team's status across review runs. This semester: a working prototype on sample data. The completed prototype is the deliverable; there is no usability testing.

**Revised Oct 25** after Professor Prayaga's review of the prototype: added onboarding, plan files in any format, "Connect your apps" in place of Jira-only, a stage-aware flow, and next actions on every result.

**Revised Nov 22, later** (repo copy): launch readiness no longer needs a plan of record, which not every company writes. With a PRD and Jira, each team is read as ready, at risk, blocking or can't tell from what the PRD commits it to; a plan of record or launch checklist is optional and adds dated items. See "Launch readiness without a plan of record".

**Revised Nov 22** (repo copy): no stages. The person adds what they have; each file is read for what it is (a PRD for the sentences that imply a team or an approval, a plan of record and launch checklist for what they commit to), and every check those files and connections allow runs as one review. The phase shown (just starting, building, preparing to launch) is read from the evidence, never chosen.

**Revised Nov 21** (repo copy): renamed from Release Readiness Review to **Throughline**: the PM's view of a project from PRD to launch, keeping the plan and the tickets telling the same story, with a coding agent such as Devin doing the reading. The skills are now `throughline` (the entry skill) and `throughline-reader`, `-analyzer`, `-status`, `-starter`.

**Revised Oct 30** (repo copy): the early-stage path (R17) and the building-stage path (R18) were built ahead of plan as the `throughline-starter` skill, on placeholder sample data (a PRD, a directory export) with their own answer key. Both are rule-based (`skills/throughline-starter/templates/signals.yaml`); the employee directory is a file export, not a live connector.

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

There is no stage to pick. Each check runs once what it needs is here, and they run together as one review, with every team's results on one card:

| Check | Needs | Gives |
|---|---|---|
| Who to involve | A PRD or one-pager (the employee directory adds names) | Teams to involve, with why and when; a likely contact per team; a stakeholder map; approvals they'll need; first actions |
| Who is on the work | The same, plus Jira and the epic the work is tracked in | Teams missing from the work; approvals not started or without an owner; next actions |
| Ready to launch | The same as above, once the PM asks for it; the launch date comes from the epic's release date | Each team ready, at risk, blocking or can't tell, with why; the project's answer is its worst team |
| What is missing for launch | Optional: a plan of record or launch checklist, plus Jira and the epic; a team list sharpens it | The launch review above: dated findings with evidence, team status across runs, next actions |

## Scope

**MVP (locked by Nov 4):** the launch review. Onboarding that explains the tool, what counts as a plan, and asks the project's stage; plan files in any format (doc, slides, spreadsheet, PDF), with a POR required and a launch checklist and team list optional (since Nov 22 a POR is optional: see "Launch readiness without a plan of record"); "Connect your apps", where apps the company allows can be connected and the rest are greyed out (Jira works; others are shown only); process, cross-team date and commitment gaps; linkage gaps between the epic and other teams' tickets; evidence, strength and a next action on every finding; one review screen over saved runs that combines findings and team status, with history across runs; an answer key for each sample release.

**Built Oct 30, ahead of the Nov 16–22 slot:** the early-stage path — suggest teams, contacts and approvals from a PRD plus an employee directory — and the building-stage path (teams missing from the Jira work; approvals not started or without an owner). Nov 16–22 now goes to evaluating both on a second sample release and fixing what the evaluation finds.

**Designed only (prototype):** connectors other than Jira and the employee directory (shown in the gallery, not connectable).

**Out this semester:** usability testing; meeting notes, Slack and email; follow-up chat; other gap types (coverage, ownership, assumption drift); briefs for other roles; writing to Jira; multi-release rollup; plugin packaging; Glean and Asana; real company data.

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
| R14 | Onboarding: say what the tool does and what counts as a plan (PRD, one-pager, POR deck, brief, checklist; any format, no template), and say what each kind of file lets the review check; there is no stage to choose |
| R15 | Connect your apps: a gallery grouped by kind (work tracking, docs, product planning, people and org, chat); apps the company allows can be connected read-only, others are greyed out; Jira marked required only when a plan of record asks for the launch check (readiness without one needs Jira too, but only once the PM asks for it). Jira and the employee directory work; others are shown only |
| R16 | Next actions: every finding carries one (who, what, by when, why), and every result keeps the user's next actions in view beside it, each marked done on its team's card |
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

## Commitments: one list the checks share (first slice built, Nov 2026)

Each project keeps one running list of commitments: the teams, approvals, deliverables and launch checks it has promised. Every stage reads that list and adds to it, so a launch finding can say how long something has been owed. Today each stage works everything out again from its own files: the building stage recomputes teams and approvals from the PRD's signals, launch compares only the POR and checklist with Jira, and decisions are saved per run. The project moves forward, but what it learned does not come with it. That is the gap between the name and the product.

**What a commitment holds.** One entry in `commitments.yaml` in the project folder, beside `teams.yaml`. It belongs to the project, not to a run.

| Field | What it holds | Example |
| --- | --- | --- |
| id | Stable for the project's life; never reused | `c-007` |
| kind | team, approval, deliverable, dependency, launch check | approval |
| what | The promise in plain words | Security review approved |
| team · owner | The team that owes it; a person once the directory or Jira names one | Security · Jordan Blake |
| due | A date, or a phrase until a later plan dates it | before launch → Nov 20 |
| first seen | Stage, date and file it was first written down in | Starting · PRD §2 Scope |
| sources | Every quote that backs it, across all files, each checked against its original | PRD §2, POR §4 |
| ticket | The Jira key it is tracked by, and how it was matched | SEC-881 · linked to the epic |
| state | Proposed, open, tracked, done or dropped (lifecycle below) | tracked |
| decision | The PM's call and reason; it holds until the PM changes it | kept · Nov 13 |
| history | One line per review that changed it | Nov 13: still In Review, 7 days to launch |

**How each check reads and writes it (the checks were stages until Nov 22).**

| Stage | Proposes | Checks | Example result |
| --- | --- | --- | --- |
| Starting | Teams and approvals from the PRD's signals | Nothing in Jira yet; who the directory names | Security review needed (PRD §2 Scope) |
| Building | Deliverables and dependencies from the plan | Each open team and approval against Jira: is there a ticket, an owner, a team on the work | Security review: no ticket yet, flagged |
| Preparing to launch | Launch checks from the checklist; dated items from the POR, when there is one | Every open commitment against its ticket, its due date and launch; with no POR, each team's commitments against Jira | Security approval still open: needed since the PRD (§2 Scope), SEC-881 In Review |

**Rules that keep the list trustworthy.**

- **Readings propose; the PM confirms.** A reading (Devin, another agent, or the rules) only proposes items. The confirm step shows each proposal as already on the list, new, or possibly the same as an existing item. Nothing merges silently.
- **Matching.** A proposal matches an existing item when they share a Jira ticket, or have the same kind and team and close wording. Anything weaker goes to the PM as a question.
- **Never deleted.** A dropped item stays with its reason, so it is not proposed again and the history shows why.
- **Decisions follow the item, not the run.** A dismissal in building still holds at launch. Each review's findings point at commitment ids, and the run keeps a copy of the list as it stood.
- **Agents never edit the list directly.** They write proposals into the folder; the rules check every quote and apply only what the PM confirmed, as they already do for readings.

**The life of one commitment.**

Lifecycle (diagram in the live doc): Proposed (from a reading) → Open (confirmed, no ticket) → Tracked (a ticket carries it) → Done (kept in history). The PM confirms Proposed → Open; a review moves Open → Tracked when a Jira ticket is found and Tracked → Done when it is resolved. From Proposed, Open or Tracked the PM can dismiss an item to Dropped, with a reason; it is never proposed again. Readings propose; only the PM puts a commitment on the list or takes it off.

Reviews move items only along the top row, when Jira shows a ticket or a resolution. Open and tracked items also get flags on each review (late, no owner, claimed in a comment only), and those flags are the findings.

**What changes in the build.** The smallest useful slice is teams and approvals carried from starting to launch; deliverables and launch checks follow. Built Nov 21: steps 1 to 6 for teams and approvals, plus one rule found while building: a team or approval an earlier stage named that the launch plan leaves out is flagged "not in the launch plan". On the ingestion sample that flags six teams and four approvals the PRD named and the POR dropped.

1. A `Commitment` schema and `commitments.yaml` in the project folder; each run keeps a copy of the list as it stood.
2. A merge step after every reading: proposals come back as matched, new or ask-the-PM, and the confirm step on Your plan shows those three groups.
3. Building coverage and the launch analyzer read the open commitments as well as the files; every finding carries a commitment id and its first-seen date.
4. Decisions keyed by commitment id instead of run; existing per-run decisions are moved over once.
5. The overview shows the list's count (open, at risk, new since the last review) and a per-team list one click away.
6. `AGENTS.md`: agents write proposals and never edit `commitments.yaml`.

**Done when,** on the ingestion sample: the launch finding for the Security approval says it was first seen in the PRD; an item dismissed while building does not come back at launch; and a refresh with no new files changes nothing on the list.

**Open questions.**

- [ ] Does a resolved Jira ticket close a commitment by itself, or does the PM confirm done?
- [ ] Can a PM add a commitment by hand, such as one agreed in a meeting (today's known miss)?
- [ ] Who judges close wording: the rules alone, or the agent proposes matches and the rules check them?
- [ ] Does work found only in Jira, promised in no plan, become a commitment, or stay under related tickets?

## Launch readiness without a plan of record (built Nov 22)

A plan of record is not a thing at every company. Many teams ship from a PRD, an epic and a release date, so the launch check can't depend on one. It needs three things, and most projects have them without a POR:

1. **What each team owes.** The commitments list already holds this: the teams the PRD involves and the sign-offs it asks of them. A POR or checklist, when there is one, adds items and dates to the same list.
2. **When it launches.** The epic's release date or fix version in Jira, then a date the PRD names. Without one, readiness still works, but nothing can be late.
3. **Whether each team is done.** The Jira coverage check already answers this per team and per sign-off.

**Rules.** The rules are fixed; no model rates a team. Anything the PM dropped, or whose PRD signal they unticked, is left out.

| Team | When |
| --- | --- |
| Blocking | Nobody from the team is on the work, or a sign-off it owes has not started or has no owner |
| At risk | A sign-off is in progress |
| Can't tell | Jira can't show whether the team is on the work |
| Ready | On the work, and every sign-off it owes is done |

The project's answer is its worst team: "Launch Nov 20: not ready". On the ingestion sample, 2 of 9 teams are ready (Data Platform, SRE), Security is at risk (SEC-881 In Review) and six block, QA among them (nobody on the work, and INGEST-170 has no owner).

**Why not the launch review on synthesized items.** The first build made plan items from the commitments and ran the POR analyzer on them. It gave wrong answers: items of teams with no Jira project were counted as Data Platform's, and "Privacy review" and "Legal review" matched Security's SEC-881 on the word "review". Short PRD sign-offs need the coverage check's per-approval search, so readiness reads that.

**In the product.** Once Jira and the epic are in, the suggestion is "Ready to launch?" with **Check launch readiness**, and "Add a launch checklist" as a quieter link. Checking turns readiness on for the project. The review becomes the readiness view, with teams grouped Blocking, At risk, Can't tell, Ready, and Dropped (still reopenable). Each card has a Launch line saying why. The phase reads Preparing to launch, and History records "Launch readiness · INGEST-142". A launch checklist or plan of record, added from the same dialog, switches to the full launch review with dated items.

**Limits.** Without written commitments, "ready" means "Jira shows the work and the sign-offs done", not "every team did what it agreed to". The page says it was checked against the PRD and Jira. With no launch date anywhere, the heading has no date. A past readiness record counts teams the PM dropped later.

**Open questions.**

- [ ] Should readiness turn on by itself as the launch date nears, rather than when the PM asks?
- [ ] Can the PM set or correct the launch date when Jira has none?
- [ ] Should a company's standard launch checklist live at the organisation level, so every project gets it without a POR?

## Direction: a project folder any coding agent can work in (Nov 2026)

The GUI makes a coding agent useful to a PM who is not technical. Each project is real files in a folder that is its own repository: settings, the original documents, every reading and review, a plain-English history, and instructions for any coding agent. The agent reads the documents and makes the judgment calls; the rules check every quote against the original and check the plan against Jira, so a refresh costs nothing and does not vary. Devin reads automatically through its API, and any major coding agent (Claude Code, Codex, Cursor, Copilot, Gemini CLI, or Devin opened on the folder) can do the reading in the folder by its AGENTS.md. The organisation's directory never enters a project: it lists teams and their Jira projects, not people. Git stays hidden. Prompt injection is met by telling every agent the documents are data, flagging text addressed to an AI, giving reading sessions no repository or credentials, letting an agent write one file and undoing anything else, checking every quote outside the agent, and the PM confirming the plan.

This semester the working build is the deliverable, and the folder contract runs on local disk as a demonstration (a folder per project, a git repository with a commit per save when git is installed). The hosted version (a GitHub App that creates a private repository per project, branch-only agent writes merged through a path guard) is the plan; its setup and risks are in `docs/project-folders.md`. The main risks: a planted but genuine-looking sentence in a document passes the quote check; originals in git are hard to erase; one repository per project needs naming, archiving and access rules; and the GitHub App needs an organisation admin's approval.

## How it works

Devin runs the orchestrator on each dated snapshot of a sample release (reader → analyzer → status) and saves each run as JSON; the GUI loads the runs in order, so the review screen shows the latest status and how it changed. The GUI asks for no stage: it reads each file for what it is, runs every check the files and connections allow as one review, and ends in next actions. The agent reads the plan files itself, in any format (a POR deck, a PDF, a PRD in Word), and writes the plan items and signals, each with a quote; the command checks the quotes against every file it can read, marks the rest unchecked for the TPM to confirm, and adds the structured parts it can parse. Which items are gaps, and what a signal implies, stays rule-based. The reading runs on the agent's own model and credits (Devin's), so the product needs no model API key; from the GUI, the server starts the Devin session through the company's service-user key. Skills are plain `SKILL.md` files, so they can move to another agent. Details: Dependency Review Skills — Design (Devin + Jira) (`docs/skills-design.md`; where they disagree, this PRD wins).

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
| Without a POR, "ready" rests on Jira alone | Say on the page that readiness was checked against the PRD and Jira; offer a launch checklist, never require it |
| POR formats vary widely (slides, docs, spreadsheets) | Read slide decks first, test them against the markdown POR, and keep every plan item tied to a source quote the TPM confirms |

## Parked ideas

Not this semester. The test for a new idea: does it help a PM see, or act on, where the plan and the tickets disagree? If not, it goes here.

| Idea | Why parked | Smallest version that fits |
| --- | --- | --- |
| Our own chat around the agent | Competes with Devin's own interface, Slack and the IDE; Throughline's strength is that the PM never prompts | "Ask about this project": opens a Devin session already pointed at the project folder, then hands off to Devin's UI |
| Cover the PM skills in pm-workflow (10 workflows, 39 skills, ideation to measurement) | One PM's own work, while Throughline covers the work between teams; they overlap only at the PRD stage and launch | Put the skills beside a project folder's files, since any agent already works there; no integration |

## Open questions

- [ ] Who writes the sample POR, checklist and org map?
- [ ] How should RQ2 be reworded?
- [ ] GUI host: existing program-management-tool codebase or a new page?
- [ ] One adaptive flow for the three stages, or separate entry points? (Answered Nov 22: neither. There are no stages; the review checks what the files and connections allow.)
- [ ] Which employee directory source is realistic for the early-stage path, and is a sample directory enough for this semester? (Answered Nov 2026, see Employee directory sources: a sample export this semester; then Atlassian Teams and Microsoft Graph, both behind sign-ins the product already has.)
