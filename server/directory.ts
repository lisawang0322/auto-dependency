/**
 * The employee directory, connected first (Get started) and read in two layers (PRD "Employee directory sources"):
 *
 *   entra   people, titles and departments from Microsoft Graph through the sign-in the person already has
 *           (incremental consent in a popup: GET /auth/directory/entra/start → the provider's consent page →
 *           GET /auth/directory/entra/callback; the Graph token is used once, never stored). Teams = departments.
 *           GRAPH_API_BASE (default https://graph.microsoft.com/v1.0), GRAPH_SCOPES (default User.Read.All).
 *   jira    teams as Jira knows them: every project with its lead and the people assigned to its work, through
 *           the Jira connection (Sign in with Atlassian, a token, or the company's credentials).
 *   export  a team list or org chart file, read as before (handled by the upload step, not here).
 *
 * Each source is a snapshot stored per person (sealed, no tokens); the merged directory is written as a team-list
 * YAML the reader already understands, so Stage A, the early stages and Devin's grounding all take it as a file.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { JiraRest, type RestCreds } from "../skills/throughline-reader/scripts/lib/jira-rest.js";
import type { DirectoryEntry } from "../skills/throughline-starter/scripts/lib/directory.js";
import type { Store, User } from "./store.js";
import type { TokenBox } from "./crypto.js";
import { parseCookies, safeNext, type Auth } from "./auth.js";
import { DEMO_DIRECTORY, DEMO_ORG, demoDirectoryConsentPage, escapeHtml } from "./demo.js";

export type DirectorySourceId = "entra" | "jira";
export interface DirectorySnapshot { source: DirectorySourceId; label: string; teams: DirectoryEntry[]; people: number; connected_at: string }
export interface DirectorySummary { label: string; teams: number; people: number; connected_at: string }
export interface DirectoryInfo { entra: { available: boolean; connected: DirectorySummary | null }; jira: { available: boolean; connected: DirectorySummary | null } }

export interface DirectoryOptions {
  /** Microsoft Graph: the base URL and the delegated scopes asked for in the consent popup. */
  graphBase?: string;
  graphScopes?: string[];
  fetchImpl?: typeof fetch;
}

const COOKIE = "rrr_dir";
const KIND = (s: DirectorySourceId) => `directory:${s}`;

export class DirectoryHub {
  readonly graphBase: string;
  readonly graphScopes: string[];
  private readonly f: typeof fetch;
  constructor(private readonly store: Store, private readonly box: TokenBox, private readonly auth: Auth, opts: DirectoryOptions = {}, private readonly log: (s: string) => void = () => {}) {
    this.graphBase = (opts.graphBase ?? "https://graph.microsoft.com/v1.0").replace(/\/+$/, "");
    this.graphScopes = opts.graphScopes?.length ? opts.graphScopes : ["User.Read.All"];
    this.f = opts.fetchImpl ?? fetch;
  }

  // ---- snapshots ----
  snapshot(u: User, s: DirectorySourceId): DirectorySnapshot | null {
    const sealed = this.store.connection<{ sealed: string }>(u.id, KIND(s));
    return sealed ? this.box.open<DirectorySnapshot>(sealed.sealed) : null;
  }
  private save(u: User, snap: DirectorySnapshot) { this.store.setConnection(u.id, KIND(snap.source), { sealed: this.box.seal(snap) }); }
  disconnect(u: User, s: DirectorySourceId) { this.store.deleteConnection(u.id, KIND(s)); }
  private summary(snap: DirectorySnapshot | null): DirectorySummary | null { return snap ? { label: snap.label, teams: snap.teams.length, people: snap.people, connected_at: snap.connected_at } : null; }
  info(u: User, jiraAvailable: boolean): DirectoryInfo {
    return { entra: { available: this.auth.oidc() !== null || this.auth.mode === "demo", connected: this.summary(this.snapshot(u, "entra")) }, jira: { available: jiraAvailable, connected: this.summary(this.snapshot(u, "jira")) } };
  }
  /** The merged directory, or null when no source is connected. Entries with the same name merge: people from both, the Jira project from Jira. */
  merged(u: User): DirectoryEntry[] | null {
    const snaps = [this.snapshot(u, "jira"), this.snapshot(u, "entra")].filter((s): s is DirectorySnapshot => !!s);
    if (!snaps.length) return null;
    const out: DirectoryEntry[] = [];
    const norm = (s: string) => s.toLowerCase().replace(/\bteam\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    for (const snap of snaps) for (const e of snap.teams) {
      const hit = out.find((x) => norm(x.name) === norm(e.name) || x.aliases.some((a) => norm(a) === norm(e.name)) || e.aliases.some((a) => norm(a) === norm(x.name)));
      if (!hit) { out.push({ name: e.name, aliases: [...e.aliases], project: e.project, people: [...e.people] }); continue; }
      if (!hit.project && e.project) hit.project = e.project;
      for (const a of e.aliases) if (!hit.aliases.includes(a)) hit.aliases.push(a);
      for (const p of e.people) { const q = hit.people.find((x) => x.name === p.name); if (!q) hit.people.push({ ...p }); else if (!q.title && p.title) q.title = p.title; }
    }
    return out;
  }
  /** Write the merged directory as a team-list YAML under dir (the reader's format: teams[] with owners "Name (title)"); null when nothing is connected. */
  writeFile(u: User, dir: string): string | null {
    const teams = this.merged(u);
    if (!teams) return null;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "Employee directory.yaml");
    const doc = { teams: teams.map((t) => ({ name: t.name, ...(t.aliases.length ? { aliases: t.aliases } : {}), ...(t.project ? { jira_project: t.project } : {}), owners: t.people.map((p) => p.title ? `${p.name} (${p.title})` : p.name) })) };
    writeFileSync(path, `# The employee directory as connected on Get started (${[this.snapshot(u, "entra"), this.snapshot(u, "jira")].filter(Boolean).map((s) => s!.label).join(" + ")}).\n` + yamlStringify(doc));
    return path;
  }

