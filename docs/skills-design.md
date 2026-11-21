> **Note for Claude Code (added Oct 17, 2026):** this design predates the PRD (`docs/PRD.md`). Where they disagree, the PRD wins. In particular:
> - The three skills are now **reader → analyzer → status** (R11). `readiness-brief` and the "Ask about this finding" follow-up chat are out of scope.
> - Meeting notes, Slack and email are out of scope as inputs. The reader reads Jira only (R4), including one-hop links, comment-mentioned keys and a scoped search per plan team.
> - The analyzer reports only process, cross-team date and commitment gaps (R5), plus linkage gaps (R13). Coverage, ownership and assumption-drift gaps are out of scope.
> - There is no usability study. "Study mode" and the Week 8 plan no longer apply; the build timeline is in the PRD.
> - The GUI reads saved run JSON files. It does not call Devin live.
> - The evidence-strength rules, "evidence or drop it", hidden weak findings, the 10-finding cap and the read-only Atlassian MCP approach all still apply.

# Dependency Review Skills — Design (Devin + Jira)

Oct 4, 2026 · @Lisa

## Summary

Build three small skills that each do one job, share one output format, and are chained by a thin orchestrator with a GUI — not one large skill. This follows Professor Shyamala's feedback and the Shared Atlas pattern: separate pieces, unified in one interface, linked by shared data rather than by calling each other.

- **Use case:** a TPM, engineering lead or product lead reviews an epic or release before launch against its plan of record (POR) and the company launch checklist, and gets the gaps between plan and reality, each with evidence, an owning team and an evidence-strength level. Stories are read as evidence, not reviewed one by one.
- **Sources:** Jira (epics, stories, links, components) plus meeting notes, because the survey's top missed signal was dependencies mentioned but never tracked (75%).
- **Test setup:** Devin as the agent, connected to Jira. Skills are plain markdown plus a shared format, so they stay portable to other agents.
- **Differentiator:** business-process and technical dependencies, untracked mentions, and evidence-based strength levels, which none of the Week 2 competitors show. To be re-checked against Atlassian Rovo in Week 6.
- **"Plug-and-play" means install only:** the plugin installs in one step, but value depends on an org map someone maintains.
- **Status:** design only, revised after a red-team review (see Red-team review).

## How skills and Jira connect in Devin

A skill holds no Jira connection of its own; it tells Devin which tools to use, and the connection comes from an MCP server or Devin's native Jira integration. That answers Professor Shyamala's concern: connectivity is a separate layer, and Phase 0 tests it before any skill logic is written.

