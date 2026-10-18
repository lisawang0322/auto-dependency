import { useState } from "react";
import type { PlanDraft } from "@rrr/schemas";
import type { UploadedFile, FileKind } from "../backend/types";
import { fmtDate } from "../model/dates";

interface Props {
  files: UploadedFile[];
  plan: PlanDraft | null;
  planError: string | null;
  planDates: Record<string, string>;
  onAddFiles: (list: FileList | File[] | null) => void;
  onSetKind: (id: string, kind: FileKind) => void;
  onRemove: (id: string) => void;
  onLoadSample: () => void;
  onSetDate: (id: string, value: string) => void;
  onConfirm: () => void;
}

const NEEDS: { kind: FileKind; label: string; required: boolean; desc: string; where: string; without: string }[] = [
  { kind: "plan", label: "Plan items", required: true, desc: "Deliverables with owners and due dates, plus dependencies and approvals. This is what Jira is checked against.", where: "a plan of record, PRD, launch plan or project brief", without: "" },
  { kind: "checks", label: "Launch checks", required: false, desc: "Standard items every launch must clear, like rollback, permissions reviews or load tests.", where: "a launch or readiness checklist", without: "standard launch items won’t be checked." },
  { kind: "teams", label: "Teams and owners", required: false, desc: "Who owns what, and each team’s Jira project. Makes owners exact.", where: "an org chart, team roster or RACI", without: "owners are inferred from Jira assignees." },
];

