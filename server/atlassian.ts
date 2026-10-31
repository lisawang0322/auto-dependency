/**
 * Jira through "Sign in with Atlassian": OAuth 2.0 (3LO), authorization code, read-only scopes.
 *
 *   ATLASSIAN_CLIENT_ID=…  ATLASSIAN_CLIENT_SECRET=…    the app at developer.atlassian.com; its callback URL is APP_URL + /auth/atlassian/callback
 *   TOKEN_KEY=<long random string>                     encrypts stored tokens (SESSION_SECRET is used when unset)
 *
 * Flow: GET /auth/atlassian/start (signed-in person) → auth.atlassian.com/authorize → GET /auth/atlassian/callback:
 * the code is exchanged, the accessible sites are listed, the first Jira site is chosen (others selectable),
 * and the tokens are stored per person, encrypted. Access tokens refresh themselves (refresh tokens rotate).
 * Jira is then read through https://api.atlassian.com/ex/jira/{cloudId} with a bearer token.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { JiraRest, type RestCreds } from "../skills/release-reader/scripts/lib/jira-rest.js";
import type { Store, User } from "./store.js";
import type { TokenBox } from "./crypto.js";
import { parseCookies, safeNext } from "./auth.js";

export interface AtlassianConfig {
  clientId: string;
  clientSecret: string;
  /** Where the browser reaches this server; the callback is appUrl + /auth/atlassian/callback. */
  appUrl: string;
  authBase?: string;
  apiBase?: string;
  scopes?: string[];
  fetchImpl?: typeof fetch;
}

export function atlassianFromEnv(env = process.env, appUrl: string): AtlassianConfig | null {
  if (!env.ATLASSIAN_CLIENT_ID) return null;
  if (!env.ATLASSIAN_CLIENT_SECRET) throw new Error("ATLASSIAN_CLIENT_ID is set but ATLASSIAN_CLIENT_SECRET is missing.");
  return { clientId: env.ATLASSIAN_CLIENT_ID, clientSecret: env.ATLASSIAN_CLIENT_SECRET, appUrl, authBase: env.ATLASSIAN_AUTH_BASE, apiBase: env.ATLASSIAN_API_BASE };
}

export interface AtlassianSite { id: string; url: string; name: string }
/** What is stored per person (sealed). */
export interface AtlassianConnection {
  cloud_id: string;
  site_url: string;
  site_name: string;
  sites: AtlassianSite[];
  access_token: string;
  refresh_token: string | null;
  /** ms since epoch */
  expires_at: number;
  scope: string;
  user_name: string | null;
  connected_at: string;
}

const KIND = "atlassian";
const COOKIE = "rrr_atl";
const DEFAULT_SCOPES = ["read:jira-work", "read:jira-user", "offline_access"];

