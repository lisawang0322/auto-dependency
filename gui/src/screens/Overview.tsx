import { useState, type ReactNode } from "react";
import type { HistoryRecord, Stage, ActionsGlance, PathStep } from "../backend/types";
import { NOT_IN_PLAN, type Commitment } from "@throughline/schemas";
import { Commitments } from "./Commitments";
import { fmtDate } from "../model/dates";
import { STAGE_SHORT } from "./GetStarted";
import { Info } from "./Info";

export interface CheckItem {
  id: string; label: string;
  /** done; todo (needed for the review); optional (helps, not needed); waiting (needs an earlier item first) */
  state: "done" | "todo" | "optional" | "waiting";
  detail: string;
  action?: { label: string; go: () => void };
}
export interface NextUp { title: string; detail: string; action?: { label: string; go: () => void }; /** A quieter alternative, as a link. */ more?: { label: string; go: () => void } }

interface Props {
  name: string; stage: Stage;
  /** The project's path: which checks ran, and the one the suggestion leads to. */
  path: PathStep[];
  /** This review includes the PRD's check: the teams only the PRD names are then cards on the page, not a list. */
  hasPrdReview?: boolean;
  notice: string | null; onDismissNotice: () => void;
  next: NextUp; items: CheckItem[];
  earlier: HistoryRecord[]; onOpenRecord: (r: HistoryRecord) => void;
  /** The stage's review, once it has one: the page then is the review, framed by the stage and what comes next. */
  review?: ReactNode;
  onOpenFiles: () => void; onOpenConnections: () => void;
  /** The review's checklist: the panel lists it, beside the team cards it points to. */
  actions: ActionsGlance | null;
  onHistory: () => void;
  commitments: Commitment[]; onCommitment: (id: string, kind: "dropped" | "reopen", reason: string) => void;
}

const MARK: Record<CheckItem["state"], string> = { done: "✓", todo: "", optional: "", waiting: "" };
const NEED: Record<CheckItem["state"], string> = { done: "", todo: "Needed", optional: "Recommended", waiting: "Later" };

/**
 * The project's page, in two columns on a wide screen. The main column is the work: before the stage is reviewed, the one
 * thing to do next and what the stage still needs; once reviewed, the review itself, a card per team. Beside it, "at a
 * glance" keeps the stage and the next move, the checklist of next actions, and the links to files, connections and
 * history in view while the main column scrolls.
 */