const KIND_LABEL: Record<string, string> = { deliverable: "Deliverable", dependency: "Dependency", approval: "Approval", checklist: "Checklist" };

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
  const hasPor = filesOf("plan").length > 0;
  const hasChecklist = filesOf("checks").length > 0;
  const hasOrg = filesOf("teams").length > 0;
  const notReady = !hasPor || !p.plan;
  const skipped = NEEDS.filter((n) => !n.required && !filesOf(n.kind).length).map((n) => n.label.toLowerCase());
  const rows = p.plan?.items ?? [];
  const planCount = rows.filter((r) => r.kind !== "checklist").length;
  const checkTotal = p.plan?.files.find((f) => f.read_as.includes("launch_checks"))?.notes.match(/(\d+) checks/)?.[1];
  const checkApplied = rows.filter((r) => r.kind === "checklist").length;

  return (
    <div className="stack">
      <div className="between" style={{ alignItems: "flex-end", gap: 16 }}>
        <div className="stack-sm">
          <span className="small muted">Step 1 · plan documents</span>
          <h1>Upload the plan</h1>
          <p className="lead">Add whatever describes how this release is supposed to go — one file or several. You'll confirm the plan read from them before Jira is checked.</p>
        </div>
        <button type="button" className="btn" onClick={p.onLoadSample}>Use sample files</button>
      </div>

      <div className="row">
        <section className="card" style={{ flex: "1.4 1 440px", gap: 16 }}>
          <div
            className={"drop" + (over ? " over" : "")}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); p.onAddFiles(e.dataTransfer?.files ?? null); }}
          >
            <span style={{ fontWeight: 500 }}>Drop files here</span>
            <span className="small muted">PDF, Word, Markdown, spreadsheets, CSV, YAML or JSON</span>
            <label htmlFor="plan-files" className="btn dark" style={{ cursor: "pointer" }}>Choose files</label>
            <input id="plan-files" className="sr-only" type="file" multiple accept=".pdf,.docx,.doc,.md,.txt,.xlsx,.csv,.yaml,.yml,.json"
              onChange={(e) => { p.onAddFiles(e.target.files); e.target.value = ""; }} />
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
                      <span className="small muted">{f.size}</span>
                      <span className={"sm " + (used ? "ok" : "muted")}>{f.kind === "other" ? "Nothing used from this file" : entry ? entry.notes : hasPor ? "Reading…" : "Waiting for a plan items file"}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
                      <div className="stack-sm" style={{ gap: 2 }}>
                        <label htmlFor={`kind-${f.id}`} className="label">Read as</label>
                        <select id={`kind-${f.id}`} className="input" style={{ width: "auto", minWidth: 170, height: 44 }} value={f.kind} onChange={(e) => p.onSetKind(f.id, e.target.value as FileKind)}>
                          <option value="plan">Plan items</option>
                          <option value="checks">Launch checks</option>
                          <option value="teams">Teams and owners</option>
                          <option value="other">Not used</option>
                        </select>
                      </div>
                      <button type="button" className="btn" aria-label={`Remove ${f.name}`} onClick={() => p.onRemove(f.id)}>Remove</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {p.planError && <div className="notice-grey">{p.planError}</div>}
        </section>

        <section className="card tight" style={{ flex: "1 1 320px", padding: 20 }}>
          <h2 style={{ marginBottom: 6 }}>What the review needs</h2>
          {NEEDS.map((n) => {
            const found = filesOf(n.kind);
            return (
              <div key={n.kind} className="need">
                <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{n.label}</span>
                  <span className="small" style={{ whiteSpace: "nowrap", fontWeight: n.required ? 600 : 400, color: n.required ? "var(--ink)" : "var(--muted)", fontSize: 12 }}>{n.required ? "Required" : "Optional"}</span>
                </div>
                <span className="sm text2">{n.desc}</span>
                <span className="small muted">Often found in: {n.where}</span>
                <span className={"small " + (found.length ? "ok" : "warn")} style={{ overflowWrap: "anywhere" }}>
                  {found.length ? `Found in ${found.map((f) => f.name).join(", ")}` : n.required ? "Not found yet" : `Not found — ${n.without}`}
                </span>
              </div>
            );
          })}
        </section>
      </div>

      {hasPor && p.plan && (
        <section className="stack" style={{ gap: 12 }}>
          <div className="stack-sm" style={{ gap: 4 }}>
            <h2>Extracted plan</h2>
            <p className="sm muted" style={{ maxWidth: 680 }}>From {filesOf("plan").concat(filesOf("checks")).map((f) => f.name).join(" and ")}. Fix anything that's wrong — every finding is checked against this list.</p>
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
                        {flag && <div className="inferred">{sourceShort(p.plan!, r.source.file)} says "{r.due_text}" — {fmtDate(r.due)} is a guess. Confirm the date.</div>}
                        {isOpen && <div className="quote" data-testid={`quote-${r.id}`}>“{r.source.quote}”<div className="small muted" style={{ marginTop: 4 }}>{r.source.file} · {r.source.locator}</div></div>}
                      </td>
                      <td className="sm text2">{KIND_LABEL[r.kind]}</td>
                      <td>{r.owner_team ?? "—"}</td>
                      <td style={{ padding: "8px 16px" }}>
                        <label htmlFor={`due-${r.id}`} className="sr-only">Due date for {r.text}</label>
                        <input id={`due-${r.id}`} type="date" className="input" style={{ width: 150, height: 44, borderColor: flag ? "var(--amber-input)" : undefined }} value={val} onChange={(e) => p.onSetDate(r.id, e.target.value)} />
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
            {[`Plan items: ${planCount}`, hasChecklist ? `Launch checks: ${checkApplied} of ${checkTotal ?? "?"} apply` : "No launch checks", hasOrg ? "Owners: from your files" : "Owners: inferred from Jira"].join(" · ")}
          </span>
          {p.plan.warnings.length > 0 && <div className="notice-grey">{p.plan.warnings.join(" ")}</div>}
        </section>
      )}

      <div className="between" style={{ gap: 16 }}>
        <span className="sm muted" style={{ maxWidth: 640 }}>
          {!hasPor ? "Add a file with plan items — deliverables, owners and dates — to continue." : skipped.length ? `No ${skipped.join(" or ")} found, so some checks run at reduced strength. You can add more files later and re-run.` : "Everything the review uses was found."}
        </span>
        <button type="button" className="btn primary" style={{ padding: "0 20px" }} disabled={notReady} onClick={p.onConfirm}>Confirm plan and connect Jira</button>
      </div>
    </div>
  );
}
