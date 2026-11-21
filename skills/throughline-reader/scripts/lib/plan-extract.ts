/**
 * Stage A: turn plan files into a PlanDraft. Deterministic rules for structured
 * plans (sections + bullets, checklist tables, team lists). Agent-written items
 * go through the same assembler (see assembleAgentItems) so "no source, no item"
 * holds either way.
 */
import { PlanDraft, PlanItem, PlanItemKind, PlanTeam, ProjectKey, ReadAs } from "@throughline/schemas";
import { findDatePhrase, findLaunchDate } from "./dates.js";
import { extractIssueKeys, explicitProjectKeys } from "./keys.js";
import type { LoadedFile } from "./files.js";

export interface ExtractOptions {
  files: LoadedFile[];
  /** Override the detected read_as per file name. */
  readAs?: Record<string, ReadAs[]>;
  /** Override the detected launch date. */
  launchDate?: string | null;
  /** Items written by the agent (unstructured documents). Validated against the files. */
  agentItems?: AgentItem[];
  /** Teams the agent read from a team list or org chart; each name must appear in its file. */
  agentTeams?: AgentTeam[];
  /** The launch date the agent read, used when none is given; its quote must be in the file. */
  agentLaunchDate?: AgentLaunchDate | null;
  /** Epic keys the agent read; each must appear in a file. */
  agentEpicKeys?: string[];
  /** The agent read the files. The parsers read nothing on their own; the files are loaded only to check the agent's quotes. */
  agentOnly?: boolean;
  /** With agentOnly: the files the agent read. Any other file (a directory export the connector added) is still parsed by the rules. */
  agentFiles?: string[];
}

export interface AgentItem {
  text: string;
  kind: PlanItemKind;
  owner_team: string | null;
  due_text?: string | null;
  due?: string | null;
  source: { file: string; locator: string; quote: string };
  /** Checklist items only: the document's words for when the check applies, and whether the agent judged it applies to this release. */
  applies_to?: string | null;
  applies?: boolean;
}

export interface AgentTeam {
  name: string;
  role?: string | null;
  jira_project?: string | null;
  owners?: string[];
  components?: string[];
  source: { file: string; locator?: string | null };
}

export interface AgentLaunchDate { date: string; source: { file: string; quote: string } }

// ---------- classification ----------

export function classifyFile(f: LoadedFile): ReadAs[] {
  const out: ReadAs[] = [];
  const d = f.data as any;
  if (d && typeof d === "object" && Array.isArray(d.teams)) out.push("teams_and_owners");
  if (f.rows && f.rows.length > 1) {
    const h = f.rows[0].map((c) => c.toLowerCase());
    if (h.some((c) => /check|requirement|gate/.test(c)) && h.some((c) => /applies|scope|when|owner/.test(c))) out.push("launch_checks");
    else if (h.some((c) => /^(team|name)$/.test(c)) && h.some((c) => /project|jira/.test(c))) out.push("teams_and_owners");
    else if (h.some((c) => /item|deliverable|milestone/.test(c)) && h.some((c) => /owner|team/.test(c))) out.push("plan_items");
  }
  if (!out.length && f.text) {
    const t = f.text.toLowerCase();
    if (/plan of record|\bpor\b|deliverables|dependencies|milestones|launch plan/.test(t)) out.push("plan_items");
    else if (/checklist|launch checks|readiness check/.test(t)) out.push("launch_checks");
    else if (/org (map|chart)|team roster|\bteams?:/.test(t)) out.push("teams_and_owners");
  }
  return out;
}

// ---------- sections ----------

interface Section {
  number: string | null;
  heading: string;
  locator: string;
  body: string;
  /** Table rows (decks). */
  rows?: string[][];
}

export function splitSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let cur: Section = { number: null, heading: "", locator: "preamble", body: "" };
  const headingRe = /^(?:#{1,6}\s+)?(?:(\d+(?:\.\d+)*)[.)]?\s+)?([A-Z][^\n]{0,80})$/;
  for (const raw of lines) {
    const line = raw.trim();
    const isMd = /^#{1,6}\s+/.test(line);
    const m = line.match(headingRe);
    const looksLikeHeading = isMd || (m && m[1] && line.length < 80 && !/[.;:]$/.test(line));
    if (m && looksLikeHeading) {
      if (cur.body.trim() || cur.heading) sections.push(cur);
      const number = m[1] ?? null;
      const heading = m[2].trim();
      cur = { number, heading, locator: number ? `§${number}` : heading, body: "" };
    } else {
      cur.body += raw + "\n";
    }
  }
  if (cur.body.trim() || cur.heading) sections.push(cur);
  return sections;
}

