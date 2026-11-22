import { useEffect, useState } from "react";
import type { PlanDraft, ReleaseTarget, Run, Starter, Commitment } from "@throughline/schemas";
import type { DecisionStore, RunSummary, ActionsGlance, Stage } from "../backend/types";
import { EarlyResults, teamFacts, teamSlug, useStarterState, type TeamLink } from "./EarlyResults";
import { Review, type OwnerSource } from "./Review";

/**
 * The review on the project's page: every check that ran, as one. With a plan of record, the launch review's team cards are
 * the spine, and each carries what the PRD says about that team (why, who, signs off, on the work, its own actions); the
 * teams only the PRD names follow. With a PRD alone, the PRD's cards are the page. The checklist of both goes to the panel.
 */

export interface LaunchView {
  runs: RunSummary[]; runsById: Record<string, Run>; latestId: string; target: ReleaseTarget; launch: string;
  planIds: Set<string> | null; planDates: Record<string, string>; plan: PlanDraft; ownerSource: OwnerSource;
}

interface Props {
  eyebrow: string; store: DecisionStore;
  starter: Starter | null; signalsOff: Record<string, boolean>;
  launch: LaunchView | null;
  /** Where the project stands, read from its evidence: what is due now, and what is coming up. */
  phase: Stage;
  link?: TeamLink;
  /** The launch date the project knows (the plan's, or the epic's release date), for the PRD's review. */
  launchDate?: string | null;
  /** The launch check with no plan of record (see EarlyResults). */
  readiness?: { date: string | null; onAddChecklist?: () => void };
  commitments: Commitment[]; onCommitment: (id: string, kind: "kept" | "dropped" | "reopen", reason: string) => void;
  onActions: (a: ActionsGlance) => void;
  onSummary: (s: { status: string | null; open: number | null; detail: string | null }) => void;
  onConnectApps: () => void;
}

export function ProjectReview(p: Props) {
  const state = useStarterState(p.store, p.starter);
  const [early, setEarly] = useState<ActionsGlance | null>(null);
  const [launchActs, setLaunchActs] = useState<ActionsGlance | null>(null);
  // One checklist for the panel: the launch review's actions, then the PRD's; each ticked by the view that owns it.
  useEffect(() => {
    const parts = [p.launch ? launchActs : null, p.starter ? early : null].filter((x): x is ActionsGlance => !!x);
    if (!parts.length) return;
    const owner = (id: string) => parts.find((x) => x.items.some((i) => i.id === id));
    p.onActions({ items: parts.flatMap((x) => x.items), toggle: (id) => owner(id)?.toggle(id), jump: (id) => owner(id)?.jump(id), later: p.starter ? early?.later : undefined });
  }, [early, launchActs, !!p.launch, !!p.starter]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p.launch) return p.starter ? (
    <EarlyResults onSummary={p.onSummary} eyebrow={p.eyebrow} starter={p.starter} signalsOff={p.signalsOff} store={p.store} state={state} phase={p.phase} link={p.link}
      readiness={p.readiness} launch={p.launchDate ?? null} commitments={p.commitments} onCommitment={p.onCommitment} onActions={setEarly} onConnectApps={p.onConnectApps} />
  ) : null;

  const st = p.starter;
  const latest = p.launch.runsById[p.launch.latestId];
  const launchTeams = latest?.teams.map((t) => t.team) ?? [];
  const known = (team: string) => !!st && [...st.teams.map((t) => t.team), ...st.approvals.map((a) => a.team), ...st.coverage.map((c) => c.team), ...st.approval_status.map((a) => a.team)]
    .some((n) => n.trim().toLowerCase() === team.trim().toLowerCase());
  return (
    <Review onSummary={p.onSummary} eyebrow={p.eyebrow} stage="launching" store={p.store}
      runs={p.launch.runs} runsById={p.launch.runsById} latestId={p.launch.latestId} target={p.launch.target} launch={p.launch.launch}
      planIds={p.launch.planIds} planDates={p.launch.planDates} plan={p.launch.plan} ownerSource={p.launch.ownerSource}
      commitments={p.commitments} onCommitment={p.onCommitment} onActions={setLaunchActs}
      teamExtra={st ? (team) => {
        if (!known(team)) return null;
        const f = teamFacts({ starter: st, signalsOff: p.signalsOff, name: team, state, link: p.link, commitments: p.commitments, onCommitment: p.onCommitment });
        return (
          <div id={teamSlug(team)} className="stack-sm" style={{ gap: 8, scrollMarginTop: 16 }} data-testid={`prd-facts-${team}`}>
            <span className="row" style={{ gap: 8, alignItems: "baseline" }}><span className="eyebrow">From your PRD</span>{f.tags}</span>
            {f.body}
          </div>
        );
      } : undefined}
      moreTeams={st ? (
        <EarlyResults mode="inLaunch" excludeTeams={launchTeams} eyebrow={p.eyebrow} starter={st} signalsOff={p.signalsOff} store={p.store} state={state} phase={p.phase} link={p.link}
          launch={null} commitments={p.commitments} onCommitment={p.onCommitment} onActions={setEarly} onConnectApps={p.onConnectApps} />
      ) : undefined}
    />
  );
}
