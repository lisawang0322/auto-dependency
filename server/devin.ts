/**
 * Devin as the reader behind the GUI's upload step (PRD "How it works", Oct 31 direction).
 *
 * The person uploads plan files in the GUI; this module hands them to a Devin session, with the same
 * reading instructions the release-review skill gives an agent, and waits for the items Devin wrote as the
 * session's structured output. The items then go through Stage A's quote check like any agent items.
 *
 * Billing is the Devin account's (ACUs), capped per session with max_acu_limit. The key is a company
 * service-user key held by the server (DEVIN_API_KEY); the browser never sees it.
 *
 * Two API generations, chosen by the key's prefix:
 *   cog_… (service-user keys and personal access tokens) → v3, organisation-scoped: GET /v3/self for the org id,
 *     POST /v3/organizations/{org}/attachments (JSON {url}), POST /v3/organizations/{org}/sessions with
 *     attachment_urls and a structured_output_schema Devin enforces, GET …/sessions/{id} (status new|claimed|
 *     running|exit|error|suspended|resuming, structured_output).
 *   apk_… (legacy keys) → v1: POST /v1/attachments (plain-text URL), POST /v1/sessions with ATTACHMENT:"<url>"
 *     in the prompt, GET /v1/sessions/{id} (status_enum working|blocked|finished|expired…).
 */
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PlanItemKind } from "@rrr/schemas";
import type { AgentItem } from "../skills/release-reader/scripts/lib/plan-extract.js";
import type { AgentSignal } from "../skills/release-starter/scripts/lib/signals.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Devin's agent tiers (v3 devin_mode). The company can narrow the list with DEVIN_MODES and pick a default with DEVIN_MODE. */
export const DEVIN_MODES = ["lite", "normal", "fast", "fusion", "ultra", "swe-2-medium", "swe-2-high", "swe-2-max"] as const;
export type DevinMode = (typeof DEVIN_MODES)[number];

