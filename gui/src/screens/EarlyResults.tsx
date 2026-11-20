import { useEffect, useState } from "react";
import type { Starter, InvolveRole, CoverageState, ApprovalState } from "@rrr/schemas";
import type { DecisionStore, RunDecisions } from "../backend/types";
import { fmtDate, prettyDates } from "../model/dates";
import { STAGE_SHORT } from "./GetStarted";

/**
 * Step 4 for the early stages (PRD R16, R17, R18): next actions first, then for "Just starting" the
 * stakeholder map, teams to involve and approvals to plan for; for "Building" team coverage and
 * approval status against Jira. Everything comes from release-starter's output, filtered by the
 * signals the person left ticked.
 */

interface Props {
  starter: Starter;
  signalsOff: Record<string, boolean>;
  store: DecisionStore;
  /** What the projects home shows for this project. */
  onSummary?: (s: { status: string | null; open: number | null; detail: string | null }) => void;
  eyebrow?: string;
  /** A past record opened from History: shown as it was, nothing can be ticked or marked. */
  readOnly?: boolean;
  launch: string | null;
  onChangeStage: () => void; onAddFiles: () => void; onConnectApps: () => void;
}

const ROLE_LABEL: Record<InvolveRole, string> = { core: "Work with closely", consult: "Consult", approve: "Approves", inform: "Keep informed" };
const ROLE_DESC: Record<InvolveRole, string> = { core: "In the room every week", consult: "Ask before decisions", approve: "Must sign off", inform: "Update at milestones" };
const COV_LABEL: Record<CoverageState, string> = { covered: "Covered", unclear: "Unclear", missing: "Missing" };
const APPR_LABEL: Record<ApprovalState, string> = { done: "Done", started: "In progress", no_owner: "No owner", not_started: "Not started" };
const EMPTY: RunDecisions = { decisions: {}, log: [], actionsDone: {}, contacted: {} };

