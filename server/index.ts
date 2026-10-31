#!/usr/bin/env -S npx tsx
/**
 * Local API server for the GUI: runs the same pipeline as scripts/review.ts behind a few JSON routes,
 * and serves the built GUI (gui/dist) when it exists.
 *
 *   npm run server                      # http://localhost:8787
 *   PORT=9000 npm run server
 *
 * Jira credentials come from the environment (JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN) or from the GUI's
 * connect form; they stay in this process's memory, are never written to disk and never logged.
 * Jira is only read. Set JIRA_FIXTURE_DIR=<snapshot dir> to run without a Jira site (demo mode).
 *
 * Routes
 *   GET  /auth/login, /auth/callback, POST /auth/logout   sign-in with the company identity provider (server/auth.ts)
 *   GET  /api/health                  {ok, jira:{connected, site, user}, agent, auth:{mode, user, login_url}, settings}
 *   GET  /api/settings, PUT /api/settings           {agent_consent}  (per user; what used to live in localStorage)
 *   GET  /api/decisions/:key, PUT /api/decisions/:key   keep/dismiss decisions, the log and ticked actions, per user and run
 *   POST /api/jira/connect            {site, email, token} → checks /myself, keeps the credentials
 *   POST /api/jira/disconnect
 *   POST /api/plan                    {files:[{name, kind, content_base64 | sample}], launch_date?, stage?} → {plan}
 *                                     stage starting|building adds {signals, project} (release-starter)
 *                                     agent: "devin" → 202 {job}; the job's result is the same plus {agent}: Devin
 *                                     reads the plan documents (not csv/yaml) and its items go through Stage A's
 *                                     quote check; each file's reading is cached by content, so a re-read is free
 *   POST /api/starter                 {files, stage, exclude_signals?, epic?, label?} → {job}; the job's result is the Starter
 *   POST /api/target                  {plan, epic, no_search?} → {target}
 *   GET  /api/runs/:epic              [{id, label}]
 *   GET  /api/runs/:epic/:id          the saved run
 *   POST /api/run                     {plan, target, label?, go_no_go?} → {job}
 *   GET  /api/jobs/:job               {stage, done, run_id?, error?, log}
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PlanDraft, ReleaseTarget, ReadAs } from "@rrr/schemas";
import { JiraRest, JiraAuthError, type RestCreds } from "../skills/release-reader/scripts/lib/jira-rest.js";
import { stageA, stageB, stageC, analyzeStep, statusStep, previousRun, saveRun, listRunLabels, loadRun, todayLabel, readStarterInputs, starterSignals, starterPlan, runStarter, type SourceSpec, type AgentReading } from "../scripts/lib/pipeline.js";
import { loadRules } from "../skills/release-starter/scripts/lib/config.js";
import type { AgentItem, AgentTeam, AgentLaunchDate } from "../skills/release-reader/scripts/lib/plan-extract.js";
import type { AgentSignal } from "../skills/release-starter/scripts/lib/signals.js";
import { DevinClient, devinFromEnv, readWithDevin, itemRules, signalRuleLines, type DevinOptions, type ReadingOutcome, type DevinMode, type FileRole } from "./devin.js";
import { loadFile } from "../skills/release-reader/scripts/lib/files.js";
import { loadDirectory } from "../skills/release-starter/scripts/lib/directory.js";
import { createHash } from "node:crypto";
import { Store, type User } from "./store.js";
import { Auth, authFromEnv, LOCAL_USER, type AuthConfig } from "./auth.js";
import { Atlassian, atlassianFromEnv, type AtlassianConfig } from "./atlassian.js";
import { TokenBox } from "./crypto.js";
import { randomBytes } from "node:crypto";

export interface ServerOptions {
  port?: number;
  runsRoot?: string;
  uploadRoot?: string;
  cacheRoot?: string;
  fixtureDir?: string | null;
  creds?: RestCreds | null;
  guiDist?: string;
  sampleDocs?: string;
  quiet?: boolean;
  /** Devin as the reader behind the upload step; undefined reads DEVIN_API_KEY from the environment, null disables. */
  devin?: DevinOptions | null;
  /** Where each file's Devin reading is cached by content hash (default out/agent-reads). */
  agentCacheRoot?: string;
  /** Sign-in: undefined reads OIDC_* from the environment (none when unset); {mode: "none"} is one local user. */
  auth?: AuthConfig;
  /** The SQLite file for users, sessions, settings and decisions (default out/rrr.sqlite; ":memory:" for tests). */
  storePath?: string;
  /** Jira through Sign in with Atlassian; undefined reads ATLASSIAN_* from the environment, null disables (the token form stays). */
  atlassian?: AtlassianConfig | null;
  /** Where the browser reaches this server (OAuth callbacks); default APP_URL, else the sign-in config's, else http://localhost:8787. */
  appUrl?: string;
  /** Encrypts stored tokens; default TOKEN_KEY, else SESSION_SECRET, else a random key (connections are lost on restart). */
  tokenKey?: string;
}

