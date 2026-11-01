/**
 * Live mode: the GUI talks to server/index.ts (npm run server), which runs the real reader, analyzer and
 * status stages. Jira is read with credentials the server holds in memory; the browser never sees a token
 * again after the connect form.
 */
import { PlanDraft, ReleaseTarget, Run, Signal, Starter, type Stage } from "@rrr/schemas";
import type { ReviewBackend, UploadedFile, RunSummary, ProgressStage, JiraConnection, JiraCredentials, JiraState, PlanExtract, StarterRunInput, AgentInfo, AgentRead, AgentReadStage, ExtractOptions, Settings, UserInfo, DirectoryConnection, DirectoryInfo, DirectorySourceId } from "./types";
import { fmtDate } from "../model/dates";

export interface JiraInfo { connected: boolean; site: string | null; user: string | null; fixture: boolean; oauth?: boolean; method?: "oauth" | "token" | "company" | "fixture" | null; sites?: number }

async function apiRaw<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<{ status: number; data: T }> {
  // The server takes JSON on every write, bodiless DELETEs included (its cross-site check keys on the content type).
  const res = await fetch(path, { method, headers: method !== "GET" ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `${res.status} on ${path}`);
  return { status: res.status, data: data as T };
}
async function api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> { return (await apiRaw<T>(method, path, body)).data; }

export interface AuthInfo { mode: "none" | "oidc"; user: UserInfo | null; login_url: string | null }
export interface Health { jira: JiraInfo; agent?: AgentInfo; auth?: AuthInfo; settings?: Settings | null; directory?: DirectoryInfo }

/** Ends the session and returns to the sign-in screen. */
export async function signOut(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

/** Is the local server there? Decides sample vs live mode at startup. */
export async function probeServer(timeoutMs = 1500): Promise<Health | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/health", { signal: ctl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data : null;
  } catch { return null; } finally { clearTimeout(t); }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LiveBackend implements ReviewBackend {
  readonly mode = "live" as const;
  readonly agent: AgentInfo;
  readonly directory: DirectoryConnection = new LiveDirectory();
  /** Launch date and go/no-go the person set on the Connect step, applied on run. */
  launchDate: string | null = null;
  constructor(health?: Health | null) { this.agent = health?.agent ?? { available: false, name: "Devin" }; }
  /** The tier the person chose, from the health probe; the panel keeps it current after a change. */
  initialMode(health?: Health | null): string | null { return health?.settings?.agent_mode ?? null; }

  async saveSettings(patch: Partial<Settings>): Promise<void> { await api("PUT", "/api/settings", patch); }

  private async payload(files: UploadedFile[]) {
    const out = [];
    for (const f of files) {
      // The directory connector's export is marked, so the server keeps it as structured data rather than sending it to Devin.
      const via = f.via ? { via: f.via } : {};
      // A directory the server holds travels by name only; the server writes the merged team list itself.
      if (f.source === "server") { out.push({ name: f.name, kind: f.kind, via: "directory", source: "server" }); continue; }
      if (f.sample || !f.file) out.push({ name: f.name, kind: f.kind, sample: true, ...via });
      else out.push({ name: f.name, kind: f.kind, content_base64: toBase64(await f.file.arrayBuffer()), ...via });
    }
    return out;
  }

  async extractPlan(files: UploadedFile[], stage: Stage, opts: ExtractOptions = {}): Promise<PlanExtract> {
    type PlanRes = { plan: unknown; signals?: unknown[]; project?: string; agent?: AgentRead | null };
    const useAgent = !!opts.agent && this.agent.available;
    const first = await apiRaw<PlanRes & { job?: string }>("POST", "/api/plan", { files: await this.payload(files), stage, ...(useAgent ? { agent: "devin" } : {}) });
    let res: PlanRes = first.data;
    if (first.status === 202 && first.data.job) {
      opts.onProgress?.(0);
      for (;;) {
        await wait(500);
        const j = await api<{ stage: AgentReadStage; done: boolean; result?: PlanRes; error?: string; progress?: number; detail?: string }>("GET", `/api/jobs/${first.data.job}`);
        opts.onProgress?.(j.stage, j.progress !== undefined ? { pct: j.progress, detail: j.detail ?? "" } : undefined);
        if (j.error) throw new Error(j.error);
        if (j.done && j.result) { res = j.result; break; }
      }
    }
    return { plan: PlanDraft.parse(res.plan), signals: (res.signals ?? []).map((s) => Signal.parse(s)), project: res.project ?? null, agent: res.agent ?? null };
  }

  async runStarter(input: StarterRunInput, onProgress: (s: ProgressStage) => void): Promise<Starter> {
    const { job } = await api<{ job: string }>("POST", "/api/starter", { files: await this.payload(input.files), stage: input.stage, exclude_signals: input.excludeSignals, epic: input.epic });
    onProgress(0);
    for (;;) {
      await wait(400);
      const j = await api<{ stage: ProgressStage; done: boolean; result?: unknown; error?: string }>("GET", `/api/jobs/${job}`);
      onProgress(j.stage);
      if (j.error) throw new Error(j.error);
      if (j.done && j.result) return Starter.parse(j.result);
    }
  }

  async resolveRelease(plan: PlanDraft, epicKey: string): Promise<ReleaseTarget> {
    const { target } = await api<{ target: unknown }>("POST", "/api/target", { plan, epic: epicKey });
    return ReleaseTarget.parse(target);
  }

  async listRuns(epicKey: string): Promise<RunSummary[]> {
    const runs = await api<{ id: string }[]>("GET", `/api/runs/${epicKey}`);
    return runs.map((r) => ({ id: r.id, label: fmtDate(r.id) }));
  }

  async loadRun(epicKey: string, runId: string): Promise<Run> {
    return Run.parse(await api("GET", `/api/runs/${epicKey}/${runId}`));
  }

  async runReview(plan: PlanDraft, target: ReleaseTarget, onProgress: (s: ProgressStage) => void): Promise<string> {
    const { job } = await api<{ job: string }>("POST", "/api/run", { plan, target });
    onProgress(0);
    for (;;) {
      await wait(400);
      const j = await api<{ stage: ProgressStage; done: boolean; run_id?: string; error?: string }>("GET", `/api/jobs/${job}`);
      onProgress(j.stage);
      if (j.error) throw new Error(j.error);
      if (j.done && j.run_id) return j.run_id;
    }
  }
}

const NO_DIRECTORY: DirectoryInfo = { entra: { available: false, connected: null }, jira: { available: false, connected: null } };

/** The server-held layers of the employee directory. The Entra consent runs in a popup like Sign in with Atlassian. */
export class LiveDirectory implements DirectoryConnection {
  async info(): Promise<DirectoryInfo> { try { return await api<DirectoryInfo>("GET", "/api/directory"); } catch { return NO_DIRECTORY; } }
  async connectEntra(): Promise<DirectoryInfo> {
    const popup = window.open("/auth/directory/entra/start?popup=1", "rrr-directory", "popup=yes,width=620,height=720");
    if (!popup) { location.href = `/auth/directory/entra/start?next=${encodeURIComponent(location.pathname + location.search)}`; return this.info(); }
    const outcome = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      const onMessage = (e: MessageEvent) => { if (e.origin === location.origin && e.data?.type === "rrr:directory") { cleanup(); resolve({ ok: !!e.data.ok, message: e.data.message }); } };
      const timer = setInterval(async () => {
        if (popup.closed) { cleanup(); resolve({ ok: false, message: "closed" }); return; }
        const d = await this.info().catch(() => null);
        if (d?.entra.connected) { cleanup(); try { popup.close(); } catch { /* cross-origin while on the provider */ } resolve({ ok: true }); }
      }, 1000);
      const cleanup = () => { window.removeEventListener("message", onMessage); clearInterval(timer); };
      window.addEventListener("message", onMessage);
    });
    const info = await this.info();
    if (!outcome.ok && !info.entra.connected) throw new Error(outcome.message && outcome.message !== "closed" ? outcome.message : "The directory was not connected: the consent window closed before access was granted.");
    return info;
  }
  async connectJira(): Promise<DirectoryInfo> { return api<DirectoryInfo>("POST", "/api/directory/jira", {}); }
  async disconnect(source: DirectorySourceId): Promise<DirectoryInfo> { return api<DirectoryInfo>("DELETE", `/api/directory/${source}`); }
}

