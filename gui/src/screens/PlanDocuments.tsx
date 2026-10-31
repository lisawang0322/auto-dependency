import { useState } from "react";
import type { PlanDraft, Signal } from "@rrr/schemas";
import { PLAN_KINDS, type UploadedFile, type FileKind, type Stage, type AgentInfo, type AgentConsent, type AgentRead, type AgentReadStage } from "../backend/types";
import { fmtDate } from "../model/dates";

/** Step 2 (PRD R1–R3, R14): add plan files in any format, see what was read from them, fix dates, confirm. */

/** The agent (Devin) that can read the uploads: whether the company set it up, the person's answer, and what it did. */
export interface AgentPanel { info: AgentInfo; consent: AgentConsent; setConsent: (c: AgentConsent) => void; mode: string | null; setMode: (m: string | null) => void; stage: AgentReadStage | null; /** A read of any kind is in flight. */ reading: boolean; read: AgentRead | null; /** Read (or re-read) the current files: with the agent, or with the rules alone. */ read_now: (withAgent: boolean) => void }

/** The Devin tier picker, shown only when the company lets people choose. */
export function ModeSelect({ agent, id }: { agent: Pick<AgentPanel, "info" | "mode" | "setMode">; id: string }) {
  const modes = agent.info.modes ?? [];
  if (modes.length < 2) return null;
  const value = agent.mode && modes.includes(agent.mode) ? agent.mode : "";
  // One row, the height of a button, so it sits level with the button beside it: label, then the select with its own chevron.
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <label htmlFor={id} className="sm muted" style={{ whiteSpace: "nowrap" }}>Reading mode</label>
      <select id={id} className="input" style={{ width: "auto", minWidth: 200 }} value={value} title="Devin's agent tier for this reading; heavier tiers cost more of the ACU cap." onChange={(e) => agent.setMode(e.target.value || null)}>
        <option value="">Company default{agent.info.default_mode ? ` (${agent.info.default_mode})` : ""}</option>
        {modes.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </div>
  );
}

interface Props {
  stage: Stage;
  agent: AgentPanel;
  files: UploadedFile[];
  plan: PlanDraft | null;
  planError: string | null;
  planDates: Record<string, string>;
  /** The early stages: sentences of the PRD that imply a team, which the person can untick. */
  signals: Signal[];
  signalsOff: Record<string, boolean>;
  onToggleSignal: (id: string) => void;
  /** One line about something the app did on its own (a stage change kept the files; sample files replaced yours). */
  notice: string | null;
  onDismissNotice: () => void;
  onAddFiles: (list: FileList | File[] | null) => void;
  onSetKind: (id: string, kind: FileKind) => void;
  onRemove: (id: string) => void;
  onLoadSample: () => void;
  onSetDate: (id: string, value: string) => void;
  onBack: () => void;
  onConfirm: () => void;
}

const KIND_LABEL: Record<string, string> = { deliverable: "Deliverable", dependency: "Dependency", approval: "Approval", checklist: "Checklist" };

export const PLAN_INTRO: Record<Stage, string> = {
  starting: "A PRD or one-pager is enough to start. Add an org chart if you have one.",
  building: "Add your plan, plus a team list or org chart if you have one.",
  launching: "Add your plan of record — doc or slides — plus your launch checklist if your company has one.",
};

/** What a file gave us, in plain words. The reader's own note (a log-like count line) stays in the tooltip. */
export function fileSummary(entry: { read_as: string[]; notes: string }): string {
  const n = entry.notes;
  if (!n) return "";
  const standIn = /sample data stands in/.test(n) ? " · sample data stands in for this file" : "";
  const done = (s: string) => s + standIn;
  if (entry.read_as.includes("launch_checks")) { const m = n.match(/(\d+) checks · (\d+) apply/); return done(m ? `${m[2]} of ${m[1]} checks apply to this release` : n); }
  if (entry.read_as.includes("teams_and_owners")) { const m = n.match(/(\d+) teams.*?(\d+) (?:owners|people)/); return done(m ? `${m[1]} teams, ${m[2]} people` : n); }
  if (entry.read_as.includes("plan_items")) {
    const sig = n.match(/(\d+) signals/);
    if (sig) return done(`${sig[1]} line${sig[1] === "1" ? "" : "s"} point to a team or an approval`);
    const items = n.match(/(\d+) plan items/), slides = n.match(/(\d+) slides/), teams = n.match(/names (\d+) teams/), epic = n.match(/epic ([A-Z][A-Z0-9]+-\d+)/), agent = n.match(/(\d+) items? read by the agent/);
    if (!items) return n;
    return done([`${items[1]} commitment${items[1] === "1" ? "" : "s"} found${slides ? ` on ${slides[1]} slides` : ""}`, teams ? `${teams[1]} teams named` : null, epic ? `epic ${epic[1]}` : null, agent ? `${agent[1]} from the agent` : null].filter(Boolean).join(" · "));
  }
  return n;
}