/** What the GUI shows about the agent's reading of the uploads. */
export interface AgentRead {
  name: "Devin";
  status: "done" | "failed";
  /** True when every document had a cached reading and no session was started. */
  cached: boolean;
  session_url: string | null;
  /** The Devin tier that read the documents (v3), or null for Devin's default. */
  mode: string | null;
  /** Plan items (not checks). */
  items_read: number;
  signals_read: number;
  /** Checks read from checklists, and how many of them Devin judged to apply to this release. */
  checks_read: number;
  checks_apply: number;
  teams_read: number;
  files_read: { name: string; how: string }[];
  unreadable: { name: string; reason: string }[];
  warnings: string[];
  error: string | null;
}

/** One document's cached reading. */
interface CachedRead { name: string; items: AgentItem[]; signals: AgentSignal[]; teams?: AgentTeam[]; launch_date?: AgentLaunchDate | null; epic_keys?: string[]; file_read: { name: string; how: string } | null; unreadable: { name: string; reason: string } | null; warnings: string[]; session_url: string | null; mode?: string | null }

interface Job { stage: 0 | 1 | 2 | 3; done: boolean; run_id?: string; error?: string; log: string[]; result?: unknown; /** 0–100 and what is happening, for the GUI's progress bar. */ progress?: number; detail?: string }