export function Overview(p: Props) {
  const doneCount = p.items.filter((i) => i.state === "done" || i.state === "optional").length;
  const complete = p.items.every((i) => i.state === "done" || i.state === "optional");
  // A finished checklist folds to one line; it opens on request, and stays open while anything is left.
  const [showAll, setShowAll] = useState(false);
  const open = !complete || showAll;

  const notice = p.notice && (
    <div className="notice-grey between" role="status" data-testid="overview-notice" style={{ gap: 12 }}>
      <span>{p.notice}</span>
      <button type="button" className="btn" style={{ minHeight: 32, padding: "0 10px" }} aria-label="Dismiss this note" onClick={p.onDismissNotice}>OK</button>
    </div>
  );
  const reviewed = !!p.review;
  // Once reviewed, each commitment is on its team's card (the early stages) or, at launch, with its finding or in the list
  // of what the launch plan left out.
  const leftOut = p.commitments.filter((c) => c.flags.includes(NOT_IN_PLAN) || c.state === "dropped");
  const openCount = p.actions ? p.actions.items.filter((a) => !a.done).length : 0;
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  /** Beside the page (above it on a narrow screen): where the project is and what comes next, then the checklist, the
   *  review's next actions, each leading to the team card that says why. The cards are the page; the checklist is here. */
  const glance = (
    <aside className="glance" aria-label="Project at a glance" data-testid="glance">
      <section className="glance-sec" aria-label="Project stage" data-testid="lifecycle">
        {/* Where the project stands is read from what it has (a plan of record, work in Jira, a PRD); it is never chosen. */}
        <div className="stack-sm" style={{ gap: 2 }}>
          <span className="eyebrow">Where it stands</span>
          <span style={{ fontWeight: 600 }} data-testid="phase">{STAGE_SHORT[p.stage]}</span>
        </div>
        {reviewed && (
          <ol className="path" data-testid="path" aria-label="The project's path">
            {p.path.map((s) => (
              <li key={s.id} className={s.state} data-testid={`path-${s.id}`} aria-current={s.state === "next" ? "step" : undefined}>
                <span className="path-dot" aria-hidden="true">{s.state === "done" ? "✓" : ""}</span>
                <span className="sm path-label">{s.label}<span className="sr-only">{s.state === "done" ? " (checked)" : s.state === "next" ? " (next)" : ""}</span></span>
              </li>
            ))}
          </ol>
        )}
        {reviewed && (
          <div className="glance-next" data-testid="next-up">
            <span style={{ fontWeight: 600 }}>{p.next.title}{p.next.detail && <Info>{p.next.detail}</Info>}</span>
            {p.next.action && <button type="button" className="btn outline-accent" style={{ alignSelf: "flex-start" }} onClick={p.next.action.go}>{p.next.action.label}</button>}
            {p.next.more && <button type="button" className="linkbtn" style={{ alignSelf: "flex-start" }} onClick={p.next.more.go}>{p.next.more.label}</button>}
          </div>
        )}
      </section>

      {reviewed && p.actions && (
        <section className="glance-sec" aria-labelledby="glance-actions" data-testid="next-actions">
          <div className="between" style={{ gap: 8, alignItems: "baseline" }}>
            <h2 id="glance-actions" className="h3" style={{ margin: 0 }}>Your next actions</h2>
            <span className="small muted" data-testid="actions-count">{openCount} open · {p.actions.items.length - openCount} done</span>
          </div>
          {p.actions.items.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing open.</p>}
          {/* A status list, in the review's order: actions are marked done on their team's card (or finding), where the why is,
              and each line here leads there. */}
          <ol className="glance-actions">
            {p.actions.items.map((a) => (
              <li key={a.id} className={"glance-action" + (a.done ? " is-done" : "")}>
                <span className={"status-mark" + (a.done ? " done" : "")} aria-hidden="true">{a.done ? "✓" : ""}</span>
                <button type="button" className="glance-action-btn" onClick={() => p.actions!.jump(a.id)}
                  aria-label={`${a.text}${a.done ? " (done)" : ""}${a.team ? `. Go to ${a.team}` : ""}`}>
                  <span className={"sm" + (a.done ? " done" : "")} style={a.done ? undefined : { fontWeight: 500 }}>{a.text}</span>
                  <span className="small muted">{a.detail}{a.kept ? " · kept" : ""}{a.team ? ` · ${a.team} ›` : ""}</span>
                </button>
              </li>
            ))}
          </ol>
          {p.actions.later && (
            <button type="button" className="linkbtn" style={{ minHeight: 32, alignSelf: "flex-start" }} data-testid="later-note" onClick={() => jumpTo(p.actions!.later!.anchor)}>
              {p.actions.later.teams} more coming up · {p.actions.later.when.join(", ")} ›
            </button>
          )}
          {p.stage === "launching" && p.hasPrdReview && (
            <button type="button" className="linkbtn" style={{ minHeight: 32, alignSelf: "flex-start" }} onClick={() => jumpTo("prd-teams")}>Teams only your PRD names ›</button>
          )}
          {p.stage === "launching" && !p.hasPrdReview && leftOut.filter((c) => c.state !== "dropped").length > 0 && (
            <button type="button" className="linkbtn" style={{ minHeight: 32, alignSelf: "flex-start" }} onClick={() => jumpTo("commitments")}>
              {leftOut.filter((c) => c.state !== "dropped").length} named earlier, not in the launch plan ›
            </button>
          )}
        </section>
      )}

      <nav className="glance-sec project-links" aria-label="Files, connections and history" data-testid="project-links">
        <button type="button" className="linkbtn" onClick={p.onOpenFiles}>Files and reading</button>
        <button type="button" className="linkbtn" onClick={p.onOpenConnections}>Connections</button>
        <button type="button" className="linkbtn" onClick={p.onHistory}>History{p.earlier.length ? ` · ${p.earlier.length} earlier review${p.earlier.length === 1 ? "" : "s"}` : ""}</button>
      </nav>
    </aside>
  );

  const main = reviewed ? (
    <div className="project-main stack" style={{ gap: 24 }}>
      {notice}
      {!complete && (
        <section className="notice between" data-testid="checklist" style={{ gap: 12 }}>
          <span>Something the review needs has changed since it ran: {p.items.filter((i) => i.state === "todo").map((i) => i.label.toLowerCase()).join(", ")}.</span>
          {p.items.find((i) => i.state === "todo")?.action && <button type="button" className="btn" onClick={p.items.find((i) => i.state === "todo")!.action!.go}>{p.items.find((i) => i.state === "todo")!.action!.label}</button>}
        </section>
      )}
      {p.review}
      {/* At launch the team cards come from the plan of record; what an earlier stage promised and the POR leaves out
          would otherwise vanish, so it is listed under the review, with Drop for what no longer applies. */}
      {p.stage === "launching" && !p.hasPrdReview && leftOut.length > 0 && (
        <div id="commitments"><Commitments commitments={leftOut} onDecide={p.onCommitment}
          title="Named earlier, not in the launch plan"
          intro="Teams and approvals named earlier that the plan of record leaves out. Confirm each is still needed, or drop it with a reason." /></div>
      )}
    </div>
  ) : (
    <div className="project-main stack" style={{ gap: 24 }}>
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">{STAGE_SHORT[p.stage]}</span>
        <h1 className="flow-title">{p.name}</h1>
        <p className="lead">What the review needs</p>
      </header>

      {notice}

      <section className="card next-up" data-testid="next-up" aria-labelledby="next-title">
        <span className="eyebrow" style={{ color: "var(--accent)" }}>Next up</span>
        <h2 id="next-title" style={{ fontSize: 20 }}>{p.next.title}</h2>
        <p className="sm text2" style={{ margin: 0 }}>{p.next.detail}</p>
        {p.next.action && <div><button type="button" className="btn primary" style={{ padding: "0 20px" }} onClick={p.next.action.go}>{p.next.action.label}</button></div>}
      </section>

      <section className="card" style={{ gap: 12 }} data-testid="checklist" aria-labelledby="check-title">
        <div className="between" style={{ gap: 12, alignItems: "baseline" }}>
          <h2 id="check-title" className="h3">{complete ? "Everything the review needs is in place" : "What the review needs"}</h2>
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
        <p className="sm muted" style={{ margin: 0 }}>No review since the files changed.</p>
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

      <div id="commitments"><Commitments commitments={p.commitments} onDecide={p.onCommitment} /></div>
    </div>
  );

  return <div className="project-layout">{main}{glance}</div>;
}
