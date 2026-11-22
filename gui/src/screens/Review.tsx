import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Finding, PlanDraft, ReleaseTarget, Run, TeamStatus, Commitment } from "@throughline/schemas";
import { linkFindings, firstSeenLabel } from "@throughline/schemas";
import type { DecisionStore, RunSummary, RunDecisions, Stage, ActionsGlance, ActionGlance } from "../backend/types";
import { fmtDate, daysBetween, clock, prettyDates } from "../model/dates";
import { Info } from "./Info";
import { rollup, releaseStatus, visibleFindings, openFindingCount, nextActions, type TeamView, type Effective } from "../model/review";
import { STAGE_SHORT } from "./GetStarted";
import { sourceLabel } from "./PlanDocuments";

/** Where owner names came from: the connected directory, an uploaded team list, or Jira assignees. */
export type OwnerSource = "directory" | "files" | "inferred";

interface Props {
  stage: Stage; store: DecisionStore; runs: RunSummary[]; runsById: Record<string, Run>; latestId: string;
  target: ReleaseTarget; launch: string; planIds: Set<string> | null; planDates: Record<string, string>; plan: PlanDraft; ownerSource: OwnerSource;
  /** Back to the project's overview, where the stage, files and connections are changed. */
  onOverview?: () => void;
  /** What the projects home shows for this project: the latest run's status and open actions. */
  onSummary?: (s: { status: string | null; open: number | null; detail: string | null }) => void;
  eyebrow?: string;
  /** A past record opened from History: everything is shown, nothing can be decided or ticked. */
  readOnly?: boolean;
  /** The project's commitments: a finding about one shows where it was first written down, and the PM's call on it
   *  follows the item from review to review (a dropped commitment's finding reads as dismissed). */
  commitments?: Commitment[];
  onCommitment?: (id: string, kind: "kept" | "dropped" | "reopen", reason: string) => void;
  /** The checklist, for the panel beside the review; given this, the review leaves the list to the panel. */
  onActions?: (a: ActionsGlance) => void;
  /** With a PRD too: what it says about each team (why, who, signs off, on the work, its own next actions), shown at the
   *  top of that team's card; and the teams only the PRD names, listed after the launch teams. */
  teamExtra?: (team: string) => ReactNode;
  moreTeams?: ReactNode;
}

const STATUS_LABEL: Record<TeamStatus, string> = { on_track: "On track", at_risk: "At risk", late: "Late" };
/** Plain words for the analyzer's categories (PRD R5, R7); the technical names stay in the data and the detail's tooltip. */
const TYPE_LABEL: Record<Finding["gap_type"], string> = { process: "Approval or gate", cross_team_date: "Date after launch", commitment: "Promise, no ticket" };
const TYPE_TECH: Record<Finding["gap_type"], string> = { process: "process gap", cross_team_date: "cross-team date gap", commitment: "commitment gap" };
const STRENGTH_LABEL: Record<Finding["strength"], string> = { strong: "Confirmed in Jira", moderate: "Inferred match", weak: "Comment only" };
const STRENGTH_TECH: Record<Finding["strength"], string> = { strong: "strong: plan or checklist item matched to a linked ticket", moderate: "moderate: owner or match inferred", weak: "weak: comment text only" };
/** Status-skill notes, in plain words. */
function plainNote(n: string): string { return n.replace(/linkage gap/gi, "not linked to the epic").replace(/Weak evidence/g, "Comment only"); }
const EMPTY: RunDecisions = { decisions: {}, log: [], actionsDone: {} };