function isPlanSection(heading: string): boolean {
  return /deliverable|dependenc|approval|readiness|milestone|commitment|scope|timeline/i.test(heading);
}

function kindForSection(heading: string, sentence: string): PlanItemKind {
  if (/approv|sign[- ]?off/i.test(sentence)) return "approval";
  if (/deliverable|milestone|scope/i.test(heading)) return "deliverable";
  if (/dependenc|readiness/i.test(heading)) return "dependency";
  if (/approval/i.test(heading)) return "approval";
  return "deliverable";
}

/** Bullets are one item each; other paragraphs split into sentences. Shared with throughline-starter's PRD reading. */
export function candidateSentences(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      out.push(line.replace(/^([-*•]|\d+[.)])\s+/, ""));
    } else {
      for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z])/)) if (s.trim()) out.push(s.trim());
    }
  }
  return out;
}

/**
 * A table row is a plan item only when one cell names a known team; other rows (headers, phases,
 * "Launch", "Go/no-go") are skipped and counted. The quote is the row's cells joined with " | ".
 */
export function rowItem(cells: string[], teams: string[], launchDate: string | null): { owner: string; label: string; quote: string; date: ReturnType<typeof findDatePhrase> } | null {
  const trimmed = cells.map((c) => c.trim());
  let ownerIdx = -1, owner = "";
  for (let i = 0; i < trimmed.length && ownerIdx < 0; i++) {
    for (const t of teams) if (trimmed[i].length <= t.length + 12 && teamRe(t).test(trimmed[i])) { ownerIdx = i; owner = t; break; }
  }
  if (ownerIdx < 0) return null;
  let dateIdx = -1, date: ReturnType<typeof findDatePhrase> = null;
  for (let i = 0; i < trimmed.length; i++) {
    if (i === ownerIdx) continue;
    const d = findDatePhrase(trimmed[i], launchDate);
    if (d && d.end - d.start >= trimmed[i].length * 0.6) { dateIdx = i; date = d; break; }
  }
  const rest = trimmed.filter((_, i) => i !== ownerIdx && i !== dateIdx && _.length);
  if (!rest.length) return null;
  const label = rest.slice().sort((a, b) => b.length - a.length)[0];
  return { owner, label: label.replace(/[\s.;,:]+$/, ""), quote: trimmed.join(" | "), date };
}

// ---------- teams ----------

const TEAM_STOP = new Set(["the", "a", "an", "and", "team", "teams"]);

/** Teams named in a "teams involved" sentence: "Four teams are involved: A (x), B, C and D." */
export function teamsFromProse(rawText: string): { name: string; role: string | null }[] {
  const text = rawText.replace(/\s+/g, " ");
  const m = text.match(/teams?\s+(?:are\s+)?(?:involved|participating|contributing)\s*:\s*([^.\n]+)\./i)
    ?? text.match(/\bteams?\s*:\s*([^.\n]+)\./i);
  if (!m) return [];
  const parts = splitOutsideParens(m[1]);
  const out: { name: string; role: string | null }[] = [];
  for (const p of parts) {
    const rm = p.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    let name = (rm ? rm[1] : p).trim().replace(/^the\s+/i, "");
    const role = rm ? rm[2].trim() : null;
    if (!name || TEAM_STOP.has(name.toLowerCase())) continue;
    out.push({ name, role });
  }
  return out;
}