export function sourceShort(plan: PlanDraft, file: string): string {
  const f = plan.files.find((x) => x.name === file);
  return f?.read_as.includes("launch_checks") ? "Launch checklist" : f?.read_as.includes("plan_items") ? "POR" : file;
}
export function sourceLabel(plan: PlanDraft, file: string, locator: string): string {
  return `${sourceShort(plan, file)} ${locator}`;
}

export function PlanDocuments(p: Props) {
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const filesOf = (k: FileKind) => p.files.filter((f) => f.kind === k);
  const planFiles = p.files.filter((f) => PLAN_KINDS.includes(f.kind));
  const hasPlan = planFiles.length > 0;
  const hasChecklist = filesOf("checks").length > 0;
  const teamFiles = filesOf("teams");
  const hasOrg = teamFiles.length > 0;
  const viaDirectory = teamFiles.some((f) => f.via === "directory");
  const notReady = !hasPlan || !p.plan;
  const launching = p.stage === "launching";
  const rows = p.plan?.items ?? [];
  const planCount = rows.filter((r) => r.kind !== "checklist").length;
  const checkTotal = p.plan?.files.find((f) => f.read_as.includes("launch_checks"))?.notes.match(/(\d+) checks/)?.[1];
  const checkApplied = rows.filter((r) => r.kind === "checklist").length;
  const inferredCount = rows.filter((r) => r.due_is_inferred && !(p.planDates[r.id] !== undefined && p.planDates[r.id] !== (r.due ?? ""))).length;
  const agent = p.agent;
  const reading = agent.stage !== null;
  const readingAny = reading || agent.reading;
  /** The question is asked once: the first read decides whether Devin is used, and the choice is remembered. */
  const devinOffer = agent.info.available && agent.consent === "unknown";
  const read = agent.read;
  const agentOn = agent.info.available && agent.consent === "yes";
  /** What goes to Devin: every upload but "other"; the directory connector's export is structured data, not a document. */
  const docs = p.files.filter((f) => f.kind !== "other" && f.via !== "directory");
  /** "5 plan items, 3 of 9 checks and 4 teams" — what the reading found, in the stage's terms. */
  const readSummary = (r: AgentRead) => {
    const parts = [launching ? `${r.items_read} plan item${r.items_read === 1 ? "" : "s"}` : `${r.signals_read} signal${r.signals_read === 1 ? "" : "s"}`];
    if (r.checks_read) parts.push(`${r.checks_apply ?? 0} of ${r.checks_read} checks`);
    if (r.teams_read) parts.push(`${r.teams_read} team${r.teams_read === 1 ? "" : "s"}`);
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  };
  const unchecked = rows.filter((r) => r.source.quote_verified === false).length;
  const modeLabel = agent.mode ?? agent.info.default_mode;
  /** What the agent writes down depends on the stage: commitments from a plan of record, signals from a PRD. */
  const readsFor = launching ? "writes down what it commits to, which launch checks apply and which teams it names" : "writes down the sentences that point to a team or an approval, and the teams it names";
  const READ_STEPS: [string, string][] = [
    ["Uploading", `Sending your documents to ${agent.info.name}.`],
    ["Reading", `${agent.info.name} opens each file, in whatever format it is, and ${readsFor}.`],
    ["Checking", "Every item's quote is checked against the file before you see it."],
  ];

  const needs: { label: string; required: boolean; desc: string; found: UploadedFile[]; without: string }[] = [
    { label: "What you're building", required: true, desc: p.stage === "launching" ? "Dates, owners, dependencies and approvals — usually a POR deck or doc." : "Goals, users, data and scope — a PRD, one-pager or brief is enough.", found: planFiles, without: "" },
    { label: "Launch checks", required: false, desc: "Approvals and gates your company expects before launch.", found: filesOf("checks"), without: p.stage === "launching" ? "standard launch items won't be checked." : "approvals come from common practice only." },
    { label: "Teams and people", required: false, desc: "An org chart or team list — or connect your directory next.", found: teamFiles, without: "you'll get team names, not people." },
  ];

  return (
    <div className="stack">
      <div className="between" style={{ alignItems: "flex-end", gap: 16 }}>
        <div className="stack-sm">
          <span className="small muted">Step 2 · your plan</span>
          <h1>Add what you have</h1>
          <p className="lead">{PLAN_INTRO[p.stage]}</p>
        </div>
        <button type="button" className="btn" onClick={p.onLoadSample}>Use sample files</button>
      </div>

      {p.notice && (
        <div className="notice-grey between" role="status" data-testid="plan-notice" style={{ gap: 12 }}>
          <span>{p.notice}</span>
          <button type="button" className="btn" style={{ minHeight: 32, padding: "0 10px" }} aria-label="Dismiss this note" onClick={p.onDismissNotice}>OK</button>
        </div>
      )}
      <div className="row">
        <section className="card" style={{ flex: "1.4 1 440px", gap: 16 }}>
          <div
            className={"drop" + (over ? " over" : "")}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); p.onAddFiles(e.dataTransfer?.files ?? null); }}
          >
            <span style={{ fontWeight: 500 }}>Drop any files here</span>
            <span className="small muted">Docs, slides, spreadsheets, PDFs, CSV or YAML — any format</span>
            <label htmlFor="plan-files" className="btn" style={{ cursor: "pointer" }}>Choose files</label>
            <input id="plan-files" className="sr-only" type="file" multiple onChange={(e) => { p.onAddFiles(e.target.files); e.target.value = ""; }} />
          </div>
          {p.files.length > 0 && (
            <div className="stack-sm" style={{ gap: 8 }}>
              {p.files.map((f) => {
                const entry = p.plan?.files.find((x) => x.name === f.name);
                const used = f.kind !== "other" && entry && entry.read_as.length > 0;
                return (
                  <div key={f.id} className="file-row">
                    <div className="meta">
                      <span className="name">{f.name}</span>
                      <span className="small muted">{f.size}{f.via === "directory" ? " · via Employee directory" : ""}</span>
                      <span className={"sm " + (used ? "ok" : "muted")} title={entry?.notes}>{f.kind === "other" ? "Nothing used from this file" : !launching && f.kind === "checks" ? "Launch checks are used when preparing to launch" : entry ? fileSummary(entry) : readingAny ? (reading ? `${agent.info.name} is reading…` : "Reading…") : hasPlan ? "Ready to read" : "Waiting for a plan file"}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
                      <div className="stack-sm" style={{ gap: 2 }}>
                        <label htmlFor={`kind-${f.id}`} className="label">Read as</label>
                        <select id={`kind-${f.id}`} className="input" style={{ width: "auto", minWidth: 190, height: 44 }} value={f.kind} disabled={f.via === "directory"} onChange={(e) => p.onSetKind(f.id, e.target.value as FileKind)}>
                          <option value="prd">PRD or one-pager</option>
                          <option value="plan">Plan of record</option>
                          <option value="checks">Launch checklist</option>
                          <option value="teams">Team list or org chart</option>
                          <option value="other">Not used</option>
                        </select>
                      </div>
                      {f.via !== "directory" && <button type="button" className="btn" aria-label={`Remove ${f.name}`} onClick={() => p.onRemove(f.id)}>Remove</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {p.planError && <div className="notice-grey" role="alert">{p.planError}</div>}
        </section>

        <section className="card tight" style={{ flex: "1 1 320px", padding: 20 }}>
          <h2 style={{ marginBottom: 6 }}>What we'll look for</h2>
          {needs.map((n) => (
            <div key={n.label} className="need">
              <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{n.label}</span>
                <span className="small" style={{ whiteSpace: "nowrap", fontWeight: n.required ? 600 : 400, color: n.required ? "var(--ink)" : "var(--muted)", fontSize: 12 }}>{n.required ? "Required" : "Optional"}</span>
              </div>
              <span className="sm text2">{n.desc}</span>
              <span className={"small " + (n.found.length ? "ok" : "warn")} style={{ overflowWrap: "anywhere" }}>
                {n.found.length ? `Found in ${n.found.map((f) => f.name).join(", ")}` : n.required ? "Not found yet" : `Not found — ${n.without}`}
              </span>
            </div>
          ))}
        </section>
      </div>

      {docs.length > 0 && !readingAny && (
        <section className={"card" + (read?.status === "done" ? " agent-done" : "")} data-testid={p.plan ? "agent-panel" : devinOffer ? "agent-consent" : "agent-panel"} style={{ gap: 10 }}>
          <div className="between" style={{ gap: 12, alignItems: "flex-start" }}>
            {p.plan && read?.status === "done" ? (
              <div className="stack-sm" style={{ gap: 4 }} data-testid="agent-result">
                <span>
                  <strong style={{ fontWeight: 600 }}>{agent.info.name}{read.mode ? ` (${read.mode})` : ""} read {readSummary(read)}</strong>
                  {read.files_read.length > 0 && <> from {read.files_read.map((f) => f.name).join(", ")}</>}
                  {read.session_url && <> · <a href={read.session_url} target="_blank" rel="noreferrer">open the {agent.info.name} session</a></>}
                </span>
                {(read.cached || read.files_read.some((f) => f.how)) && (
                  <details className="small"><summary style={{ cursor: "pointer" }} className="muted">How it was read</summary>
                    <div className="stack-sm muted" style={{ gap: 2, marginTop: 4 }}>
                      {read.cached && <span>From an earlier reading of the same file; nothing was sent this time.</span>}
                      {read.files_read.filter((f) => f.how).map((f) => <span key={f.name}><span className="mono">{f.name}</span>: {f.how}</span>)}
                    </div>
                  </details>
                )}
                {read.unreadable.length > 0 && <span className="small">Could not open: {read.unreadable.map((u) => `${u.name}${u.reason ? ` (${u.reason})` : ""}`).join(", ")}</span>}
                {read.warnings.length > 0 && <span className="small">{read.warnings.join(" ")}</span>}
                {unchecked > 0 && <span className="small">{unchecked} item{unchecked === 1 ? "" : "s"} could not be checked against the file (the server cannot open that format); confirm them below.</span>}
                <span className="small muted">Change a file or how it is read and this reading no longer applies; read again to refresh it.</span>
              </div>
            ) : p.plan && read?.status === "failed" ? (
              <div className="stack-sm" style={{ gap: 4 }} role="alert" data-testid="agent-result">
                <span><strong style={{ fontWeight: 600 }}>{agent.info.name} could not read your files.</strong> {read.error}</span>
                <span className="small muted">Showing what the built-in rules found on their own.</span>
              </div>
            ) : p.plan ? (
              <div className="stack-sm" style={{ gap: 4 }} data-testid="rules-result">
                <span style={{ fontWeight: 600 }}>Read with the built-in rules</span>
                <span className="sm muted">They read structured plans, checklists and team lists; prose and slides can be missed.{agent.info.available && agent.consent !== "yes" ? ` ${agent.info.name} can read any format.` : ""} Change a file or how it is read and this reading no longer applies.</span>
              </div>
            ) : devinOffer ? (
              <div className="stack-sm" style={{ gap: 4 }}>
                <span style={{ fontWeight: 600 }}>{agent.info.name} will read these files</span>
                <span className="sm muted">Set up by your company. {agent.info.name} opens each document in whatever format it is and {readsFor}; nothing is sent until you click, and every line is checked against the file before you see it.</span>
                <details className="small"><summary style={{ cursor: "pointer" }}>How {agent.info.name} works</summary><span className="muted">{agent.info.name} opens each plan document in your company's {agent.info.name} account and returns what it read with a quote for each line. Lines whose quote is not in the file are dropped; the rest appear below for you to confirm. Nothing is read by rules: the plan, the checklist and the team list all go to {agent.info.name}.</span></details>
              </div>
            ) : agentOn ? (
              <div className="stack-sm" style={{ gap: 4 }}>
                <span style={{ fontWeight: 600 }}>Ready for {agent.info.name} to read</span>
                <span className="sm muted">{docs.length ? `Check "Read as" on each file first. Then ${agent.info.name} opens ${docs.map((f) => f.name).join(", ")}${modeLabel ? ` in ${modeLabel} mode` : ""} and ${readsFor}. Nothing is sent until you click.` : "Add a file first."}</span>
              </div>
            ) : (
              <div className="stack-sm" style={{ gap: 4 }}>
                <span style={{ fontWeight: 600 }}>Ready to read</span>
                <span className="sm muted">Check "Read as" on each file first. The built-in rules read structured plans, checklists and team lists.{agent.info.available ? ` ${agent.info.name} can read any format.` : ""}</span>
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              {agent.info.available && agent.consent !== "no" && <ModeSelect agent={agent} id={devinOffer ? "agent-mode-consent" : "agent-mode-plan"} />}
              {/* Devin is the reader whenever the company has set it up; the rules alone are the fallback when it is off or disconnected. */}
              {agent.info.available && (
                <button type="button" className={"btn" + (!p.plan && agent.consent !== "no" ? " primary" : "")} disabled={!docs.length} data-testid="agent-read"
                  onClick={() => { if (agent.consent !== "yes") agent.setConsent("yes"); agent.read_now(true); }}>
                  {read?.status === "failed" ? "Try again" : read ? `Read again with ${agent.info.name}` : agent.consent === "no" ? `Read with ${agent.info.name} instead` : `Read with ${agent.info.name}`}
                </button>
              )}
              {(!agent.info.available || agent.consent === "no") && (
                <button type="button" className={"btn" + (!p.plan ? " primary" : "")} data-testid="rules-read" onClick={() => agent.read_now(false)}>
                  {p.plan && !read ? "Read again" : "Read my files"}
                </button>
              )}
            </div>
          </div>
        </section>
      )}
      {agent.reading && agent.stage === null && (
        <section className="card" style={{ padding: "12px 20px" }} role="status" aria-live="polite" data-testid="rules-reading"><span className="sm muted">Reading your files…</span></section>
      )}
      {reading && (
        <section className="card" style={{ padding: "8px 20px", gap: 0, maxWidth: 640 }} role="status" aria-live="polite" data-testid="agent-reading">
          <div style={{ padding: "12px 0 4px" }}><span style={{ fontWeight: 600 }}>{agent.info.name} is reading your files</span><span className="small muted"> · this takes a few minutes</span></div>
          {READ_STEPS.map(([name, detail], i) => {
            const st = i < (agent.stage ?? 0) ? "done" : i === agent.stage ? "running" : "waiting";
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
        </section>
      )}

      {hasPlan && p.plan && !launching && p.signals.length > 0 && (
        <section className="stack" style={{ gap: 12 }} data-testid="signals">
          <div className="stack-sm" style={{ gap: 4 }}>
            <h2>What we read in your PRD</h2>
            <p className="sm muted" style={{ maxWidth: 680 }}>Each line below points to a team you'll likely need. Untick anything that's wrong.</p>
          </div>
          <div className="card" style={{ padding: "4px 18px", gap: 0 }}>
            {p.signals.map((g) => (
              <div key={g.id} className="signal-row">
                <input id={`sig-${g.id}`} type="checkbox" checked={!p.signalsOff[g.id]} onChange={() => p.onToggleSignal(g.id)} />
                <label htmlFor={`sig-${g.id}`}>
                  <span>“{g.quote}”</span>
                  <span className="small muted">{sourceShort(p.plan!, g.file) === "POR" ? "PRD" : g.file} {g.locator} · points to <strong style={{ fontWeight: 500, color: "var(--ink)" }}>{g.teams.join(", ")}</strong></span>
                </label>
              </div>
            ))}
          </div>
        </section>
      )}
      {hasPlan && p.plan && !launching && p.signals.length === 0 && (
        <div className="notice-grey">Nothing in {planFiles.map((f) => f.name).join(", ")} matched a signal (customer data, public APIs, peak load, user-facing screens, GA…). Check it was read as the right kind, or add a PRD.</div>
      )}

      {hasPlan && p.plan && launching && (
        <section className="stack" style={{ gap: 12 }}>
          <div className="stack-sm" style={{ gap: 4 }}>
            <h2>Plan we read</h2>
            <p className="sm muted" style={{ maxWidth: 680 }}>From {planFiles.concat(filesOf("checks")).map((f) => f.name).join(" and ")}. Fix anything that's wrong — everything is checked against this list.</p>
          </div>
          <div className="table-wrap plan-table">
            <table>
              <thead>
                <tr><th>Plan item</th><th>Type</th><th>Owner</th><th style={{ width: 170 }}>Due</th><th>Source</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const val = p.planDates[r.id] ?? r.due ?? "";
                  const edited = p.planDates[r.id] !== undefined && p.planDates[r.id] !== (r.due ?? "");
                  const flag = r.due_is_inferred && !edited;
                  const isOpen = !!open[r.id];
                  return (
                    <tr key={r.id}>
                      <td>
                        <div>{r.text}</div>
                        {r.source.quote_verified === false && <div className="inferred" data-testid={`unchecked-${r.id}`}>Quote not checked: the server could not open {r.source.file}. Open the source and confirm it.</div>}
                        {isOpen && <div className="quote" data-testid={`quote-${r.id}`}>“{r.source.quote}”<div className="small muted" style={{ marginTop: 4 }}>{r.source.file} · {r.source.locator}</div></div>}
                      </td>
                      <td className="sm text2">{KIND_LABEL[r.kind]}</td>
                      <td>{r.owner_team ?? "—"}</td>
                      <td style={{ padding: "8px 16px" }}>
                        <label htmlFor={`due-${r.id}`} className="sr-only">Due date for {r.text}</label>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input id={`due-${r.id}`} type="date" className="input" style={{ width: 150, height: 44 }} value={val} onChange={(e) => p.onSetDate(r.id, e.target.value)} />
                          {flag && <span className="inferred-tag" data-testid={`inferred-${r.id}`} title={`${sourceShort(p.plan!, r.source.file)} says "${r.due_text}"; ${fmtDate(r.due)} was inferred from that`}>inferred</span>}
                        </div>
                        {edited && <div className="edited">Edited · was {fmtDate(r.due)}</div>}
                      </td>
                      <td className="small muted">
                        <div>{sourceLabel(p.plan!, r.source.file, r.source.locator)}</div>
                        <button type="button" className="linkbtn" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [r.id]: !isOpen }))}>{isOpen ? "Hide source" : "Show source"}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <span className="sm muted">
            {[`Plan items: ${planCount}`, hasChecklist ? `Launch checks: ${checkApplied} of ${checkTotal ?? "?"} apply` : "No launch checks", hasOrg ? (viaDirectory ? "Owners: from your directory" : "Owners: from your files") : "Owners: inferred from Jira", ...(read?.status === "done" ? [`Read by ${agent.info.name}: ${read.items_read}`] : agentOn ? [`${agent.info.name} has not read these files yet`] : agent.info.available ? [`${agent.info.name} not used`] : [])].join(" · ")}
          </span>
          {inferredCount > 0 && <span className="sm muted" data-testid="inferred-note">{inferredCount} date{inferredCount === 1 ? " was" : "s were"} inferred from the plan's wording, such as "the week before launch"; they are marked <span className="inferred-tag">inferred</span>. Adjust any that are wrong.</span>}
          {p.plan.warnings.length > 0 && <div className="notice-grey">{p.plan.warnings.join(" ")}</div>}
        </section>
      )}

      <div className="between actions" style={{ gap: 16 }}>
        <span className="sm muted" style={{ maxWidth: 640 }}>
          {!hasPlan ? "Add something that describes what you're building to continue." : !p.plan ? (p.planError ? "Fix the file above, or read it as something else, to continue." : reading ? `${agent.info.name} is reading your files…` : agent.reading ? "Reading your files…" : "Read your files to continue.") : !launching && p.signals.length === 0 ? "No signals found yet; you can still continue." : "Looks good. Next, connect the apps your teams use."}
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn" onClick={p.onBack}>Back</button>
          <button type="button" className="btn primary" style={{ padding: "0 20px" }} disabled={notReady} onClick={p.onConfirm}>Confirm and connect apps</button>
        </div>
      </div>
    </div>
  );
}