  // ---- jira: projects as teams ----
  async fromJira(u: User, creds: RestCreds, siteLabel: string): Promise<DirectorySnapshot> {
    const jira = new JiraRest(creds, this.f);
    const projects = await jira.listProjects();
    const teams: DirectoryEntry[] = [];
    for (const p of projects) {
      const people: DirectoryEntry["people"] = [];
      if (p.lead?.displayName) people.push({ name: p.lead.displayName, title: "project lead" });
      // Whoever is assigned work in the project is on the team; the search is best effort (a site may refuse it).
      try {
        const issues = await jira.search(`project = ${p.key}`, 50, ["assignee"]);
        for (const i of issues) { const a = (i as any).fields?.assignee?.displayName; if (a && !people.some((q) => q.name === a)) people.push({ name: a, title: null }); }
      } catch { /* lead only */ }
      teams.push({ name: p.name, aliases: [p.key], project: p.key, people });
    }
    const snap: DirectorySnapshot = { source: "jira", label: `Jira projects · ${siteLabel}`, teams, people: teams.reduce((n, t) => n + t.people.length, 0), connected_at: new Date().toISOString() };
    this.save(u, snap);
    this.log(`directory: ${u.name} connected Jira projects (${teams.length} teams, ${snap.people} people)`);
    return snap;
  }

  /** The directory from a Graph token the sign-in already holds (one consent for both). */
  async connectWithToken(u: User, accessToken: string): Promise<DirectorySnapshot> {
    const snap = await this.readGraph(accessToken, u.org);
    this.save(u, snap);
    this.log(`directory: ${u.name} connected Microsoft Entra ID at sign-in (${snap.teams.length} teams, ${snap.people} people)`);
    return snap;
  }
  /** The demo company's directory, as the demo sign-in connects it. */
  async connectDemo(u: User): Promise<DirectorySnapshot> {
    const snap = this.teamsFromGraphUsers(DEMO_DIRECTORY.map((x) => ({ displayName: x.displayName, jobTitle: x.jobTitle, department: x.department, manager: x.manager ?? null })), `Microsoft Entra ID · ${DEMO_ORG} (demo)`);
    this.save(u, snap);
    return snap;
  }

