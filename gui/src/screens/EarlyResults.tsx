import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Starter, InvolveRole, CoverageState, ApprovalState, Commitment } from "@throughline/schemas";
import { findMatch, firstSeenLabel } from "@throughline/schemas";
import type { DecisionStore, RunDecisions, ActionsGlance, ActionGlance } from "../backend/types";
import { fmtDate, prettyDates } from "../model/dates";
import { Info } from "./Info";
import { teamReadiness, overall, READINESS_ORDER, READINESS_LABEL, type TeamReadiness, type Readiness } from "../model/readiness";
import { STAGE_SHORT } from "./GetStarted";
import type { Stage } from "../backend/types";

/**
 * What the PRD tells the review (PRD R16, R17, R18), one card per team: why the plan needs it, who to contact, the approvals
 * it owes, whether it is on the Jira work (with Jira and the epic), and what to do. Everything comes from throughline-starter's
 * output, filtered by the signals the person left ticked. With a plan of record too, the launch review's team cards carry
 * these facts (teamFacts) and this component lists only the teams the plan of record leaves out (mode "inLaunch").
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
  onConnectApps: () => void;
  /** The project's commitments: each team card shows its own (and its approvals') state, where it was first written
   *  down, and Drop or Reopen. A past record opened from History has none. */
  commitments?: Commitment[];
  onCommitment?: (id: string, kind: "dropped" | "reopen", reason: string) => void;
  /** The checklist, for the panel beside the review; given this, the review leaves the list to the panel. */
  onActions?: (a: ActionsGlance) => void;
  /** Back to the project's overview, where the stage, files and connections are changed. */
  onOverview?: () => void;
  /** Shared ticks, when another view (the launch review's cards) shows these actions too. */
  state?: StarterState;
  /** Where the project stands, read from its evidence: teams whose milestone is further out are coming up, not due now. */
  phase?: Stage;
  /** Linking a team the reading missed to its Jira project (with Jira). */
  link?: TeamLink;
  /** "inLaunch": beside a launch review, only the teams it does not cover (excludeTeams), with no header or checklist of its own. */
  mode?: "full" | "inLaunch";
  excludeTeams?: string[];
  /** The launch check with no plan of record: each team read as ready, at risk, blocking or can't tell, by the launch
   *  date the project knows. Adding a launch checklist (or plan of record) is offered, never needed. */
  readiness?: { date: string | null; onAddChecklist?: () => void };
}