export function Review(p: Props) {
  const [runId, setRunId] = useState(p.latestId);
  const [showWeak, setShowWeak] = useState(false);
  const [filter, setFilter] = useState<"all" | TeamStatus>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState<Record<string, RunDecisions>>({});

  const epic = p.target.epic.key;
  const keyOf = (id: string) => `${epic}/${id}`;
  useEffect(() => {
    let on = true;
    Promise.all(p.runs.map((r) => p.store.load(keyOf(r.id)))).then((list) => {
      if (!on) return;
      const all: Record<string, RunDecisions> = {};
      p.runs.forEach((r, i) => { all[r.id] = list[i]; });
      setSaved(all);
    });
    return () => { on = false; };
  }, [p.runs, p.store, epic]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLatest = runId === p.latestId;
  const run = p.runsById[runId];
  const latest = p.runsById[p.latestId];
  const idx = p.runs.findIndex((r) => r.id === runId);
  const prevSummary = idx > 0 ? p.runs[idx - 1] : null;
  const prevRun = prevSummary ? p.runsById[prevSummary.id] : null;
  const raw = saved[runId] ?? EMPTY;
  // Which commitment each finding is about. On the latest run a commitment the PM dropped (here or at an earlier stage)
  // dismisses its finding; that call lives on the list, not in this run's saved decisions.
  const linked = useMemo(() => (p.commitments?.length ? linkFindings(p.commitments, run) : {}), [p.commitments, run]);
  const withList = (d: RunDecisions, r: Run): RunDecisions => {
    if (!p.commitments?.length) return d;
    const l = r === run ? linked : linkFindings(p.commitments, r);
    const extra: RunDecisions["decisions"] = {};
    for (const f of r.findings) {
      const c = l[f.id];
      if (c?.decision?.kind === "dropped" && !d.decisions[f.id]) extra[f.id] = { kind: "dismissed", reason: `Dropped ${fmtDate(c.decision.at)}: ${c.decision.reason}`, at: c.decision.at };
    }
    return Object.keys(extra).length ? { ...d, decisions: { ...d.decisions, ...extra } } : d;
  };
  const dec = isLatest ? withList(raw, run) : raw;

  const viewTeams = useMemo(() => rollup(run.teams, dec.decisions, p.planIds, p.planDates), [run, dec, p.planIds, p.planDates]);
  const prevTeams = useMemo(() => (prevRun ? rollup(prevRun.teams, (saved[prevSummary!.id] ?? EMPTY).decisions, p.planIds, p.planDates) : null), [prevRun, prevSummary, saved, p.planIds, p.planDates]);
  const statusOf = (id: string) => releaseStatus(rollup(p.runsById[id].teams, (saved[id] ?? EMPTY).decisions, p.planIds, p.planDates));

  const findingsById = useMemo(() => Object.fromEntries(run.findings.map((f) => [f.id, f])), [run]);
  const liveFindings = run.findings.filter((f) => !p.planIds || p.planIds.has(f.plan_item_id));
  const shown = visibleFindings(liveFindings, showWeak);
  const shownIds = shown.map((f) => f.id);
  const selId = sel && shownIds.includes(sel) ? sel : shownIds[0] ?? null;
  const selected = isLatest && selId ? findingsById[selId] : null;

  const persist = (next: RunDecisions) => { setSaved((s) => ({ ...s, [runId]: next })); p.store.save(keyOf(runId), next); };
  const decide = (f: Finding, kind: "kept" | "dismissed") => {
    const r = reason.trim();
    if (kind === "dismissed" && !r) return;
    const text = kind === "kept" ? `Kept "${f.title}" — added to actions` : `Dismissed "${f.title}" — ${r}`;
    const decisions = { ...raw.decisions, [f.id]: { kind, reason: r, at: new Date().toISOString() } };
    persist({ ...raw, decisions, log: [{ time: clock(), text }, ...raw.log] });
    const c = linked[f.id];
    if (c) p.onCommitment?.(c.id, kind === "kept" ? "kept" : "dropped", r);
    setReason("");
    setSel(f.id); // stay here: the detail now reads "Kept" or "Dismissed — reason" with Reopen, so the decision is visible
  };
  const reopen = (f: Finding) => {
    const decisions = { ...raw.decisions };
    delete decisions[f.id];
    persist({ ...raw, decisions, log: [{ time: clock(), text: `Reopened "${f.title}"` }, ...raw.log] });
    const c = linked[f.id];
    if (c?.decision) p.onCommitment?.(c.id, "reopen", "");
  };

  const release = releaseStatus(viewTeams);
  const lateTeams = viewTeams.filter((t) => t.status === "late").length;
  const riskCount = viewTeams.filter((t) => t.status !== "on_track").length;
  const openCount = isLatest ? openFindingCount(liveFindings, dec.decisions) : viewTeams.reduce((n, t) => n + t.items.filter((i) => i.effective === "gap" || i.effective === "late").length, 0);
  const decs = Object.values(dec.decisions);
  // R16: the next actions come from the latest run's shown findings that are open or kept; ticks are saved with that run.
  const latestRaw = saved[p.latestId] ?? EMPTY;
  const latestDec = withList(latestRaw, latest);
  const latestLive = latest.findings.filter((f) => !p.planIds || p.planIds.has(f.plan_item_id));
  const actions = nextActions(visibleFindings(latestLive, showWeak), latestDec.decisions);
  const actionsDone = latestDec.actionsDone ?? {};
  const openActions = actions.filter((a) => !actionsDone[a.id]).length;
  useEffect(() => { if (isLatest && !p.readOnly) p.onSummary?.({ status: release, open: openActions, detail: `${openCount} open finding${openCount === 1 ? "" : "s"} · ${fmtDate(p.latestId)} run` }); }, [release, openActions, openCount, isLatest]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleAction = (id: string) => {
    const next: RunDecisions = { ...latestRaw, actionsDone: { ...actionsDone, [id]: !actionsDone[id] } };
    setSaved((s) => ({ ...s, [p.latestId]: next }));
    p.store.save(keyOf(p.latestId), next);
  };
  const rows = viewTeams.filter((t) => filter === "all" || t.status === filter);
  const daysOut = daysBetween(run.release.snapshot_label, p.launch);
  const searchedProjects = run.release.projects_searched.map((s) => s.jira_project);
  const hopProjects = [...new Set(run.release.related.map((r) => r.project))].sort();
  const otherGaps = run.linkage_gaps.filter((g) => !g.finding_id);
  const selDec = selected ? dec.decisions[selected.id] : undefined;
  /** The team a finding belongs to, so a next action can lead to the team card that holds its finding. */
  const teamOfFinding = (fid: string) => latest.teams.find((t) => t.items.some((i) => i.finding_id === fid)) ?? null;
  const goToFinding = (fid: string) => {
    const t = teamOfFinding(fid);
    if (!t) return;
    setFilter("all");
    setCollapsed((c) => ({ ...c, [t.team]: false }));
    setSel(fid);
    requestAnimationFrame(() => document.getElementById(`team-card-${t.project_key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // The checklist goes to the panel: the latest run's actions, each leading to the team card that holds its finding.
  const toggleRef = useRef(toggleAction); toggleRef.current = toggleAction;
  const goRef = useRef(goToFinding); goRef.current = goToFinding;
  // Who (when it is a person, not just the team) and by when; the why is on the team card the action leads to.
  const actionItems: ActionGlance[] = actions.map((a) => ({ id: a.id, text: prettyDates(a.text), detail: a.who === teamOfFinding(a.id)?.team ? prettyDates(a.when) : `${a.who} · ${prettyDates(a.when)}`, team: teamOfFinding(a.id)?.team ?? null, done: !!actionsDone[a.id], kept: a.kept }));
  const itemsKey = JSON.stringify(actionItems);
  useEffect(() => {
    if (p.readOnly || !p.onActions) return;
    p.onActions({ items: actionItems, toggle: (id) => toggleRef.current(id), jump: (id) => goRef.current(id) });
  }, [itemsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const planItem = selected ? p.plan.items.find((i) => i.id === selected.plan_item_id) : null;
  const planDue = planItem ? p.planDates[planItem.id] ?? planItem.due : null;

  type Upcoming = { date: string | null; key: string; item: string; flag: string; cls: Effective | "launch" };
  const upcoming: Upcoming[] = viewTeams.flatMap((t) => t.items.map((i): Upcoming => ({ date: i.plan_due_effective, key: t.project_key, item: i.text, flag: i.note_effective, cls: i.effective })))
    .concat([{ date: p.launch, key: "LAUNCH", item: "Go-live", flag: "Go/no-go Friday", cls: "launch" }])
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  /** The selected finding's evidence and your call, shown under the finding itself. */
  const detailNode = selected ? (
    <section aria-label="Finding detail" className="detail-inline">
            <div className="stack" style={{ gap: 16 }}>
        <div className="stack-sm" style={{ gap: 8 }}>
          {/* The finding's title and tags are on the row just above; the detail starts with who owns it. */}
          <h2 className="sr-only">{selected.title}</h2>
          <span className="muted">Owner: {selected.owner} <span className="small">{selected.owner_source === "team_list" && p.ownerSource !== "inferred" ? (p.ownerSource === "directory" ? "(from your directory)" : "(from your team list)") : "(inferred from Jira assignee)"}</span></span>
        </div>
        <div className="notice" style={{ display: "flex", flexDirection: "column", gap: 2 }} data-testid="suggested-action">
          <span className="eyebrow" style={{ color: "var(--blue-text)" }}>Suggested next action</span>
          <span>{prettyDates(selected.next_action?.action ?? selected.ask ?? selected.title)}</span>
          {selected.next_action && <span className="small">{selected.next_action.who} · {prettyDates(selected.next_action.by_when)}</span>}
          {/* The action is marked done here, beside the evidence; the panel's list follows. */}
          {p.onActions && !p.readOnly && actions.some((a) => a.id === selected.id) && (actionsDone[selected.id]
            ? <span className="row" style={{ gap: 8, alignItems: "center", marginTop: 6 }}><span className="small" style={{ color: "var(--green-dark)", fontWeight: 600 }}>✓ Done</span><button type="button" className="linkbtn" style={{ minHeight: 28 }} aria-label="Undo: mark not done" onClick={() => toggleAction(selected.id)}>Undo</button></span>
            : <div style={{ marginTop: 6 }}><button type="button" className="btn" style={{ minHeight: 32, padding: "0 12px", fontSize: 14 }} onClick={() => toggleAction(selected.id)}>Mark done</button></div>)}
        </div>
        <div className="box">
          <span className="eyebrow">Expected (plan)</span>
          <span>{planItem?.text ?? selected.plan_item_id}{planDue ? ` by ${fmtDate(planDue)}` : ""}</span>
          {planItem && <span className="small muted">Source: {sourceLabel(p.plan, planItem.source.file, planItem.source.locator)} · “{planItem.source.quote}”</span>}
          {linked[selected.id] && <span className="small" data-testid="commitment-since">Committed since {firstSeenLabel(linked[selected.id], fmtDate)}{linked[selected.id].first_seen.stage !== "launching" && linked[selected.id].sources[0] ? ` · “${linked[selected.id].sources[0].quote}”` : ""}</span>}
        </div>
        <div className="box" style={{ gap: 8 }}>
          <span className="eyebrow">Found in Jira</span>
          {selected.evidence.length === 0 && (<><span>None found</span><span className="small muted">Searched {searchedProjects.join(", ").replace(/, ([^,]*)$/, " and $1")} for a matching ticket or linked doc.</span></>)}
          {selected.evidence.map((ev, i) => (
            <span key={i} className="stack-sm" style={{ gap: 2 }}>
              <span><span className="key">{ev.key}</span> {ev.text}</span>
              <span className="small muted">{ev.meta}</span>
            </span>
          ))}
        </div>
        <div className="sm text2">{selected.why}</div>
        {selected.linkage && (
          <div className="notice">Not linked: <span className="mono">{selected.linkage.from}</span> isn't linked to <span className="mono">{selected.linkage.to}</span> in Jira. Suggested link: <strong style={{ fontWeight: 500 }}>{selected.linkage.suggested_type}</strong></div>
        )}
        <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 16, gap: 12 }}>
          {p.readOnly ? <p className="sm muted">A past record: decisions are made on the project's current review.</p> : <>
          <h3>Your call</h3>
          {selDec && (
            <div className="decided">
              <span className="sm">{selDec.kind === "kept" ? "Kept — in your next actions" : `Dismissed — ${selDec.reason}`}</span>
              <button type="button" className="btn" onClick={() => reopen(selected)}>Reopen</button>
            </div>
          )}
          {!selDec && (
            <div className="stack-sm" style={{ gap: 10 }}>
              <button type="button" className="btn primary" style={{ alignSelf: "flex-start" }} onClick={() => decide(selected, "kept")}>Keep — add to my actions</button>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
                <div className="stack-sm" style={{ gap: 4, flex: "1 1 200px" }}>
                  <label htmlFor="dismiss-reason" className="label">Reason for dismissing (required, logged)</label>
                  <input id="dismiss-reason" type="text" className="input" value={reason} placeholder="e.g. Doesn't apply to this release" onChange={(e) => setReason(e.target.value)} />
                </div>
                <button type="button" className="btn outline-ink" style={{ padding: "0 18px" }} disabled={!reason.trim()} onClick={() => decide(selected, "dismissed")}>Dismiss</button>
              </div>
            </div>
          )}
          </>}
        </div>
      </div>
    </section>
  ) : null;

  return (
    <div className="flow stack">
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">{p.eyebrow ?? "Step 3 of 3"} · {STAGE_SHORT[p.stage]}</span>
        <h1 className="flow-title">Launch {fmtDate(p.launch)} · {daysOut} days out</h1>
        <p className="lead">{fmtDate(run.release.snapshot_label)} run{isLatest ? " (latest)" : ""} · {epic}, its linked tickets in {hopProjects.join(", ")}, and each team's project</p>
        <div className="run-row">
          <span id="run-label" className="small muted">Status by run</span>
          <div role="group" aria-labelledby="run-label" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {p.runs.map((r) => (
              <button key={r.id} type="button" className="chip" aria-pressed={runId === r.id} onClick={() => { setRunId(r.id); setSel(null); setReason(""); }}>
                {r.label}{r.id === p.latestId ? " · latest" : ""} · {statusOf(r.id)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {!p.onActions && <section className="card" style={{ gap: 6, borderColor: "var(--accent)" }} data-testid="next-actions">
        <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
          <h2>Your next actions</h2>
          <span className="small muted" data-testid="actions-count">{openActions} open · {actions.length - openActions} done</span>
        </div>
        {actions.length === 0 && <p className="sm muted">Nothing open. Re-run when the plan or the work changes.</p>}
        {actions.map((a) => {
          const done = !!actionsDone[a.id];
          return (
            <div key={a.id} className="action-row">
              <input id={`act-${a.id}`} type="checkbox" checked={done} disabled={p.readOnly} onChange={() => toggleAction(a.id)} />
              <label htmlFor={`act-${a.id}`}>
                <span className={done ? "done" : ""} style={done ? undefined : { fontWeight: 500 }}>{prettyDates(a.text)}</span>
                <span className="small muted"><strong style={{ fontWeight: 500, color: "var(--text-2)" }}>{a.who}</strong> · {prettyDates(a.when)} · {prettyDates(a.why)}{a.kept ? " · kept" : ""}</span>
              </label>
              {teamOfFinding(a.id) && <button type="button" className="linkbtn team-jump" aria-label={`Go to ${teamOfFinding(a.id)!.team}`} onClick={() => goToFinding(a.id)}>{teamOfFinding(a.id)!.team} ›</button>}
            </div>
          );
        })}
        {!isLatest && <p className="small muted">Actions come from the latest run ({fmtDate(p.latestId)}).</p>}
      </section>}

      {!isLatest && <div className="notice-grey">Earlier run, shown read-only.<Info>Switch to {fmtDate(p.latestId)} to keep or dismiss findings.{p.onActions ? ` Your next actions are always the latest run's (${fmtDate(p.latestId)}).` : ""}</Info></div>}

      <div className="tiles">
        <div className={"tile " + (release === "Green" ? "green" : "amber")}>
          <div className="small">Release status</div>
          <div className="big" data-testid="throughline-status">{release}</div>
          <div className="small">{lateTeams > 0 ? `${lateTeams} team${lateTeams > 1 ? "s" : ""} with a date after launch` : release === "Green" ? "No open gaps" : "Open gaps, no late dates"}</div>
        </div>
        <div className="tile"><div className="small muted">Teams at risk or late</div><div className="big">{riskCount} of {viewTeams.length}</div></div>
        <div className="tile"><div className="small muted">Open findings</div><div className="big" data-testid="open-findings">{openCount}</div><div className="small muted">Comment-only findings not counted</div></div>
        {decs.length > 0 && <div className="tile"><div className="small muted">Your calls</div><div className="big">{decs.filter((d) => d.kind === "kept").length} · {decs.filter((d) => d.kind === "dismissed").length}</div><div className="small muted">kept · dismissed</div></div>}
      </div>

      <div>
        <section aria-label="Teams and findings" id="teams" className="stack" style={{ gap: 12, scrollMarginTop: 16 }}>
          <div className="between" style={{ gap: 10 }}>
            <h2>Teams and findings</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <div role="group" aria-label="Filter teams" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(["all", "on_track", "at_risk", "late"] as const).map((id) => (
                  <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                    {id === "all" ? "All" : STATUS_LABEL[id]} {id === "all" ? viewTeams.length : viewTeams.filter((t) => t.status === id).length}
                  </button>
                ))}
              </div>
              <button type="button" className="btn dashed" aria-pressed={showWeak} onClick={() => setShowWeak((w) => !w)}>{showWeak ? "Hide comment-only" : "Show comment-only"}</button>
            </div>
          </div>
          {rows.length === 0 && <div className="card sm muted">No teams match this filter.</div>}
          {rows.map((t) => <TeamCard key={t.team} t={t} prev={prevTeams?.find((x) => x.team === t.team) ?? null} prevLabel={prevSummary?.label ?? null} isLatest={isLatest}
            findingsById={findingsById} shownIds={shownIds} showWeak={showWeak} selId={selected?.id ?? null} decisions={dec.decisions}
            expanded={!collapsed[t.team]} onToggle={() => setCollapsed((c) => ({ ...c, [t.team]: !c[t.team] }))} onOpen={(id) => { setSel(id); setReason(""); }} detail={detailNode}
            extra={isLatest ? p.teamExtra?.(t.team) : undefined} />)}
          {isLatest && !selected && rows.length > 0 && <p className="small muted">Open a finding to see its evidence and make your call.</p>}
        </section>
        {isLatest && p.moreTeams}

      </div>

      <section className="stack" style={{ gap: 10 }}>
        <h2>Related tickets not linked to the epic<Info>Worth linking so they show up with the release. None of these is a gap on its own, so they don't count toward the findings above.</Info></h2>
        {otherGaps.length === 0 && <div className="card sm muted">None in this run.</div>}
        {otherGaps.map((g) => (
          <div key={g.id} className="card" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "14px 16px" }}>
            <span className="key" style={{ padding: "2px 8px" }}>{g.from}</span>
            <span className="sm muted">{g.how === "comment_mention" ? "mentions" : "matches"}</span>
            <span className="key" style={{ padding: "2px 8px" }}>{g.to}</span>
            <span>{g.to_summary}</span>
            <span className="sm muted">{g.how === "comment_mention" ? "in a comment, with no link" : "by search, with no link"} · suggested: <strong style={{ fontWeight: 500, color: "var(--ink)" }}>{g.suggested_type}</strong></span>
          </div>
        ))}
      </section>

      <div className="stack" style={{ gap: 28 }}>
        <section className="stack" style={{ gap: 10 }}>
          <h2>Upcoming plan dates</h2>
          <div className="card" style={{ padding: "6px 18px", gap: 0 }}>
            {upcoming.map((u, i) => (
              <div key={i} className="upcoming">
                <span style={{ fontWeight: 500 }}>{fmtDate(u.date)}</span>
                <span className="mono muted u-key">{u.key}</span>
                <span>{u.item}</span>
                <span className={u.cls === "launch" ? "sm" : "flag " + u.cls} style={u.cls === "launch" ? { fontWeight: 500 } : undefined}>{plainNote(u.flag)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {dec.log.length > 0 && (
        <section className="stack" style={{ gap: 8 }}>
          <h2>Decision log</h2>
          <div className="card" style={{ padding: "6px 16px", gap: 0 }}>
            {dec.log.map((e, i) => <div key={i} className="log-row"><span className="mono muted">{e.time}</span> {e.text}</div>)}
          </div>
        </section>
      )}

      <p className="small muted limits" data-testid="limits">What this review can't see<Info>Anything agreed only in meetings, chat or email; approvals tracked in apps that aren't connected; and whether the technical work itself is adequate.</Info></p>

      {!p.readOnly && p.onOverview && <div><button type="button" className="btn" onClick={p.onOverview}>‹ Overview</button></div>}
    </div>
  );
}

function TeamCard(p: {
  t: TeamView; prev: TeamView | null; prevLabel: string | null; isLatest: boolean; findingsById: Record<string, Finding>; shownIds: string[]; showWeak: boolean;
  selId: string | null; decisions: Record<string, { kind: string; reason: string }>; expanded: boolean; onToggle: () => void; onOpen: (id: string) => void;
  /** The open finding's detail, placed right under it. */ detail: ReactNode;
  /** What the PRD says about this team, above its launch items. */ extra?: ReactNode;
}) {
  const { t } = p;
  const openItems = t.items.filter((i) => i.effective === "gap" || i.effective === "late");
  const next = openItems.map((i) => i.plan_due_effective).filter(Boolean).sort()[0];
  let change = "First run", changed = false;
  if (p.prevLabel) {
    if (p.prev && p.prev.status !== t.status) { change = `Since ${p.prevLabel}: ${STATUS_LABEL[p.prev.status]} → ${STATUS_LABEL[t.status]}`; changed = true; }
    else change = `Since ${p.prevLabel}: no status change`;
    if (t.change_note) change += ` · ${t.change_note}`;
  }
  let hiddenWeak = 0;
  return (
    <div className="team" id={`team-card-${t.project_key}`} data-testid={`team-${t.project_key}`} style={{ scrollMarginTop: 16 }}>
      <button type="button" className="team-head" aria-expanded={p.expanded} onClick={p.onToggle}>
        <span className="stack-sm" style={{ gap: 2 }}>
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600 }}>{t.team}</span>
            <span className={"badge " + t.status} data-testid="team-status">{STATUS_LABEL[t.status]}</span>
          </span>
          <span className="small muted"><span className="mono">{t.project_key}</span> · {t.role} · {openItems.length === 0 ? "no open gaps" : `${openItems.length} open · next ${fmtDate(next)}`}</span>
          <span className="change">{changed && <span className="changed-tag">Changed</span>}<span>{change}</span></span>
        </span>
        <span className="small muted">{p.expanded ? "Hide" : `Show ${t.items.length} items`}</span>
      </button>
      {p.expanded && (
        <div className="team-body">
          {p.extra && <div className="team-extra">{p.extra}</div>}
          {p.extra && <span className="eyebrow" style={{ marginTop: 4 }}>For launch</span>}
          {t.items.map((i) => {
            const f = i.finding_id && p.isLatest ? p.findingsById[i.finding_id] : null;
            if (f && f.strength === "weak" && !p.showWeak) { hiddenWeak++; return null; }
            if (f && p.shownIds.includes(f.id)) {
              const d = p.decisions[f.id];
              return (
                <Fragment key={i.plan_item_id}>
                <button type="button" className={"finding-row" + (d?.kind === "dismissed" ? " dismissed" : "")} aria-pressed={p.selId === f.id} aria-expanded={p.selId === f.id} onClick={() => p.onOpen(f.id)}>
                  <span className="between" style={{ alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontWeight: 500 }}>{f.title}</span>
                    <span className="small" style={{ whiteSpace: "nowrap", fontSize: 12, color: d ? "var(--muted)" : "var(--amber-text)", fontWeight: d ? 400 : 500 }}>{!d ? "Open" : d.kind === "kept" ? "Kept" : "Dismissed"}</span>
                  </span>
                  <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <span className={"pill " + f.strength} title={STRENGTH_TECH[f.strength]}>{STRENGTH_LABEL[f.strength]}</span>
                    <span className="pill type" title={TYPE_TECH[f.gap_type]}>{TYPE_LABEL[f.gap_type]}</span>
                    <span className="muted"><span className="mono" style={{ fontSize: 12 }}>{i.ticket ?? "—"}</span> · plan {fmtDate(i.plan_due_effective)} · Jira {fmtDate(i.jira_due)}</span>
                    {f.linkage && <span style={{ color: "var(--accent)" }}>· not linked to the epic</span>}
                  </span>
                </button>
                {p.selId === f.id && p.detail}
                </Fragment>
              );
            }
            return (
              <div key={i.plan_item_id} className="plain-row">
                <span className="stack-sm" style={{ gap: 0 }}>
                  <span>{i.text}</span>
                  <span className="muted" style={{ fontSize: 12 }}><span className="mono" style={{ fontSize: 12 }}>{i.ticket ?? "—"}</span> · {i.ticket_status} · plan {fmtDate(i.plan_due_effective)} · Jira {fmtDate(i.jira_due)}</span>
                </span>
                <span className={"flag " + i.effective}>{plainNote(i.note_effective)}</span>
              </div>
            );
          })}
          {hiddenWeak > 0 && <span className="small muted" style={{ padding: "0 4px" }}>{hiddenWeak} comment-only finding{hiddenWeak > 1 ? "s" : ""} hidden</span>}
        </div>
      )}
    </div>
  );
}
