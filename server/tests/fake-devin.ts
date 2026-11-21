/**
 * Test helper: a tiny look-alike of Devin's v1 External API (attachments, sessions, session detail, message),
 * so the GUI's "Devin reads your uploads" path runs end to end without a Devin account.
 *
 * `answer` decides what a session's structured output is, from the prompt and the files it attached
 * (their names and text); it is called once the session has been polled `workingPolls` times. Return
 * null to leave the session "working", or set `endWith` to finish without output.
 */
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkApplies, splitSections } from "../../skills/throughline-reader/scripts/lib/plan-extract.js";
import { loadFile, type LoadedFile } from "../../skills/throughline-reader/scripts/lib/files.js";
import { readSignals } from "../../skills/throughline-starter/scripts/lib/signals.js";
import { loadRules } from "../../skills/throughline-starter/scripts/lib/config.js";

export interface FakeDevinSession { id: string; prompt: string; title: string | null; max_acu_limit: number | null; polls: number; attachments: { name: string; text: string; data: Buffer }[]; messages: string[]; api: "v1" | "v3"; output_schema: unknown; devin_mode: string | null }
const ORG = "org-fake";
export interface FakeDevinOptions {
  apiKey?: string;
  workingPolls?: number;
  answer?: (session: FakeDevinSession) => unknown | Promise<unknown>;
  /** Instead of an answer: end the session with this status_enum and no structured output. */
  endWith?: "expired" | "blocked" | "finished";
}
export interface FakeDevin { url: string; sessions: FakeDevinSession[]; uploads: { name: string; text: string; data: Buffer; url: string }[]; calls: string[]; close(): Promise<void> }

