/**
 * Test helper: a minimal OpenID Connect provider (discovery, authorize, token, jwks) that approves every
 * sign-in at once as a fixed user, so the sign-in flow can run end to end without a real tenant.
 */
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from "node:crypto";

export interface FakeIdpOptions { clientId?: string; clientSecret?: string; user?: { sub: string; email: string; name: string; tid?: string }; /** The directory the Graph look-alike serves (GET /graph/users). */ directory?: FakeGraphUser[] }
export interface FakeGraphUser { displayName: string; jobTitle?: string; department?: string; manager?: string; accountEnabled?: boolean }
export interface FakeIdp { url: string; issuer: string; /** Microsoft Graph look-alike: {graph}/users with $select, $expand=manager and paging. */ graph: string; calls: string[]; scopes: string[]; user: Required<FakeIdpOptions>["user"]; close(): Promise<void>; /** Sign a token by hand (for negative tests). */ token(claims: Record<string, unknown>, kid?: string): string }

/** A small company: departments that match the sample plan's teams, with titles and managers. */
export const FAKE_DIRECTORY: FakeGraphUser[] = [
  { displayName: "Priya Natarajan", jobTitle: "TPM", department: "Ingestion team", manager: "Dana Okafor" },
  { displayName: "Marcus Lee", jobTitle: "eng lead", department: "Ingestion team", manager: "Dana Okafor" },
  { displayName: "Dana Okafor", jobTitle: "product", department: "Product" },
  { displayName: "Wei Zhang", jobTitle: "eng lead", department: "Data Platform", manager: "Anika Rao" },
  { displayName: "Tomás Herrera", jobTitle: "DBA", department: "Data Platform", manager: "Anika Rao" },
  { displayName: "Anika Rao", jobTitle: "director, platform", department: "Platform leadership" },
  { displayName: "Jordan Blake", jobTitle: "security lead", department: "Security", manager: "Anika Rao" },
  { displayName: "Fatima Noor", jobTitle: "reviewer", department: "Security", manager: "Jordan Blake" },
  { displayName: "Sam Ortiz", jobTitle: "SRE", department: "SRE", manager: "Anika Rao" },
  { displayName: "Old Account", jobTitle: "left", department: "SRE", accountEnabled: false },
];

export async function startFakeIdp(opts: FakeIdpOptions = {}): Promise<FakeIdp> {
  const clientId = opts.clientId ?? "app-client-id", clientSecret = opts.clientSecret ?? "app-secret";
  const user = opts.user ?? { sub: "sub-123", email: "lisa@example.com", name: "Lisa Wang", tid: "tenant-abc" };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const kid = "k1";
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  const calls: string[] = [];
  const scopes: string[] = [];
  const directory = opts.directory ?? FAKE_DIRECTORY;
  let issuer = "";
  const tokens = new Set<string>();
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (claims: Record<string, unknown>, k: string = kid) => {
    const h = b64({ alg: "RS256", typ: "JWT", kid: k }), p = b64(claims);
    const sig = cryptoSign("sha256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url");
    return `${h}.${p}.${sig}`;
  };
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const p = url.pathname;
    calls.push(`${req.method} ${p}`);
    if (p === "/.well-known/openid-configuration") return json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, end_session_endpoint: `${issuer}/logout` });
    if (p === "/keys") return json(res, 200, { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
    if (p === "/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
      const code = randomBytes(8).toString("hex");
      scopes.push(q.get("scope") ?? "");
      codes.set(code, { nonce: q.get("nonce") ?? "", challenge: q.get("code_challenge") ?? "", redirect: q.get("redirect_uri") ?? "" });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code); back.searchParams.set("state", q.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (p === "/token" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const f = new URLSearchParams(body);
      const c = codes.get(f.get("code") ?? "");
      if (!c || f.get("grant_type") !== "authorization_code" || f.get("client_id") !== clientId || f.get("client_secret") !== clientSecret) return json(res, 400, { error: "invalid_grant" });
      if (createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verifier mismatch" });
      if (f.get("redirect_uri") !== c.redirect) return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      codes.delete(f.get("code")!);
      const now = Math.floor(Date.now() / 1000);
      const id_token = token({ iss: issuer, aud: clientId, sub: user.sub, email: user.email, name: user.name, tid: user.tid, nonce: c.nonce, iat: now, exp: now + 3600 });
      const access_token = "at-" + randomBytes(4).toString("hex");
      tokens.add(access_token);
      return json(res, 200, { access_token, token_type: "Bearer", expires_in: 3600, id_token });
    }
    // ---- Microsoft Graph look-alike: GET /graph/users?$select=…&$expand=manager(…)&$top=N[&$skiptoken=K] ----
    if (p === "/graph/users" && req.method === "GET") {
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokens.has(bearer)) return json(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token is empty or not one this provider issued." } });
      const top = Math.max(1, Math.min(999, Number(url.searchParams.get("$top") ?? 100)));
      const skip = Number(url.searchParams.get("$skiptoken") ?? 0);
      const expandManager = /manager/.test(url.searchParams.get("$expand") ?? "");
      const page = directory.slice(skip, skip + top).map((u, i) => ({ id: `u-${skip + i}`, displayName: u.displayName, jobTitle: u.jobTitle ?? null, department: u.department ?? null, accountEnabled: u.accountEnabled ?? true, ...(expandManager && u.manager ? { manager: { displayName: u.manager } } : {}) }));
      const body: Record<string, unknown> = { value: page };
      if (skip + top < directory.length) body["@odata.nextLink"] = `${issuer}/graph/users?$top=${top}&$skiptoken=${skip + top}${expandManager ? "&$expand=manager" : ""}`;
      return json(res, 200, body);
    }
    json(res, 404, { error: `no route ${req.method} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  issuer = `http://127.0.0.1:${addr.port}`;
  return { url: issuer, issuer, graph: `${issuer}/graph`, calls, scopes, user, token, close: () => new Promise((r) => server.close(() => r())) };
}