export class Atlassian {
  readonly authBase: string;
  readonly apiBase: string;
  readonly scopes: string[];
  private readonly f: typeof fetch;
  private refreshing = new Map<string, Promise<string>>();
  constructor(private readonly cfg: AtlassianConfig, private readonly store: Store, private readonly box: TokenBox, private readonly log: (s: string) => void = () => {}) {
    this.authBase = (cfg.authBase ?? "https://auth.atlassian.com").replace(/\/+$/, "");
    this.apiBase = (cfg.apiBase ?? "https://api.atlassian.com").replace(/\/+$/, "");
    this.scopes = cfg.scopes ?? DEFAULT_SCOPES;
    this.f = cfg.fetchImpl ?? fetch;
  }
  private get redirectUri() { return `${this.cfg.appUrl.replace(/\/+$/, "")}/auth/atlassian/callback`; }
  private cookie(value: string, maxAge: number) { return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.cfg.appUrl.startsWith("https://") ? "; Secure" : ""}`; }

  // ---- stored connection ----
  connection(u: User): AtlassianConnection | null {
    const sealed = this.store.connection<{ sealed: string }>(u.id, KIND);
    return sealed ? this.box.open<AtlassianConnection>(sealed.sealed) : null;
  }
  private save(u: User, c: AtlassianConnection) { this.store.setConnection(u.id, KIND, { sealed: this.box.seal(c) }); }
  disconnect(u: User) { this.store.deleteConnection(u.id, KIND); }
  info(u: User): { site: string; user: string | null; sites: number } | null {
    const c = this.connection(u);
    return c ? { site: c.site_url.replace(/^https?:\/\//, ""), user: c.user_name, sites: c.sites.length } : null;
  }
  sites(u: User): AtlassianSite[] { return this.connection(u)?.sites ?? []; }
  /** Switch to another of the person's sites; refreshes the display name. */
  async chooseSite(u: User, cloudId: string): Promise<AtlassianConnection> {
    const c = this.connection(u);
    if (!c) throw new Error("Not connected to Atlassian.");
    const site = c.sites.find((s) => s.id === cloudId);
    if (!site) throw new Error("That site is not one this account can reach.");
    this.save(u, { ...c, cloud_id: site.id, site_url: site.url, site_name: site.name });
    return this.withDisplayName(u);
  }

  /** Credentials for the Jira client, with a token that refreshes itself. */
  creds(u: User): RestCreds | null {
    const c = this.connection(u);
    if (!c) return null;
    return { kind: "oauth", site: c.site_url, cloudId: c.cloud_id, apiBase: this.apiBase, accessToken: () => this.token(u) };
  }
  private async displayName(u: User): Promise<string | null> {
    const creds = this.creds(u);
    if (!creds) return null;
    const me = await new JiraRest(creds, this.f).myself();
    return me.displayName ?? null;
  }
  /** Look up the display name and store it. The lookup may refresh (and rotate) the tokens, so the stored
   *  connection is re-read before writing: saving a stale copy would bring back a refresh token Atlassian has retired. */
  private async withDisplayName(u: User): Promise<AtlassianConnection> {
    const name = await this.displayName(u).catch(() => null);
    const latest = this.connection(u);
    if (!latest) throw new Error("Not connected to Atlassian.");
    const next = { ...latest, user_name: name };
    this.save(u, next);
    return next;
  }

  /** The current access token, refreshed when it is about to expire. Refresh tokens rotate: the new one is stored at once. */
  async token(u: User): Promise<string> {
    const c = this.connection(u);
    if (!c) throw new Error("Not connected to Atlassian.");
    if (c.expires_at - Date.now() > 60_000) return c.access_token;
    const inflight = this.refreshing.get(u.id);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        if (!c.refresh_token) throw new Error("The Atlassian access token expired and there is no refresh token; connect Jira again.");
        const tok = await this.exchange({ grant_type: "refresh_token", refresh_token: c.refresh_token });
        const next: AtlassianConnection = { ...c, access_token: tok.access_token, refresh_token: tok.refresh_token ?? c.refresh_token, expires_at: Date.now() + tok.expires_in * 1000, scope: tok.scope ?? c.scope };
        this.save(u, next);
        this.log(`atlassian: refreshed the token for ${u.name}`);
        return next.access_token;
      } finally { this.refreshing.delete(u.id); }
    })();
    this.refreshing.set(u.id, p);
    return p;
  }

  private async exchange(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
    const res = await this.f(`${this.authBase}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...body }) });
    if (!res.ok) {
      let detail = ""; try { const j = await res.json(); detail = String(j?.error_description ?? j?.error ?? ""); } catch { /* not json */ }
      throw new Error(`Atlassian token request failed (${res.status}${detail ? `: ${detail}` : ""}).`);
    }
    const tok = await res.json();
    if (!tok?.access_token || typeof tok.expires_in !== "number") throw new Error("Atlassian token response was incomplete.");
    return tok;
  }

  // ---- the routes ----
  /** Handle /auth/atlassian/*; returns false when the path is not one of them. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, user: User | null): Promise<boolean> {
    const p = url.pathname;
    if (p === "/auth/atlassian/start" && req.method === "GET") { await this.start(req, res, url, user); return true; }
    if (p === "/auth/atlassian/callback" && req.method === "GET") { await this.callback(req, res, url, user); return true; }
    return false;
  }

  private async start(_req: IncomingMessage, res: ServerResponse, url: URL, user: User | null) {
    if (!user) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("Sign in first."); }
    const state = randomBytes(16).toString("base64url");
    const popup = url.searchParams.get("popup") === "1";
    const sealed = this.box.seal({ state, uid: user.id, next: safeNext(url.searchParams.get("next") ?? "/"), popup });
    const q = new URLSearchParams({ audience: "api.atlassian.com", client_id: this.cfg.clientId, scope: this.scopes.join(" "), redirect_uri: this.redirectUri, state, response_type: "code", prompt: "consent" });
    res.writeHead(302, { Location: `${this.authBase}/authorize?${q}`, "Set-Cookie": this.cookie(sealed, 600), "Cache-Control": "no-store" });
    res.end();
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL, user: User | null) {
    const pending = this.box.open<{ state: string; uid: string; next: string; popup: boolean }>(parseCookies(req)[COOKIE] ?? "");
    const finish = (status: number, body: string, ok: boolean) => {
      const popup = pending?.popup ?? false;
      const html = popup
        ? `<!doctype html><meta charset="utf-8"><title>Jira ${ok ? "connected" : "not connected"}</title><body style="font-family:system-ui;padding:24px"><p>${escapeHtml(body)}</p><script>try{window.opener&&window.opener.postMessage({type:"rrr:atlassian",ok:${ok ? "true" : "false"},message:${JSON.stringify(body)}},location.origin)}catch(e){}${ok ? "window.close();" : ""}</script></body>`
        : null;
      if (html) { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": this.cookie("", 0), "Cache-Control": "no-store" }); return res.end(html); }
      if (ok) { res.writeHead(302, { Location: pending?.next || "/", "Set-Cookie": this.cookie("", 0), "Cache-Control": "no-store" }); return res.end(); }
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Set-Cookie": this.cookie("", 0) }); res.end(body);
    };
    if (!pending) return finish(400, "Connecting Jira failed: the attempt expired or was not started here; try again.", false);
    if (!user || user.id !== pending.uid) return finish(400, "Connecting Jira failed: a different person started this; sign in and try again.", false);
    const err = url.searchParams.get("error");
    if (err) return finish(400, `Atlassian did not grant access: ${err}${url.searchParams.get("error_description") ? ` (${url.searchParams.get("error_description")})` : ""}.`, false);
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (!code || !state || state !== pending.state) return finish(400, "Connecting Jira failed: the state did not match; try again.", false);
    try {
      const tok = await this.exchange({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
      const r = await this.f(`${this.apiBase}/oauth/token/accessible-resources`, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" } });
      if (!r.ok) throw new Error(`Atlassian did not list your sites (${r.status}).`);
      const all = (await r.json()) as { id: string; url: string; name: string; scopes?: string[] }[];
      const sites: AtlassianSite[] = all.filter((s) => !s.scopes || s.scopes.some((sc) => /jira/.test(sc))).map((s) => ({ id: s.id, url: s.url, name: s.name }));
      if (!sites.length) throw new Error("This Atlassian account has no Jira site the app may read.");
      const c: AtlassianConnection = { cloud_id: sites[0].id, site_url: sites[0].url, site_name: sites[0].name, sites, access_token: tok.access_token, refresh_token: tok.refresh_token ?? null, expires_at: Date.now() + tok.expires_in * 1000, scope: tok.scope ?? this.scopes.join(" "), user_name: null, connected_at: new Date().toISOString() };
      this.save(user, c);
      const saved = await this.withDisplayName(user);
      this.log(`atlassian: ${user.name} connected ${saved.site_url}${saved.user_name ? ` as ${saved.user_name}` : ""}${sites.length > 1 ? ` (${sites.length} sites)` : ""}`);
      return finish(200, `Jira connected: ${c.site_url.replace(/^https?:\/\//, "")}. You can close this window.`, true);
    } catch (e) {
      return finish(502, `Connecting Jira failed: ${(e as Error).message}`, false);
    }
  }
}

function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)); }
