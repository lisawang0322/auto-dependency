/**
 * Sign-in with the company identity provider: OpenID Connect, authorization code flow with PKCE, no
 * library. Works with Microsoft Entra ID (tenant-specific issuer), Google, Okta and any conforming provider.
 *
 *   AUTH=none (default when no OIDC_* is set): one local user, for the demo, the CLI-adjacent server and tests.
 *   OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0  OIDC_CLIENT_ID=…  OIDC_CLIENT_SECRET=…
 *   APP_URL=http://localhost:8787 (where the browser reaches this server; the redirect URI is APP_URL + /auth/callback)
 *   SESSION_SECRET=<long random string>  (signs the short-lived login cookie; generated if absent, which logs out everyone on restart)
 *   ALLOWED_EMAIL_DOMAINS=example.com,example.org  (optional)
 *
 * Routes (mounted by server/index.ts): GET /auth/login?next=/…  GET /auth/callback  POST /auth/logout  GET /api/me
 */
import { createHmac, createPublicKey, createHash, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store, User } from "./store.js";

export interface OidcConfig { issuer: string; clientId: string; clientSecret: string; appUrl: string; sessionSecret?: string; allowedEmailDomains?: string[]; sessionTtlMs?: number; fetchImpl?: typeof fetch }
export type AuthConfig = { mode: "none" } | ({ mode: "oidc" } & OidcConfig);

export const LOCAL_USER: User = { id: "local", issuer: "local", sub: "local", email: null, name: "You", org: "local", created_at: "", last_seen: "" };

export function authFromEnv(env = process.env): AuthConfig {
  if (!env.OIDC_ISSUER) return { mode: "none" };
  if (!env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) throw new Error("OIDC_ISSUER is set but OIDC_CLIENT_ID or OIDC_CLIENT_SECRET is missing.");
  return {
    mode: "oidc", issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
    appUrl: (env.APP_URL ?? `http://localhost:${env.PORT ?? 8787}`).replace(/\/+$/, ""), sessionSecret: env.SESSION_SECRET,
    allowedEmailDomains: env.ALLOWED_EMAIL_DOMAINS ? env.ALLOWED_EMAIL_DOMAINS.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) : undefined,
  };
}