/** Split a list on commas and " and ", ignoring separators inside parentheses. */
function splitOutsideParens(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === ",") { out.push(cur); cur = ""; continue; }
    if (depth === 0 && s.slice(i, i + 5) === " and ") { out.push(cur); cur = ""; i += 4; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

function teamRe(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i");
}

function ownerOf(sentence: string, teams: string[]): string | null {
  let best: { name: string; idx: number } | null = null;
  for (const t of teams) {
    const m = sentence.match(teamRe(t));
    if (m && m.index !== undefined && (!best || m.index < best.idx)) best = { name: t, idx: m.index };
  }
  if (best) return best.name;
  const m = sentence.match(/^(?:The\s+)?([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*(?:\s+team)?)\s+(?:\([^)]*\)\s+)?will\b/);
  return m ? m[1] : null;
}

// ---------- labels ----------

export function deriveLabel(sentence: string, owner: string | null, date: { start: number; end: number } | null): string {
  let s = sentence;
  if (date) s = s.slice(0, date.start) + " " + s.slice(date.end);
  s = s.replace(/\s*\([^)]*\)/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (owner) {
    const esc = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`^(?:the\\s+)?${esc}(?:\\s+team)?\\s+will\\s+(?:have\\s+|be\\s+)?(?:the\\s+)?`, "i"), "");
  }
  s = s.replace(/\s+will\s+(?:be|have)\s+/g, " ").replace(/\s+will\s+/g, " ");
  s = s.replace(/[\s.;,:]+$/, "").replace(/^[\s,;:]+/, "");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ---------- checklist ----------

function col(header: string[], re: RegExp): number {
  return header.findIndex((h) => re.test(h.toLowerCase()));
}

const STOP = new Set(["the", "a", "an", "of", "to", "with", "and", "or", "for", "in", "on"]);
function stem(w: string): string {
  return w.toLowerCase().replace(/s$/, "");
}

/** "All launches" always applies; otherwise every content word must appear in the launch profile. */
export function checkApplies(appliesTo: string, profile: string): boolean {
  const a = appliesTo.trim().toLowerCase();
  if (!a || /^(all|always|every launch|all launches|any)$/.test(a)) return true;
  const words = a.split(/[\s/]+/).map(stem).filter((w) => w && !STOP.has(w));
  const prof = profile.toLowerCase().split(/[^a-z0-9-]+/).map(stem);
  const profSet = new Set(prof);
  return words.every((w) => profSet.has(w));
}

// ---------- main ----------