export interface DevinOptions {
  apiKey: string;
  baseUrl?: string;
  /** v3 only; found through GET /v3/self when not given. */
  orgId?: string;
  /** The tier used when the person has not chosen one; Devin's organisation default when unset. */
  defaultMode?: DevinMode | null;
  /** The tiers people may choose from (default: all). */
  modes?: DevinMode[];
  /** Cap per reading session, in ACUs. */
  maxAcu?: number;
  /** Give up waiting for the session after this long. */
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DevinSession { session_id: string; url: string }
/** One shape for both generations: where the session is, and the output if any. */
export interface DevinSessionState { phase: "working" | "waiting" | "done" | "failed"; detail: string; structured_output: unknown; url?: string }
export type DevinApi = "v1" | "v3";

export class DevinError extends Error {}

/** A thin client for the four v1 calls. */
export class DevinClient {
  readonly baseUrl: string;
  readonly maxAcu: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly api: DevinApi;
  readonly defaultMode: DevinMode | null;
  readonly modes: DevinMode[];
  private orgId: string | null;
  private readonly f: typeof fetch;
  constructor(private readonly opts: DevinOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.devin.ai").replace(/\/+$/, "");
    this.maxAcu = opts.maxAcu ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.pollMs = opts.pollMs ?? 5_000;
    this.api = opts.apiKey.startsWith("cog_") ? "v3" : "v1";
    this.orgId = opts.orgId ?? null;
    this.modes = opts.modes?.length ? opts.modes : [...DEVIN_MODES];
    this.defaultMode = opts.defaultMode && this.modes.includes(opts.defaultMode) ? opts.defaultMode : null;
    this.f = opts.fetchImpl ?? fetch;
  }
  /** The organisation the key's sessions belong to (v3), from GET /v3/self. */
  async org(): Promise<string> {
    if (this.orgId) return this.orgId;
    const res = await this.check(await this.f(`${this.baseUrl}/v3/self`, { headers: this.headers() }), "self");
    const me = await res.json();
    const org = me?.devin_sessions_org_id ?? me?.org_id;
    if (!org) throw new DevinError("Devin did not say which organisation this key belongs to; set DEVIN_ORG_ID.");
    this.orgId = String(org);
    return this.orgId;
  }
  /** Who the key is, for the health line (v3); null on v1. */
  async whoami(): Promise<{ user_name: string | null; org_id: string | null } | null> {
    if (this.api !== "v3") return null;
    try { const res = await this.f(`${this.baseUrl}/v3/self`, { headers: this.headers() }); if (!res.ok) return null; const me = await res.json(); return { user_name: me?.user_name ?? null, org_id: me?.devin_sessions_org_id ?? me?.org_id ?? null }; } catch { return null; }
  }
  private headers(extra: Record<string, string> = {}) { return { Authorization: `Bearer ${this.opts.apiKey}`, ...extra }; }
  private async check(res: Response, what: string): Promise<Response> {
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let detail = "";
    try { const j = JSON.parse(text); detail = String(j?.detail ?? j?.title ?? j?.error ?? ""); } catch { detail = text.slice(0, 200); }
    if (res.status === 401 || res.status === 403) throw new DevinError(`Devin refused the key on ${what} (${res.status}${detail ? `: ${detail}` : ""}).`);
    throw new DevinError(`Devin ${what} failed: ${res.status}${detail ? ` ${detail}` : ""}`.trim());
  }
  async uploadAttachment(name: string, data: Buffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), name);
    const path = this.api === "v3" ? `/v3/organizations/${encodeURIComponent(await this.org())}/attachments` : "/v1/attachments";
    const res = await this.check(await this.f(`${this.baseUrl}${path}`, { method: "POST", headers: this.headers(), body: form }), "attachment upload");
    const url = this.api === "v3" ? String((await res.json())?.url ?? "") : (await res.text()).trim().replace(/^"|"$/g, "");
    if (!/^https?:\/\//.test(url)) throw new DevinError(`Devin attachment upload returned no URL for ${name}.`);
    return url;
  }
  /** v3 passes the attachments and an output schema as fields; v1 only has the prompt. */
  async createSession(body: { prompt: string; title?: string; tags?: string[]; attachmentUrls?: string[]; outputSchema?: object; createAsUserId?: string | null; mode?: DevinMode | null }): Promise<DevinSession> {
    const path = this.api === "v3" ? `/v3/organizations/${encodeURIComponent(await this.org())}/sessions` : "/v1/sessions";
    const mode = body.mode ?? this.defaultMode;
    const payload = this.api === "v3"
      ? { prompt: body.prompt, title: body.title, tags: body.tags, attachment_urls: body.attachmentUrls ?? [], max_acu_limit: this.maxAcu, structured_output_schema: body.outputSchema, structured_output_required: !!body.outputSchema, ...(mode ? { devin_mode: mode } : {}), ...(body.createAsUserId ? { create_as_user_id: body.createAsUserId } : {}) }
      : { prompt: body.prompt, title: body.title, tags: body.tags, unlisted: true, max_acu_limit: this.maxAcu };
    const res = await this.check(await this.f(`${this.baseUrl}${path}`, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify(payload) }), "session create");
    const data = await res.json();
    if (!data?.session_id) throw new DevinError("Devin session create returned no session_id.");
    return { session_id: String(data.session_id), url: String(data.url ?? "") };
  }
  async getSession(id: string): Promise<DevinSessionState> {
    const path = this.api === "v3" ? `/v3/organizations/${encodeURIComponent(await this.org())}/sessions/${encodeURIComponent(id)}` : `/v1/sessions/${encodeURIComponent(id)}`;
    const res = await this.check(await this.f(`${this.baseUrl}${path}`, { headers: this.headers() }), "session read");
    const data = await res.json();
    const out = data?.structured_output ?? null;
    if (this.api === "v3") {
      const st = String(data?.status ?? ""), detail = String(data?.status_detail ?? "");
      const phase: DevinSessionState["phase"] = st === "exit" ? "done" : st === "error" ? "failed" : st === "suspended" || /waiting/i.test(detail) ? "waiting" : "working";
      return { phase, detail: detail || st, structured_output: out, url: data?.url };
    }
    const e = String(data?.status_enum ?? "");
    const phase: DevinSessionState["phase"] = e === "finished" ? "done" : e === "expired" ? "failed" : e === "blocked" ? "waiting" : "working";
    return { phase, detail: e || String(data?.status ?? ""), structured_output: out, url: data?.url };
  }
}

// ---------- the reading prompt ----------

const ITEM_RULES_FALLBACK = `A plan item is something a team must deliver, a dependency on another team, an approval or review that must happen, or a readiness check, dated or not. Goals, context, assumptions, the go/no-go meeting itself and things the document says are out of scope are not items.

- kind is deliverable, dependency, approval or checklist.
- owner_team is the team the document names for it, spelled as the document spells it; null when it names none. Never guess a team.
- due_text is the document's own words for the date ("by Nov 14", "the week before launch"); null when it gives none. Never invent or infer a date.
- source.file is the file's name exactly as given; locator is "§4", "slide 9", "slide 9 (notes)" or "page 3"; quote is one sentence or one table row copied word for word. For a deck the quote must be on that slide.
- One item per commitment. If the same commitment appears twice, quote the more specific one.`;

