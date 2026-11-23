import { useState } from "react";
import { counts, firstSeenLabel, type Commitment } from "@throughline/schemas";
import { fmtDate } from "../model/dates";
import { Info } from "./Info";

/**
 * The project's commitments (PRD "Commitments: one list the stages share"): the teams and approvals it has
 * promised, each from the stage that first named it, with its ticket, what the latest review flagged, and the
 * PM's call. Dropping takes a reason and holds across later reviews; reopening undoes it.
 */

interface Props {
  commitments: Commitment[];
  onDecide: (id: string, kind: "dropped" | "reopen", reason: string) => void;
  readOnly?: boolean;
  /** A heading and a line for a list that is a slice of the commitments (e.g. what the launch plan left out). */
  title?: string; intro?: string;
}

const STATE: Record<Commitment["state"], { label: string; cls: string }> = {
  proposed: { label: "Proposed", cls: "cov unclear" }, open: { label: "Open", cls: "cov unclear" }, tracked: { label: "Tracked", cls: "cov covered" },
  done: { label: "Done", cls: "cov covered" }, dropped: { label: "Dropped", cls: "cov unclear" },
};
const SHOWN = 6;

export function Commitments(p: Props) {
  const [all, setAll] = useState(false);
  const [dropping, setDropping] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const n = counts(p.commitments);
  // What needs the PM first: flagged items, then open and tracked, then done and dropped; approvals before teams.
  const rank = (c: Commitment) => (c.state === "dropped" ? 4 : c.state === "done" ? 3 : c.flags.length ? 0 : c.state === "open" ? 1 : 2) * 2 + (c.kind === "approval" ? 0 : 1);
  const sorted = [...p.commitments].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const list = all ? sorted : sorted.slice(0, SHOWN);
  const fmt = (iso: string) => fmtDate(iso);

  return (
    <section className="card" style={{ gap: 12 }} data-testid="commitments" aria-labelledby="commit-title">
      <div className="between" style={{ gap: 12, alignItems: "baseline" }}>
        <h2 id="commit-title" className="h3">{p.title ?? "Commitments"}<Info>{p.intro ?? "What this project has promised, carried from the review that first named it. Each review checks them again; your calls hold until you change them."}</Info></h2>
        <span className="small muted" data-testid="commit-counts">{n.open} open · {n.atRisk} at risk · {n.done} done · {n.dropped} dropped</span>
      </div>
      {p.commitments.length === 0 && <p className="sm muted" style={{ margin: 0 }}>Nothing yet. The first review adds the teams and approvals your plan needs.</p>}
      <div className="stack-sm" style={{ gap: 0 }}>
        {list.map((c) => (
          <div key={c.id} className="commit-row" data-testid={`commit-${c.id}`}>
            <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
              <span><span style={{ fontWeight: 600 }}>{c.kind === "team" ? c.team : c.what}</span>{c.kind === "approval" && !c.what.toLowerCase().startsWith(c.team.toLowerCase()) && <span className="muted"> · {c.team}</span>}{c.kind === "team" && <span className="muted"> · team to involve</span>}</span>
              <span className="small muted" data-testid="first-seen">Since {firstSeenLabel(c, fmt)}{c.ticket ? ` · ${c.ticket.key}` : ""}</span>
              {c.flags.length > 0 && c.state !== "dropped" && <span className="small" style={{ color: "var(--amber)" }} data-testid="flags">{c.flags.join(" · ")}</span>}
              {c.decision?.kind === "dropped" && <span className="small muted">Dropped {fmt(c.decision.at)}: {c.decision.reason}</span>}
              {dropping === c.id && (
                <form className="row" style={{ gap: 8, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); if (!reason.trim()) return; p.onDecide(c.id, "dropped", reason.trim()); setDropping(null); setReason(""); }}>
                  <input className="input" style={{ height: 36 }} aria-label={`Why drop ${c.what}`} placeholder="Why it no longer applies" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                  <button type="submit" className="btn" style={{ minHeight: 36 }} disabled={!reason.trim()}>Drop</button>
                  <button type="button" className="linkbtn" style={{ minHeight: 36 }} onClick={() => { setDropping(null); setReason(""); }}>Cancel</button>
                </form>
              )}
            </div>
            <div className="row" style={{ gap: 10, alignItems: "baseline", justifyContent: "flex-end" }}>
              <span className={STATE[c.state].cls}>{STATE[c.state].label}</span>
              {!p.readOnly && (c.state === "dropped"
                ? <button type="button" className="linkbtn" onClick={() => p.onDecide(c.id, "reopen", "")}>Reopen</button>
                : dropping !== c.id && c.state !== "done" && <button type="button" className="linkbtn" aria-label={`Drop ${c.kind === "team" ? c.team : c.what}`} onClick={() => { setDropping(c.id); setReason(""); }}>Drop</button>)}
            </div>
          </div>
        ))}
      </div>
      {sorted.length > SHOWN && <button type="button" className="linkbtn" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${sorted.length}`}</button>}
    </section>
  );
}