| Piece | What it is in Devin | Role in this design |
| --- | --- | --- |
| [Skill](https://docs.devin.ai/product-guides/skills) | A `SKILL.md` file (frontmatter: `name`, `description`, optional `allowed-tools`, `triggers`) in a repo, e.g. `.agents/skills/<name>/SKILL.md`. Auto-invoked when relevant, or called with `@skills:<name>` | Each of the three skills and the orchestrator. Same file format as Claude skills, so they stay portable |
| [Plugin](https://docs.devin.ai/product-guides/plugins) | Bundles skills plus optional rules, hooks, MCP servers and subagents; installed at personal, org or enterprise scope; skills appear as `/<plugin>:<skill>` | The plug-and-play package: all four skills + the Atlassian MCP config |
| [MCP marketplace](https://docs.devin.ai/work-with-devin/mcp) | Customize → MCPs; Atlassian is listed; custom servers need the Manage MCP Servers permission | Reads Jira: epics, stories, links, components, JQL search, Confluence meeting pages |
| [Native Jira integration](https://docs.devin.ai/integrations/jira) | Reads summary, description and comments; posts comments; a session starts on assignment, a `devin` label or an @mention. Jira Cloud only, one site per account, needs a Jira admin | The trigger ("review this release") and posting findings back as a comment |
| [API + structured output](https://docs.devin.ai/api-reference/v1/structured-output) | Create sessions by API; Devin fills a JSON schema given in the prompt, read from `structured_output` by polling (10–30 s) | How the GUI orchestrator drives Devin and gets findings back |

Two things to confirm early: whether your company's Devin org already has the Atlassian MCP installed (or who holds the admin permission), and whether you may point it at a sandbox Jira project rather than live team data.

## Architecture

_[Architecture diagram not included in this export: entry points, orchestrator, three skills, shared formats, data sources.]_

Either entry point runs the same orchestrator; the skills exchange Releases and Findings, and only the bottom layer touches Jira.

## The skills

Three skills plus an orchestrator, each usable alone in a Devin session. The unit of review is an epic or release (a Jira fix version); stories inside it are read as evidence, so a small copy change is never checked for a monitoring plan.

| Skill | Job | Input → output | Works alone? |
| --- | --- | --- | --- |
| **throughline-reader** | Reads the POR and extracts a Plan (deliverables, owners, dates, declared dependencies, approvals, assumptions) for the TPM to confirm; loads the launch checklist; pulls the epic or fix version with child stories, links, components, comments and meeting notes | POR + epic key → Plan + checklist + Release | "What does the plan for the Q4 ingestion launch say?" |
| **throughline-analyzer** | Compares expected (Plan + checklist) with found (Release) and reports six gap types: coverage, date, process, commitment, ownership, assumption drift. Tags each with Stray's dependency type and an owner from the org map | Plan + checklist + Release + org map → Findings | "What doesn't match the plan?" |
| **readiness-brief** | Rolls findings up for one audience (TPM, eng lead, product lead) and answers follow-up questions about a finding using only its cited evidence | Findings → brief, or a question → answer | "Brief the eng lead" · "Why is Data Platform on this list?" |

If no POR exists, throughline-reader falls back to the epic description and the checklist, and throughline-analyzer reports "no plan of record" as a finding. The review cannot judge whether technical work is adequate, see Slack or DMs, or tell whether "Done" is really done; the brief says so.

The shared format means throughline-analyzer can later split into gap-check, dep-finder and org-context without touching the other skills. Only throughline-reader calls Jira tools; the other two work on data handed to them. Each `SKILL.md` stays short, with checklists, the Stray taxonomy and worked examples in reference files beside it.

**Meeting notes as a second source.** The top AI capability respondents asked for was extracting dependencies from meetings, messages and docs (62.5%). throughline-reader takes meeting notes from Confluence meeting pages (through the Atlassian MCP) or, in the study, from sample text files. Slack and email stay out of scope: no confirmed access through Devin, and meeting notes cover the same "said but not tracked" signal.

**Org map, built by someone else.** throughline-analyzer reads an `org-map.yaml` (teams, owners, components, approvers). To avoid testing data against itself, a classmate or colleague builds it from a realistic org chart before you write the sample releases; seeded dependencies follow their ownership map, not yours. A Glean or Confluence source can replace the file later without changing the output. The pitch no longer says "Glean-style"; the org map is named as a limitation.

## Shared contract

Skills never call each other; they read and write four shared formats (Plan, Checklist, Release, Finding). The same Finding schema goes into Devin's structured output, so the GUI receives it directly.

```json
Plan {                          // from the POR, confirmed by the TPM
  source_url, launch_date, confirmed_by,
  deliverables[{name, owner_team, due}],
  declared_dependencies[{from_team, to_team, what, need_by}],
  required_approvals[], assumptions[]
}

Checklist { launch_type, items[{id, requirement, owner_team}] }

Release {
  key, title, target_date, status,
  items[{key, title, description, acceptance_criteria[], components[],
         labels[], status, due, links[{type, key, status}],
         comments[{author, date, text}]}],
  meeting_notes[{title, date, url, text}],
  source: "jira" | "sample"
}

Finding {
  id, release,
  gap_type: "coverage" | "date" | "process" | "commitment" | "ownership" | "assumption_drift",
  dependency_type,              // one of Stray's 8 types
  claim,                        // "Prod DB permissions review has no ticket"
  team, owner,
  expected: {source, url, quote} | null,   // Plan line or checklist item
  found[{source, url, quote}],             // empty = nothing found
  evidence_strength: "strong" | "moderate" | "weak",
  strength_rule, suggested_action,
  status: "open" | "accepted" | "dismissed"
}
```

**Evidence strength is set by rule, not by the model rating itself.** This is what the study tests for RQ2b, without claiming calibration.

| Level | Rule | Example |
| --- | --- | --- |
| Strong | Both sides explicit: a Plan line or checklist item matched to a linked ticket, or to a note naming an owner or ticket | Checklist needs Security approval; ticket SEC-41 linked, still open |
| Moderate | One side inferred: owner from the org map, or a ticket matched by content rather than a link | Sync note mentions prod DB permissions; owner Data Platform from the org map |
| Weak | Inferred from free text only | "We should check with support" in a comment |

Two more rules, both aimed at the survey's top distrust driver (irrelevant alerts, 68.8%):

- **Evidence or drop it.** A finding with no cited source is discarded.
- **Precision over volume.** Weak findings are hidden by default, and at most 10 findings show per release (a starting value, tuned in the pilot).

## Orchestrator and GUI

The orchestrator is a thin fourth skill (`review-release`) that runs throughline-reader, pauses for the TPM to confirm the extracted Plan (in the GUI; the Jira-label path uses the unconfirmed Plan and says so), then runs throughline-analyzer → readiness-brief; the GUI is a separate web app that starts Devin sessions by API and is where the conversation happens.

**Two ways in, same skills:**

1. **Inside Jira (no GUI).** Someone adds the `devin` label to an epic; Devin runs `review-release` and posts the brief as a Jira comment.
2. **Through the GUI.** The app calls `POST /sessions` with a prompt like `@skills:review-release CHK-Q4` plus the Finding schema, then polls `structured_output` every 10–30 seconds. Your existing program-management-tool codebase (frontend/backend/bridge) could host it.

**Three GUI screens:**

- **Release view:** the confirmed Plan at the top, then findings grouped by gap type, with evidence-strength badges and evidence links; weak findings behind "show more."
- **Finding detail + conversation:** the evidence, the strength rule that applied, accept/dismiss, and an **"Ask about this finding"** box ("Why is Payments involved?", "What happens if this slips a week?"). This is the conversational surface RQ2 studies.
- **Launch rollup:** teams involved, open gaps, date risk.

**Where follow-up answers come from.** In live use, a question goes to the same Devin session as a message. In the study, a fast model answers using only the frozen finding and its source excerpts, so answers come in seconds and can't change the seeded findings (see Study mode).

**Fallbacks if Phase 0 fails:**

- If a skill can't reliably run other skills, the GUI's prompt names them in order ("run `@skills:throughline-reader`, then …"); `review-release` becomes a prompt template, not a skill.
- If structured output updates too unpredictably, `readiness-brief` ends by posting the findings as one JSON message, which the GUI parses when the session finishes.

Accept/dismiss and follow-up questions are logged by the GUI; that log doubles as study data on precision and on what users want explained.

## Study mode

Week 8 tests the interface on frozen Devin output, not on live Devin, because live runs vary and take minutes. The live Jira connection is reported separately as a feasibility result.

1. **Sample data.** Two or three sample releases, each with a POR, a launch checklist, stories and meeting notes. The POR, checklist and org map are written by someone other than you, so the seeded gaps aren't tested against your own writing. No company data.
2. **Run Devin ahead of time.** Run each sample release through `review-release` three times and record how much the findings differ between runs. That variation is itself a finding for the report.
3. **Freeze one run.** Pick one run per release as the frozen finding set, with the confirmed Plan saved alongside it.
4. **Seed errors in the frozen set.** Add one false dependency (for RAIR) and remove one real blocker (for RSR), as RQ3 requires.
5. **Same for everyone.** Every participant sees the same Plan and the same frozen findings; follow-up questions are answered from that set only.

## Build plan

Phase 0 runs first in Week 6 because approvals run on other people's schedules and every later phase depends on the Devin checks.

1. **Phase 0, approvals and checks (Week 6, Oct 5–11, \~3 h).**
   - Ask your employer whether you may use Devin and a sandbox Jira project for a CMU study; ask Shyamala whether Week 8 needs IRB review.
   - Ask a classmate or colleague to build `org-map.yaml`.
   - In Devin: fetch one epic with its child stories, links and components through the Atlassian MCP (pass = 5 of 5 runs). Confirm the `devin` label trigger and comment posting.
   - Test whether one skill can run another, and whether structured output updates reliably. Each has a fallback (see Orchestrator and GUI).
   - Re-check Atlassian Rovo and Teamwork Graph (\~1 h) and update the differentiator if needed.
2. **Phase 1 (Week 6).** throughline-reader + throughline-analyzer on sample data.
3. **Phase 2 (Week 7, Oct 12–18).** readiness-brief, `review-release`, and the GUI with the follow-up box.
4. **Phase 3 (end of Week 7).** Run Devin three times per sample release, freeze one run, seed the errors, pilot with one person.
5. **Week 8 (Oct 19–25).** Usability testing on the frozen set.
6. **After testing (optional).** Package the skills plus the Atlassian MCP config as one Devin plugin.

If Phase 0's Jira check fails (no MCP access or no approval), the study runs entirely on sample data and the live connection is described as designed, not tested.

## Risks and open decisions

The remaining risks are mostly about access and other people's time; the design risks from the red-team review are addressed above.

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Approvals are slow | The Atlassian MCP needs Manage MCP Servers; the native integration needs a Jira admin; the employer and IRB may need to sign off | Ask on day 1 of Week 6; sample data as fallback |
| Org-map builder unavailable | Without a second person, the org map is circular again | Line someone up in Week 6; if no one is free, name it as a limitation |
| Two models in the study | Follow-ups use a fast model, findings came from Devin | State it in the method; both see only the same frozen evidence |
| Run-to-run variation is high | Shows the live agent isn't stable enough to trust | Report it as a finding; it supports the evidence-strength design |
| Rovo overlap | Atlassian may already ship much of this inside Jira | Week 6 re-check; lead with untracked mentions and evidence strength |
| Plug-and-play overstated | The org map is the real setup cost | Claim covers install only; setup cost named in the report |
| Skill auto-triggering | Devin may fire the wrong skill | `triggers: ["user"]` on all but `review-release` |

**Decisions for you:**

- [ ] Who builds the org map?
- [ ] Are you comfortable with a fast model answering follow-ups in the study, or would you rather use scripted answers?
- [ ] Sandbox Jira project, or read-only access to a real one (for Phase 0 only)?
- [ ] GUI host: your existing program-management-tool codebase, or a new light web page?

## Sources

- [Devin docs: Skills](https://docs.devin.ai/product-guides/skills)
- [Devin docs: Plugins](https://docs.devin.ai/product-guides/plugins)
- [Devin docs: MCP marketplace](https://docs.devin.ai/work-with-devin/mcp)
- [Devin docs: Jira integration](https://docs.devin.ai/integrations/jira)
- [Devin docs: Structured output](https://docs.devin.ai/api-reference/v1/structured-output)
- [Devin docs: API overview](https://docs.devin.ai/api-reference/overview)
