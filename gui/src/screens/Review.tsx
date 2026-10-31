import { useEffect, useMemo, useState } from "react";
import type { Finding, PlanDraft, ReleaseTarget, Run, TeamStatus } from "@rrr/schemas";
import type { DecisionStore, RunSummary, RunDecisions, Stage } from "../backend/types";
import { fmtDate, daysBetween, clock, prettyDates } from "../model/dates";
import { rollup, releaseStatus, visibleFindings, openFindingCount, nextActions, type TeamView, type Effective } from "../model/review";
import { STAGE_SHORT } from "./GetStarted";
import { sourceLabel } from "./PlanDocuments";

/** Where owner names came from: the connected directory, an uploaded team list, or Jira assignees. */
export type OwnerSource = "directory" | "files" | "inferred";

interface Props {
  stage: Stage; store: DecisionStore; runs: RunSummary[]; runsById: Record<string, Run>; latestId: string;
  target: ReleaseTarget; launch: string; planIds: Set<string> | null; planDates: Record<string, string>; plan: PlanDraft; ownerSource: OwnerSource;
  onChangeStage: () => void; onAddFiles: () => void; onConnectApps: () => void;
}

const STATUS_LABEL: Record<TeamStatus, string> = { on_track: "On track", at_risk: "At risk", late: "Late" };
const TYPE_LABEL: Record<Finding["gap_type"], string> = { process: "Process", cross_team_date: "Cross-team date", commitment: "Commitment" };
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
    const all: Record<string, RunDecisions> = {};
    for (const r of p.runs) all[r.id] = p.store.load(keyOf(r.id));
    setSaved(all);
  }, [p.runs, p.store, epic]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLatest = runId === p.latestId;
  const run = p.runsById[runId];
  const latest = p.runsById[p.latestId];
  const idx = p.runs.findIndex((r) => r.id === runId);
  const prevSummary = idx > 0 ? p.runs[idx - 1] : null;
  const prevRun = prevSummary ? p.runsById[prevSummary.id] : null;
  const dec = saved[runId] ?? EMPTY;

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
    const decisions = { ...dec.decisions, [f.id]: { kind, reason: r, at: new Date().toISOString() } };
    persist({ ...dec, decisions, log: [{ time: clock(), text }, ...dec.log] });
    setReason("");
    setSel(shownIds.find((id) => id !== f.id && !decisions[id]) ?? f.id);
  };
  const reopen = (f: Finding) => {
    const decisions = { ...dec.decisions };
    delete decisions[f.id];
    persist({ ...dec, decisions, log: [{ time: clock(), text: `Reopened "${f.title}"` }, ...dec.log] });
  };

  const release = releaseStatus(viewTeams);
  const lateTeams = viewTeams.filter((t) => t.status === "late").length;
  const riskCount = viewTeams.filter((t) => t.status !== "on_track").length;
  const openCount = isLatest ? openFindingCount(liveFindings, dec.decisions) : viewTeams.reduce((n, t) => n + t.items.filter((i) => i.effective === "gap" || i.effective === "late").length, 0);
  const decs = Object.values(dec.decisions);
  // R16: the next actions come from the latest run's shown findings that are open or kept; ticks are saved with that run.
  const latestDec = saved[p.latestId] ?? EMPTY;
  const latestLive = latest.findings.filter((f) => !p.planIds || p.planIds.has(f.plan_item_id));
  const actions = nextActions(visibleFindings(latestLive, showWeak), latestDec.decisions);
  const actionsDone = latestDec.actionsDone ?? {};
  const openActions = actions.filter((a) => !actionsDone[a.id]).length;
  const toggleAction = (id: string) => {
    const next: RunDecisions = { ...latestDec, actionsDone: { ...actionsDone, [id]: !actionsDone[id] } };
    setSaved((s) => ({ ...s, [p.latestId]: next }));
    p.store.save(keyOf(p.latestId), next);
  };
  const rows = viewTeams.filter((t) => filter === "all" || t.status === filter);
  const daysOut = daysBetween(run.release.snapshot_label, p.launch);
  const searchedProjects = run.release.projects_searched.map((s) => s.jira_project);
  const hopProjects = [...new Set(run.release.related.map((r) => r.project))].sort();
  const otherGaps = run.linkage_gaps.filter((g) => !g.finding_id);
  const selDec = selected ? dec.decisions[selected.id] : undefined;
  const planItem = selected ? p.plan.items.find((i) => i.id === selected.plan_item_id) : null;
  const planDue = planItem ? p.planDates[planItem.id] ?? planItem.due : null;

  type Upcoming = { date: string | null; key: string; item: string; flag: string; cls: Effective | "launch" };
  const upcoming: Upcoming[] = viewTeams.flatMap((t) => t.items.map((i): Upcoming => ({ date: i.plan_due_effective, key: t.project_key, item: i.text, flag: i.note_effective, cls: i.effective })))
    .concat([{ date: p.launch, key: "LAUNCH", item: "Go-live", flag: "Go/no-go Friday", cls: "launch" }])
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="between" style={{ alignItems: "flex-end", gap: 16 }}>
        <div className="stack-sm" style={{ gap: 4 }}>
          <span className="small muted">Step 4 · next steps · {STAGE_SHORT[p.stage]}</span>
          <h1>Launch {fmtDate(p.launch)} · {daysOut} days out</h1>
          <span className="muted">Viewing the {fmtDate(run.release.snapshot_label)}{isLatest ? " (latest)" : ""} run · read {epic}, its links one hop into {hopProjects.join(", ")}, and a search of each team's project</span>
        </div>
        <div className="stack-sm">
          <span id="run-label" className="small muted">Status by run</span>
          <div role="group" aria-labelledby="run-label" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {p.runs.map((r) => (
              <button key={r.id} type="button" className="chip" aria-pressed={runId === r.id} onClick={() => { setRunId(r.id); setSel(null); setReason(""); }}>
                {r.label}{r.id === p.latestId ? " · latest" : ""} · {statusOf(r.id)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className="card" style={{ gap: 6, borderColor: "var(--accent)" }} data-testid="next-actions">
        <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
          <h2>Your next actions</h2>
          <span className="small muted" data-testid="actions-count">{openActions} open · {actions.length - openActions} done</span>
        </div>
        {actions.length === 0 && <p className="sm muted">Nothing open. Re-run when the plan or the work changes.</p>}
        {actions.map((a) => {
          const done = !!actionsDone[a.id];
          return (
            <div key={a.id} className="action-row">
              <input id={`act-${a.id}`} type="checkbox" checked={done} onChange={() => toggleAction(a.id)} />
              <label htmlFor={`act-${a.id}`}>
                <span className={done ? "done" : ""} style={done ? undefined : { fontWeight: 500 }}>{prettyDates(a.text)}</span>
                <span className="small muted"><strong style={{ fontWeight: 500, color: "var(--text-2)" }}>{a.who}</strong> · {prettyDates(a.when)} · {prettyDates(a.why)}{a.kept ? " · kept" : ""}</span>
              </label>
            </div>
          );
        })}
        {!isLatest && <p className="small muted">Actions come from the latest run ({fmtDate(p.latestId)}).</p>}
      </section>

      {!isLatest && <div className="notice-grey">Earlier run, shown read-only. Switch to {fmtDate(p.latestId)} to keep or dismiss findings.</div>}

      <div className="tiles">
        <div className={"tile " + (release === "Green" ? "green" : "amber")}>
          <div className="small">Release status</div>
          <div className="big" data-testid="release-status">{release}</div>
          <div className="small">{lateTeams > 0 ? `${lateTeams} team${lateTeams > 1 ? "s" : ""} with a date after launch` : release === "Green" ? "No open gaps" : "Open gaps, no late dates"}</div>
        </div>
        <div className="tile"><div className="small muted">Teams at risk or late</div><div className="big">{riskCount} of {viewTeams.length}</div></div>
        <div className="tile"><div className="small muted">Open findings</div><div className="big" data-testid="open-findings">{openCount}</div><div className="small muted">Weak not counted</div></div>
        <div className="tile"><div className="small muted">Kept · dismissed</div><div className="big">{decs.filter((d) => d.kind === "kept").length} · {decs.filter((d) => d.kind === "dismissed").length}</div></div>
      </div>

      <div className="row">
        <section aria-label="Teams and findings" className="stack" style={{ flex: "1.3 1 520px", minWidth: 0, gap: 12 }}>
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
              <button type="button" className="btn dashed" aria-pressed={showWeak} onClick={() => setShowWeak((w) => !w)}>{showWeak ? "Hide weak" : "Show weak"}</button>
            </div>
          </div>
          {rows.length === 0 && <div className="card sm muted">No teams match this filter.</div>}
          {rows.map((t) => <TeamCard key={t.team} t={t} prev={prevTeams?.find((x) => x.team === t.team) ?? null} prevLabel={prevSummary?.label ?? null} isLatest={isLatest}
            findingsById={findingsById} shownIds={shownIds} showWeak={showWeak} selId={selected?.id ?? null} decisions={dec.decisions}
            expanded={!collapsed[t.team]} onToggle={() => setCollapsed((c) => ({ ...c, [t.team]: !c[t.team] }))} onOpen={(id) => { setSel(id); setReason(""); }} />)}
        </section>

        <section aria-label="Finding detail" className="card" style={{ flex: "1 1 400px", padding: 22, gap: 16 }}>
          {!selected && (
            <div className="stack-sm">
              <h2>Finding detail</h2>
              <p className="sm muted">{isLatest ? "Pick a finding in a team to see its evidence." : `Findings are reviewed on the latest run. Switch to ${fmtDate(p.latestId)} to open one.`}</p>
            </div>
          )}
          {selected && (
            <div className="stack" style={{ gap: 16 }}>
              <div className="stack-sm" style={{ gap: 8 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }} className="small">
                  <span className={"pill " + selected.strength} style={{ padding: "2px 8px" }}>{selected.strength[0].toUpperCase() + selected.strength.slice(1)} evidence</span>
                  <span className="pill type" style={{ padding: "2px 8px" }}>{TYPE_LABEL[selected.gap_type]}</span>
                </div>
                <h2 style={{ fontSize: 22, lineHeight: 1.25 }}>{selected.title}</h2>
                <span className="muted">Owner: {selected.owner} <span className="small">{selected.owner_source === "team_list" && p.ownerSource !== "inferred" ? (p.ownerSource === "directory" ? "(from your directory)" : "(from your team list)") : "(inferred from Jira assignee)"}</span></span>
              </div>
              <div className="notice" style={{ display: "flex", flexDirection: "column", gap: 2 }} data-testid="suggested-action">
                <span className="eyebrow" style={{ color: "var(--blue-text)" }}>Suggested next action</span>
                <span>{prettyDates(selected.next_action?.action ?? selected.ask ?? selected.title)}</span>
                {selected.next_action && <span className="small">{selected.next_action.who} · {prettyDates(selected.next_action.by_when)}</span>}
              </div>
              <div className="box">
                <span className="eyebrow">Expected (plan)</span>
                <span>{planItem?.text ?? selected.plan_item_id}{planDue ? ` by ${fmtDate(planDue)}` : ""}</span>
                {planItem && <span className="small muted">Source: {sourceLabel(p.plan, planItem.source.file, planItem.source.locator)} · “{planItem.source.quote}”</span>}
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
                <div className="notice">Linkage gap: <span className="mono">{selected.linkage.from}</span> isn't linked to <span className="mono">{selected.linkage.to}</span>. Suggested link: <strong style={{ fontWeight: 500 }}>{selected.linkage.suggested_type}</strong></div>
              )}
              <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 16, gap: 12 }}>
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
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="stack" style={{ gap: 10 }}>
        <h2>Other linkage gaps</h2>
        <p className="sm muted">Related tickets not linked to the epic, with no finding behind them. Not counted toward the 10-finding cap.</p>
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

      <div className="row">
        <section className="stack" style={{ flex: "1.4 1 420px", minWidth: 0, gap: 10 }}>
          <h2>Upcoming plan dates</h2>
          <div className="card" style={{ padding: "6px 18px", gap: 0 }}>
            {upcoming.map((u, i) => (
              <div key={i} className="upcoming">
                <span style={{ fontWeight: 500 }}>{fmtDate(u.date)}</span>
                <span className="mono muted u-key">{u.key}</span>
                <span>{u.item}</span>
                <span className={u.cls === "launch" ? "sm" : "flag " + u.cls} style={u.cls === "launch" ? { fontWeight: 500 } : undefined}>{u.flag}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="stack" style={{ flex: "1 1 300px", minWidth: 0, gap: 10 }}>
          <h2>What this review can't see</h2>
          <div className="card sm text2" style={{ padding: "16px 18px" }}>
            <ul className="list" style={{ gap: 6 }}>
              <li>Anything agreed only in meetings, chat or email</li>
              <li>Approvals tracked in apps that aren't connected</li>
              <li>Whether the technical work itself is adequate</li>
            </ul>
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

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="button" className="btn" onClick={p.onChangeStage}>Change stage</button>
        <button type="button" className="btn" onClick={p.onAddFiles}>Add more files</button>
        <button type="button" className="btn" onClick={p.onConnectApps}>Connect more apps</button>
      </div>
    </div>
  );
}

function TeamCard(p: {
  t: TeamView; prev: TeamView | null; prevLabel: string | null; isLatest: boolean; findingsById: Record<string, Finding>; shownIds: string[]; showWeak: boolean;
  selId: string | null; decisions: Record<string, { kind: string; reason: string }>; expanded: boolean; onToggle: () => void; onOpen: (id: string) => void;
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
    <div className="team" data-testid={`team-${t.project_key}`}>
      <button type="button" className="team-head" aria-expanded={p.expanded} onClick={p.onToggle}>
        <span className="stack-sm" style={{ gap: 2 }}>
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600 }}>{t.team}</span>
            <span className={"badge " + t.status} data-testid="team-status">{STATUS_LABEL[t.status]}</span>
          </span>
          <span className="small muted"><span className="mono">{t.project_key}</span> · {t.role} · {openItems.length === 0 ? "no open gaps" : `${openItems.length} open · next ${fmtDate(next)}`}</span>
          <span className={"change" + (changed ? " changed" : "")}>{change}</span>
        </span>
        <span className="small muted">{p.expanded ? "Hide" : `Show ${t.items.length} items`}</span>
      </button>
      {p.expanded && (
        <div className="team-body">
          {t.items.map((i) => {
            const f = i.finding_id && p.isLatest ? p.findingsById[i.finding_id] : null;
            if (f && f.strength === "weak" && !p.showWeak) { hiddenWeak++; return null; }
            if (f && p.shownIds.includes(f.id)) {
              const d = p.decisions[f.id];
              return (
                <button key={i.plan_item_id} type="button" className={"finding-row" + (d?.kind === "dismissed" ? " dismissed" : "")} aria-pressed={p.selId === f.id} onClick={() => p.onOpen(f.id)}>
                  <span className="between" style={{ alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontWeight: 500 }}>{f.title}</span>
                    <span className="small" style={{ whiteSpace: "nowrap", fontSize: 12, color: d ? "var(--muted)" : "var(--amber-text)", fontWeight: d ? 400 : 500 }}>{!d ? "Open" : d.kind === "kept" ? "Kept" : "Dismissed"}</span>
                  </span>
                  <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <span className={"pill " + f.strength}>{f.strength[0].toUpperCase() + f.strength.slice(1)}</span>
                    <span className="pill type">{TYPE_LABEL[f.gap_type]}</span>
                    <span className="muted"><span className="mono" style={{ fontSize: 12 }}>{i.ticket ?? "—"}</span> · plan {fmtDate(i.plan_due_effective)} · Jira {fmtDate(i.jira_due)}</span>
                    {f.linkage && <span style={{ color: "var(--accent)" }}>· Linkage gap</span>}
                  </span>
                </button>
              );
            }
            return (
              <div key={i.plan_item_id} className="plain-row">
                <span className="stack-sm" style={{ gap: 0 }}>
                  <span>{i.text}</span>
                  <span className="muted" style={{ fontSize: 12 }}><span className="mono" style={{ fontSize: 12 }}>{i.ticket ?? "—"}</span> · {i.ticket_status} · plan {fmtDate(i.plan_due_effective)} · Jira {fmtDate(i.jira_due)}</span>
                </span>
                <span className={"flag " + i.effective}>{i.note_effective}</span>
              </div>
            );
          })}
          {hiddenWeak > 0 && <span className="small muted" style={{ padding: "0 4px" }}>{hiddenWeak} weak finding{hiddenWeak > 1 ? "s" : ""} hidden</span>}
        </div>
      )}
    </div>
  );
}
