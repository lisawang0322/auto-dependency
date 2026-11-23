import { useState } from "react";
import type { ProjectRecord, Stage, UserInfo } from "../backend/types";
import { fmtDate } from "../model/dates";

export const LIFECYCLE: { id: Stage; label: string }[] = [
  { id: "starting", label: "Just starting" },
  { id: "building", label: "Building" },
  { id: "launching", label: "Preparing to launch" },
];

/** Three dots for where a project is in its life; the current one filled, the ones behind it ticked. */
export function LifecycleDots({ stage }: { stage: Stage | null | undefined }) {
  const at = LIFECYCLE.findIndex((l) => l.id === stage);
  return (
    <span className="life-dots" aria-label={at >= 0 ? `Stage ${at + 1} of 3: ${LIFECYCLE[at].label}` : "No stage yet"}>
      {LIFECYCLE.map((l, i) => <span key={l.id} className={"life-dot" + (i < at ? " past" : i === at ? " now" : "")} />)}
      <span className="small muted">{at >= 0 ? LIFECYCLE[at].label : "Not set up yet"}</span>
    </span>
  );
}


interface Props {
  projects: ProjectRecord[] | null; error: string | null; live: boolean; user: UserInfo | null; siteLabel: string;
  onOpen: (p: ProjectRecord) => void; onCreate: () => void; onDelete: (p: ProjectRecord) => void; onSignOut?: () => void;
}

/** The portal's home: every project the person has, where each is, and what is open on it. */
export function ProjectsHome(p: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const list = p.projects ?? [];
  return (
    <div>
      <header className="top">
        <div className="wrap top-row">
          <div className="brand"><span className="name">Throughline</span><span className="muted">Projects</span></div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <span className="tag">{p.live ? `Live · ${p.siteLabel}` : "Sample data"}</span>
            {p.user && <span className="tag" data-testid="user-chip" title={p.user.email ?? undefined}>{p.user.name}</span>}
            {p.onSignOut && <button type="button" className="btn" style={{ minHeight: 32, padding: "0 12px", fontSize: 14 }} onClick={p.onSignOut}>Sign out</button>}
          </div>
        </div>
      </header>
      <main className="wrap page">
        <div className="flow stack">
          <header className="between" style={{ gap: 16, alignItems: "flex-end" }}>
            <div className="stack-sm" style={{ gap: 8 }}>
              <span className="eyebrow">Your projects</span>
              <h1 className="flow-title">Projects</h1>
              <p className="lead">From the first PRD to launch. Add only what changed.</p>
            </div>
            <button type="button" className="btn primary" style={{ padding: "0 20px", flex: "none" }} onClick={p.onCreate}>New project</button>
          </header>

          {p.error && <div className="notice-grey" role="alert">{p.error}</div>}
          {p.projects === null && !p.error && <p className="sm muted">Loading your projects…</p>}

          {p.projects !== null && list.length === 0 && (
            <section className="card empty-projects" data-testid="no-projects">
              <h2 className="h3">No projects yet</h2>
              <p className="sm muted">Start one for anything you're planning or shipping.</p>
              <div><button type="button" className="btn primary" onClick={p.onCreate}>New project</button></div>
            </section>
          )}

          {list.length > 0 && (
            <ul className="project-list" aria-label="Projects">
              {list.map((r) => {
                const d = r.data ?? {};
                const s = d.summary;
                const launch = d.stage === "launching" ? (d.launch || d.plan?.launch_date || null) : null;
                return (
                  <li key={r.id} className="project-card" data-testid={`project-${r.name}`}>
                    <button type="button" className="project-open" onClick={() => p.onOpen(r)} aria-label={`Open ${r.name}`}>
                      <span className="stack-sm" style={{ gap: 6, minWidth: 0 }}>
                        <span className="project-name">{r.name}</span>
                        <LifecycleDots stage={d.stage} />
                        {(d.epic || launch) && <span className="small muted">{[d.epic ? d.epic : null, launch ? `Launch ${fmtDate(launch)}` : null].filter(Boolean).join(" · ")}</span>}
                      </span>
                      <span className="project-status">
                        {s?.status && <span className={"status-pill " + s.status.toLowerCase()}>{s.status}</span>}
                        {s && s.open !== null ? <span className="sm">{s.open} open action{s.open === 1 ? "" : "s"}</span> : <span className="sm muted">{d.stage ? "Not reviewed yet" : "Setup not finished"}</span>}
                        {s?.detail && <span className="small muted">{s.detail}</span>}
                      </span>
                    </button>
                    <div className="project-foot">
                      {confirming !== r.id && <span className="small muted">Updated {fmtDate(r.updated_at.slice(0, 10))}</span>}
                      {confirming === r.id ? (
                        <span className="sm" role="alert" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                          Delete {r.name}, with its files and readings? This cannot be undone.
                          <button type="button" className="btn danger" onClick={() => { setConfirming(null); p.onDelete(r); }}>Delete</button>
                          <button type="button" className="linkbtn" onClick={() => setConfirming(null)}>Keep it</button>
                        </span>
                      ) : (
                        <button type="button" className="linkbtn muted-link" onClick={() => setConfirming(r.id)}>Delete</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
