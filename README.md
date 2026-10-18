# Release Readiness Review

Prototype for a CMU independent study: an agent skill that reads a release's plan of record and its
Jira epic, and a GUI that shows the gaps between them. Sample data only; see `docs/PRD.md`.

```
docs/                  PRD, clickable-prototype source (read as a spec), earlier skills design
packages/schemas/      zod schemas + TypeScript types shared by the skill and the GUI
skills/release-reader/ the reader skill: SKILL.md, helper scripts, reference, tests
fixtures/ingest-142/   sample plan files, sample Jira snapshots, and the reader's outputs
runs/INGEST-142/       saved runs the GUI loads: { plan, target, release, findings, linkage_gaps, teams }
gui/                   Vite + React + TypeScript web app (three steps: plan documents → connect Jira → review)
scripts/build-runs.ts  assembles runs/ from reader output + hand-written analysis
```

Setup: Node 22+, then `npm install` at the root (one workspace).

## The release-reader skill

Three stages, each a script under `skills/release-reader/scripts/`, each runnable alone. The
person confirms the output of A and B before the next stage. Full instructions for an agent are in
`skills/release-reader/SKILL.md`; the Atlassian MCP tool names are in `reference/mcp-tools.md`.

Fixture mode (no Jira):

```
D=fixtures/ingest-142
npx tsx skills/release-reader/scripts/extract-plan.ts --files $D/docs/Ingestion-service-POR-v3.md $D/docs/launch-checklist.csv $D/docs/team-list.yaml --out plan-draft.json
npx tsx skills/release-reader/scripts/resolve-release.ts --plan plan-draft.json --source fixture --dir $D/jira/2026-11-13 --out release-target.json
npx tsx skills/release-reader/scripts/read-jira.ts --plan plan-draft.json --target release-target.json --source fixture --dir $D/jira/2026-11-13 --out release.json
```

MCP mode (real Jira, read-only): the same commands with `--source mcp --dir .mcp-cache/<label>
--cloud-id <id>`. The scripts never call the MCP server themselves. When a response is missing they
write `<dir>/requests.json` and exit with code 3; the agent runs those read calls through the
Atlassian MCP server, saves each raw response where `save_as` says, and re-runs. Both modes read the
same file layout, so the logic is identical.

Options worth knowing: `--read-as file=plan_items|launch_checks|teams_and_owners` overrides file
detection; `--agent-items items.json` adds items the agent extracted from prose (each must quote
the source file or it is dropped); `--epic KEY` picks the epic; `--no-search TEAM` skips a team's
scoped search; `--label` names the snapshot.

Tests: `npm test` (31 tests: the required Stage A/B/C cases, repeatability, the MCP request loop).

Regenerate fixtures: `npm run build:jira-fixtures` (Jira snapshots from `fixtures/ingest-142/jira/generate.ts`),
then the three stage commands above with `--out` into `fixtures/ingest-142/` (the committed
`plan-draft*.json`, `release-target*.json`, `release.<snapshot>.json`), then `npm run build:runs`.

## The GUI

```
npm run gui:dev      # http://localhost:5173
npm run gui:test     # unit tests: status roll-up, weak filter, 10-finding cap, "all teams resolved" gate
npm run gui:e2e      # Playwright: all three steps, including resolving the ambiguous Security team (desktop + phone)
npm run gui:build
```

First e2e run: `npx playwright install chromium` inside `gui/`.

The GUI works from saved files behind three interfaces in `gui/src/backend/types.ts`:

- `ReviewBackend` (`fixtureBackend.ts`): loads `fixtures/ingest-142/plan-draft*.json`,
  `release-target*.json` and `runs/INGEST-142/*.json`. A live agent replaces this class.
- `JiraConnection` (`stubJira.ts`): the simulated Atlassian consent flow.
- `DecisionStore` (`decisionStore.ts`): keep/dismiss decisions and the decision log, per run, in localStorage.

Add `?fast=1` to the URL to shorten the simulated delays.

## What is stubbed, and what is real

Real: the three reader stages and their outputs; the Jira snapshot data and the JQL evaluator; the
`plan`, `target` and `release` parts of each saved run (produced by the reader from the fixtures);
every number and label the GUI shows, which comes from those files.

Stubbed or hand-written:

- **File parsing in the GUI.** Any upload is treated as the sample files: a file read as plan items
  gives the fixture plan, a file read as launch checks adds its checklist items, a file read as
  teams and owners adds the team list (and makes every team resolve). Real parsing is Stage A.
- **Jira in the GUI.** OAuth is simulated; the epic lookup only knows INGEST-142; the Jira project
  table comes from the fixture `release-target.json` (with or without the team list).
- **Running the review.** Progress is animated, then the latest saved run is loaded.
- **The analyzer and status skills.** They do not exist yet. `findings`, `linkage_gaps` and `teams` in
  `runs/INGEST-142/analysis/*.json` are hand-written to match the prototype and validated against the
  `Finding`, `LinkageGap` and `Team` schemas in `packages/schemas`, which is what those skills must produce.
- **The sample data.** The POR, checklist, team list and Jira snapshots are placeholders written by
  the tool author; PRD R12 says the real ones are written by someone else.
- **Atlassian MCP tool names.** Taken from Atlassian's documentation; the skill tells the agent to
  confirm them against the server before the first call.