/** The item rules, taken from the release-review skill so the GUI path and the agent path read by the same words. */
export function itemRules(): string {
  const skill = resolve(ROOT, "skills/release-review/SKILL.md");
  if (!existsSync(skill)) return ITEM_RULES_FALLBACK;
  const text = readFileSync(skill, "utf8");
  const start = text.indexOf("A plan item is");
  const end = text.indexOf("Then run Stage A with your items");
  if (start < 0 || end < 0 || end <= start) return ITEM_RULES_FALLBACK;
  return text.slice(start, end).replace(/`/g, "").trim();
}

/** The signal rules' ids and meanings, for the early stages: one line per rule from signals.yaml. */
export function signalRuleLines(rules: { rules: { id: string; teams: { team: string; why: string }[]; approvals?: { name: string }[] }[] }): string {
  return rules.rules.map((r) => `- ${r.id}: implies ${r.teams.map((t) => t.team).join(", ")}${r.approvals?.length ? ` and the approvals ${r.approvals.map((a) => a.name).join(", ")}` : ""} (${r.teams[0]?.why ?? ""})`).join("\n");
}

export interface ReadingRequest {
  files: { name: string; url: string }[];
  /** v1 references attachments inside the prompt; v3 passes them as a field and the prompt just names them. */
  inlineAttachments?: boolean;
  /** "launching" asks for plan items; "starting" / "building" ask for signals as well. */
  stage: "launching" | "starting" | "building";
  rules: string;
  signalRules?: string;
  /** Who asked, for the session title. */
  user?: string | null;
}

export function readingPrompt(req: ReadingRequest): string {
  const early = req.stage !== "launching";
  const lines = [
    `Read the attached plan files and write down what they commit to. Do not write code, open a pull request, commit, or ask me questions: if something is unclear, decide and note it in the output.`,
    ``,
    `Files (open each one with your own tools, in whatever format it is: a .pptx or Google Slides export, a PDF, a Word file, a Keynote or Pages export, a spreadsheet, markdown; read every slide with its speaker notes and tables, every section of a doc; if you cannot open a format directly, convert it and say how in files_read):`,
    ...req.files.map((f) => (req.inlineAttachments === false ? `- ${f.name} (attached)` : `- ${f.name}: ATTACHMENT:"${f.url}"`)),
    ``,
    `What to extract. ${early ? "Plan items and signals." : "Plan items."}`,
    ``,
    req.rules,
    ``,
  ];
  if (early) {
    lines.push(
      `A signal is one sentence of the PRD that is an instance of one of these rules (the rule, not you, decides which teams it implies). Quote the sentence word for word, name the file, give a locator, and list the rule ids it is an instance of. Sentences that say what is not in scope, or describe something that already exists, are not signals.`,
      req.signalRules ?? "",
      ``,
    );
  }
  lines.push(
    `Result. Provide this JSON object as the session's structured output (nothing else is read):`,
    `{"done": true,`,
    ` "items": [{"text": "<short label>", "kind": "deliverable|dependency|approval|checklist", "owner_team": "<team or null>", "due_text": "<the document's words or null>", "source": {"file": "<file name exactly as above>", "locator": "<§4 | slide 9 | slide 9 (notes) | page 3>", "quote": "<one sentence or row, verbatim>"}}],`,
    early ? ` "signals": [{"quote": "<sentence, verbatim>", "file": "<file name>", "locator": "<§3 Data | slide 4>", "rule_ids": ["<rule id>"]}],` : ` "signals": [],`,
    ` "files_read": [{"name": "<file name>", "how": "<e.g. python-pptx, text, converted with soffice>"}],`,
    ` "unreadable": [{"name": "<file name>", "reason": "<why>"}]}`,
    `Update the structured output as soon as it is complete, then finish the session.`,
  );
  return lines.join("\n");
}