const KIND_TO_READ_AS: Record<string, ReadAs> = { prd: "plan_items", plan: "plan_items", checks: "launch_checks", teams: "teams_and_owners" };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function createApp(opts: ServerOptions = {}) {
  const runsRoot = opts.runsRoot ?? "runs";
  const uploadRoot = opts.uploadRoot ?? "out/gui-uploads";
  const cacheRoot = opts.cacheRoot ?? "out/jira-cache";
  const guiDist = opts.guiDist ?? resolve("gui/dist");
  const sampleDocs = opts.sampleDocs ?? resolve("fixtures/ingest-142/docs");
  const fixtureDir = opts.fixtureDir ?? process.env.JIRA_FIXTURE_DIR ?? null;
  const agentCacheRoot = opts.agentCacheRoot ?? "out/agent-reads";
  const log = opts.quiet ? () => {} : (s: string) => console.error(s);
  const devinOpts = opts.devin === undefined ? devinFromEnv() : opts.devin;
  const devin = devinOpts ? new DevinClient(devinOpts) : null;
  const agentCache = new Map<string, CachedRead>();
  const companyCreds: RestCreds | null = opts.creds === undefined ? envCreds() : opts.creds;
  /** Jira credentials a person entered in the GUI, per user, in memory only; the company's (environment) ones apply to everyone else. */
  const userCreds = new Map<string, { creds: RestCreds; user: string }>();
  const jobs = new Map<string, Job>();
  const store = new Store(opts.storePath ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "rrr.sqlite") : "out/rrr.sqlite"));
  const authCfg: AuthConfig = opts.auth ?? authFromEnv();
  const auth = new Auth(authCfg, store, log);
  const appUrl = (opts.appUrl ?? process.env.APP_URL ?? (authCfg.mode === "oidc" ? authCfg.appUrl : "http://localhost:8787")).replace(/\/+$/, "");
  const appOrigin = authCfg.mode === "oidc" ? new URL(authCfg.appUrl).origin : null;
  const tokenKey = opts.tokenKey ?? process.env.TOKEN_KEY ?? process.env.SESSION_SECRET ?? null;
  if (!tokenKey) log("tokens: TOKEN_KEY and SESSION_SECRET not set; a random key is used, so Jira connections are lost on restart");
  const box = new TokenBox(tokenKey ?? randomBytes(32).toString("hex"));
  const atlCfg = opts.atlassian === undefined ? atlassianFromEnv(process.env, appUrl) : opts.atlassian ? { ...opts.atlassian, appUrl: opts.atlassian.appUrl || appUrl } : null;
  const atlassian = atlCfg ? new Atlassian(atlCfg, store, box, log) : null;
  /** With sign-in, each organisation's runs, uploads and caches live under orgs/<org>/; without it, the plain roots. */
  const rootsFor = (u: User) => authCfg.mode === "none" ? { runsRoot, uploadRoot, cacheRoot, agentCacheRoot } : {
    runsRoot: join(runsRoot, "orgs", safeSeg(u.org)), uploadRoot: join(uploadRoot, "orgs", safeSeg(u.org)), cacheRoot: join(cacheRoot, "orgs", safeSeg(u.org)), agentCacheRoot: join(agentCacheRoot, "orgs", safeSeg(u.org)),
  };

  function envCreds(): RestCreds | null {
    const { JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    return JIRA_SITE && JIRA_EMAIL && JIRA_API_TOKEN ? { site: JIRA_SITE, email: JIRA_EMAIL, token: JIRA_API_TOKEN } : null;
  }
  /** The person's Atlassian sign-in first, then a token they typed, then the company's environment credentials. */
  function credsFor(u: User): { creds: RestCreds; user: string | null; method: "oauth" | "token" | "company" } | null {
    const oauth = atlassian?.creds(u);
    if (oauth) return { creds: oauth, user: atlassian!.info(u)?.user ?? null, method: "oauth" };
    const mine = userCreds.get(u.id);
    if (mine) return { ...mine, method: "token" };
    return companyCreds ? { creds: companyCreds, user: null, method: "company" } : null;
  }
  function jiraInfo(u: User = LOCAL_USER) {
    if (fixtureDir) return { connected: true, site: `fixture ${basename(fixtureDir)}`, user: "sample data", fixture: true, oauth: false, method: "fixture" as const, sites: 0 };
    const c = credsFor(u);
    return { connected: !!c, site: c ? c.creds.site.replace(/^https?:\/\//, "") : null, user: c?.user ?? null, fixture: false, oauth: !!atlassian, method: c?.method ?? null, sites: c?.method === "oauth" ? (atlassian?.info(u)?.sites ?? 0) : 0 };
  }
  function source(u: User, epic: string, label: string, fresh = false): SourceSpec {
    if (fixtureDir) return { kind: "fixture", dir: fixtureDir };
    const c = credsFor(u);
    if (!c) throw new HttpError(400, "Not connected to Jira. Connect first.");
    const cacheDir = join(rootsFor(u).cacheRoot, epic, label);
    if (fresh) rmSync(cacheDir, { recursive: true, force: true });
    return { kind: "rest", creds: c.creds, cacheDir, log: (l) => log("  jira: " + l) };
  }
  function settingsOf(u: User) { return { agent_consent: store.setting<string>(u.id, "agent_consent") ?? "unknown", agent_mode: devin?.api === "v3" ? modeFor(u) : null }; }

  function agentInfo() { return { available: !!devin, name: "Devin" as const, max_acu: devin?.maxAcu ?? null, api: devin?.api ?? null, modes: devin?.api === "v3" ? devin.modes : [], default_mode: devin?.api === "v3" ? devin.defaultMode : null }; }
  /** The tier this person chose, if it is still allowed; otherwise the company default. */
  function modeFor(u: User): DevinMode | null {
    if (!devin || devin.api !== "v3") return null;
    const chosen = store.setting<string>(u.id, "agent_mode");
    return chosen && (devin.modes as string[]).includes(chosen) ? (chosen as DevinMode) : devin.defaultMode;
  }

  // ---------- Devin reads the documents ----------

  /** What each upload is to Devin. Every kind goes, except "other" and the directory connector's export (structured data, not a document). */
  const ROLE_OF: Record<string, FileRole> = { prd: "plan", plan: "plan", checks: "checks", teams: "teams" };
  const safeName = (f: any) => basename(String(f.name ?? "")).replace(/[^\w.\- ()]+/g, "_");
  function cacheKey(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  function cachedRead(root: string, key: string): CachedRead | null {
    const hit = agentCache.get(`${root}|${key}`);
    if (hit) return hit;
    const f = join(root, `${key}.json`);
    if (!existsSync(f)) return null;
    try { const c = JSON.parse(readFileSync(f, "utf8")) as CachedRead; agentCache.set(`${root}|${key}`, c); return c; } catch { return null; }
  }
  function storeRead(root: string, key: string, c: CachedRead) {
    agentCache.set(`${root}|${key}`, c);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${key}.json`), JSON.stringify(c, null, 2) + "\n");
  }

  /** Devin reads every upload: plans and PRDs, checklists, team lists (cached per file by content, role and tier). Never throws. */
  async function readDocuments(u: User, paths: string[], files: any[], stage: "launching" | "starting" | "building", say: (l: string) => void, onProgress: (pct: number, detail: string) => void = () => {}): Promise<{ reading: AgentReading | null; signals: AgentSignal[]; agent: AgentRead }> {
    const root = rootsFor(u).agentCacheRoot;
    const mode = modeFor(u);
    const docs: { path: string; role: FileRole }[] = [];
    const orgTeams: string[] = [];
    for (const p of paths) {
      const f = files.find((x) => safeName(x) === basename(p));
      const role = ROLE_OF[String(f?.kind)];
      if (!role) continue;
      if (f?.via !== "directory") { docs.push({ path: p, role }); continue; }
      // The directory connected on step 1 grounds the reading: Devin gets the company's team names and spells owners as it does.
      try { for (const e of loadDirectory(await loadFile(p))) orgTeams.push(e.name, ...e.aliases); } catch { /* an export the loader cannot open: no grounding */ }
    }
    const orgKey = orgTeams.length ? `.org-${createHash("sha256").update(orgTeams.join("|")).digest("hex").slice(0, 8)}` : "";
    const reads: CachedRead[] = [];
    const toRead: { path: string; role: FileRole; key: string }[] = [];
    // A reading is cached per document, per role, per tier and per directory: any of those changing reads again.
    for (const d of docs) { const key = `${cacheKey(d.path)}.${d.role}${mode ? `.${mode}` : ""}${orgKey}`; const c = cachedRead(root, key); if (c) reads.push(c); else toRead.push({ ...d, key }); }
    let outcome: ReadingOutcome | null = null;
    if (toRead.length) {
      say(`Devin: reading ${toRead.map((t) => basename(t.path)).join(", ")}${reads.length ? ` (${reads.length} cached)` : ""}${orgTeams.length ? ` (grounded in ${orgTeams.length} directory team names)` : ""}`);
      const early = stage !== "launching";
      outcome = await readWithDevin(devin!, { files: toRead.map((t) => ({ path: t.path, role: t.role })), stage, rules: itemRules(), signalRules: early ? signalRuleLines(loadRules()) : undefined, user: u.id === LOCAL_USER.id ? null : u.name, mode, orgTeams, onLog: (l) => say(`Devin: ${l}`), onProgress });
      if (outcome.status === "done") {
        for (const t of toRead) {
          const name = basename(t.path);
          const c: CachedRead = {
            name, items: outcome.items.filter((i) => i.source.file === name), signals: outcome.signals.filter((g) => g.file === name), teams: outcome.teams.filter((x) => x.source.file === name),
            launch_date: outcome.launch_date?.source.file === name ? outcome.launch_date : null, epic_keys: t.role === "plan" ? outcome.epic_keys : [],
            file_read: outcome.files_read.find((f) => f.name === name) ?? null, unreadable: outcome.unreadable.find((u) => u.name === name) ?? null,
            warnings: outcome.warnings, session_url: outcome.session_url, mode: outcome.mode,
          };
          storeRead(root, t.key, c); reads.push(c);
        }
      } else say(`Devin: ${outcome.error}`);
    } else if (docs.length) { say(`Devin: all ${docs.length} file(s) read before; using the cached reading`); onProgress(85, "Using the earlier reading of these files"); }
    const items = reads.flatMap((r) => r.items), signals = reads.flatMap((r) => r.signals), teams = reads.flatMap((r) => r.teams ?? []);
    const checks = items.filter((i) => i.kind === "checklist");
    const ok = !outcome || outcome.status === "done";
    const agent: AgentRead = {
      name: "Devin", status: outcome ? outcome.status : "done", cached: !outcome, session_url: outcome?.session_url ?? reads.find((r) => r.session_url)?.session_url ?? null,
      mode: outcome?.mode ?? reads.find((r) => r.mode)?.mode ?? mode,
      items_read: items.length - checks.length, signals_read: signals.length,
      checks_read: checks.length, checks_apply: checks.filter((c) => c.applies !== false).length, teams_read: teams.length,
      files_read: reads.map((r) => r.file_read).filter((x): x is { name: string; how: string } => !!x),
      unreadable: reads.map((r) => r.unreadable).filter((x): x is { name: string; reason: string } => !!x),
      warnings: [...new Set(reads.flatMap((r) => r.warnings))], error: outcome?.error ?? null,
    };
    // When the reading failed, the rules read on their own (the GUI says so); otherwise the parsers read nothing.
    const reading: AgentReading | null = ok ? { items, teams, launchDate: reads.map((r) => r.launch_date).find((d) => d) ?? null, epicKeys: [...new Set(reads.flatMap((r) => r.epic_keys ?? []))], files: reads.map((r) => docs.find((d) => basename(d.path) === r.name)?.path).filter((p): p is string => !!p) } : null;
    return { reading, signals, agent };
  }

  /** Stage A (or the early stages' signals) over saved uploads, with the agent's items and signals if any. */
  async function buildPlan(paths: string[], readAs: Record<string, ReadAs[]>, dirPaths: string[], files: any[], stage: string, launchDate: string | null, agent?: AgentReading | null, agentSignals?: AgentSignal[]) {
    if (stage === "starting" || stage === "building") {
      // Early stages: the PRD's signals, and the plan Stage B needs (the needed teams, with directory projects).
      const inputs = await readStarterInputs(paths, dirPaths, agent);
      if (!inputs.docs.length) throw new HttpError(400, "No PRD or plan file: every file was read as a team list or directory.");
      const sig = starterSignals(inputs, loadRules(), [], agentSignals ?? [], !!agent);
      const plan = await starterPlan(inputs, sig, paths, agent);
      plan.warnings.push(...sig.warnings);
      log(`plan (${stage}): ${sig.signals.length} signals, ${sig.teams.length} teams from ${paths.map((p) => basename(p)).join(", ")}${agent ? " (read by Devin)" : ""}`);
      return { plan, signals: sig.signals, project: inputs.project };
    }
    const plan = await stageA({ files: paths, readAs, launchDate, agent });
    if (!files.some((f) => f.kind === "plan" || f.kind === "prd")) plan.warnings.unshift("No file was read as a plan.");
    log(`plan: ${plan.items.length} items from ${paths.map((p) => basename(p)).join(", ")}${agent ? ` (${agent.items.length} items, ${agent.teams.length} teams read by Devin)` : ""}`);
    return { plan };
  }

  /** Write the request's files under out/gui-uploads/<uuid>/ (sample files are read from sampleDocs). */
  function saveUploads(u: User, body: any): { paths: string[]; readAs: Record<string, ReadAs[]>; dirPaths: string[]; files: any[] } {
    const files: any[] = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) throw new HttpError(400, "No files.");
    const dir = join(rootsFor(u).uploadRoot, randomUUID());
    mkdirSync(dir, { recursive: true });
    const paths: string[] = [], dirPaths: string[] = [];
    const readAs: Record<string, ReadAs[]> = {};
    for (const f of files) {
      const name = basename(String(f.name ?? "")).replace(/[^\w.\- ()]+/g, "_");
      if (!name) throw new HttpError(400, "A file has no name.");
      let path: string;
      if (f.sample) {
        path = join(sampleDocs, name);
        if (!existsSync(path)) throw new HttpError(400, `No sample file named ${name}.`);
      } else {
        if (typeof f.content_base64 !== "string") throw new HttpError(400, `${name}: missing content.`);
        path = join(dir, name);
        writeFileSync(path, Buffer.from(f.content_base64, "base64"));
      }
      if (f.kind === "other") continue;
      paths.push(path);
      if (f.kind === "teams") dirPaths.push(path);
      const ra = KIND_TO_READ_AS[String(f.kind)];
      if (ra) readAs[name] = [ra];
    }
    if (!paths.length) throw new HttpError(400, "No file was read as a plan.");
    return { paths, readAs, dirPaths, files };
  }

  const routes = {
    async health(req: IncomingMessage) {
      const me = auth.me(req);
      const u = auth.userOf(req);
      return { ok: true, mode: "live", jira: jiraInfo(u ?? LOCAL_USER), agent: agentInfo(), auth: me, settings: u ? settingsOf(u) : null, runs_root: resolve(u ? rootsFor(u).runsRoot : runsRoot) };
    },

    async settings(u: User) { return settingsOf(u); },
    async saveSettings(u: User, body: any) {
      if (body?.agent_consent !== undefined) {
        const v = String(body.agent_consent);
        if (!["unknown", "yes", "no"].includes(v)) throw new HttpError(400, "agent_consent must be unknown, yes or no.");
        store.setSetting(u.id, "agent_consent", v);
      }
      if (body?.agent_mode !== undefined) {
        if (!devin || devin.api !== "v3") throw new HttpError(400, "Reading modes need Devin's v3 API (a cog_ key).");
        const v = body.agent_mode === null ? null : String(body.agent_mode);
        if (v !== null && !(devin.modes as string[]).includes(v)) throw new HttpError(400, `agent_mode must be one of ${devin.modes.join(", ")}.`);
        store.setSetting(u.id, "agent_mode", v);
      }
      return settingsOf(u);
    },
    async decisions(u: User, key: string) { return store.decisions(u.id, key) ?? { decisions: {}, log: [], actionsDone: {} }; },
    async saveDecisions(u: User, key: string, body: any) {
      if (!body || typeof body !== "object" || typeof body.decisions !== "object" || !Array.isArray(body.log)) throw new HttpError(400, "Expected {decisions, log, actionsDone?, contacted?}.");
      store.setDecisions(u.id, key, body);
      return body;
    },

    async connect(u: User, body: any) {
      if (fixtureDir) return jiraInfo(u);
      const site = String(body?.site ?? "").trim().replace(/\/+$/, "");
      const email = String(body?.email ?? "").trim();
      const token = String(body?.token ?? "");
      if (!/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(site) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(site)) throw new HttpError(400, "Site must look like https://<you>.atlassian.net");
      if (!email || !token) throw new HttpError(400, "Email and API token are required.");
      const candidate = { site, email, token };
      let who: string;
      try {
        const me = await new JiraRest(candidate).myself();
        who = me.displayName;
      } catch (e) {
        if (e instanceof JiraAuthError) throw new HttpError(401, "Jira rejected the credentials. Check the site, email and API token.");
        throw new HttpError(502, `Could not reach ${site}: ${(e as Error).message}`);
      }
      userCreds.set(u.id, { creds: candidate, user: who });
      log(`jira: ${u.name} connected to ${site} as ${who}`);
      return jiraInfo(u);
    },

    /** Forgets the person's Atlassian sign-in and any token they typed; the company's environment credentials, if any, still apply. */
    async disconnect(u: User) { if (!fixtureDir) { userCreds.delete(u.id); atlassian?.disconnect(u); } return jiraInfo(u); },
    async jiraSites(u: User) { return { sites: atlassian?.sites(u) ?? [], current: atlassian?.connection(u)?.cloud_id ?? null }; },
    async chooseJiraSite(u: User, body: any) {
      if (!atlassian) throw new HttpError(400, "Sign in with Atlassian is not set up on this server.");
      try { await atlassian.chooseSite(u, String(body?.cloud_id ?? "")); } catch (e) { throw new HttpError(400, (e as Error).message); }
      return jiraInfo(u);
    },

    /** Sync (rules only) → 200 {plan…}; with agent: "devin" → a job (202) whose result adds {agent}. */
    async plan(u: User, body: any): Promise<{ status: number; data: unknown }> {
      const { paths, readAs, dirPaths, files } = saveUploads(u, body);
      const stage = String(body?.stage ?? "launching") as "launching" | "starting" | "building";
      const launchDate = body?.launch_date ?? null;
      if (body?.agent !== "devin") return { status: 200, data: await buildPlan(paths, readAs, dirPaths, files, stage, launchDate) };
      if (!devin) throw new HttpError(400, "Devin is not set up on this server (DEVIN_API_KEY). Ask your admin, or read without an agent.");
      const job: Job = { stage: 0, done: false, log: [] };
      const id = randomUUID();
      jobs.set(id, job);
      (async () => {
        try {
          const say = (l: string) => { job.log.push(l); log(`  ${l}`); if (/^Devin: Devin session /.test(l)) job.stage = 1; };
          const read = await readDocuments(u, paths, files, stage, say, (pct, detail) => { job.progress = pct; job.detail = detail; });
          job.stage = 2; job.progress = Math.max(job.progress ?? 0, 85); job.detail = "Checking every quote against your files";
          const data = await buildPlan(paths, readAs, dirPaths, files, stage, launchDate, read.reading, read.signals);
          job.result = { ...data, agent: read.agent }; job.stage = 3; job.progress = 100; job.detail = "Done"; job.done = true;
        } catch (e) {
          job.error = (e as Error).message ?? String(e); job.done = true;
          log(`plan (devin) failed: ${job.error}`);
        }
      })();
      return { status: 202, data: { job: id } };
    },

    /** Early stages (release-starter): a job whose result is the Starter output. Jira only for building. */
    async startStarter(u: User, body: any) {
      const stage = String(body?.stage ?? "");
      if (stage !== "starting" && stage !== "building") throw new HttpError(400, "stage must be starting or building.");
      const { paths, dirPaths } = saveUploads(u, body);
      const { runsRoot } = rootsFor(u);
      const label = String(body?.label ?? todayLabel());
      const epic = stage === "building" ? String(body?.epic ?? "").trim().toUpperCase() : null;
      if (stage === "building" && !/^[A-Z][A-Z0-9]+-\d+$/.test(epic ?? "")) throw new HttpError(400, "The building stage needs an epic key like PROJ-123.");
      const src = epic ? source(u, epic, label, true) : undefined;
      const exclude: string[] = Array.isArray(body?.exclude_signals) ? body.exclude_signals.map(String) : [];
      const job: Job = { stage: 0, done: false, log: [] };
      const id = randomUUID();
      jobs.set(id, job);
      (async () => {
        try {
          const out = await runStarter({
            stage, files: paths, directoryFiles: dirPaths, excludeSignals: exclude, epicKey: epic, source: src, label, runsRoot,
            onStage: (s, d) => { job.log.push(`${s}: ${d}`); if (s === "suggest" || s === "target") job.stage = 1; if (s === "people" || s === "coverage") job.stage = 2; },
          });
          job.result = out.starter; job.run_id = label; job.stage = 3; job.done = true;
          log(`starter: ${stage} ${out.starter.project} saved ${out.file}`);
        } catch (e) {
          job.error = (e as Error).message ?? String(e); job.done = true;
          log(`starter: ${stage} failed: ${job.error}`);
        }
      })();
      return { job: id };
    },

    async target(u: User, body: any) {
      const plan = PlanDraft.parse(body?.plan);
      const epic = String(body?.epic ?? "").trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(epic)) throw new HttpError(400, "Epic key must look like PROJ-123.");
      const label = String(body?.label ?? todayLabel());
      try {
        const target = await stageB({ plan, epicKey: epic, source: source(u, epic, label), noSearch: body?.no_search ?? [] });
        log(`target: ${epic} ${target.epic.summary}; ${target.projects.filter((p) => p.match !== "unresolved").length}/${target.projects.length} teams resolved`);
        return { target };
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof JiraAuthError) throw new HttpError(401, e.message);
        throw new HttpError(404, (e as Error).message);
      }
    },

    async runs(u: User, epic: string) {
      return listRunLabels(rootsFor(u).runsRoot, epic).map((id) => ({ id, label: id }));
    },

    async run(u: User, epic: string, id: string) {
      const { runsRoot } = rootsFor(u);
      if (!listRunLabels(runsRoot, epic).includes(id)) throw new HttpError(404, `No saved run ${id} for ${epic}.`);
      return loadRun(runsRoot, epic, id);
    },

    async startRun(u: User, body: any) {
      const plan = PlanDraft.parse(body?.plan);
      const target = ReleaseTarget.parse(body?.target);
      const label = String(body?.label ?? todayLabel());
      const epic = target.epic.key;
      const { runsRoot } = rootsFor(u);
      const src = source(u, epic, label, true);
      const job: Job = { stage: 0, done: false, log: [] };
      const id = randomUUID();
      jobs.set(id, job);
      (async () => {
        try {
          const release = await stageC({ plan, target, source: src, label });
          job.log.push(`read ${epic}: ${release.stories.length} stories, ${release.related.length} related, ${release.search_candidates.length} search candidates`);
          job.stage = 1;
          const findings = analyzeStep({ plan, target, release, goNoGo: body?.go_no_go ?? null });
          job.log.push(`${findings.findings.length} findings, ${findings.linkage_gaps.length} linkage gaps`);
          job.stage = 2;
          const prev = previousRun(runsRoot, epic, label);
          const status = statusStep({ plan, target, release, findings, previous: prev?.run ?? null, previousLabel: prev?.label ?? null });
          const saved = saveRun(runsRoot, epic, label, { plan, target, release, findings, status });
          job.log.push(`saved ${saved.runFile}`);
          job.stage = 3; job.run_id = label; job.done = true;
          log(`run: ${epic} ${label} saved (${findings.findings.length} findings)`);
        } catch (e) {
          job.error = (e as Error).message ?? String(e); job.done = true;
          log(`run: ${epic} failed: ${job.error}`);
        }
      })();
      return { job: id };
    },

    async job(id: string) {
      const j = jobs.get(id);
      if (!j) throw new HttpError(404, "No such job.");
      return j;
    },
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
    try {
      if (p.startsWith("/auth/atlassian/")) { if (!atlassian) return send(404, { error: "Sign in with Atlassian is not set up on this server." }); if (await atlassian.handle(req, res, url, auth.userOf(req))) return; return send(404, { error: `No route ${req.method} ${p}` }); }
      if (p.startsWith("/auth/")) { if (await auth.handle(req, res, url)) return; return send(404, { error: `No route ${req.method} ${p}` }); }
      if (p.startsWith("/api/")) {
        if (p === "/api/health" && req.method === "GET") return send(200, await routes.health(req));
        const u = auth.userOf(req);
        if (!u) return send(401, { error: "Sign in to continue.", login_url: "/auth/login" });
        if (req.method !== "GET" && req.method !== "HEAD") {
          // Cross-site requests cannot be made with these headers from a browser without CORS, which this server does not grant.
          const sfs = String(req.headers["sec-fetch-site"] ?? "");
          if (sfs && sfs !== "same-origin" && sfs !== "none") throw new HttpError(403, "Cross-site request refused.");
          if (appOrigin && req.headers.origin && req.headers.origin !== appOrigin) throw new HttpError(403, "Cross-site request refused.");
          if (!/^application\/json\b/.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "Send JSON.");
        }
        const body = req.method === "POST" || req.method === "PUT" ? await readJson(req) : null;
        let m: RegExpMatchArray | null;
        if (p === "/api/settings" && req.method === "GET") return send(200, await routes.settings(u));
        if (p === "/api/settings" && req.method === "PUT") return send(200, await routes.saveSettings(u, body));
        if ((m = p.match(/^\/api\/decisions\/(.+)$/)) && req.method === "GET") return send(200, await routes.decisions(u, decodeURIComponent(m[1])));
        if ((m = p.match(/^\/api\/decisions\/(.+)$/)) && req.method === "PUT") return send(200, await routes.saveDecisions(u, decodeURIComponent(m[1]), body));
        if (p === "/api/jira/connect" && req.method === "POST") return send(200, await routes.connect(u, body));
        if (p === "/api/jira/disconnect" && req.method === "POST") return send(200, await routes.disconnect(u));
        if (p === "/api/jira/sites" && req.method === "GET") return send(200, await routes.jiraSites(u));
        if (p === "/api/jira/site" && req.method === "POST") return send(200, await routes.chooseJiraSite(u, body));
        if (p === "/api/plan" && req.method === "POST") { const r = await routes.plan(u, body); return send(r.status, r.data); }
        if (p === "/api/target" && req.method === "POST") return send(200, await routes.target(u, body));
        if (p === "/api/run" && req.method === "POST") return send(202, await routes.startRun(u, body));
        if (p === "/api/starter" && req.method === "POST") return send(202, await routes.startStarter(u, body));
        if ((m = p.match(/^\/api\/runs\/([A-Z][A-Z0-9]+-\d+)$/)) && req.method === "GET") return send(200, await routes.runs(u, m[1]));
        if ((m = p.match(/^\/api\/runs\/([A-Z][A-Z0-9]+-\d+)\/(\d{4}-\d{2}-\d{2})$/)) && req.method === "GET") return send(200, await routes.run(u, m[1], m[2]));
        if ((m = p.match(/^\/api\/jobs\/([\w-]+)$/)) && req.method === "GET") return send(200, await routes.job(m[1]));
        return send(404, { error: `No route ${req.method} ${p}` });
      }
      // Static GUI
      const rel = p === "/" ? "/index.html" : p;
      const file = resolve(guiDist, "." + rel);
      if (file.startsWith(guiDist) && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(readFileSync(file));
      }
      if (existsSync(join(guiDist, "index.html"))) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(guiDist, "index.html"))); }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("GUI not built. Run `npm run gui:build`, or use `npm run gui:dev` and open http://localhost:5173.");
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if ((e as any)?.name === "ZodError") return send(400, { error: "Invalid input: " + (e as Error).message.slice(0, 400) });
      log(`error on ${req.method} ${p}: ${(e as Error).stack ?? e}`);
      send(500, { error: (e as Error).message ?? String(e) });
    }
  }

  return { handle, routes, jiraInfo, agentInfo, auth, store, close: () => store.close(), devinWhoami: () => (devin ? devin.whoami() : Promise.resolve(null)) };
}

function safeSeg(s: string): string { return s.replace(/[^\w.-]+/g, "_").slice(0, 80) || "org"; }

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 64 * 1024 * 1024) { reject(new HttpError(413, "Request too large (64 MB max).")); req.destroy(); } chunks.push(c); });
    req.on("end", () => { const t = Buffer.concat(chunks).toString("utf8"); try { resolve(t ? JSON.parse(t) : null); } catch { reject(new HttpError(400, "Body is not JSON.")); } });
    req.on("error", reject);
  });
}

export async function startServer(opts: ServerOptions = {}): Promise<{ url: string; app: ReturnType<typeof createApp>; close(): Promise<void> }> {
  const app = createApp(opts);
  const server = createServer((req, res) => void app.handle(req, res));
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, "127.0.0.1", r); });
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, app, close: () => new Promise((r) => server.close(() => { app.close(); r(); })) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  // Secrets live in an untracked .env (see .gitignore): OIDC_*, JIRA_*, DEVIN_*, SESSION_SECRET. Values already in the environment win.
  if (existsSync(".env")) { try { process.loadEnvFile(".env"); } catch (e) { console.error(`.env not loaded: ${(e as Error).message}`); } }
  startServer().then(async (s) => {
    const devinWhoami = s.app.devinWhoami;
    const j = s.app.jiraInfo();
    console.error(`Release Readiness Review server on ${s.url}`);
    console.error(j.fixture ? `  Jira: demo mode, reading ${j.site}` : j.connected ? `  Jira: ${j.site} (from environment)` : j.oauth ? "  Jira: Sign in with Atlassian on the Connect step (ATLASSIAN_CLIENT_ID set)" : "  Jira: not connected; the GUI's Connect step asks for a site, email and API token (set ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET for Sign in with Atlassian)");
    const a = s.app.agentInfo();
    console.error(s.app.auth.mode === "oidc" ? "  Sign-in: with your identity provider (OIDC_ISSUER)" : "  Sign-in: off (AUTH=none); set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and APP_URL to require it");
    if (a.available) {
      const who = await devinWhoami();
      console.error(`  Devin: reads uploaded plan documents (${a.api} API; up to ${a.max_acu} ACU per reading${who?.user_name ? `; key belongs to ${who.user_name}` : ""}${who?.org_id ? `, organisation ${who.org_id}` : ""}${a.api === "v3" ? `; mode ${a.default_mode ?? "Devin's default"}, people may pick ${a.modes.join(", ")}` : ""})`);
    } else console.error("  Devin: not set up (no DEVIN_API_KEY); uploads are read by the rules only");
    console.error(existsSync(resolve("gui/dist/index.html")) ? `  GUI: ${s.url}` : "  GUI: not built; run `npm run gui:dev` and open http://localhost:5173 (it proxies /api here)");
  }).catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
