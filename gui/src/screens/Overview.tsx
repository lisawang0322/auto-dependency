import { useState } from "react";
import type { HistoryRecord, ProjectEvent, Stage } from "../backend/types";
import { fmtDate } from "../model/dates";
import { STAGE_SHORT } from "./GetStarted";
import { LIFECYCLE } from "./Projects";

export interface CheckItem {
  id: string; label: string;
  /** done; todo (needed for this stage); optional (helps, not needed); waiting (needs an earlier item first) */
  state: "done" | "todo" | "optional" | "waiting";
  detail: string;
  action?: { label: string; go: () => void };
}
export interface NextUp { title: string; detail: string; action?: { label: string; go: () => void } }

interface Props {
  name: string; stage: Stage; nextStage: Stage | null;
  onMove: (s: Stage) => void; onChangeStage: () => void;
  notice: string | null; onDismissNotice: () => void;
  next: NextUp; items: CheckItem[];
  latest: HistoryRecord | null; onOpenReview: () => void;
  earlier: HistoryRecord[]; onOpenRecord: (r: HistoryRecord) => void;
  activity: ProjectEvent[]; onHistory: () => void;
}

const MARK: Record<CheckItem["state"], string> = { done: "✓", todo: "", optional: "", waiting: "" };
const NEED: Record<CheckItem["state"], string> = { done: "", todo: "Needed", optional: "Recommended", waiting: "Later" };

/** The project's hub: where it is in its life, the one thing to do next, what this stage still needs, what the last review found, and what happened lately. */
export function Overview(p: Props) {
  const at = LIFECYCLE.findIndex((l) => l.id === p.stage);
  const doneCount = p.items.filter((i) => i.state === "done" || i.state === "optional").length;
  const complete = p.items.every((i) => i.state === "done" || i.state === "optional");
  // A finished checklist folds to one line; it opens on request, and stays open while anything is left.
  const [showAll, setShowAll] = useState(false);
  const open = !complete || showAll;
  return (
    <div className="flow stack">
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">Overview</span>
        <h1 className="flow-title">{p.name}</h1>
        <p className="lead">Where this project is, what to do next, and what its latest review found. Everything else is one click from here.</p>
      </header>

      {p.notice && (
        <div className="notice-grey between" role="status" data-testid="overview-notice" style={{ gap: 12 }}>
          <span>{p.notice}</span>
          <button type="button" className="btn" style={{ minHeight: 32, padding: "0 10px" }} aria-label="Dismiss this note" onClick={p.onDismissNotice}>OK</button>
        </div>
      )}

      <section className="lifecycle" aria-label="Project stage" data-testid="lifecycle">
        <ol className="life-steps">
          {LIFECYCLE.map((l, i) => (
            <li key={l.id} className={i < at ? "past" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}><span className="life-num" aria-hidden="true">{i < at ? "✓" : i + 1}</span>{l.label}</li>
          ))}
        </ol>
        <div className="life-next">
          {p.nextStage && <button type="button" className="btn" onClick={() => p.onMove(p.nextStage!)}>Move to {STAGE_SHORT[p.nextStage].toLowerCase()}</button>}
          <button type="button" className="linkbtn" onClick={p.onChangeStage}>Change stage</button>
        </div>
      </section>

      <section className="card next-up" data-testid="next-up" aria-labelledby="next-title">
        <span className="eyebrow" style={{ color: "var(--accent)" }}>Next up</span>
        <h2 id="next-title" style={{ fontSize: 20 }}>{p.next.title}</h2>
        <p className="sm text2" style={{ margin: 0 }}>{p.next.detail}</p>
        {p.next.action && <div><button type="button" className="btn primary" style={{ padding: "0 20px" }} onClick={p.next.action.go}>{p.next.action.label}</button></div>}
      </section>

      <section className="card" style={{ gap: 12 }} data-testid="checklist" aria-labelledby="check-title">
        <div className="between" style={{ gap: 12, alignItems: "baseline" }}>
          <h2 id="check-title" className="h3">{complete ? `Everything ${STAGE_SHORT[p.stage].toLowerCase()} needs is in place` : `Ready for ${STAGE_SHORT[p.stage].toLowerCase()}`}</h2>
          {complete
            ? <button type="button" className="linkbtn" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>{showAll ? "Hide the checklist" : "Show the checklist"}</button>
            : <span className="small muted">{doneCount} of {p.items.length} done</span>}
        </div>
        {open && p.items.map((it) => (
          <div key={it.id} className="prep-row check-row" data-testid={`check-${it.id}`}>
            <span className={"prep-mark" + (it.state === "done" ? " done" : "")} aria-hidden="true">{MARK[it.state]}</span>
            <span className="prep-text">
              <span style={{ fontWeight: 500 }}>{it.label}</span>
              <span className={"small " + (it.state === "done" ? "muted" : it.state === "todo" ? "warn" : "muted")}>{it.detail}</span>
            </span>
            <span className="check-side">
              {NEED[it.state] && <span className={"prep-need " + (it.state === "todo" ? "required" : "")}>{NEED[it.state]}</span>}
              {it.action && it.state !== "waiting" && <button type="button" className="linkbtn" onClick={it.action.go}>{it.action.label}</button>}
            </span>
          </div>
        ))}
      </section>

      <section className="card" style={{ gap: 12 }} data-testid="latest-review" aria-labelledby="latest-title">
        <h2 id="latest-title" className="h3">Latest review</h2>
        {p.latest ? (
          <div className="between" style={{ gap: 16, alignItems: "flex-start" }}>
            <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{p.latest.title}</span>
              <span className="small muted">{fmtDate(p.latest.at.slice(0, 10))} · {STAGE_SHORT[p.latest.stage]}{p.latest.summary?.detail ? ` · ${p.latest.summary.detail}` : ""}</span>
              <div style={{ marginTop: 8 }}><button type="button" className="btn" onClick={p.onOpenReview}>Open the review</button></div>
            </div>
            <div className="project-status">
              {p.latest.summary?.status && <span className={"status-pill " + p.latest.summary.status.toLowerCase()}>{p.latest.summary.status}</span>}
              {p.latest.summary?.open != null && <span className="sm">{p.latest.summary.open} open action{p.latest.summary.open === 1 ? "" : "s"}</span>}
            </div>
          </div>
        ) : <p className="sm muted" style={{ margin: 0 }}>No review at this stage yet. The checklist above says what it needs.</p>}
        {p.earlier.length > 0 && (
          <div className="stack-sm" style={{ gap: 6, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
            <span className="eyebrow">Earlier reviews</span>
            {p.earlier.map((r) => (
              <div key={r.id} className="between" style={{ gap: 12 }}>
                <span className="sm">{r.title} <span className="small muted">· {fmtDate(r.at.slice(0, 10))} · {STAGE_SHORT[r.stage]}{r.summary?.status ? ` · ${r.summary.status}` : ""}</span></span>
                <button type="button" className="linkbtn" onClick={() => p.onOpenRecord(r)}>Open</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="stack" style={{ gap: 8 }} aria-labelledby="activity-title">
        <div className="between" style={{ gap: 12, alignItems: "baseline" }}>
          <h2 id="activity-title" className="h3">Recent activity</h2>
          <button type="button" className="linkbtn" onClick={p.onHistory}>All history</button>
        </div>
        <ol className="history" data-testid="activity">
          {[...p.activity].reverse().slice(0, 5).map((e, i) => (
            <li key={i}><span className="small muted mono">{fmtDate(e.at.slice(0, 10))} {e.at.slice(11, 16)}</span><span>{e.text}</span></li>
          ))}
        </ol>
      </section>
    </div>
  );
}