export class LiveJiraConnection implements JiraConnection {
  site = "";
  user: string | null = null;
  fixture = false;
  oauthAvailable = false;
  method: JiraConnection["method"] = null;
  /** The token form is the fallback when Sign in with Atlassian is not set up on the server. */
  get credentialsNeeded() { return !this.oauthAvailable; }
  readonly scopes = {
    can: ["Read issues, comments, links and due dates", "Read projects, components and fix versions", "Read user names, to find owners"],
    cannot: ["Create, edit, comment on or move issues"],
  };
  constructor(info?: JiraInfo) { if (info) this.take(info); }
  private take(info: JiraInfo) { this.site = info.site ?? ""; this.user = info.user; this.fixture = info.fixture; this.oauthAvailable = !!info.oauth; this.method = info.method ?? null; return info.connected ? "on" as const : "off" as const; }
  /** Atlassian's consent page in a popup; the callback page posts a message and closes. Poll health too, for browsers that block the message. */
  async startOAuth(): Promise<JiraState> {
    const popup = window.open("/auth/atlassian/start?popup=1", "rrr-atlassian", "popup=yes,width=620,height=720");
    if (!popup) { location.href = `/auth/atlassian/start?next=${encodeURIComponent(location.pathname + location.search)}`; return "connecting"; }
    const outcome = await new Promise<"done" | "closed" | "failed">((resolve) => {
      const onMessage = (e: MessageEvent) => { if (e.origin === location.origin && e.data?.type === "rrr:atlassian") { cleanup(); resolve(e.data.ok ? "done" : "failed"); } };
      const timer = setInterval(async () => {
        if (popup.closed) { cleanup(); resolve("closed"); return; }
        const h = await probeServer(1000).catch(() => null);
        if (h?.jira.connected && h.jira.method === "oauth") { cleanup(); try { popup.close(); } catch { /* cross-origin while on Atlassian */ } resolve("done"); }
      }, 1000);
      const cleanup = () => { window.removeEventListener("message", onMessage); clearInterval(timer); };
      window.addEventListener("message", onMessage);
    });
    if (outcome === "failed") throw new Error("Atlassian did not grant access. Try again, and check the site you picked.");
    return this.initialState();
  }
  async sites() { return api<{ sites: { id: string; url: string; name: string }[]; current: string | null }>("GET", "/api/jira/sites"); }
  async chooseSite(cloudId: string): Promise<JiraState> { return this.take(await api<JiraInfo>("POST", "/api/jira/site", { cloud_id: cloudId })); }
  async initialState(): Promise<JiraState> {
    const h = await probeServer();
    return h ? this.take(h.jira) : "off";
  }
  start(): JiraState { return "consent"; }
  async accept(): Promise<JiraState> { return this.initialState(); }
  async connect(creds: JiraCredentials): Promise<JiraState> {
    const info = await api<JiraInfo>("POST", "/api/jira/connect", creds);
    return this.take(info);
  }
  cancel(): JiraState { return "off"; }
  disconnect(): JiraState { void api("POST", "/api/jira/disconnect").catch(() => {}); this.user = null; return "off"; }
}
