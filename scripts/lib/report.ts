/**
 * One self-contained HTML page for a saved run: the review as a file that can be attached, mailed or
 * kept. Same input, same bytes; no scripts, no network, inline CSS only.
 */
import type { Run, Finding, Team } from "@rrr/schemas";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (iso: string | null | undefined) => { const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso ?? "—"; };
const days = (a: string, b: string) => { const p = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 86_400_000); };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const STATUS: Record<Team["status"], string> = { on_track: "On track", at_risk: "At risk", late: "Late" };
const TYPE: Record<Finding["gap_type"], string> = { process: "Process", cross_team_date: "Cross-team date", commitment: "Commitment" };
const RESULT: Record<string, string> = { ok: "OK", gap: "Gap", late: "Late", weak: "Weak" };

export interface ReportOptions { goNoGo?: string | null; comparedWith?: string | null; sourceFile?: string }

export function renderReport(run: Run, opts: ReportOptions = {}): string {
  const epic = run.release.epic;
  const launch = run.plan.launch_date ?? run.target.epic.release_date ?? null;
  const snapshot = run.release.snapshot_label;
  const snapDate = /^\d{4}-\d{2}-\d{2}$/.test(snapshot) ? snapshot : run.release.read_at.slice(0, 10);
  const out = launch ? days(snapDate, launch) : null;
  const amber = run.teams.some((t) => t.status !== "on_track");
  const shown = run.findings.filter((f) => f.strength !== "weak");
  const weak = run.findings.filter((f) => f.strength === "weak");
  const otherGaps = run.linkage_gaps.filter((g) => !g.finding_id);
  const owners = [...new Set(shown.map((f) => f.owner))];
  const warnings = [...run.plan.warnings, ...run.target.warnings, ...run.release.warnings];
  const planById = new Map(run.plan.items.map((i) => [i.id, i]));

  const finding = (f: Finding) => {
    const item = planById.get(f.plan_item_id);
    return `<article class="finding ${esc(f.strength)}" id="${esc(f.id)}">
  <h3>${esc(f.title)}</h3>
  <p class="meta"><span class="pill">${TYPE[f.gap_type]}</span> <span class="pill ${esc(f.strength)}">${esc(f.strength)} evidence</span> <span>Owner: <b>${esc(f.owner)}</b>${f.owner_source === "jira_inferred" ? " (inferred from Jira)" : ""}</span> <span>Plan item ${esc(f.plan_item_id)}</span></p>
  ${item ? `<blockquote>“${esc(f.plan_quote ?? item.source.quote)}”<footer>${esc(f.plan_source?.file ?? item.source.file)} · ${esc(f.plan_source?.locator ?? item.source.locator)}${item.due ? ` · plan date ${fmt(item.due)}` : ""}</footer></blockquote>` : ""}
  ${f.evidence.length ? `<ul class="evidence">${f.evidence.map((e) => `<li><code>${esc(e.key)}</code> ${esc(e.text)} <span class="muted">${esc(e.meta)}</span></li>`).join("")}</ul>` : ""}
  ${f.none_found ? `<p class="muted">Nothing found in ${esc(f.none_found.projects.join(", ") || "the searched projects")}.${f.none_found.jql.length ? ` Searched: <code>${f.none_found.jql.map(esc).join("</code>, <code>")}</code>` : ""}</p>` : ""}
  ${f.linkage ? `<p class="notice">Linkage gap: <code>${esc(f.linkage.from)}</code> is not linked to <code>${esc(f.linkage.to)}</code>. Suggested link: <b>${esc(f.linkage.suggested_type)}</b>.</p>` : ""}
  ${f.strength_rule ? `<p class="muted">Why ${esc(f.strength)}: ${esc(f.strength_rule)}.</p>` : ""}
  ${f.next_action ? `<p class="action"><b>Next action</b> · ${esc(f.next_action.who)} · by ${esc(f.next_action.by_when)}<br>${esc(f.next_action.action)}</p>` : ""}
</article>`;
  };

  const team = (t: Team) => `<section class="team">
  <h3>${esc(t.team)} <span class="pill ${esc(t.status)}">${STATUS[t.status]}</span> <span class="muted">${esc(t.project_key)}${t.role ? " · " + esc(t.role) : ""}</span></h3>
  ${t.change_note ? `<p class="muted">Since ${esc(opts.comparedWith ?? "the previous run")}: ${esc(t.change_note)}</p>` : opts.comparedWith ? `<p class="muted">Since ${esc(opts.comparedWith)}: no change in the tickets behind these items.</p>` : ""}
  <table><thead><tr><th>Plan item</th><th>Ticket</th><th>Plan date</th><th>Jira date</th><th>Result</th><th>Note</th></tr></thead><tbody>
  ${t.items.map((i) => `<tr class="${esc(i.result)}"><td>${esc(i.text)}</td><td>${i.ticket ? `<code>${esc(i.ticket)}</code> ` : ""}<span class="muted">${esc(i.ticket_status)}</span></td><td>${fmt(i.plan_due)}</td><td>${fmt(i.jira_due)}</td><td><span class="pill ${esc(i.result)}">${RESULT[i.result]}</span></td><td>${esc(i.note)}${i.finding_id ? ` <a href="#${esc(i.finding_id)}">${esc(i.finding_id)}</a>` : ""}</td></tr>`).join("\n  ")}
  </tbody></table>
</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release review ${esc(epic.key)} · ${esc(fmt(snapDate))}</title>
<style>
:root{--bg:#fff;--ink:#1b1f24;--muted:#5c6570;--line:#e3e6ea;--card:#f7f8fa;--green:#1f7a3d;--amber:#9a6400;--red:#b4232c;--accent:#1f5fbf;--pillbg:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--ink:#e6e8eb;--muted:#9aa3ad;--line:#2a2f36;--card:#1a1e23;--green:#5fc27a;--amber:#e3b341;--red:#f08089;--accent:#7fb0ff;--pillbg:#262b32}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px;border-bottom:1px solid var(--line);padding-bottom:6px}h3{font-size:16px;margin:0 0 6px}
.muted{color:var(--muted)}.small{font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--pillbg);font-size:12px;font-weight:600;vertical-align:middle}
.pill.on_track,.pill.ok,.pill.strong{color:var(--green)}.pill.at_risk,.pill.gap,.pill.moderate{color:var(--amber)}.pill.late{color:var(--red)}.pill.weak{color:var(--muted)}
.status{font-size:20px;font-weight:700}.status.amber{color:var(--amber)}.status.green{color:var(--green)}
.finding{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}.finding.weak{opacity:.85}
.meta{margin:0 0 8px}.meta span{margin-right:10px}blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--line)}blockquote footer{font-size:13px;color:var(--muted)}
.evidence{margin:8px 0;padding-left:20px}.action{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:10px 0 0}.notice{color:var(--accent)}
table{width:100%;border-collapse:collapse;margin:8px 0 16px;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:13px}
.team{margin:16px 0}details summary{cursor:pointer;color:var(--muted)}a{color:var(--accent)}.wrap{overflow-x:auto}
@media print{body{padding:0}.finding{break-inside:avoid}}
</style>
</head>
<body><main>
<header>
<p class="muted small">Release Readiness Review · snapshot ${esc(fmt(snapDate))}${opts.comparedWith ? ` · compared with ${esc(fmt(opts.comparedWith))}` : " · first run"}</p>
<h1>${esc(epic.summary)} <code>${esc(epic.key)}</code></h1>
<p><span class="status ${amber ? "amber" : "green"}">${amber ? "Amber" : "Green"}</span> &nbsp; ${launch ? `Launch ${esc(fmt(launch))}${out !== null ? ` · ${out} days out` : ""}` : "No launch date"}${opts.goNoGo ? ` · go/no-go ${esc(fmt(opts.goNoGo))}` : ""}${epic.fix_version ? ` · fix version ${esc(epic.fix_version)}` : ""} · epic ${esc(epic.status)}</p>
<p class="muted">${shown.length} finding${shown.length === 1 ? "" : "s"} to act on${weak.length ? `, ${weak.length} weak hidden below` : ""}, ${otherGaps.length} other linkage gap${otherGaps.length === 1 ? "" : "s"}. ${run.release.stories.length} stories read, ${run.release.related.length} related tickets, ${run.release.search_candidates.length} search candidates across ${esc(run.release.projects_searched.map((p) => p.jira_project).join(", ") || "no projects")}.${owners.length ? ` Owners to chase: ${esc(owners.join(", "))}.` : ""}</p>
</header>

<h2>Findings</h2>
${shown.length ? shown.map(finding).join("\n") : "<p>No gaps between the plan and Jira.</p>"}
${weak.length ? `<details><summary>${weak.length} weak finding${weak.length === 1 ? "" : "s"} (comment text only, hidden by default)</summary>${weak.map(finding).join("\n")}</details>` : ""}

${otherGaps.length ? `<h2>Other linkage gaps</h2>
<div class="wrap"><table><thead><tr><th>From</th><th>To</th><th>How it was found</th><th>Suggested link</th></tr></thead><tbody>
${otherGaps.map((g) => `<tr><td><code>${esc(g.from)}</code></td><td><code>${esc(g.to)}</code> ${esc(g.to_summary)}</td><td>${g.how === "comment_mention" ? "mentioned in a comment" : "matched by search"}</td><td>${esc(g.suggested_type)}</td></tr>`).join("\n")}
</tbody></table></div>` : ""}

<h2>Teams</h2>
<div class="wrap">${run.teams.map(team).join("\n")}</div>

<h2>Plan as confirmed</h2>
<div class="wrap"><table><thead><tr><th>Id</th><th>Plan item</th><th>Type</th><th>Owner</th><th>Due</th><th>Source</th></tr></thead><tbody>
${run.plan.items.map((i) => `<tr><td>${esc(i.id)}</td><td>${esc(i.text)}</td><td>${esc(i.kind)}</td><td>${esc(i.owner_team ?? "—")}</td><td>${fmt(i.due)}${i.due_is_inferred ? ' <span class="muted small">(inferred)</span>' : ""}</td><td class="small muted">${esc(i.source.file)} · ${esc(i.source.locator)}</td></tr>`).join("\n")}
</tbody></table></div>
<p class="small muted">Teams and projects: ${run.target.projects.map((p) => `${esc(p.team)} → ${esc(p.jira_project ?? "unresolved")}${p.search === false ? " (not searched)" : ""}`).join("; ")}.</p>

${warnings.length ? `<h2>Warnings</h2><ul class="small muted">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}

<p class="small muted">Jira read at ${esc(run.release.read_at)}${opts.sourceFile ? ` · from ${esc(opts.sourceFile)}` : ""}. Jira was only read; nothing was changed.</p>
</main></body>
</html>
`;
}
