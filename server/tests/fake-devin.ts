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

export interface FakeDevinSession { id: string; prompt: string; title: string | null; max_acu_limit: number | null; polls: number; attachments: { name: string; text: string }[]; messages: string[]; api: "v1" | "v3"; output_schema: unknown; devin_mode: string | null }
const ORG = "org-fake";
export interface FakeDevinOptions {
  apiKey?: string;
  workingPolls?: number;
  answer?: (session: FakeDevinSession) => unknown;
  /** Instead of an answer: end the session with this status_enum and no structured output. */
  endWith?: "expired" | "blocked" | "finished";
}
export interface FakeDevin { url: string; sessions: FakeDevinSession[]; uploads: { name: string; text: string; url: string }[]; calls: string[]; close(): Promise<void> }

export async function startFakeDevin(opts: FakeDevinOptions = {}): Promise<FakeDevin> {
  const apiKey = opts.apiKey ?? "cog_test";
  const workingPolls = opts.workingPolls ?? 2;
  const sessions: FakeDevinSession[] = [];
  const uploads: { name: string; text: string; url: string }[] = [];
  const calls: string[] = [];
  let base = "";
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const saveUpload = async (req: import("node:http").IncomingMessage) => {
    const webReq = new Request("http://x/", { method: "POST", headers: req.headers as Record<string, string>, body: Readable.toWeb(req) as any, duplex: "half" } as any);
    const form = await webReq.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return null;
    const name = (file as File).name ?? "file";
    const text = Buffer.from(await file.arrayBuffer()).toString("utf8");
    const u = { name, text, url: `${base}/files/${uploads.length + 1}/${encodeURIComponent(name)}` };
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
      res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(u.text);
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(res, 403, { detail: "Unauthorized" });
    try {
      // ---- v3 (organisation-scoped) ----
      if (p === "/v3/self" && req.method === "GET") return json(res, 200, { principal_type: "service_user", user_name: "Readiness Review bot", org_id: ORG, devin_sessions_org_id: ORG });
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
        const attachments = (Array.isArray(b.attachment_urls) ? b.attachment_urls : []).map((url: string) => uploads.find((u) => u.url === url)).filter((u: any): u is typeof uploads[number] => !!u).map((u: any) => ({ name: u.name, text: u.text }));
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
        const out = opts.answer ? opts.answer(s) : null;
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
        const attachments = [...b.prompt.matchAll(/ATTACHMENT:"([^"]+)"/g)].map((m) => uploads.find((u) => u.url === m[1])).filter((u): u is typeof uploads[number] => !!u).map((u) => ({ name: u.name, text: u.text }));
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
        const out = opts.answer ? opts.answer(s) : null;
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

/** A reasonable stand-in for Devin's reading of a markdown POR: every "will have … by …" sentence becomes an item. */
export function naiveReader(session: FakeDevinSession): unknown {
  const items: unknown[] = [];
  const files_read: unknown[] = [];
  for (const a of session.attachments) {
    files_read.push({ name: a.name, how: "text" });
    let section = "";
    for (const raw of a.text.split(/\r?\n/)) {
      const line = raw.trim();
      const h = line.match(/^##\s+(\d+)\./);
      if (h) { section = `§${h[1]}`; continue; }
      const m = line.match(/^-\s+(.+?)\s+will have (.+?) by (\w+ \d+)\.$/);
      if (m) items.push({ text: m[2][0].toUpperCase() + m[2].slice(1), kind: /review|approv/i.test(m[2]) ? "approval" : /quota|capacity/i.test(m[2]) ? "dependency" : "deliverable", owner_team: m[1].replace(/\s*\(.*\)\s*$/, ""), due_text: `by ${m[3]}`, source: { file: a.name, locator: section, quote: line.replace(/^-\s+/, "") } });
    }
  }
  return { done: true, items, signals: [], files_read, unreadable: [] };
}
