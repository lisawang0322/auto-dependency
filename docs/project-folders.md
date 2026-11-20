# A project folder any coding agent can work in

Direction, November 2026. Part of the PRD ("Direction: a project folder any coding agent can work in"); where they
disagree, the PRD wins.

The product is a GUI that makes a coding agent useful to a product or program manager who is not technical. The
project lives as real files, in a folder that is its own repository, so the PM, their coding agent and anyone they
share it with see the same thing. The GUI turns the PM's clicks into files, has an agent read the documents, and has
the rules check what was read and check the work in Jira.

## Decisions

| Question | Decision |
|---|---|
| Who does what | The agent reads the documents and makes the judgment calls (which sentence is a commitment, who owns it). The rules check: the schema, every quote against the original file, and the plan against Jira. A refresh is the rules alone: seconds, no credits. |
| Where a project lives | One repository per project. Locally (this semester): one folder per project, a git repository when git is installed, every save a commit. |
| Original documents | Kept, in the project's `inputs/`, so a reading can be repeated and any quote checked again. |
| People | The organisation's directory never enters a project. `teams.yaml` lists teams and their Jira projects only; contacts stay with the directory connection on the server; `.gitignore` keeps directory exports and contact lists out. Names that are part of the evidence (a Jira assignee, a quoted sentence) stay. |
| Git | Hidden. The GUI says "Saved"; history is plain-English lines; nobody sees a branch. |
| Which agent | Any major coding agent. Devin runs automatically through its API; any agent (Claude Code, Codex, Cursor, Copilot's agent, Gemini CLI, or Devin) can work in the folder by `AGENTS.md`, and the GUI takes the reading in. |

## The folder contract

```
<project>/
  project.yaml        name, stage, epic, launch date, files and how each is read, team → Jira choices, status
  inputs/             the originals the PM added
  readings/<stage>/   what was read at that stage: plan.json, and each agent reading that was used
  readings/inbox/     the one place an agent writes: reading.json
  reviews/<id>/       every review as it was: review.json, summary.md
  teams.yaml          teams and their Jira projects; no people
  history.md          what happened, one line each
  README.md           the status, readable anywhere
  AGENTS.md           the job, the output, the safety rules (CLAUDE.md and GEMINI.md point to it)
  .gitignore          directory exports, contact lists, the agent's scratch space
```

The GUI writes `project.yaml` and `inputs/`; the rules write `readings/<stage>/` and `reviews/`; an agent writes only
`readings/inbox/reading.json`. One writer per path, so nothing needs merging by hand.

## How a reading works with any agent

1. The PM adds files in the GUI; they land in `inputs/`, and `AGENTS.md` lists them with the reading instructions.
2. Either the GUI starts a Devin session with the files attached (automatic), or the PM opens the folder in their own
   coding agent and asks it to "read the files in inputs/ by AGENTS.md".
3. The agent writes its reading: plan items, signals, teams, the launch date and epic, each with a word-for-word quote.
4. The PM clicks "Use the reading". The rules validate it, check every quote against the original, drop what the
   file does not support, undo anything else the agent changed, and file the reading under `readings/<stage>/`.
5. Reviews run on the rules against Jira, with the confirmed plan; the agent is not needed again until a document
   changes.

## Prompt injection

The documents are untrusted, and they go to an agent that can write files. Defences, in the order they act:

| # | Defence | Status |
|---|---|---|
| 1 | Every agent is told the documents are data: text addressed to it is part of the document, never an instruction, and it reports such text as a warning. (Devin's prompt and `AGENTS.md`.) | Built |
| 2 | Text in a document that reads as addressed to an AI (ignore instructions, orders to an agent, download commands, send-to addresses) is flagged to the PM with the line. | Built |
| 3 | Automated reading sessions get the documents and nothing else: no repository, no Jira, no secrets. | Built (Devin) |
| 4 | An agent may write one file. Anything else it changed is undone (tracked files restored) or moved to `.scratch/quarantine/`, and the PM is told. | Built (local, with git) |
| 5 | What the agent wrote is validated (schema, known files), and every quote is checked against the original by the rules, outside the agent. | Built |
| 6 | The agent's text is shown as plain text, never as links or markup. | Built |
| 7 | The PM confirms the plan before any review uses it. | Built |
| 8 | Hosted: the agent pushes a branch; the server merges only `readings/inbox/`, and the main branch is protected. | Planned |
| 9 | Hosted: each project is its own repository, so an agent working on one cannot reach another. | Planned |

Residual risk: a document can contain a false commitment that is genuinely in the file (white text on a slide, a
speaker note). The quote check passes because the words are there. Defence 2 catches text written at an agent, and
the PM sees each item's source before confirming, but a plausible planted sentence can still get through. Items from
speaker notes and hidden text should be marked as such (not built yet).

## From local folders to one repository per project

What it takes to run the same contract on GitHub, with any agent.

**One-time, a GitHub organisation admin**
- A GitHub organisation, and a template repository with the folder skeleton, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
  and the `.gitignore`.
- A GitHub App for the GUI's server, installed on the organisation, with: contents read and write, pull requests read
  and write, and repository creation (administration) so the GUI can create a project's repository from the template
  and add its members. Its private key lives on the server; it issues one-hour tokens.
- Main branch protection on project repositories (a paid plan for private repositories; confirm current terms).

**Per project (done by the GUI)**
- Create `<org>/<project-slug>` from the template, private, and add the PM and the people they share it with.
- Every GUI change is a commit through GitHub's API, batched so a burst of edits is one commit.

**Per agent**
- Devin (automatic): a service user with permission to start sessions. Reading sessions need no repository access: the
  documents go as attachments and the reading comes back as structured output, which the server writes.
- Any coding agent (interactive): the PM clones the project repository with their agent (or opens it in Devin with
  GitHub connected), the agent writes `readings/inbox/reading.json` on a branch, and the GUI takes it from there. The
  PM needs push access to branches; the agent needs nothing special.
- Jira: none of the agents. The rules read Jira on the server with the person's own Sign in with Atlassian.

**Server work**
- A GitHub-backed project store (read the tree on open, write through the API, merge the inbox branch with the path
  guard), cached reads, and conflict handling when two people save at once.
- The project-to-repository map, and the people who can open each project from its repository's collaborators.

## Risks

| Risk | What we do about it |
|---|---|
| A reading varies between agents and runs | The agent only reads; the rules decide what is a gap. Quotes are checked; the PM confirms the plan. |
| Prompt injection | The defences above; the residual risk is a planted but genuine-looking sentence. |
| Originals in git are hard to remove | Removing a file in the GUI does not erase it from history. Erasing needs a history rewrite by an admin; say so in the GUI. Large decks need Git LFS above a size cap. |
| Repository sprawl | One repository per project means many repositories: name them by a rule, archive finished projects, and manage access from the GUI. |
| Admin approval at a real company | The GitHub App needs an organisation admin; at a large company that is a security review. The local folder works without any of it. |
| Agents differ | Instruction file names and sandboxes differ; `AGENTS.md` plus pointers covers the major ones, and the write guard does not rely on the agent obeying. |
| Saves and conflicts | Commits are batched; a second person's save on a changed file is merged or refused with a clear message. |
| Cost | Devin spends credits per reading only; a PM's own agent uses their own subscription; reviews cost nothing. |
| Names in evidence | The directory stays out, but Jira assignees and quoted sentences name people; the repository must stay private. |

## What is built this semester

The working build is the deliverable. On top of it, the folder contract runs on local disk:
- each project is a folder under `workspace/` (`PROJECTS_DIR`), a git repository when git is installed, with a
  commit per save and the history in plain English;
- originals are kept in `inputs/`, and every later run reads them from there;
- any coding agent can do the reading in the folder ("Use your own coding agent" on the plan step), and the rules check
  it, undo stray changes, and flag injection-like text;
- `teams.yaml` carries no people; `.gitignore` keeps directory exports and contact lists out.

Not built: the GitHub-backed store, repository creation, sharing, batching across sessions, and marking items that come
from speaker notes or hidden text.