/** The ticks on a PRD review's actions, kept per review in the decision store; shared by every view that shows them. */
export interface StarterState { actionsDone: Record<string, boolean>; contacted: Record<string, boolean>; toggle: (id: string) => void }
export function useStarterState(store: DecisionStore, st: Starter | null): StarterState {
  const key = st ? `starter:${st.stage}:${st.epic ?? st.project}/${st.label}` : "";
  const [saved, setSaved] = useState<RunDecisions>(EMPTY);
  useEffect(() => { if (!key) return; let on = true; store.load(key).then((d) => { if (on) setSaved(d); }); return () => { on = false; }; }, [key, store]);
  const actionsDone = saved.actionsDone ?? {};
  return {
    actionsDone, contacted: saved.contacted ?? {},
    toggle: (id) => { const next = { ...saved, actionsDone: { ...actionsDone, [id]: !actionsDone[id] } }; setSaved(next); if (key) store.save(key, next); },
  };
}
export const teamSlug = (team: string) => `team-${team.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** How closely to work with a team: a scale, not a sequence. "approve" is not a level of closeness but a sign-off a team
 *  holds, shown on its own; a team that only signs off is consulted, the usual relationship with a reviewer. */
const CLOSENESS: Record<InvolveRole, { label: string; title: string }> = {
  core: { label: "Work closely", title: "In the room every week" }, consult: { label: "Consult", title: "Ask before decisions" },
  approve: { label: "Consult", title: "Ask before decisions; signs off" }, inform: { label: "Keep informed", title: "Update at milestones" },
};
/** When to involve a team is the one real sequence on the page: the milestones in the order a project meets them. */
const WHEN_ORDER: [RegExp, string, string][] = [
  [/^now\b/i, "now", "Now"], [/design review/i, "design-review", "Before the design review"], [/work starts/i, "work-starts", "Before work starts"],
  [/code complete/i, "code-complete", "Before code complete"], [/beta/i, "beta", "Before beta"],
];
const whenGroup = (when: string): { id: string; label: string; rank: number } => {
  const i = WHEN_ORDER.findIndex(([re]) => re.test(when));
  return i < 0 ? { id: "later", label: "Later", rank: WHEN_ORDER.length } : { id: WHEN_ORDER[i][1], label: WHEN_ORDER[i][2], rank: i };
};
/** How far ahead is "now", by where the project stands (read from its evidence, never chosen): just starting, up to work
 *  starting; building, up to code complete; preparing to launch, everything (whatever is not done is late). A team whose
 *  milestone is further out is coming up: shown, but its actions are not asked for yet. */
const HORIZON: Record<Stage, number> = { starting: 2, building: 3, launching: Infinity };
const COV_LABEL: Record<CoverageState, string> = { covered: "Covered", unclear: "Unclear", missing: "Missing" };
const APPR_LABEL: Record<ApprovalState, string> = { done: "Done", started: "In progress", no_owner: "No owner", not_started: "Not started" };
const EMPTY: RunDecisions = { decisions: {}, log: [], actionsDone: {}, contacted: {} };

/** Drop (with a reason) or Reopen for one commitment, the team's or one of its approvals'. */
function DropControl(p: { c: Commitment; label: string; onCommitment?: (id: string, kind: "dropped" | "reopen", reason: string) => void; readOnly?: boolean }) {
  const [dropping, setDropping] = useState(false);
  const [reason, setReason] = useState("");
  if (p.readOnly || !p.onCommitment) return null;
  if (p.c.state === "dropped") return <button type="button" className="linkbtn" style={{ minHeight: 28 }} aria-label={`Reopen ${p.label}`} onClick={() => p.onCommitment!(p.c.id, "reopen", "")}>Reopen</button>;
  if (dropping) return (
    <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) { p.onCommitment!(p.c.id, "dropped", reason.trim()); setDropping(false); setReason(""); } }}>
      <input className="input" style={{ height: 36, width: 220 }} aria-label={`Why drop ${p.label}`} placeholder="Why it no longer applies" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      <button type="submit" className="btn" style={{ minHeight: 36 }} disabled={!reason.trim()}>Drop</button>
      <button type="button" className="linkbtn" style={{ minHeight: 36 }} onClick={() => setDropping(false)}>Cancel</button>
    </form>
  );
  return <button type="button" className="linkbtn" style={{ minHeight: 28 }} aria-label={`Drop ${p.label}`} onClick={() => { setDropping(true); setReason(""); }}>Drop</button>;
}

/** Linking a team to its Jira project by hand, for when the reading missed it: the links made so far, the projects to pick
 *  from, and the change (null unlinks). The review runs again with it. */
export interface TeamLink { linked: Record<string, string>; projects: () => Promise<{ key: string; name: string }[]>; set: (team: string, project: string | null) => void }

function LinkProject(p: { team: string; linked: string | null; link: TeamLink }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ key: string; name: string }[] | null>(null);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setOpen(true); setError(null); setPick(p.linked ?? "");
    p.link.projects().then(setList).catch((e) => { setList([]); setError(String((e as Error).message ?? e)); });
  };
  const name = (key: string) => list?.find((x) => x.key === key)?.name;
  if (open) return (
    <form className="row" style={{ gap: 8, flexWrap: "wrap" }} data-testid={`link-form-${p.team}`}
      onSubmit={(e) => { e.preventDefault(); if (pick) { p.link.set(p.team, pick); setOpen(false); } }}>
      <select className="input" style={{ height: 36, width: "auto", minWidth: 220 }} aria-label={`Jira project for ${p.team}`} value={pick} onChange={(e) => setPick(e.target.value)} disabled={!list}>
        <option value="">{list ? "Pick a project" : "Loading projects…"}</option>
        {(list ?? []).map((x) => <option key={x.key} value={x.key}>{x.key} · {x.name}</option>)}
      </select>
      <button type="submit" className="btn" style={{ minHeight: 36 }} disabled={!pick}>Link and re-check</button>
      <button type="button" className="linkbtn" style={{ minHeight: 36 }} onClick={() => setOpen(false)}>Cancel</button>
      {error && <span className="small muted" role="alert">{error}</span>}
    </form>
  );
  return p.linked ? (
    <span className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <span className="sm">Linked by you: <span className="mono">{p.linked}</span>{name(p.linked) ? ` · ${name(p.linked)}` : ""}</span>
      <button type="button" className="linkbtn" style={{ minHeight: 28 }} onClick={start}>Change</button>
      <button type="button" className="linkbtn" style={{ minHeight: 28 }} onClick={() => p.link.set(p.team, null)}>Unlink</button>
    </span>
  ) : (
    <span className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <button type="button" className="linkbtn" style={{ minHeight: 28 }} onClick={start}>Link its Jira project</button>
      <Info>Not right? The reading may have missed the team's Jira project.</Info>
    </span>
  );
}

export interface FactsArgs {
  starter: Starter; signalsOff: Record<string, boolean>; name: string; state: StarterState; readOnly?: boolean;
  /** The team's milestone is still ahead: its actions are shown as what will be asked, not marked done yet. */
  later?: boolean;
  link?: TeamLink;
  commitments?: Commitment[]; onCommitment?: (id: string, kind: "dropped" | "reopen", reason: string) => void;
  /** With the launch check: whether this team is ready, and why. */
  readiness?: TeamReadiness;
}
/** One team, from the PRD (and, with Jira, its coverage): the tags (how closely, signs off, on the work, its commitment),
 *  and the facts: why (with the plan's own words), who, what it owes, what to do (marked done here), and the commitment
 *  line with Drop. Used by this review's cards and, beside a launch review, inside the launch review's team cards. */
export function teamFacts(a: FactsArgs): { tags: ReactNode; body: ReactNode; dropped: boolean } {
  const st = a.starter;
  const on = (ids: string[]) => ids.length === 0 || ids.some((id) => !a.signalsOff[id]);
  const starting = st.stage === "starting";
  const t = st.teams.filter((x) => on(x.signal_ids)).find((x) => same(x.team, a.name));
  const cov = st.coverage.filter((x) => on(x.signal_ids)).find((x) => same(x.team, a.name));
  const owes = starting
    ? st.approvals.filter((x) => on(x.signal_ids) && same(x.team, a.name)).map((x) => ({ name: x.name, line: `Start: ${x.start}`, state: null as ApprovalState | null, signal_ids: x.signal_ids }))
    : st.approval_status.filter((x) => on(x.signal_ids) && same(x.team, a.name)).map((x) => ({ name: x.name, line: prettyDates(x.detail), state: x.state as ApprovalState | null, signal_ids: x.signal_ids }));
  const acts = st.next_actions.filter((x) => on(x.signal_ids) && same(x.team, a.name));
  const sig = new Map(st.signals.map((g) => [g.id, g]));
  const quote = [...(t?.signal_ids ?? cov?.signal_ids ?? []), ...owes.flatMap((o) => o.signal_ids)].map((id) => sig.get(id)).find(Boolean);
  // Building asks Jira and the directory who is on the work, so its coverage names the contact; just starting, the reading does.
  const contact = (cov ? cov.contact : t?.contact) ?? null;
  const commitmentOf = (kind: "team" | "approval", what: string) => (a.commitments?.length ? findMatch(a.commitments, kind, a.name, what) : null);
  const tc = commitmentOf("team", `Involve ${a.name}`);
  const dropped = tc?.state === "dropped";
  const { actionsDone, toggle } = a.state;
  const tags = <>
    {a.readiness && <span className={READY_CLASS[a.readiness.state]} data-testid="readiness">{READINESS_LABEL[a.readiness.state]}</span>}
    {t && <span className="rel-tag" title={CLOSENESS[t.role].title} data-testid="closeness">{CLOSENESS[t.role].label}</span>}
    {owes.length > 0 && <span className="rel-tag signs" data-testid="signs-off">Signs off: {owes.map((o) => o.name).join(", ")}</span>}
    {cov && !a.readiness && <span className={"cov " + cov.state}>{COV_LABEL[cov.state]}</span>}
    {tc && (!a.readiness || dropped) && <span className="small muted">{dropped ? "Dropped" : tc.state === "tracked" ? "Tracked" : tc.state === "done" ? "Done" : "Open"}</span>}
  </>;
  const body = <>
    <dl className="team-facts">
      {a.readiness && <>
        <dt>Launch</dt>
        <dd><span className="sm" data-testid="readiness-why">{a.readiness.reasons.join(" · ")}</span></dd>
      </>}
      <dt>Why</dt>
      <dd>
        <span className="sm text2">{cov && !starting ? cov.found : t?.why ?? owes[0]?.line}</span>
        {quote && <span className="small muted">“{quote.quote}” · {quote.file} {quote.locator}</span>}
        {t && starting && <span className="small muted">Involve: <strong style={{ fontWeight: 500, color: "var(--ink)" }}>{t.when}</strong></span>}
      </dd>
      <dt>Who</dt>
      <dd><span className={"sm" + (contact ? "" : " muted")}>{contact ?? `${a.name} lead`}{!contact && <Info>Connect your directory for a name.</Info>}</span></dd>
      {cov && !starting && !a.readOnly && a.link && (cov.state !== "covered" || a.link.linked[a.name]) && <>
        <dt>Jira</dt>
        <dd data-testid={`team-link-${a.name}`}><LinkProject team={a.name} linked={a.link.linked[a.name] ?? null} link={a.link} /></dd>
      </>}
      {owes.length > 0 && <>
        <dt>Owes</dt>
        <dd className="stack-sm" style={{ gap: 6 }}>
          {owes.map((o) => {
            const ac = commitmentOf("approval", o.name);
            return (
              <span key={o.name} className="owe-row" data-testid={starting ? undefined : `approval-${o.name}`}>
                <span style={{ fontWeight: 500 }}>{o.name}</span>
                {o.state && <span className={"cov " + (o.state === "done" || o.state === "started" ? "covered" : o.state === "no_owner" ? "unclear" : "missing")}>{APPR_LABEL[o.state]}</span>}
                <span className="small muted">{o.line}</span>
                {ac?.state === "dropped" && <span className="small muted">Dropped: {ac.decision?.reason}</span>}
                {ac && <DropControl c={ac} label={o.name} onCommitment={a.onCommitment} readOnly={a.readOnly} />}
              </span>
            );
          })}
        </dd>
      </>}
      {acts.length > 0 && !dropped && a.later && <>
        <dt>Later<Info>Asked for when the project gets there; it joins your next actions then.</Info></dt>
        <dd className="stack-sm" style={{ gap: 4 }} data-testid="team-later">
          {acts.map((x) => <span key={x.id} className="sm text2">{prettyDates(x.text)} <span className="small muted">· {x.when}</span></span>)}
        </dd>
      </>}
      {acts.length > 0 && !dropped && !a.later && <>
        <dt>Next</dt>
        <dd className="stack-sm" style={{ gap: 4 }} data-testid="team-next">
          {acts.map((x) => (
            <span key={x.id} className="team-next">
              <span className={"sm" + (actionsDone[x.id] ? " done" : "")}>{prettyDates(x.text)} <span className="small muted">· {x.when}</span></span>
              {!a.readOnly && (actionsDone[x.id]
                ? <span className="row" style={{ gap: 8, alignItems: "center" }}><span className="small" style={{ color: "var(--green-dark)", fontWeight: 600 }}>✓ Done</span><button type="button" className="linkbtn" style={{ minHeight: 28, fontSize: 13 }} aria-label={`Undo: ${x.text}`} onClick={() => toggle(x.id)}>Undo</button></span>
                : <button type="button" className="btn" style={{ minHeight: 32, padding: "0 12px", fontSize: 14 }} aria-label={`Mark done: ${x.text}`} onClick={() => toggle(x.id)}>Mark done</button>)}
            </span>
          ))}
        </dd>
      </>}
    </dl>
    {tc && (
      <div className="team-foot">
        <span className="small muted">Committed since {firstSeenLabel(tc, fmtDate)}{dropped && tc.decision ? ` · dropped: ${tc.decision.reason}` : ""}</span>
        <DropControl c={tc} label={a.name} onCommitment={a.onCommitment} readOnly={a.readOnly} />
      </div>
    )}
  </>;
  return { tags, body, dropped };
}
const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();
const READY_CLASS: Record<Readiness, string> = { ready: "badge on_track", at_risk: "badge at_risk", unknown: "cov unclear", blocking: "badge late" };
const READY_GROUP: Record<Readiness, string> = { blocking: "Won't clear on its own", at_risk: "Under way, not done", unknown: "Jira can't show it", ready: "On the work, sign-offs done" };
const VERDICT: Record<Readiness, string> = { blocking: "not ready", at_risk: "at risk", unknown: "can't tell yet", ready: "ready" };

export function EarlyResults(p: Props) {
  const st = p.starter;
  const own = useStarterState(p.store, p.state ? null : st);
  const shared = p.state ?? own;
  const { actionsDone } = shared;
  const inLaunch = p.mode === "inLaunch";

  // Anything implied only by unticked signals is left out.
  const on = (ids: string[]) => ids.length === 0 || ids.some((id) => !p.signalsOff[id]);
  const teams = st.teams.filter((t) => on(t.signal_ids));
  const approvals = st.approvals.filter((a) => on(a.signal_ids));
  const coverage = st.coverage.filter((c) => on(c.signal_ids));
  const approvalStatus = st.approval_status.filter((a) => on(a.signal_ids));
  // Teams whose milestone is still ahead of where the project stands are coming up: listed apart, their actions not asked yet.
  const horizon = HORIZON[p.phase ?? "launching"];
  const whenOfTeam = (name: string) => st.teams.find((t) => t.team === name)?.when ?? st.approvals.find((a) => a.team === name)?.start ?? "";
  const isLater = (name: string) => whenGroup(whenOfTeam(name)).rank > horizon;
  const actions = st.next_actions.filter((a) => on(a.signal_ids) && !isLater(a.team));
  const openActions = actions.filter((a) => !actionsDone[a.id]).length;
  const starting = st.stage === "starting";
  const covered = coverage.filter((c) => c.state === "covered").length;
  const missing = coverage.filter((c) => c.state === "missing").length;
  const openNow = actions.filter((a) => !actionsDone[a.id]).length;
  const ready = p.readiness && !starting ? teamReadiness(st, p.signalsOff, p.commitments) : null;
  const verdict = ready ? overall(ready) : null;
  const readyOf = (name: string) => ready?.find((r) => same(r.team, name));
  const verdictKey = verdict ? JSON.stringify(verdict.counts) : "";
  useEffect(() => {
    if (p.readOnly || inLaunch) return;
    p.onSummary?.(st.stage === "starting"
      ? { status: null, open: openNow, detail: `${st.teams.length} teams to involve` }
      : verdict
        ? { status: verdict.state === "blocking" ? "Red" : verdict.state === "ready" ? "Green" : "Amber", open: openNow, detail: `${verdict.counts.ready} of ${ready!.length} teams ready to launch` }
        : { status: missing ? "Red" : coverage.some((c) => c.state === "unclear") ? "Amber" : "Green", open: openNow, detail: `${covered} of ${coverage.length} teams covered` });
  }, [openNow, missing, covered, verdictKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const unclear = coverage.filter((c) => c.state === "unclear").length;
  const notStarted = approvalStatus.filter((a) => a.state === "not_started").length;
  const toggle = shared.toggle;
  const jump = (team: string) => document.getElementById(teamSlug(team))?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Every team the review talks about, grouped the way the stage reads: by how closely to involve them when just
  // starting, by whether they are on the work when building (missing first).
  const allTeams = [...new Set([...teams.map((t) => t.team), ...approvals.map((a) => a.team), ...coverage.map((c) => c.team), ...approvalStatus.map((a) => a.team)])];
  // Just starting, the cards follow the one real sequence, when to involve each team; how closely, and whether it signs
  // off, are on each card. Building, they follow whether the team is on the Jira work, missing first.
  const whenOf = (name: string) => teams.find((t) => t.team === name)?.when ?? approvals.find((a) => a.team === name)?.start ?? "";
  const groups: { id: string; label: string; desc: string; teams: string[] }[] = ready
    ? READINESS_ORDER.map((id): { id: string; label: string; desc: string; teams: string[] } => ({ id, label: READINESS_LABEL[id], desc: READY_GROUP[id], teams: ready.filter((r) => r.state === id).map((r) => r.team) }))
        .concat([{ id: "dropped", label: "Dropped", desc: "Not counted for launch", teams: allTeams.filter((n) => !readyOf(n)) }])
        .filter((g) => g.teams.length)
    : starting
    ? [...new Map(allTeams.map((n) => whenGroup(whenOf(n))).sort((a, b) => a.rank - b.rank).map((g) => [g.id, g])).values()]
        .map((g) => ({ id: g.id, label: g.label, desc: "", teams: allTeams.filter((n) => whenGroup(whenOf(n)).id === g.id) }))
    : ([["missing", "Missing from the work", "Nobody from the team is on the Jira work yet"], ["unclear", "Unclear", "Can't tell from Jira whether they are on the work"], ["covered", "On the work", "Someone from the team is on the Jira work"]] as const)
        .map(([id, label, desc]): { id: string; label: string; desc: string; teams: string[] } => ({ id, label, desc, teams: coverage.filter((c) => c.state === id).map((c) => c.team) }))
        .concat([{ id: "other", label: "Also owes an approval", desc: "Not among the teams checked against Jira", teams: allTeams.filter((n) => !coverage.some((c) => c.team === n)) }])
        .filter((g) => g.teams.length);
  // Beside a launch review, its cards carry the teams it covers; this lists the rest.
  const shownGroups = (inLaunch ? groups.map((g) => ({ ...g, teams: g.teams.filter((n) => !(p.excludeTeams ?? []).some((x) => same(x, n))) })) : groups)
    .map((g) => ({ ...g, teams: g.teams.filter((n) => !isLater(n)) })).filter((g) => g.teams.length);
  const laterTeams = allTeams.filter((n) => isLater(n) && !(inLaunch && (p.excludeTeams ?? []).some((x) => same(x, n))))
    .sort((a, b) => whenGroup(whenOfTeam(a)).rank - whenGroup(whenOfTeam(b)).rank);
  const laterWhen = [...new Set(laterTeams.map((n) => whenGroup(whenOfTeam(n)).label.toLowerCase()))];

  // The checklist goes to the panel: each action with who and when, and its team, whose card holds the why.
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  const jumpRef = useRef(jump); jumpRef.current = jump;
  // Who (when it is a person, not just the team) and by when; the why is on the team card the action leads to.
  const actionItems: ActionGlance[] = actions.map((a) => ({ id: a.id, text: prettyDates(a.text), detail: a.who === a.team ? a.when : `${a.who} · ${a.when}`, team: a.team, done: !!actionsDone[a.id] }));
  const itemsKey = JSON.stringify(actionItems);
  useEffect(() => {
    if (p.readOnly || !p.onActions) return;
    p.onActions({ items: actionItems, toggle: (id) => toggleRef.current(id), jump: (id) => { const t = actionItems.find((a) => a.id === id)?.team; if (t) jumpRef.current(t); },
      later: laterTeams.length ? { teams: laterTeams.length, when: laterWhen, anchor: "coming-up" } : undefined });
  }, [itemsKey, laterTeams.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One team's card: its name and tags, then its facts (teamFacts). */
  const teamCard = (name: string, later = false) => {
    const f = teamFacts({ starter: st, signalsOff: p.signalsOff, name, state: shared, readOnly: p.readOnly, link: p.link, commitments: p.commitments, onCommitment: p.onCommitment, later, readiness: readyOf(name) });
    return (
      <article key={name} id={teamSlug(name)} className={"card team-card" + (f.dropped ? " dropped" : "")} data-testid={st.stage === "starting" ? `involve-${name}` : `coverage-${name}`}>
        <div className="between" style={{ gap: 8, alignItems: "baseline" }}>
          <h3 className="h3" style={{ margin: 0 }}>{name}</h3>
          <span className="row" style={{ gap: 8, alignItems: "baseline" }}>{f.tags}</span>
        </div>
        {f.body}
      </article>
    );
  };

  const groupList = (list: typeof groups) => list.map((g) => (
    <div key={g.id} className="role-group" data-testid={`role-${g.id}`}>
      <div className="role-head">
        <span style={{ fontWeight: 600 }}>{g.label}</span>
        {g.desc && <span className="small muted">{g.desc}</span>}
      </div>
      <div className="stack" style={{ gap: 12 }}>
        {g.teams.map((name) => teamCard(name))}
      </div>
    </div>
  ));

  /** Teams whose milestone is still ahead: one line each (who, when, what they will owe), the full card a click away. */
  const comingUp = laterTeams.length > 0 && (
    <section className="stack" style={{ gap: 10, scrollMarginTop: 16 }} id="coming-up" data-testid="coming-up" aria-labelledby="coming-up-title">
      <div className="stack-sm" style={{ gap: 2 }}>
        <h2 id="coming-up-title" className="h3">Coming up<Info>Not needed yet. Their actions join your next actions when the project gets there.</Info></h2>
        <p className="sm muted" style={{ margin: 0 }}>Needed {laterWhen.join(" and ")}</p>
      </div>
      {laterTeams.map((name) => {
        const owes = [...st.approvals, ...st.approval_status].filter((a) => same(a.team, name)).map((a) => a.name);
        return (
          <details key={name} className="card later-team" data-testid={`later-${name}`}>
            <summary>
              <span style={{ fontWeight: 600 }}>{name}</span>
              <span className="small muted">{whenGroup(whenOfTeam(name)).label}{owes.length ? ` · signs off: ${[...new Set(owes)].join(", ")}` : ""}</span>
            </summary>
            {teamCard(name, true)}
          </details>
        );
      })}
    </section>
  );

  // Beside a launch review: only the teams the plan of record leaves out, which would otherwise be lost at launch.
  if (inLaunch) return shownGroups.length || laterTeams.length ? (
    <section className="stack" style={{ gap: 16, scrollMarginTop: 16 }} id="prd-teams" data-testid="prd-teams" aria-labelledby="prd-teams-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="prd-teams-title">Also in your PRD<Info>Teams your PRD names that the plan of record does not. Confirm each is still needed, or drop it with a reason.</Info></h2>
      </div>
      <div className="stack" style={{ gap: 20 }}>{groupList(shownGroups)}</div>
      {comingUp}
    </section>
  ) : null;

  return (
    <div className="flow stack">
      <header className="stack-sm" style={{ gap: 8 }}>
        <span className="eyebrow">{p.eyebrow ?? "Step 3 of 3"} · {STAGE_SHORT[verdict ? "launching" : st.stage]}</span>
        <h1 className="flow-title">{verdict
          ? `${p.readiness!.date ? `Launch ${fmtDate(p.readiness!.date)}` : "Launch"}: ${VERDICT[verdict.state]}`
          : starting ? "Who to involve, and what to do first" : "Who's missing, and what hasn't started"}</h1>
        <p className="lead">{starting
          ? `From ${st.files.filter((f) => f.read_as.includes("plan_items")).map((f) => f.name).join(", ")}${st.directory_given ? " and your directory" : ""} · ${teams.length} teams suggested`
          : `From your ${verdict ? "PRD" : "plan"} and ${st.epic} in Jira · the ${fmtDate(st.snapshot_label)} snapshot`}
          {verdict && <Info>No plan of record or launch checklist, so each team is checked for what your PRD asks of it: being on the work, and its sign-offs done.</Info>}</p>
        {verdict && p.readiness!.onAddChecklist && !p.readOnly && (
          <span className="small muted">Have a launch checklist? <button type="button" className="linkbtn" onClick={p.readiness!.onAddChecklist}>Add it</button></span>
        )}
      </header>

      {!p.onActions && <section className="card" style={{ gap: 6, borderColor: "var(--accent)" }} data-testid="next-actions">
        <div className="between" style={{ alignItems: "baseline", gap: 8 }}>
          <h2>Your next actions</h2>
          <span className="small muted" data-testid="actions-count">{openActions} open · {actions.length - openActions} done</span>
        </div>
        {actions.length === 0 && <p className="sm muted">Nothing open. Re-run when the plan or the work changes.</p>}
        {actions.map((a) => {
          const done = !!actionsDone[a.id];
          return (
            <div key={a.id} className="action-row">
              <input id={`act-${a.id}`} type="checkbox" checked={done} disabled={p.readOnly} onChange={() => toggle(a.id)} />
              <label htmlFor={`act-${a.id}`}>
                <span className={done ? "done" : ""} style={done ? undefined : { fontWeight: 500 }}>{prettyDates(a.text)}</span>
                <span className="small muted"><strong style={{ fontWeight: 500, color: "var(--text-2)" }}>{a.who}</strong> · {a.when} · {a.why}</span>
              </label>
              <button type="button" className="linkbtn team-jump" onClick={() => jump(a.team)} aria-label={`Go to ${a.team}`}>{a.team} ›</button>
            </div>
          );
        })}
      </section>}

      {!starting && (
        <div className="tiles">
          {verdict ? (
            <div className={"tile " + (verdict.state === "ready" ? "green" : "amber")} data-testid="readiness-tile">
              <div className="small">Teams ready</div>
              <div className="big" data-testid="ready-count">{verdict.counts.ready} of {ready!.length}</div>
              <div className="small">{(["blocking", "at_risk", "unknown"] as const).filter((k) => verdict.counts[k]).map((k) => `${verdict.counts[k]} ${READINESS_LABEL[k].toLowerCase()}`).join(" · ") || "Nothing open"}</div>
            </div>
          ) : (
            <div className={"tile " + (missing + unclear > 0 ? "amber" : "green")}>
              <div className="small">Teams covered</div>
              <div className="big" data-testid="covered-count">{covered} of {coverage.length}</div>
              <div className="small">{missing} missing · {unclear} unclear</div>
            </div>
          )}
          <div className="tile"><div className="small muted">Approvals not started</div><div className="big" data-testid="not-started-count">{notStarted} of {approvalStatus.length}</div></div>
          <div className="tile"><div className="small muted">Epic</div><div className="big mono" style={{ fontSize: 20 }}>{st.epic}</div><div className="small muted">{(p.readiness?.date ?? p.launch) ? `Launch ${fmtDate((p.readiness?.date ?? p.launch)!)} · from the fix version` : "No launch date yet"}</div></div>
        </div>
      )}

      {!st.directory_given && (
        <div className="between notice" style={{ gap: 10 }}>
          <span>Connect your directory to see who to contact.</span>
          <button type="button" className="btn outline-accent" style={{ padding: "0 14px" }} onClick={p.onConnectApps}>Connect directory</button>
        </div>
      )}

      {/* One card per team: why the plan needs it, who to contact, what it owes, what the review found, and what to do. */}
      <section className="stack" style={{ gap: 16 }} id="teams" data-testid="stakeholder-map" aria-labelledby="teams-title">
        <div className="stack-sm" style={{ gap: 4 }}>
          <h2 id="teams-title">{starting ? "Who to involve" : "Teams your plan needs"}<Info>{starting
            ? "Each team, why your plan needs it, who to contact, the approvals it owes, and what to do first."
            : `Each team, compared with who is actually working on ${st.epic} in Jira, with the approvals it owes and what to do.`}</Info></h2>
        </div>
        <div className="stack" style={{ gap: 20 }} data-testid="teams-to-involve">{groupList(shownGroups)}</div>
      </section>
      {comingUp}

      {st.warnings.length > 0 && <div className="notice-grey">{st.warnings.join(" ")}</div>}

      <p className="small muted limits" data-testid="limits">What this review can't see<Info>Anything agreed only in meetings, chat or email; approvals tracked in apps that aren't connected; and whether the technical work itself is adequate.</Info></p>

      {!p.readOnly && p.onOverview && <div><button type="button" className="btn" onClick={p.onOverview}>‹ Overview</button></div>}
    </div>
  );
}