  // ---- entra: Microsoft Graph through the sign-in, with its own consent (the fallback when the sign-in could not carry the scope) ----
  private cookie(value: string, maxAge: number, secure: boolean) { return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`; }
  /** Handle /auth/directory/entra/*; returns false when the path is not one of them. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, user: User | null): Promise<boolean> {
    const p = url.pathname;
    if (this.auth.mode === "demo") {
      // The demo provider: a consent page served here, and the sample company's directory on accept.
      if (p === "/auth/directory/entra/start" && req.method === "GET") {
        if (!user) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("Sign in first."), true; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(demoDirectoryConsentPage(this.graphScopes, url.searchParams.get("popup") === "1")); return true;
      }
      if (p === "/auth/directory/entra/callback" && req.method === "POST") { await this.demoCallback(req, res, url, user); return true; }
      return false;
    }
    if (p === "/auth/directory/entra/start" && req.method === "GET") { await this.start(res, url, user); return true; }
    if (p === "/auth/directory/entra/callback" && req.method === "GET") { await this.callback(req, res, url, user); return true; }
    return false;
  }
  private async demoCallback(req: IncomingMessage, res: ServerResponse, url: URL, user: User | null) {
    let body = ""; for await (const c of req) body += c;
    const decision = new URLSearchParams(body).get("decision");
    const popup = url.searchParams.get("popup") === "1";
    const finish = (status: number, text: string, ok: boolean) => {
      if (popup) { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(`<!doctype html><meta charset="utf-8"><title>Directory ${ok ? "connected" : "not connected"}</title><body style="font-family:system-ui;padding:24px"><p>${escapeHtml(text)}</p><script>try{window.opener&&window.opener.postMessage({type:"rrr:directory",ok:${ok ? "true" : "false"},message:${JSON.stringify(text)}},location.origin)}catch(e){}${ok ? "window.close();" : ""}</script></body>`); }
      if (ok) { res.writeHead(302, { Location: "/", "Cache-Control": "no-store" }); return res.end(); }
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); res.end(text);
    };
    if (!user) return finish(401, "Sign in first.", false);
    if (decision !== "accept") return finish(400, "The identity provider did not grant directory access: you cancelled.", false);
    const snap = await this.connectDemo(user);
    this.log(`directory: ${user.name} connected the demo directory (${snap.teams.length} teams, ${snap.people} people)`);
    return finish(200, `Directory connected: ${snap.teams.length} teams, ${snap.people} people. You can close this window.`, true);
  }
  private async start(res: ServerResponse, url: URL, user: User | null) {
    const oidc = this.auth.oidc();
    if (!oidc) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Sign-in is off, so there is no identity provider to read the directory from."); }
    if (!user) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("Sign in first."); }
    const d = await this.auth.endpoints();
    const state = randomBytes(16).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const popup = url.searchParams.get("popup") === "1";
    const sealed = this.box.seal({ state, verifier, uid: user.id, next: safeNext(url.searchParams.get("next") ?? "/"), popup });
    // The same app registration as the sign-in, asking for the directory scope on top; Entra's v2 endpoint takes Graph scopes by name.
    const q = new URLSearchParams({ response_type: "code", client_id: oidc.clientId, redirect_uri: `${oidc.appUrl}/auth/directory/entra/callback`, scope: ["openid", ...this.graphScopes].join(" "), state, code_challenge: challenge, code_challenge_method: "S256", prompt: "consent" });
    res.writeHead(302, { Location: `${d.authorization_endpoint}${d.authorization_endpoint.includes("?") ? "&" : "?"}${q}`, "Set-Cookie": this.cookie(sealed, 600, oidc.appUrl.startsWith("https://")), "Cache-Control": "no-store" });
    res.end();
  }
  private async callback(req: IncomingMessage, res: ServerResponse, url: URL, user: User | null) {
    const oidc = this.auth.oidc();
    const secure = !!oidc && oidc.appUrl.startsWith("https://");
    const pending = this.box.open<{ state: string; verifier: string; uid: string; next: string; popup: boolean }>(parseCookies(req)[COOKIE] ?? "");
    const finish = (status: number, body: string, ok: boolean) => {
      if (pending?.popup) {
        const html = `<!doctype html><meta charset="utf-8"><title>Directory ${ok ? "connected" : "not connected"}</title><body style="font-family:system-ui;padding:24px"><p>${escapeHtml(body)}</p><script>try{window.opener&&window.opener.postMessage({type:"rrr:directory",ok:${ok ? "true" : "false"},message:${JSON.stringify(body)}},location.origin)}catch(e){}${ok ? "window.close();" : ""}</script></body>`;
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": this.cookie("", 0, secure), "Cache-Control": "no-store" }); return res.end(html);
      }
      if (ok) { res.writeHead(302, { Location: pending?.next || "/", "Set-Cookie": this.cookie("", 0, secure), "Cache-Control": "no-store" }); return res.end(); }
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Set-Cookie": this.cookie("", 0, secure) }); res.end(body);
    };
    if (!oidc) return finish(404, "Sign-in is off.", false);
    if (!pending) return finish(400, "Connecting the directory failed: the attempt expired or was not started here; try again.", false);
    if (!user || user.id !== pending.uid) return finish(400, "Connecting the directory failed: a different person started this; sign in and try again.", false);
    const err = url.searchParams.get("error");
    if (err) return finish(400, `The identity provider did not grant directory access: ${err}${url.searchParams.get("error_description") ? ` (${url.searchParams.get("error_description")})` : ""}. An admin may have to consent to ${this.graphScopes.join(", ")} for this app.`, false);
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (!code || !state || state !== pending.state) return finish(400, "Connecting the directory failed: the state did not match; try again.", false);
    try {
      const d = await this.auth.endpoints();
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${oidc.appUrl}/auth/directory/entra/callback`, client_id: oidc.clientId, client_secret: oidc.clientSecret, code_verifier: pending.verifier });
      const tok = await this.f(d.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
      if (!tok.ok) { let detail = ""; try { const j = await tok.json(); detail = String(j?.error_description ?? j?.error ?? "").split(" Trace ID")[0]; } catch { /* not json */ } throw new Error(`the token request failed (${tok.status}${detail ? `: ${detail}` : ""})`); }
      const data = (await tok.json()) as { access_token?: string };
      if (!data.access_token) throw new Error("no access token came back");
      const snap = await this.readGraph(data.access_token, user.org);
      this.save(user, snap);
      this.log(`directory: ${user.name} connected Microsoft Entra ID (${snap.teams.length} teams, ${snap.people} people)`);
      return finish(200, `Directory connected: ${snap.teams.length} teams, ${snap.people} people. You can close this window.`, true);
    } catch (e) {
      return finish(502, `Connecting the directory failed: ${(e as Error).message}`, false);
    }
  }
  /** GET /users with title, department and manager, paged; a team per department, its people with their titles. */
  private async readGraph(accessToken: string, tenant: string): Promise<DirectorySnapshot> {
    const users: { displayName: string; jobTitle: string | null; department: string | null; manager: string | null }[] = [];
    let next: string | null = `${this.graphBase}/users?$select=id,displayName,jobTitle,department,accountEnabled&$expand=manager($select=displayName)&$top=999`;
    for (let pages = 0; next && pages < 50; pages++) {
      const r = await this.f(next, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
      if (!r.ok) { let detail = ""; try { const j = await r.json(); detail = String(j?.error?.message ?? ""); } catch { /* not json */ } throw new Error(`Microsoft Graph refused to list users (${r.status}${detail ? `: ${detail}` : ""})`); }
      const page = (await r.json()) as { value?: any[]; "@odata.nextLink"?: string };
      for (const v of page.value ?? []) if (v?.displayName && v.accountEnabled !== false) users.push({ displayName: String(v.displayName), jobTitle: v.jobTitle ?? null, department: v.department ?? null, manager: v.manager?.displayName ?? null });
      next = page["@odata.nextLink"] ?? null;
    }
    return this.teamsFromGraphUsers(users, `Microsoft Entra ID · ${tenant}`);
  }
  /** A team per department, its people with their titles. The team's own lead (the member who reports outside the
   *  department) comes first, since the first person is who the team is contacted through; the manager outside the
   *  department, whom most of it reports to, comes last, as the escalation. */
  private teamsFromGraphUsers(users: { displayName: string; jobTitle: string | null; department: string | null; manager: string | null }[], label: string): DirectorySnapshot {
    const byDept = new Map<string, DirectoryEntry>();
    for (const v of users) {
      if (!v.department) continue;
      const t = byDept.get(v.department) ?? { name: v.department, aliases: [], project: null, people: [] };
      t.people.push({ name: v.displayName, title: v.jobTitle });
      byDept.set(v.department, t);
    }
    for (const t of byDept.values()) {
      const counts = new Map<string, number>();
      for (const v of users) if (v.department === t.name && v.manager && !t.people.some((p) => p.name === v.manager)) counts.set(v.manager, (counts.get(v.manager) ?? 0) + 1);
      const outside = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!outside) continue;
      // The member who reports to that manager leads the team (a security lead, not the platform director above them).
      const leadName = users.find((v) => v.department === t.name && v.manager === outside)?.displayName;
      const i = t.people.findIndex((p) => p.name === leadName);
      if (i > 0) t.people.unshift(...t.people.splice(i, 1));
      const m = users.find((v) => v.displayName === outside);
      t.people.push({ name: outside, title: m?.jobTitle ?? "manager" });
    }
    const teams = [...byDept.values()];
    return { source: "entra", label, teams, people: teams.reduce((n, t) => n + t.people.length, 0), connected_at: new Date().toISOString() };
  }
}

export function directoryFromEnv(env = process.env): DirectoryOptions {
  return { graphBase: env.GRAPH_API_BASE, graphScopes: env.GRAPH_SCOPES ? env.GRAPH_SCOPES.split(/[\s,]+/).filter(Boolean) : undefined };
}

