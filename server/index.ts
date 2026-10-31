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
 *   GET  /api/health                  {ok, jira:{connected, site, user}, fixture}
 *   POST /api/jira/connect            {site, email, token} → checks /myself, keeps the credentials
 *   POST /api/jira/disconnect
 *   POST /api/plan                    {files:[{name, kind, content_base64 | sample}], launch_date?} → {plan}
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
import { stageA, stageB, stageC, analyzeStep, statusStep, previousRun, saveRun, listRunLabels, loadRun, todayLabel, type SourceSpec } from "../scripts/lib/pipeline.js";

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
}

interface Job { stage: 0 | 1 | 2 | 3; done: boolean; run_id?: string; error?: string; log: string[] }

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
  const log = opts.quiet ? () => {} : (s: string) => console.error(s);
  let creds: RestCreds | null = opts.creds === undefined ? envCreds() : opts.creds;
  let user: string | null = null;
  const jobs = new Map<string, Job>();

  function envCreds(): RestCreds | null {
    const { JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    return JIRA_SITE && JIRA_EMAIL && JIRA_API_TOKEN ? { site: JIRA_SITE, email: JIRA_EMAIL, token: JIRA_API_TOKEN } : null;
  }
  function jiraInfo() {
    if (fixtureDir) return { connected: true, site: `fixture ${basename(fixtureDir)}`, user: "sample data", fixture: true };
    return { connected: !!creds, site: creds ? creds.site.replace(/^https?:\/\//, "") : null, user, fixture: false };
  }
  function source(epic: string, label: string, fresh = false): SourceSpec {
    if (fixtureDir) return { kind: "fixture", dir: fixtureDir };
    if (!creds) throw new HttpError(400, "Not connected to Jira. Connect first.");
    const cacheDir = join(cacheRoot, epic, label);
    if (fresh) rmSync(cacheDir, { recursive: true, force: true });
    return { kind: "rest", creds, cacheDir, log: (l) => log("  jira: " + l) };
  }

  const routes = {
    async health() { return { ok: true, mode: "live", jira: jiraInfo(), runs_root: resolve(runsRoot) }; },

    async connect(body: any) {
      if (fixtureDir) return jiraInfo();
      const site = String(body?.site ?? "").trim().replace(/\/+$/, "");
      const email = String(body?.email ?? "").trim();
      const token = String(body?.token ?? "");
      if (!/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(site) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(site)) throw new HttpError(400, "Site must look like https://<you>.atlassian.net");
      if (!email || !token) throw new HttpError(400, "Email and API token are required.");
      const candidate = { site, email, token };
      try {
        const me = await new JiraRest(candidate).myself();
        creds = candidate; user = me.displayName;
      } catch (e) {
        if (e instanceof JiraAuthError) throw new HttpError(401, "Jira rejected the credentials. Check the site, email and API token.");
        throw new HttpError(502, `Could not reach ${site}: ${(e as Error).message}`);
      }
      log(`jira: connected to ${site} as ${user}`);
      return jiraInfo();
    },

    async disconnect() { if (!fixtureDir) { creds = null; user = null; } return jiraInfo(); },

    async plan(body: any) {
      const files: any[] = Array.isArray(body?.files) ? body.files : [];
      if (!files.length) throw new HttpError(400, "No files.");
      const dir = join(uploadRoot, randomUUID());
      mkdirSync(dir, { recursive: true });
      const paths: string[] = [];
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
        const ra = KIND_TO_READ_AS[String(f.kind)];
        if (ra) readAs[name] = [ra];
      }
      if (!paths.length) throw new HttpError(400, "No file was read as a plan.");
      const plan = await stageA({ files: paths, readAs, launchDate: body?.launch_date ?? null });
      if (!files.some((f) => f.kind === "plan" || f.kind === "prd")) plan.warnings.unshift("No file was read as a plan.");
      log(`plan: ${plan.items.length} items from ${paths.map((p) => basename(p)).join(", ")}`);
      return { plan };
    },

    async target(body: any) {
      const plan = PlanDraft.parse(body?.plan);
      const epic = String(body?.epic ?? "").trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9]+-\d+$/.test(epic)) throw new HttpError(400, "Epic key must look like PROJ-123.");
      const label = String(body?.label ?? todayLabel());
      try {
        const target = await stageB({ plan, epicKey: epic, source: source(epic, label), noSearch: body?.no_search ?? [] });
        log(`target: ${epic} ${target.epic.summary}; ${target.projects.filter((p) => p.match !== "unresolved").length}/${target.projects.length} teams resolved`);
        return { target };
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof JiraAuthError) throw new HttpError(401, e.message);
        throw new HttpError(404, (e as Error).message);
      }
    },

    async runs(epic: string) {
      return listRunLabels(runsRoot, epic).map((id) => ({ id, label: id }));
    },

    async run(epic: string, id: string) {
      if (!listRunLabels(runsRoot, epic).includes(id)) throw new HttpError(404, `No saved run ${id} for ${epic}.`);
      return loadRun(runsRoot, epic, id);
    },

    async startRun(body: any) {
      const plan = PlanDraft.parse(body?.plan);
      const target = ReleaseTarget.parse(body?.target);
      const label = String(body?.label ?? todayLabel());
      const epic = target.epic.key;
      const src = source(epic, label, true);
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
      if (p.startsWith("/api/")) {
        const body = req.method === "POST" ? await readJson(req) : null;
        let m: RegExpMatchArray | null;
        if (p === "/api/health" && req.method === "GET") return send(200, await routes.health());
        if (p === "/api/jira/connect" && req.method === "POST") return send(200, await routes.connect(body));
        if (p === "/api/jira/disconnect" && req.method === "POST") return send(200, await routes.disconnect());
        if (p === "/api/plan" && req.method === "POST") return send(200, await routes.plan(body));
        if (p === "/api/target" && req.method === "POST") return send(200, await routes.target(body));
        if (p === "/api/run" && req.method === "POST") return send(202, await routes.startRun(body));
        if ((m = p.match(/^\/api\/runs\/([A-Z][A-Z0-9]+-\d+)$/)) && req.method === "GET") return send(200, await routes.runs(m[1]));
        if ((m = p.match(/^\/api\/runs\/([A-Z][A-Z0-9]+-\d+)\/(\d{4}-\d{2}-\d{2})$/)) && req.method === "GET") return send(200, await routes.run(m[1], m[2]));
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

  return { handle, routes, jiraInfo };
}

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
  return { url: `http://127.0.0.1:${addr.port}`, app, close: () => new Promise((r) => server.close(() => r())) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  startServer().then((s) => {
    const j = s.app.jiraInfo();
    console.error(`Release Readiness Review server on ${s.url}`);
    console.error(j.fixture ? `  Jira: demo mode, reading ${j.site}` : j.connected ? `  Jira: ${j.site} (from environment)` : "  Jira: not connected; the GUI's Connect step asks for a site, email and API token");
    console.error(existsSync(resolve("gui/dist/index.html")) ? `  GUI: ${s.url}` : "  GUI: not built; run `npm run gui:dev` and open http://localhost:5173 (it proxies /api here)");
  }).catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
