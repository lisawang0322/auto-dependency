import { useState } from "react";
import type { PlanDraft } from "@rrr/schemas";
import { PLAN_KINDS, type UploadedFile, type FileKind, type Stage } from "../backend/types";
import { fmtDate } from "../model/dates";

/** Step 2 (PRD R1–R3, R14): add plan files in any format, see what was read from them, fix dates, confirm. */

interface Props {
  stage: Stage;
  files: UploadedFile[];
  plan: PlanDraft | null;
  planError: string | null;
  planDates: Record<string, string>;
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
  const rows = p.plan?.items ?? [];
  const planCount = rows.filter((r) => r.kind !== "checklist").length;
  const checkTotal = p.plan?.files.find((f) => f.read_as.includes("launch_checks"))?.notes.match(/(\d+) checks/)?.[1];
  const checkApplied = rows.filter((r) => r.kind === "checklist").length;

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
            <label htmlFor="plan-files" className="btn dark" style={{ cursor: "pointer" }}>Choose files</label>
            <input id="plan-files" className="sr-only" type="file" multiple onChange={(e) => { p.onAddFiles(e.target.files); e.target.value = ""; }} />
            <span className="small muted">Plan lives in Confluence, Google Drive or Aha!? Export it for now — those connectors are shown, not built.</span>
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
                      <span className={"sm " + (used ? "ok" : "muted")}>{f.kind === "other" ? "Nothing used from this file" : entry ? entry.notes : hasPlan ? "Reading…" : "Waiting for a plan file"}</span>
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

      {hasPlan && p.plan && (
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
            {[`Plan items: ${planCount}`, hasChecklist ? `Launch checks: ${checkApplied} of ${checkTotal ?? "?"} apply` : "No launch checks", hasOrg ? (viaDirectory ? "Owners: from your directory" : "Owners: from your files") : "Owners: inferred from Jira"].join(" · ")}
          </span>
          {p.plan.warnings.length > 0 && <div className="notice-grey">{p.plan.warnings.join(" ")}</div>}
        </section>
      )}

      <div className="between" style={{ gap: 16 }}>
        <span className="sm muted" style={{ maxWidth: 640 }}>
          {!hasPlan ? "Add something that describes what you're building to continue." : !p.plan ? (p.planError ? "Fix the file above, or read it as something else, to continue." : "Reading your files…") : "Looks good. Next, connect the apps your teams use."}
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="btn" onClick={p.onBack}>Back</button>
          <button type="button" className="btn primary" style={{ padding: "0 20px" }} disabled={notReady} onClick={p.onConfirm}>Confirm and connect apps</button>
        </div>
      </div>
    </div>
  );
}