/** The output shape, as a JSON Schema (draft 7) Devin v3 validates against before the session ends. */
export const OUTPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["done", "items", "files_read"],
  properties: {
    done: { type: "boolean" },
    items: { type: "array", items: { type: "object", required: ["text", "kind", "source"], properties: {
      text: { type: "string" }, kind: { type: "string", enum: ["deliverable", "dependency", "approval", "checklist"] },
      owner_team: { type: ["string", "null"] }, due_text: { type: ["string", "null"] },
      source: { type: "object", required: ["file", "quote"], properties: { file: { type: "string" }, locator: { type: "string" }, quote: { type: "string" } } },
    } } },
    signals: { type: "array", items: { type: "object", required: ["quote", "file", "rule_ids"], properties: { quote: { type: "string" }, file: { type: "string" }, locator: { type: ["string", "null"] }, rule_ids: { type: "array", items: { type: "string" } } } } },
    files_read: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, how: { type: "string" } } } },
    unreadable: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, reason: { type: "string" } } } },
  },
} as const;

// ---------- the result ----------

const ItemOut = z.object({
  text: z.string().min(1),
  kind: PlanItemKind,
  owner_team: z.string().nullable().optional().transform((v) => v ?? null),
  due_text: z.string().nullable().optional().transform((v) => v ?? null),
  source: z.object({ file: z.string().min(1), locator: z.string().optional().transform((v) => v ?? ""), quote: z.string().min(1) }),
});
const SignalOut = z.object({ quote: z.string().min(1), file: z.string().min(1), locator: z.string().nullable().optional(), rule_ids: z.array(z.string()).min(1) });
const FileRead = z.object({ name: z.string(), how: z.string().optional().transform((v) => v ?? "") });
const Unreadable = z.object({ name: z.string(), reason: z.string().optional().transform((v) => v ?? "") });
const Output = z.object({
  done: z.boolean().optional(),
  items: z.array(z.unknown()).optional(),
  signals: z.array(z.unknown()).optional(),
  files_read: z.array(z.unknown()).optional(),
  unreadable: z.array(z.unknown()).optional(),
});

export interface ReadingResult {
  items: AgentItem[];
  signals: AgentSignal[];
  files_read: { name: string; how: string }[];
  unreadable: { name: string; reason: string }[];
  /** Entries Devin wrote that did not match the shape, as warnings. */
  warnings: string[];
}

/** Validate Devin's structured output; bad entries become warnings, not failures. */
export function parseReading(raw: unknown, fileNames: string[]): ReadingResult {
  const out: ReadingResult = { items: [], signals: [], files_read: [], unreadable: [], warnings: [] };
  const parsed = Output.safeParse(raw);
  if (!parsed.success) { out.warnings.push("Devin's result was not in the expected shape; nothing was read from it."); return out; }
  const known = new Set(fileNames);
  for (const [i, it] of (parsed.data.items ?? []).entries()) {
    const r = ItemOut.safeParse(it);
    if (!r.success) { out.warnings.push(`Devin item ${i + 1} was dropped: ${r.error.issues[0]?.message ?? "invalid"}.`); continue; }
    if (!known.has(r.data.source.file)) { out.warnings.push(`Devin item "${r.data.text}" was dropped: it names ${r.data.source.file}, which was not uploaded.`); continue; }
    out.items.push({ text: r.data.text, kind: r.data.kind, owner_team: r.data.owner_team, due_text: r.data.due_text, source: { file: r.data.source.file, locator: r.data.source.locator || "document", quote: r.data.source.quote } });
  }
  for (const [i, sg] of (parsed.data.signals ?? []).entries()) {
    const r = SignalOut.safeParse(sg);
    if (!r.success) { out.warnings.push(`Devin signal ${i + 1} was dropped: ${r.error.issues[0]?.message ?? "invalid"}.`); continue; }
    out.signals.push({ quote: r.data.quote, file: r.data.file, locator: r.data.locator ?? null, rule_ids: r.data.rule_ids });
  }
  for (const fr of parsed.data.files_read ?? []) { const r = FileRead.safeParse(fr); if (r.success) out.files_read.push(r.data); }
  for (const u of parsed.data.unreadable ?? []) { const r = Unreadable.safeParse(u); if (r.success) out.unreadable.push(r.data); }
  return out;
}

export type ReadingStatus = "done" | "failed";

export interface ReadingOutcome extends ReadingResult {
  status: ReadingStatus;
  session_url: string | null;
  session_id: string | null;
  /** The tier the session ran in (v3), or null when Devin's default was used. */
  mode: DevinMode | null;
  error: string | null;
}