export class AuthError extends Error { constructor(public status: number, msg: string) { super(msg); } }

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string }
interface Jwk { kid?: string; kty: string; n?: string; e?: string; x?: string; y?: string; crv?: string; alg?: string; use?: string }

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const SESSION_COOKIE = "rrr_session";
const LOGIN_COOKIE = "rrr_login";

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  readonly mode: AuthConfig["mode"];
  private readonly cfg: OidcConfig | null;
  private readonly secret: Buffer;
  private readonly f: typeof fetch;
  private discovery: Discovery | null = null;
  private jwks: Jwk[] = [];
  private readonly ttl: number;
  readonly secure: boolean;

  constructor(config: AuthConfig, private readonly store: Store, log: (s: string) => void = () => {}) {
    this.mode = config.mode;
    this.cfg = config.mode === "oidc" ? config : null;
    this.f = this.cfg?.fetchImpl ?? fetch;
    this.ttl = this.cfg?.sessionTtlMs ?? 7 * 24 * 3600_000;
    this.secure = !!this.cfg && this.cfg.appUrl.startsWith("https://");
    if (this.cfg && !this.cfg.sessionSecret) log("auth: SESSION_SECRET not set; a random one is used, so a restart logs everyone out");
    this.secret = this.cfg?.sessionSecret ? createHash("sha256").update(this.cfg.sessionSecret).digest() : randomBytes(32);
  }

  /** The OIDC registration (client, app URL), for connectors that ask the same provider for more (the directory); null without sign-in. */
  oidc(): { clientId: string; clientSecret: string; appUrl: string; issuer: string } | null {
    return this.cfg ? { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, appUrl: this.cfg.appUrl, issuer: this.cfg.issuer } : null;
  }
  /** The provider's endpoints (discovery document), for the same connectors. */
  async endpoints(): Promise<{ authorization_endpoint: string; token_endpoint: string }> { return this.discover(); }

  /** Who is making this request: the local user without sign-in, the session's user, or null. */
  userOf(req: IncomingMessage): User | null {
    if (this.mode === "none") return LOCAL_USER;
    const sid = parseCookies(req)[SESSION_COOKIE];
    return sid ? this.store.sessionUser(sid) : null;
  }

  /** What the GUI shows: the mode, the user, and where to sign in. */
  me(req: IncomingMessage) {
    const u = this.userOf(req);
    return { mode: this.mode, user: u ? { id: u.id, name: u.name, email: u.email, org: u.org } : null, login_url: this.mode === "oidc" ? "/auth/login" : null };
  }

  /** Handle /auth/* ; returns false when the path is not an auth route. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === "/auth/login" && req.method === "GET") { await this.login(req, res, url); return true; }
    if (p === "/auth/callback" && req.method === "GET") { await this.callback(req, res, url); return true; }
    if (p === "/auth/logout" && req.method === "POST") { this.logout(req, res); return true; }
    return false;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const cfg = this.cfg!;
    const url = `${cfg.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const res = await this.f(url);
    if (!res.ok) {
      // Say what the provider said: Entra's AADSTS90002 "tenant not found", for one, names a mistyped OIDC_ISSUER at once.
      let detail = "";
      try { const body = await res.json(); detail = String(body?.error_description ?? body?.error ?? "").split(" Trace ID")[0]; } catch { /* not JSON */ }
      throw new AuthError(502, `The identity provider's discovery document could not be read (${res.status} from ${url})${detail ? `: ${detail}` : ""}. Check OIDC_ISSUER; for Entra it is https://login.microsoftonline.com/<tenant id>/v2.0.`);
    }
    const d = (await res.json()) as Discovery;
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new AuthError(502, "The identity provider's discovery document is incomplete.");
    this.discovery = d;
    return d;
  }
  private async keys(kid: string | undefined, refresh = false): Promise<Jwk | null> {
    if (refresh || !this.jwks.length) {
      const d = await this.discover();
      const res = await this.f(d.jwks_uri);
      if (!res.ok) throw new AuthError(502, "The identity provider's signing keys could not be read.");
      this.jwks = ((await res.json()) as { keys: Jwk[] }).keys ?? [];
    }
    return this.jwks.find((k) => !kid || k.kid === kid) ?? null;
  }

  // ---- the short-lived login cookie: state, nonce and PKCE verifier, signed ----
  private sign(payload: string): string { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
  private sealLogin(data: Record<string, string>): string { const body = b64url(JSON.stringify(data)); return `${body}.${this.sign(body)}`; }
  private openLogin(value: string | undefined): Record<string, string> | null {
    if (!value) return null;
    const [body, sig] = value.split(".");
    if (!body || !sig) return null;
    const expect = this.sign(body);
    if (expect.length !== sig.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
    try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  }
  private cookie(name: string, value: string, maxAgeSec: number): string {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${this.secure ? "; Secure" : ""}`;
  }

  private async login(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!this.cfg) { res.writeHead(404); return res.end("Sign-in is off (AUTH=none)."); }
    const d = await this.discover();
    const next = url.searchParams.get("next") ?? "/";
    const state = randomBytes(16).toString("base64url"), nonce = randomBytes(16).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: `${this.cfg.appUrl}/auth/callback`, scope: "openid profile email",
      state, nonce, code_challenge: challenge, code_challenge_method: "S256",
    });
    res.writeHead(302, { Location: `${d.authorization_endpoint}${d.authorization_endpoint.includes("?") ? "&" : "?"}${q}`, "Set-Cookie": this.cookie(LOGIN_COOKIE, this.sealLogin({ state, nonce, verifier, next: safeNext(next) }), 600), "Cache-Control": "no-store" });
    res.end();
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!this.cfg) { res.writeHead(404); return res.end(); }
    const fail = (status: number, msg: string) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Set-Cookie": this.cookie(LOGIN_COOKIE, "", 0) }); res.end(`Sign-in failed: ${msg}`); };
    const login = this.openLogin(parseCookies(req)[LOGIN_COOKIE]);
    if (!login) return fail(400, "the sign-in attempt expired or was not started here; try again.");
    const err = url.searchParams.get("error");
    if (err) return fail(400, `${err}: ${url.searchParams.get("error_description") ?? ""}`.trim());
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (!code || !state || state !== login.state) return fail(400, "the state did not match; try again.");
    let claims: Record<string, any>;
    try {
      const d = await this.discover();
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${this.cfg.appUrl}/auth/callback`, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code_verifier: login.verifier });
      const tok = await this.f(d.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
      if (!tok.ok) return fail(502, `the identity provider rejected the code (${tok.status}).`);
      const data = (await tok.json()) as { id_token?: string };
      if (!data.id_token) return fail(502, "no id_token came back.");
      claims = await this.verifyIdToken(data.id_token, login.nonce);
    } catch (e) {
      return fail(e instanceof AuthError ? e.status : 502, (e as Error).message);
    }
    // v2 tokens carry email / preferred_username; Entra v1 tokens (an issuer without /v2.0) carry upn / unique_name instead.
    const email = (claims.email ?? claims.preferred_username ?? claims.upn ?? claims.unique_name ?? null) as string | null;
    if (this.cfg.allowedEmailDomains?.length) {
      const domain = email?.split("@")[1]?.toLowerCase();
      if (!domain || !this.cfg.allowedEmailDomains.includes(domain)) return fail(403, `${email ?? "this account"} is not in an allowed domain.`);
    }
    const user = this.store.upsertUser({ issuer: String(claims.iss), sub: String(claims.sub), email, name: String(claims.name ?? email ?? claims.sub), org: String(claims.tid ?? claims.hd ?? claims.org ?? new URL(String(claims.iss)).hostname) });
    const session = this.store.createSession(user.id, this.ttl);
    res.writeHead(302, { Location: login.next || "/", "Set-Cookie": [this.cookie(SESSION_COOKIE, session.id, Math.floor(this.ttl / 1000)), this.cookie(LOGIN_COOKIE, "", 0)], "Cache-Control": "no-store" });
    res.end();
  }

  private logout(req: IncomingMessage, res: ServerResponse) {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) this.store.deleteSession(sid);
    res.writeHead(204, { "Set-Cookie": this.cookie(SESSION_COOKIE, "", 0), "Cache-Control": "no-store" });
    res.end();
  }

  /** RS256/ES256 signature against the provider's JWKS, then iss, aud, exp and nonce. */
  async verifyIdToken(jwt: string, nonce: string): Promise<Record<string, any>> {
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) throw new AuthError(502, "the id_token is malformed.");
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, any>;
    let jwk = await this.keys(header.kid);
    if (!jwk) jwk = await this.keys(header.kid, true);
    if (!jwk) throw new AuthError(502, "the id_token was signed with a key the provider does not publish.");
    const key: KeyObject = createPublicKey({ key: jwk as any, format: "jwk" });
    const ok = header.alg === "RS256" ? cryptoVerify("sha256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))
      : header.alg === "ES256" ? cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))
      : false;
    if (!ok) throw new AuthError(502, `the id_token signature did not verify (${header.alg}).`);
    const d = await this.discover();
    const issOk = claims.iss === d.issuer || claims.iss === this.cfg!.issuer || (d.issuer.includes("{tenantid}") && typeof claims.iss === "string" && claims.iss.startsWith("https://login.microsoftonline.com/"));
    if (!issOk) throw new AuthError(502, "the id_token came from a different issuer.");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg!.clientId)) throw new AuthError(502, "the id_token was not issued for this app.");
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw new AuthError(502, "the id_token has expired.");
    if (claims.nonce !== nonce) throw new AuthError(502, "the id_token nonce did not match.");
    if (!claims.sub) throw new AuthError(502, "the id_token has no subject.");
    return claims;
  }
}

/** Only same-origin paths may be the post-login destination. */
export function safeNext(next: string): string {
  return /^\/(?!\/)[^\s]*$/.test(next) ? next : "/";
}