export function EarlyResults(p: Props) {
  const st = p.starter;
  const key = `starter:${st.stage}:${st.epic ?? st.project}/${st.label}`;
  const [saved, setSaved] = useState<RunDecisions>(EMPTY);
  useEffect(() => { let on = true; p.store.load(key).then((d) => { if (on) setSaved(d); }); return () => { on = false; }; }, [key, p.store]);
  const persist = (next: RunDecisions) => { setSaved(next); p.store.save(key, next); };
  const actionsDone = saved.actionsDone ?? {};
  const contacted = saved.contacted ?? {};

  // Anything implied only by unticked signals is left out.
  const on = (ids: string[]) => ids.length === 0 || ids.some((id) => !p.signalsOff[id]);
  const teams = st.teams.filter((t) => on(t.signal_ids));
  const approvals = st.approvals.filter((a) => on(a.signal_ids));
  const coverage = st.coverage.filter((c) => on(c.signal_ids));
  const approvalStatus = st.approval_status.filter((a) => on(a.signal_ids));
  const actions = st.next_actions.filter((a) => on(a.signal_ids));
  const openActions = actions.filter((a) => !actionsDone[a.id]).length;
  const starting = st.stage === "starting";
  const covered = coverage.filter((c) => c.state === "covered").length;
  const missing = coverage.filter((c) => c.state === "missing").length;
  const openNow = (st.next_actions ?? []).filter((a) => !(saved.actionsDone ?? {})[a.id]).length;
  useEffect(() => {
    if (p.readOnly) return;
    p.onSummary?.(st.stage === "starting"
      ? { status: null, open: openNow, detail: `${st.teams.length} teams to involve` }
      : { status: missing ? "Red" : coverage.some((c) => c.state === "unclear") ? "Amber" : "Green", open: openNow, detail: `${covered} of ${coverage.length} teams covered` });
  }, [openNow, missing, covered]); // eslint-disable-line react-hooks/exhaustive-deps
  const unclear = coverage.filter((c) => c.state === "unclear").length;
  const notStarted = approvalStatus.filter((a) => a.state === "not_started").length;
  const personOf = (team: string, contact: string | null) => contact ?? `${team} lead — connect your directory for a name`;

  return (
    <div className="flow stack">
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">{p.eyebrow ?? "Step 4 of 4"} · {STAGE_SHORT[st.stage]}</span>
        <h1 className="flow-title">{starting ? "Who to involve, and what to do first" : "Who's missing, and what hasn't started"}</h1>
        <p className="lead">{starting
          ? `From ${st.files.filter((f) => f.read_as.includes("plan_items")).map((f) => f.name).join(", ")}${st.directory_given ? " and your directory" : ""} · ${teams.length} teams suggested`
          : `From your plan and ${st.epic} in Jira · the ${fmtDate(st.snapshot_label)} snapshot`}</p>
      </header>

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
              <input id={`act-${a.id}`} type="checkbox" checked={done} disabled={p.readOnly} onChange={() => persist({ ...saved, actionsDone: { ...actionsDone, [a.id]: !done } })} />
              <label htmlFor={`act-${a.id}`}>
                <span className={done ? "done" : ""} style={done ? undefined : { fontWeight: 500 }}>{prettyDates(a.text)}</span>
                <span className="small muted"><strong style={{ fontWeight: 500, color: "var(--text-2)" }}>{a.who}</strong> · {a.when} · {a.why}</span>
              </label>
            </div>
          );
        })}
      </section>

      {starting && (
        <div className="stack" style={{ gap: 22 }}>
          {!st.directory_given && (
            <div className="between notice" style={{ gap: 10 }}>
              <span>Connect your employee directory to see who to contact on each team.</span>
              <button type="button" className="btn outline-accent" style={{ padding: "0 14px" }} onClick={p.onConnectApps}>Connect directory</button>
            </div>
          )}
          {/* One map: the teams grouped by how closely to involve them, each with why, when and who. */}
          <section className="stack" style={{ gap: 16 }} data-testid="stakeholder-map" aria-labelledby="involve-title">
            <h2 id="involve-title">Who to involve</h2>
            <div className="stack" style={{ gap: 20 }} data-testid="teams-to-involve">
              {(["core", "consult", "approve", "inform"] as InvolveRole[]).filter((role) => teams.some((t) => t.role === role)).map((role) => (
                <div key={role} className="role-group" data-testid={`role-${role}`}>
                  <div className="role-head">
                    <span style={{ fontWeight: 600 }}>{role === "approve" ? "Approve" : ROLE_LABEL[role]}</span>
                    <span className="small muted">{ROLE_DESC[role]}</span>
                  </div>
                  <div className="engage-grid">
                    {teams.filter((t) => t.role === role).map((t) => {
                      const done = !!contacted[t.team];
                      return (
                        <div key={t.team} className="card" style={{ padding: 16, gap: 8 }} data-testid={`involve-${t.team}`}>
                          <span style={{ fontWeight: 600, fontSize: 16 }}>{t.team}</span>
                          <span className="sm text2">{t.why}</span>
                          <span className="small muted">Involve: <strong style={{ fontWeight: 500, color: "var(--ink)" }}>{t.when}</strong></span>
                          <div className="contact-row">
                            <span className={"sm" + (t.contact ? "" : " muted")}>{personOf(t.team, t.contact)}</span>
                            <button type="button" className={"btn" + (done ? " contacted" : "")} style={{ padding: "0 12px", fontSize: 14 }} aria-pressed={done} disabled={p.readOnly} onClick={() => persist({ ...saved, contacted: { ...contacted, [t.team]: !done } })}>{done ? "Contacted" : "Mark contacted"}</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="stack" style={{ gap: 10 }}>
            <h2>Approvals you'll need</h2>
            <div className="card" style={{ padding: "4px 18px", gap: 0 }} data-testid="approvals">
              {approvals.map((a) => (
                <div key={a.name} className="approval-row">
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  <span className="text2">{a.why}</span>
                  <span className="muted">Start: {a.start}</span>
                </div>
              ))}
              {approvals.length === 0 && <p className="sm muted" style={{ padding: "10px 0" }}>No approvals implied by the signals you kept.</p>}
            </div>
          </section>
        </div>
      )}

      {!starting && (
        <div className="stack" style={{ gap: 22 }}>
          <div className="tiles">
            <div className={"tile " + (missing + unclear > 0 ? "amber" : "green")}>
              <div className="small">Teams covered</div>
              <div className="big" data-testid="covered-count">{covered} of {coverage.length}</div>
              <div className="small">{missing} missing · {unclear} unclear</div>
            </div>
            <div className="tile"><div className="small muted">Approvals not started</div><div className="big" data-testid="not-started-count">{notStarted} of {approvalStatus.length}</div></div>
            <div className="tile"><div className="small muted">Epic</div><div className="big mono" style={{ fontSize: 20 }}>{st.epic}</div><div className="small muted">{p.launch ? `Launch ${fmtDate(p.launch)} · from the fix version` : "No launch date yet"}</div></div>
          </div>

          <section className="stack" style={{ gap: 10 }}>
            <h2>Team coverage</h2>
            <p className="sm muted">Teams your plan needs, compared with who is actually working on {st.epic} in Jira.</p>
            <div className="table-wrap">
              <table className="coverage-table">
                <thead><tr><th>Team</th><th>Status</th><th>What we found</th><th>Who to bring in</th></tr></thead>
                <tbody>
                  {coverage.map((c) => (
                    <tr key={c.team} data-testid={`coverage-${c.team}`}>
                      <td style={{ fontWeight: 500 }}>{c.team}</td>
                      <td><span className={"cov " + c.state}>{COV_LABEL[c.state]}</span></td>
                      <td className="sm text2">{c.found}</td>
                      <td className="sm">{c.state === "covered" ? "—" : personOf(c.team, c.contact)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stack" style={{ gap: 10 }}>
            <h2>Approvals</h2>
            <div className="card" style={{ padding: "4px 18px", gap: 0 }} data-testid="approval-status">
              {approvalStatus.map((a) => (
                <div key={a.name} className="approval-row" data-testid={`approval-${a.name}`}>
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  <span><span className={"cov " + (a.state === "done" || a.state === "started" ? "covered" : a.state === "no_owner" ? "unclear" : "missing")}>{APPR_LABEL[a.state]}</span></span>
                  <span className="text2">{prettyDates(a.detail)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {st.warnings.length > 0 && <div className="notice-grey">{st.warnings.join(" ")}</div>}

      <section className="limits" aria-labelledby="limits-title">
        <h2 id="limits-title" className="h3">What this review can't see</h2>
        <p className="sm muted">Anything agreed only in meetings, chat or email; approvals tracked in apps that aren't connected; and whether the technical work itself is adequate.</p>
      </section>

      {!p.readOnly && <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="button" className="btn" onClick={p.onChangeStage}>Change stage</button>
        <button type="button" className="btn" onClick={p.onAddFiles}>Add more files</button>
        <button type="button" className="btn" onClick={p.onConnectApps}>Connect more apps</button>
      </div>}
    </div>
  );
}