export function extractPlan(opts: ExtractOptions): PlanDraft {
  const warnings: string[] = [];
  const fileEntries: PlanDraft["files"] = [];
  const readAsOf = new Map<string, ReadAs[]>();
  for (const f of opts.files) {
    for (const w of f.warnings ?? []) warnings.push(w.includes(f.name) ? w : `${f.name}: ${w}`);
    const unreadable = !f.text && !f.rows && !f.data && !f.segments;
    const detected = unreadable ? [] : (opts.readAs?.[f.name] ?? classifyFile(f));
    readAsOf.set(f.name, detected);
    if (unreadable) { if (!(f.warnings ?? []).length) warnings.push(`${f.name}: nothing could be read from it; not used.`); }
    else if (!detected.length) warnings.push(`${f.name}: could not tell what it contains; not used. Pass --read-as ${f.name}=plan_items|launch_checks|teams_and_owners.`);
  }
  const agentOnly = !!opts.agentOnly;
  const agentNames = new Set(opts.agentFiles ?? (agentOnly ? opts.files.map((f) => f.name) : []));
  const withReadAs = (ra: ReadAs) => opts.files.filter((f) => readAsOf.get(f.name)?.includes(ra));
  // With the agent reading, the parsers only get the files it did not read: the lists below drive the rules only.
  const byRules = (ra: ReadAs) => withReadAs(ra).filter((f) => !agentOnly || !agentNames.has(f.name));
  const planFiles = byRules("plan_items");
  const checkFiles = byRules("launch_checks");
  const teamFiles = byRules("teams_and_owners");
  if (!planFiles.length && !agentOnly) warnings.push("No file was read as plan items. A POR is required.");
  const isUnreadable = (f: LoadedFile) => !f.text && !f.rows && !f.data && !f.segments;
  /** Where a quote may sit: the text as loaded, plus a table's raw lines (an agent quotes a csv row as written). */
  const haystack = (f: LoadedFile) => f.rawLines ? `${f.text}\n${f.rawLines.join("\n")}` : f.text;

  // Launch date: given, or the agent's (quote checked), or found in the plan text.
  let launch_date: string | null = opts.launchDate ?? null;
  if (!launch_date && opts.agentLaunchDate) {
    const d = opts.agentLaunchDate;
    const f = opts.files.find((x) => x.name === d.source?.file);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) warnings.push(`The agent's launch date "${d.date}" was not used: not a date (YYYY-MM-DD).`);
    else if (!f) warnings.push(`The agent's launch date ${d.date} was not used: ${d.source?.file} is not one of the inputs.`);
    else if (!isUnreadable(f) && !containsQuote(haystack(f), d.source.quote ?? "")) warnings.push(`The agent's launch date ${d.date} was not used: its quote was not found in ${f.name}.`);
    else launch_date = d.date;
  }
  if (!launch_date) {
    for (const f of withReadAs("plan_items")) { launch_date = findLaunchDate(f.text); if (launch_date) break; }
  }
  if (!launch_date) warnings.push("No launch date found in the plan files; relative dates could not be resolved.");

  // Teams: team list first, then POR prose
  const teams = new Map<string, PlanTeam>();
  const addTeam = (name: string, mention: string | null, patch: Partial<PlanTeam> = {}) => {
    const key = name.toLowerCase();
    const existing = [...teams.values()].find((t) => t.name.toLowerCase() === key);
    const t: PlanTeam = existing ?? { name, mentioned_in: [], jira_project_hint: null, owners: [], components: [], role: null, project_keys_mentioned: [] };
    if (mention && !t.mentioned_in.includes(mention)) t.mentioned_in.push(mention);
    Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length))));
    teams.set(key, t);
    return t;
  };
  for (const f of teamFiles) {
    const list = teamListEntries(f);
    for (const e of list) addTeam(e.name, f.name, { jira_project_hint: e.project, owners: e.owners, components: e.components, role: e.role });
    fileEntries.push({ name: f.name, read_as: readAsOf.get(f.name)!, notes: `${list.length} teams · ${list.filter((e) => e.project).length} Jira projects · ${list.reduce((n, e) => n + e.owners.length, 0)} owners` });
  }

  // Teams the agent read (a team list or org chart in any format). A name that is not in the file is dropped.
  const agentTeamCounts = new Map<string, { teams: number; projects: number; owners: number }>();
  for (const t of opts.agentTeams ?? []) {
    const name = String(t.name ?? "").trim();
    const f = opts.files.find((x) => x.name === t.source?.file);
    if (!f) { warnings.push(`Dropped agent team "${name}": source file ${t.source?.file} is not one of the inputs.`); continue; }
    if (!name) continue;
    if (!isUnreadable(f) && !containsQuote(haystack(f), name)) { warnings.push(`Dropped agent team "${name}": the name was not found in ${f.name}.`); continue; }
    const project = t.jira_project ? String(t.jira_project).trim().toUpperCase() : null;
    // The mention is the file name alone, as for a parsed team list: Stage B leaves out teams a list is the only source for.
    addTeam(name, f.name, { jira_project_hint: project && ProjectKey.safeParse(project).success ? project : null, owners: (t.owners ?? []).map(String), components: (t.components ?? []).map(String), role: t.role ?? null });
    const c = agentTeamCounts.get(f.name) ?? { teams: 0, projects: 0, owners: 0 };
    c.teams++; if (project) c.projects++; c.owners += (t.owners ?? []).length;
    agentTeamCounts.set(f.name, c);
  }

  // Plan items
  const items: PlanItem[] = [];
  const epicKeys = new Set<string>();
  let profileText = "";
  if (agentOnly) {
    // Issue keys are a pattern, not a reading: the files are scanned for them, and the agent's are kept when they appear in a file.
    for (const f of withReadAs("plan_items")) for (const k of extractIssueKeys(f.text)) epicKeys.add(k);
    for (const k of opts.agentEpicKeys ?? []) if (opts.files.some((f) => isUnreadable(f) || norm(f.text).includes(k.toLowerCase()))) epicKeys.add(k.toUpperCase());
  }
  for (const f of planFiles) {
    for (const k of extractIssueKeys(f.text)) epicKeys.add(k);
    const sections: Section[] = f.segments
      ? f.segments.map((seg) => ({ number: null, heading: seg.heading, locator: seg.locator, body: seg.body, rows: seg.rows }))
      : splitSections(f.text);
    let rowsSkipped = 0;
    const proseTeams = teamsFromProse(f.text);
    for (const t of proseTeams) addTeam(t.name, null, { role: t.role });
    const teamNames = [...teams.values()].map((t) => t.name);
    for (const sec of sections) {
      if (/overview|summary|profile|context|background/i.test(sec.heading) || sec.locator === "preamble") profileText += sec.body + "\n";
      for (const t of teamNames) if (teamRe(t).test(sec.body)) addTeam(t, `${f.name} ${sec.locator}`);
      if (!isPlanSection(sec.heading)) continue;
      for (const row of sec.rows ?? []) {
        const r = rowItem(row, teamNames, launch_date);
        if (!r) { rowsSkipped++; continue; }
        const team = addTeam(r.owner, `${f.name} ${sec.locator}`);
        for (const k of explicitProjectKeys(r.quote)) if (!team.project_keys_mentioned.includes(k)) team.project_keys_mentioned.push(k);
        items.push({
          id: "",
          text: r.label,
          kind: kindForSection(sec.heading, r.quote),
          owner_team: team.name,
          due: r.date?.due ?? null,
          due_text: r.date?.due_text ?? null,
          due_is_inferred: r.date?.inferred ?? false,
          source: { file: f.name, locator: sec.locator, quote: r.quote },
        });
      }
      for (const sentence of candidateSentences(sec.body)) {
        const owner = ownerOf(sentence, teamNames);
        if (!owner) { warnings.push(`${f.name} ${sec.locator}: no owning team found, skipped: "${sentence}"`); continue; }
        const dm = findDatePhrase(sentence, launch_date);
        const team = addTeam(owner, `${f.name} ${sec.locator}`);
        for (const k of explicitProjectKeys(sentence)) if (!team.project_keys_mentioned.includes(k)) team.project_keys_mentioned.push(k);
        items.push({
          id: "",
          text: deriveLabel(sentence, team.name, dm),
          kind: kindForSection(sec.heading, sentence),
          owner_team: team.name,
          due: dm?.due ?? null,
          due_text: dm?.due_text ?? null,
          due_is_inferred: dm?.inferred ?? false,
          source: { file: f.name, locator: sec.locator, quote: sentence },
        });
      }
    }
    if (!profileText.trim()) profileText = f.text;
    const counts = countKinds(items.filter((i) => i.source.file === f.name));
    const slides = f.segments ? f.segments.filter((sg) => !/\(notes\)$/.test(sg.locator)).length : 0;
    fileEntries.push({ name: f.name, read_as: readAsOf.get(f.name)!, notes: `${slides ? slides + " slides · " : ""}${counts} · names ${teams.size} teams${epicKeys.size ? " and epic " + [...epicKeys].sort().join(", ") : ""}${rowsSkipped ? ` · ${rowsSkipped} table rows without a team skipped` : ""}` });
  }

  // Agent items: the agent read the document itself, in any format. When the command can read the file too, the
  // quote must be in it; when it cannot (a format without a parser, a file the parser failed on), the item is kept
  // with quote_verified: false and a warning, so the person sees what rests on the agent's word.
  const agentCounts = new Map<string, { items: number; unchecked: number }>();
  // Checks the agent read from a checklist: every row counts, only the ones it judged to apply become items.
  const agentCheckCounts = new Map<string, { total: number; applied: number }>();
  for (const a of opts.agentItems ?? []) {
    const f = opts.files.find((x) => x.name === a.source?.file);
    if (!f) { warnings.push(`Dropped agent item "${a.text}": source file ${a.source?.file} is not one of the inputs.`); continue; }
    if (!a.source.quote) { warnings.push(`Dropped agent item "${a.text}": it has no quote.`); continue; }
    const unreadable = isUnreadable(f);
    if (!unreadable && !containsQuote(haystack(f), a.source.quote)) { warnings.push(`Dropped agent item "${a.text}": its quote was not found in ${f.name}.`); continue; }
    if (items.some((i) => norm(i.source.quote) === norm(a.source.quote))) continue;
    if (a.kind === "checklist" && typeof a.applies === "boolean") {
      const c = agentCheckCounts.get(f.name) ?? { total: 0, applied: 0 };
      c.total++; if (a.applies) c.applied++;
      agentCheckCounts.set(f.name, c);
      if (!a.applies) continue;
    }
    const count = agentCounts.get(f.name) ?? { items: 0, unchecked: 0 };
    count.items++;
    if (unreadable) { count.unchecked++; warnings.push(`${f.name}: the command could not read it, so the quote for "${a.text}" was not checked; confirm it against the file.`); }
    agentCounts.set(f.name, count);
    const dm = a.due_text ? findDatePhrase(a.due_text, launch_date) : null;
    if (a.owner_team) addTeam(a.owner_team, `${f.name} ${a.source.locator}`);
    items.push({
      id: "",
      text: a.text,
      kind: a.kind,
      owner_team: a.owner_team,
      due: a.due ?? dm?.due ?? null,
      due_text: a.due_text ?? null,
      due_is_inferred: a.due ? false : (dm?.inferred ?? false),
      source: { file: f.name, locator: a.source.locator, quote: a.source.quote, ...(unreadable ? { quote_verified: false } : {}) },
    });
  }
  // What the agent read also describes the release, for the checklist's "applies to" column.
  if (agentCounts.size) profileText += (opts.agentItems ?? []).map((x) => `${x.text}\n${x.source?.quote ?? ""}`).join("\n") + "\n";

  // Checklist
  const deliverableOwner = items.find((i) => i.kind === "deliverable")?.owner_team ?? null;
  for (const f of checkFiles) {
    if (!f.rows || f.rows.length < 2) { warnings.push(`${f.name}: read as launch checks but it has no table rows.`); continue; }
    const header = f.rows[0];
    const cId = col(header, /^(#|id|no\.?|number)$/);
    const cCheck = col(header, /check|requirement|item|gate/);
    const cOwner = col(header, /owner|team/);
    const cApplies = col(header, /applies|scope|when|condition/);
    const cDue = col(header, /due|date|by/);
    if (cCheck < 0) { warnings.push(`${f.name}: no 'check' column found.`); continue; }
    let applied = 0;
    const total = f.rows.length - 1;
    for (let r = 1; r < f.rows.length; r++) {
      const row = f.rows[r];
      const applies = cApplies >= 0 ? row[cApplies] ?? "" : "";
      if (!checkApplies(applies, profileText)) continue;
      applied++;
      const idText = cId >= 0 && row[cId] ? row[cId] : String(r);
      const ownerRaw = cOwner >= 0 ? row[cOwner] ?? "" : "";
      let owner: string | null = ownerRaw || null;
      if (/^(service|owning)\s+(team|owner)$/i.test(ownerRaw)) {
        owner = deliverableOwner;
        if (!owner) warnings.push(`${f.name} #${idText}: owner "${ownerRaw}" could not be mapped to the service team.`);
      }
      const dueRaw = cDue >= 0 ? row[cDue] ?? "" : "";
      const dm = dueRaw ? findDatePhrase(dueRaw, launch_date) : null;
      if (dueRaw && !dm) warnings.push(`${f.name} #${idText}: due "${dueRaw}" not understood.`);
      if (owner) addTeam(owner, `${f.name} #${idText}`);
      const quote = f.rawLines ? f.rawLines[r] : row.join(" | ");
      items.push({
        id: "",
        text: row[cCheck],
        kind: "checklist",
        owner_team: owner,
        due: dm?.due ?? null,
        due_text: dm?.due_text ?? null,
        due_is_inferred: dm?.inferred ?? false,
        source: { file: f.name, locator: `#${idText}`, quote },
      });
    }
    fileEntries.push({ name: f.name, read_as: readAsOf.get(f.name)!, notes: `${total} checks · ${applied} apply to this release` });
  }

  if (agentOnly) {
    // One note per file, in the same words the parsers use, so the GUI reads them the same way.
    for (const f of opts.files) {
      if (fileEntries.some((e) => e.name === f.name)) continue; // parsed by the rules (the agent did not read it)
      const ra = readAsOf.get(f.name) ?? [];
      const ck = agentCheckCounts.get(f.name), tm = agentTeamCounts.get(f.name), it = agentCounts.get(f.name);
      const fileItems = items.filter((i) => i.source.file === f.name && i.kind !== "checklist");
      const parts: string[] = [];
      if (ra.includes("launch_checks") || ck) parts.push(`${ck?.total ?? 0} checks · ${ck?.applied ?? 0} apply to this release`);
      if (ra.includes("teams_and_owners") || tm) parts.push(`${tm?.teams ?? 0} teams · ${tm?.projects ?? 0} Jira projects · ${tm?.owners ?? 0} owners`);
      if (ra.includes("plan_items") || fileItems.length) parts.push(`${countKinds(fileItems)} · names ${teams.size} teams${epicKeys.size ? " and epic " + [...epicKeys].sort().join(", ") : ""}`);
      if (!parts.length) continue;
      parts.push(`read by the agent${it?.unchecked ? " (quotes not checked: the command could not read the file)" : ""}`);
      fileEntries.push({ name: f.name, read_as: ra.length ? ra : ["plan_items"], notes: parts.join(" · ") });
      for (let i = warnings.length - 1; i >= 0; i--) if (warnings[i] === `${f.name}: nothing could be read from it; not used.`) warnings.splice(i, 1);
    }
  } else {
    for (const [name, c] of agentCounts) {
      const note = `${c.items} item${c.items === 1 ? "" : "s"} read by the agent${c.unchecked ? " (quotes not checked: the command could not read the file)" : ""}`;
      const entry = fileEntries.find((e) => e.name === name);
      if (entry) entry.notes = `${entry.notes} · ${note}`;
      else fileEntries.push({ name, read_as: ["plan_items"], notes: note });
      for (let i = warnings.length - 1; i >= 0; i--) if (warnings[i] === `${name}: nothing could be read from it; not used.` || warnings[i].startsWith(`${name}: could not tell what it contains; not used.`)) warnings.splice(i, 1);
    }
    if (!planFiles.length && agentCounts.size) { const i = warnings.indexOf("No file was read as plan items. A POR is required."); if (i >= 0) warnings.splice(i, 1); }
  }

  for (const f of opts.files) if (!fileEntries.some((e) => e.name === f.name)) fileEntries.push({ name: f.name, read_as: readAsOf.get(f.name) ?? [], notes: "Nothing used from this file" });
  items.forEach((it, i) => { it.id = `p${i + 1}`; });
  const order = opts.files.map((f) => f.name);
  fileEntries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const draft: PlanDraft = {
    launch_date,
    epic_keys_mentioned: [...epicKeys].sort(),
    items,
    teams: [...teams.values()],
    files: fileEntries,
    warnings,
  };
  return PlanDraft.parse(draft);
}

function countKinds(items: PlanItem[]): string {
  const n = (k: PlanItemKind) => items.filter((i) => i.kind === k).length;
  const parts = [`${items.length} plan items`];
  if (n("approval")) parts.push(`${n("approval")} approval${n("approval") > 1 ? "s" : ""}`);
  if (n("dependency")) parts.push(`${n("dependency")} dependenc${n("dependency") > 1 ? "ies" : "y"}`);
  return parts.join(" · ");
}

interface TeamListEntry { name: string; role: string | null; project: string | null; owners: string[]; components: string[] }

function teamListEntries(f: LoadedFile): TeamListEntry[] {
  const d = f.data as any;
  const out: TeamListEntry[] = [];
  if (d && Array.isArray(d.teams)) {
    for (const t of d.teams) {
      const project = t.jira_project ?? t.jira ?? t.project ?? t.key ?? null;
      out.push({
        name: String(t.name ?? t.team ?? ""),
        role: t.role ? String(t.role) : null,
        project: project ? String(project).toUpperCase() : null,
        owners: toList(t.owners),
        components: toList(t.components),
      });
    }
  } else if (f.rows && f.rows.length > 1) {
    const h = f.rows[0];
    const cName = col(h, /^(team|name)$/), cProj = col(h, /project|jira/), cOwn = col(h, /owner/), cComp = col(h, /component/), cRole = col(h, /role/);
    for (const r of f.rows.slice(1)) {
      if (cName < 0 || !r[cName]) continue;
      out.push({ name: r[cName], role: cRole >= 0 ? r[cRole] || null : null, project: cProj >= 0 && r[cProj] ? r[cProj].toUpperCase() : null, owners: cOwn >= 0 ? splitList(r[cOwn]) : [], components: cComp >= 0 ? splitList(r[cComp]) : [] });
    }
  }
  return out.filter((e) => e.name);
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x?.name ?? JSON.stringify(x)));
  if (typeof v === "string") return splitList(v);
  return [];
}
function splitList(s: string | undefined): string[] {
  return (s ?? "").split(/[;|]/).map((x) => x.trim()).filter(Boolean);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”"'‘’]/g, "").trim();
}
export function containsQuote(text: string, quote: string): boolean {
  return norm(text).includes(norm(quote));
}