export async function startFakeDevin(opts: FakeDevinOptions = {}): Promise<FakeDevin> {
  const apiKey = opts.apiKey ?? "cog_test";
  const workingPolls = opts.workingPolls ?? 2;
  const sessions: FakeDevinSession[] = [];
  const uploads: { name: string; text: string; data: Buffer; url: string }[] = [];
  const calls: string[] = [];
  let base = "";
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const saveUpload = async (req: import("node:http").IncomingMessage) => {
    const webReq = new Request("http://x/", { method: "POST", headers: req.headers as Record<string, string>, body: Readable.toWeb(req) as any, duplex: "half" } as any);
    const form = await webReq.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return null;
    const name = (file as File).name ?? "file";
    const data = Buffer.from(await file.arrayBuffer());
    const u = { name, text: data.toString("utf8"), data, url: `${base}/files/${uploads.length + 1}/${encodeURIComponent(name)}` };
    uploads.push(u);
    return u;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    calls.push(`${req.method} ${p}`);
    if (p.startsWith("/files/")) {
      const u = uploads.find((x) => x.url.endsWith(p));
      if (!u) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(u.data);
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(res, 403, { detail: "Unauthorized" });
    try {
      // ---- v3 (organisation-scoped) ----
      if (p === "/v3/self" && req.method === "GET") return json(res, 200, { principal_type: "service_user", user_name: "Throughline bot", org_id: ORG, devin_sessions_org_id: ORG });
      let v3 = p.match(/^\/v3\/organizations\/([^/]+)\/(attachments|sessions)(?:\/([^/]+))?$/);
      if (v3 && v3[1] !== ORG) return json(res, 404, { title: "Not Found", detail: "unknown organization" });
      if (v3 && v3[2] === "attachments" && req.method === "POST") {
        const u = await saveUpload(req);
        if (!u) return json(res, 400, { detail: "no file" });
        return json(res, 200, { attachment_id: `att-${uploads.length}`, name: u.name, url: u.url });
      }
      if (v3 && v3[2] === "sessions" && !v3[3] && req.method === "POST") {
        let body = ""; for await (const c of req) body += c;
        const b = JSON.parse(body || "{}");
        if (typeof b.prompt !== "string" || !b.prompt) return json(res, 422, { detail: "prompt required" });
        const attachments = (Array.isArray(b.attachment_urls) ? b.attachment_urls : []).map((url: string) => uploads.find((u) => u.url === url)).filter((u: any): u is typeof uploads[number] => !!u).map((u: any) => ({ name: u.name, text: u.text, data: u.data }));
        const s: FakeDevinSession = { id: `devin-${sessions.length + 1}`, prompt: b.prompt, title: b.title ?? null, max_acu_limit: b.max_acu_limit ?? null, polls: 0, attachments, messages: [], api: "v3", output_schema: b.structured_output_schema ?? null, devin_mode: b.devin_mode ?? null };
        sessions.push(s);
        return json(res, 200, { session_id: s.id, url: `https://app.devin.ai/sessions/${s.id}`, status: "new", tags: b.tags ?? [], org_id: ORG, created_at: 0, updated_at: 0, acus_consumed: 0, pull_requests: [] });
      }
      if (v3 && v3[2] === "sessions" && v3[3] && req.method === "GET") {
        const s = sessions.find((x) => x.id === v3![3]);
        if (!s) return json(res, 404, { title: "Not Found" });
        s.polls++;
        const base_ = { session_id: s.id, title: s.title, url: `https://app.devin.ai/sessions/${s.id}`, org_id: ORG, tags: [], created_at: 0, updated_at: 0, acus_consumed: 0.3, pull_requests: [] };
        if (s.polls <= workingPolls) return json(res, 200, { ...base_, status: "running", status_detail: "working", structured_output: null });
        if (opts.endWith) return json(res, 200, { ...base_, status: opts.endWith === "blocked" ? "suspended" : opts.endWith === "expired" ? "error" : "exit", status_detail: opts.endWith === "blocked" ? "waiting for user input" : null, structured_output: null });
        const out = opts.answer ? await opts.answer(s) : null;
        if (out === null || out === undefined) return json(res, 200, { ...base_, status: "running", status_detail: "working", structured_output: null });
        return json(res, 200, { ...base_, status: "exit", status_detail: null, structured_output: out });
      }
      // ---- v1 (legacy keys) ----
      if (p === "/v1/attachments" && req.method === "POST") {
        const u = await saveUpload(req);
        if (!u) return json(res, 400, { detail: "no file" });
        res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(u.url);
      }
      let body = "";
      for await (const c of req) body += c;
      if (p === "/v1/sessions" && req.method === "POST") {
        const b = JSON.parse(body || "{}");
        if (typeof b.prompt !== "string" || !b.prompt) return json(res, 400, { detail: "prompt required" });
        const attachments = [...b.prompt.matchAll(/ATTACHMENT:"([^"]+)"/g)].map((m) => uploads.find((u) => u.url === m[1])).filter((u): u is typeof uploads[number] => !!u).map((u) => ({ name: u.name, text: u.text, data: u.data }));
        const s: FakeDevinSession = { id: `devin-${sessions.length + 1}`, prompt: b.prompt, title: b.title ?? null, max_acu_limit: b.max_acu_limit ?? null, polls: 0, attachments, messages: [], api: "v1", output_schema: null, devin_mode: null };
        sessions.push(s);
        return json(res, 200, { session_id: s.id, url: `https://app.devin.ai/sessions/${s.id}`, is_new_session: true });
      }
      let m = p.match(/^\/v1\/sessions\/([^/]+)$/);
      if (m && req.method === "GET") {
        const s = sessions.find((x) => x.id === m![1]);
        if (!s) return json(res, 404, { detail: "no such session" });
        s.polls++;
        const base_ = { session_id: s.id, title: s.title, url: `https://app.devin.ai/sessions/${s.id}` };
        if (s.polls <= workingPolls) return json(res, 200, { ...base_, status: "working", status_enum: "working", structured_output: null });
        if (opts.endWith) return json(res, 200, { ...base_, status: opts.endWith, status_enum: opts.endWith, structured_output: null });
        const out = opts.answer ? await opts.answer(s) : null;
        if (out === null || out === undefined) return json(res, 200, { ...base_, status: "working", status_enum: "working", structured_output: null });
        return json(res, 200, { ...base_, status: "finished", status_enum: "finished", structured_output: out });
      }
      m = p.match(/^\/v1\/sessions\/([^/]+)\/message$/);
      if (m && req.method === "POST") {
        const s = sessions.find((x) => x.id === m![1]);
        if (!s) return json(res, 404, { detail: "no such session" });
        s.messages.push(JSON.parse(body || "{}").message ?? "");
        res.writeHead(204); return res.end();
      }
      json(res, 404, { detail: `no route ${req.method} ${p}` });
    } catch (e) {
      json(res, 500, { detail: String((e as Error).message ?? e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  return { url: base, sessions, uploads, calls, close: () => new Promise((r) => server.close(() => r())) };
}

/** A reasonable stand-in for Devin's reading. Each attachment is opened with the project's own loader (as Devin would
 *  open a Word or csv file with its tools): "will have … by …" sentences of a plan become items, the PRD's sentences
 *  that match a signal rule become signals (early stages), a checklist's rows become checks (applying when their
 *  "applies to" words are in the plan), a team list's entries become teams, and the plan's launch date and epic keys
 *  are written down. */
export async function naiveReader(session: FakeDevinSession): Promise<unknown> {
  const items: any[] = [];
  const signals: unknown[] = [];
  const teams: unknown[] = [];
  const files_read: unknown[] = [];
  const epic = new Set<string>();
  let launch_date: unknown = null;
  const early = /A signal is/.test(session.prompt);
  const dir = mkdtempSync(join(tmpdir(), "fake-devin-"));
  try {
    const loaded: LoadedFile[] = [];
    const converted = new Set<string>();
    for (const a of session.attachments) {
      const path = join(dir, a.name); writeFileSync(path, a.data);
      // A format the loader refuses (a Keynote bundle) is one Devin would convert; the stand-in reads its text as is.
      const asText = () => { converted.add(a.name); return { name: a.name, path, ext: a.name.replace(/^.*(\.[^.]+)$/, "$1").toLowerCase(), text: a.data.toString("utf8"), rows: null, rawLines: null, data: null, segments: null, warnings: [] }; };
      try { const f = await loadFile(path); loaded.push(f.text || f.rows || f.data || f.segments ? f : asText()); }
      catch { loaded.push(asText()); }
    }
    const isTeams = (f: LoadedFile) => !!f.data && Array.isArray((f.data as any).teams);
    const isCsv = (f: LoadedFile) => !!f.rows && !isTeams(f);
    const toList = (v: unknown): string[] => Array.isArray(v) ? v.map((x) => typeof x === "string" ? x : x?.title ? `${x.name} (${x.title})` : String(x?.name ?? x)) : typeof v === "string" ? v.split(/[;|]/).map((x) => x.trim()).filter(Boolean) : [];
    const plans = loaded.filter((f) => !isTeams(f) && !isCsv(f));
    for (const f of plans) {
      files_read.push({ name: f.name, how: converted.has(f.name) ? "converted" : f.ext === ".docx" ? "mammoth" : f.segments ? "python-pptx" : "text" });
      let section = "";
      for (const raw of f.text.split(/\r?\n/)) {
        const line = raw.trim();
        const h = line.match(/^##\s+(\d+)\./);
        if (h) { section = `§${h[1]}`; continue; }
        const ld = line.match(/Launch date:\s*(\d{4}-\d{2}-\d{2})/);
        if (ld) launch_date = { date: ld[1], source: { file: f.name, quote: line } };
        for (const k of line.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) epic.add(k[0]);
        const m = line.match(/^-\s+(.+?)\s+will have (.+?) by (\w+ \d+)\.$/);
        if (m) { const what = m[2].replace(/^the\s+/i, ""); items.push({ text: what[0].toUpperCase() + what.slice(1), kind: /review|approv/i.test(what) ? "approval" : /quota|capacity/i.test(what) ? "dependency" : "deliverable", owner_team: m[1].replace(/\s*\(.*\)\s*$/, "").replace(/^the\s+/i, ""), due_text: `by ${m[3]}`, source: { file: f.name, locator: section, quote: line.replace(/^-\s+/, "") } }); continue; }
        const w = line.match(/^-\s+([A-Z][A-Za-z]*) (.+?) will be (.+?) (the week before launch|by \w+ \d+)\.$/);
        if (w) items.push({ text: `${w[1]} ${w[2]} ${w[3]}`, kind: "dependency", owner_team: w[1], due_text: w[4], source: { file: f.name, locator: section, quote: line.replace(/^-\s+/, "") } });
      }
      if (early) for (const g of readSignals([f], loadRules())) signals.push({ quote: g.quote, file: f.name, locator: g.locator, rule_ids: g.rule_ids });
    }
    for (const f of loaded.filter(isTeams)) {
      files_read.push({ name: f.name, how: f.ext === ".json" ? "json" : "yaml" });
      ((f.data as any).teams as any[]).forEach((t, i) => teams.push({ name: String(t.name ?? t.team ?? ""), role: t.role ?? null, jira_project: t.jira_project ?? t.project ?? null, owners: [...toList(t.owners), ...toList(t.people)], components: toList(t.components), source: { file: f.name, locator: `teams[${i}]` } }));
    }
    // Which checks apply is judged against what the plan says about the release: its overview (or all of it) and the items read.
    const profile = plans.map((f) => { const secs = splitSections(f.text).filter((s) => /overview|summary|profile|context|background/i.test(s.heading) || s.locator === "preamble"); return secs.length ? secs.map((s) => s.body).join("\n") : f.text; }).join("\n") + "\n" + items.map((i) => `${i.text}\n${i.source.quote}`).join("\n");
    const serviceTeam = items.find((i) => i.kind === "deliverable")?.owner_team ?? null;
    for (const f of loaded.filter(isCsv)) {
      files_read.push({ name: f.name, how: "csv" });
      const header = f.rows![0].map((c) => c.toLowerCase());
      const col = (re: RegExp) => header.findIndex((c) => re.test(c));
      const cId = col(/^(#|id|no\.?)$/), cCheck = col(/check|requirement|item/), cOwner = col(/owner|team/), cApplies = col(/applies|scope|when/), cDue = col(/due|date/);
      for (let i = 1; i < f.rows!.length; i++) {
        const cells = f.rows![i];
        if (cCheck < 0 || !cells[cCheck]) continue;
        const appliesTo = cApplies >= 0 ? cells[cApplies] ?? "" : "";
        const ownerRaw = cOwner >= 0 ? cells[cOwner] ?? "" : "";
        items.push({ text: cells[cCheck], kind: "checklist", owner_team: /^(service|owning)\s+(team|owner)$/i.test(ownerRaw) ? serviceTeam : ownerRaw || null, due_text: cDue >= 0 && cells[cDue] ? cells[cDue] : null, applies_to: appliesTo || null, applies: checkApplies(appliesTo, profile), source: { file: f.name, locator: `#${cId >= 0 && cells[cId] ? cells[cId] : i}`, quote: f.rawLines ? f.rawLines[i] : cells.join(" | ") } });
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { done: true, items, signals, teams, launch_date, epic_keys: [...epic], files_read, unreadable: [] };
}