/** Upload the files, run one Devin session, wait for its structured output. Never throws: a failure is an outcome with status "failed". */
export async function readWithDevin(client: DevinClient, req: { paths: string[]; stage: ReadingRequest["stage"]; rules: string; signalRules?: string; user?: string | null; mode?: DevinMode | null; onLog?: (line: string) => void }): Promise<ReadingOutcome> {
  const log = req.onLog ?? (() => {});
  const names = req.paths.map((p) => basename(p));
  const mode = client.api === "v3" ? (req.mode ?? client.defaultMode) : null;
  const fail = (error: string, session: DevinSession | null = null): ReadingOutcome => ({ status: "failed", error, session_url: session?.url ?? null, session_id: session?.session_id ?? null, mode, items: [], signals: [], files_read: [], unreadable: [], warnings: [] });
  let session: DevinSession | null = null;
  try {
    const files: { name: string; url: string }[] = [];
    for (const p of req.paths) { files.push({ name: basename(p), url: await client.uploadAttachment(basename(p), readFileSync(p)) }); log(`uploaded ${basename(p)}`); }
    const v3 = client.api === "v3";
    const prompt = readingPrompt({ files, stage: req.stage, rules: req.rules, signalRules: req.signalRules, user: req.user, inlineAttachments: !v3 });
    session = await client.createSession({ prompt, title: `Readiness Review: read ${names.join(", ")}${req.user ? ` for ${req.user}` : ""}`, tags: ["readiness-review"], attachmentUrls: files.map((f) => f.url), outputSchema: v3 ? OUTPUT_SCHEMA : undefined, mode });
    log(`Devin session ${session.session_id} ${session.url}${mode ? ` (${mode})` : ""}`);
    const deadline = Date.now() + client.timeoutMs;
    for (;;) {
      const st = await client.getSession(session.session_id);
      const output = st.structured_output;
      const ready = !!output && typeof output === "object" && ((output as any).done === true || (Array.isArray((output as any).items) && (st.phase === "done" || st.phase === "waiting")));
      if (ready) {
        const parsed = parseReading(output, names);
        log(`Devin read ${parsed.items.length} items, ${parsed.signals.length} signals (${parsed.files_read.map((f) => f.name).join(", ") || "no files listed"})`);
        return { ...parsed, status: "done", error: null, session_url: session.url || st.url || null, session_id: session.session_id, mode };
      }
      if (st.phase === "done" || st.phase === "failed") return fail(`Devin session ended (${st.detail}) without a result.`, session);
      if (st.phase === "waiting") return fail(`Devin stopped and is waiting (${st.detail}) at ${session.url}; no result was written.`, session);
      if (Date.now() > deadline) return fail(`Devin did not finish within ${Math.round(client.timeoutMs / 60_000)} minutes (${session.url}).`, session);
      await new Promise((r) => setTimeout(r, client.pollMs));
    }
  } catch (e) {
    return fail(e instanceof DevinError ? e.message : `Could not reach Devin: ${(e as Error).message ?? e}`, session);
  }
}

/** Options from the environment: DEVIN_API_KEY (required to enable), DEVIN_ORG_ID (v3, optional), DEVIN_API_BASE, DEVIN_MAX_ACU,
 *  DEVIN_READ_TIMEOUT_MIN, DEVIN_MODE (default tier), DEVIN_MODES (comma list of tiers people may pick). Unknown tiers are ignored with a warning. */
export function devinFromEnv(env = process.env, warn: (s: string) => void = (s) => console.error(s)): DevinOptions | null {
  if (!env.DEVIN_API_KEY) return null;
  const isMode = (m: string): m is DevinMode => (DEVIN_MODES as readonly string[]).includes(m);
  const listed = (env.DEVIN_MODES ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  for (const m of listed) if (!isMode(m)) warn(`DEVIN_MODES: "${m}" is not a Devin mode (${DEVIN_MODES.join(", ")}); ignored.`);
  const modes = listed.filter(isMode);
  const def = env.DEVIN_MODE?.trim();
  if (def && !isMode(def)) warn(`DEVIN_MODE: "${def}" is not a Devin mode (${DEVIN_MODES.join(", ")}); ignored.`);
  return {
    apiKey: env.DEVIN_API_KEY, baseUrl: env.DEVIN_API_BASE, orgId: env.DEVIN_ORG_ID,
    defaultMode: def && isMode(def) ? def : null, modes: modes.length ? modes : undefined,
    maxAcu: env.DEVIN_MAX_ACU ? Number(env.DEVIN_MAX_ACU) : undefined,
    timeoutMs: env.DEVIN_READ_TIMEOUT_MIN ? Number(env.DEVIN_READ_TIMEOUT_MIN) * 60_000 : undefined,
  };
}
