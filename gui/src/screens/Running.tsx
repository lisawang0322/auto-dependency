import type { PlanDraft, Run } from "@rrr/schemas";
import type { ProgressStage, RunSummary } from "../backend/types";
import { fmtDate } from "../model/dates";

export function Running({ stage, plan, latestRun, runs }: { stage: ProgressStage; plan: PlanDraft | null; latestRun: Run | null; runs: RunSummary[] }) {
  const rel = latestRun?.release;
  const comments = rel ? rel.stories.reduce((n, s) => n + s.comments.length, 0) + 3 : 0;
  const projects = rel ? [...new Set(rel.related.map((r) => r.project))].sort().join(", ") : "";
  const prev = runs.length > 1 ? runs[runs.length - 2].label : null;
  const steps = [
    ["Reader", rel ? `Read ${rel.epic.key}: ${rel.stories.length} stories, ${rel.links.length} links, ${comments} comments. Followed links into ${projects}.` : "Reading the epic…"],
    ["Analyzer", `Compared ${plan?.items.length ?? 0} plan items with Jira; searched each team project for unlinked matches.`],
    ["Status", prev ? `Rolled findings up per team and compared with the ${prev} run.` : "Rolled findings up per team."],
  ];
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="stack-sm">
        <span className="small muted">Running review on the {rel ? fmtDate(rel.snapshot_label) : "latest"} snapshot</span>
        <h1>Reading Jira…</h1>
      </div>
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
