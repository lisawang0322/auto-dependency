import type { PlanDraft, Run } from "@rrr/schemas";
import type { ProgressStage, RunSummary, Stage } from "../backend/types";
import { fmtDate } from "../model/dates";

interface Props { stage: ProgressStage; projectStage: Stage; plan: PlanDraft | null; epic: string; latestRun: Run | null; runs: RunSummary[]; signalCount: number; directoryGiven: boolean }

export function Running({ stage, projectStage, plan, epic, latestRun, runs, signalCount, directoryGiven }: Props) {
  const rel = latestRun?.release;
  const comments = rel ? rel.stories.reduce((n, s) => n + s.comments.length, 0) + 3 : 0;
  const projects = rel ? [...new Set(rel.related.map((r) => r.project))].sort().join(", ") : "";
  const prev = runs.length > 1 ? runs[runs.length - 2].label : null;
  const steps: [string, string][] = projectStage === "starting" ? [
    ["Reader", `Read your PRD: ${signalCount} signals about teams and approvals.`],
    ["Analyzer", "Matched each signal to the teams and approvals it usually needs."],
    ["People", directoryGiven ? "Looked up a likely contact for each team." : "No directory connected — showing teams without names."],
  ] : projectStage === "building" ? [
    ["Reader", `Read your plan and ${epic} in Jira: stories, assignees, links and one search per approval.`],
    ["Analyzer", "Compared the teams your plan needs with the people doing the work."],
    ["Status", "Checked which approvals have a ticket and an owner."],
  ] : [
    ["Reader", rel ? `Read ${rel.epic.key}: ${rel.stories.length} stories, ${rel.links.length} links, ${comments} comments. Followed links one hop into ${projects}, and searched each team's project.` : `Reading ${epic}, its links one hop into other teams' projects, and each team's project…`],
    ["Analyzer", `Compared ${plan?.items.length ?? 0} plan items with Jira.`],
    ["Status", prev ? `Rolled findings up per team and compared with the ${prev} run.` : "Rolled findings up per team."],
  ];
  return (
    <div className="flow stack" style={{ maxWidth: 640 }}>
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">Step 4 of 4 · working on it{rel && projectStage === "launching" ? ` · the ${fmtDate(rel.snapshot_label)} snapshot` : ""}</span>
        <h1 className="flow-title">{projectStage === "starting" ? "Reading your PRD…" : "Reading your plan and Jira…"}</h1>
      </header>
      <div className="card" style={{ padding: "8px 20px", gap: 0 }} role="status" aria-live="polite">
        {steps.map(([name, detail], i) => {
          const st = i < stage ? "done" : i === stage ? "running" : "waiting";
          return (
            <div key={name} className="step">
              <span className={"pip " + st} aria-hidden="true" />
              <div className="stack-sm" style={{ gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{name} <span className="muted" style={{ fontWeight: 400 }}>· {st}</span></span>
                <span className="sm muted">{detail}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
