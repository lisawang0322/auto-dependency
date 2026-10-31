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
 * Devin's External API is marked alpha by Devin; the surface used here is v1:
 *   POST /v1/attachments (multipart, returns a URL), POST /v1/sessions, GET /v1/sessions/{id},
 *   POST /v1/sessions/{id}/message. Attachments are referenced in the prompt as ATTACHMENT:"<url>".
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

export interface DevinOptions {
  apiKey: string;
  baseUrl?: string;
  /** Cap per reading session, in ACUs. */
  maxAcu?: number;
  /** Give up waiting for the session after this long. */
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DevinSession { session_id: string; url: string }
export interface DevinSessionState { status: string; status_enum: string | null; structured_output: unknown; url?: string }

export class DevinError extends Error {}

/** A thin client for the four v1 calls. */
export class DevinClient {
  readonly baseUrl: string;
  readonly maxAcu: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  private readonly f: typeof fetch;
  constructor(private readonly opts: DevinOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.devin.ai").replace(/\/+$/, "");
    this.maxAcu = opts.maxAcu ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.pollMs = opts.pollMs ?? 5_000;
    this.f = opts.fetchImpl ?? fetch;
  }
  private headers(extra: Record<string, string> = {}) { return { Authorization: `Bearer ${this.opts.apiKey}`, ...extra }; }
  private async check(res: Response, what: string): Promise<Response> {
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new DevinError(`Devin rejected the service key (${res.status}) on ${what}.`);
    throw new DevinError(`Devin ${what} failed: ${res.status} ${text.slice(0, 200)}`.trim());
  }
  async uploadAttachment(name: string, data: Buffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), name);
    const res = await this.check(await this.f(`${this.baseUrl}/v1/attachments`, { method: "POST", headers: this.headers(), body: form }), "attachment upload");
    const url = (await res.text()).trim().replace(/^"|"$/g, "");
    if (!/^https?:\/\//.test(url)) throw new DevinError(`Devin attachment upload returned no URL for ${name}.`);
    return url;
  }
  async createSession(body: { prompt: string; title?: string; tags?: string[]; unlisted?: boolean }): Promise<DevinSession> {
    const res = await this.check(await this.f(`${this.baseUrl}/v1/sessions`, {
      method: "POST", headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ...body, max_acu_limit: this.maxAcu }),
    }), "session create");
    const data = await res.json();
    if (!data?.session_id) throw new DevinError("Devin session create returned no session_id.");
    return { session_id: String(data.session_id), url: String(data.url ?? "") };
  }
  async getSession(id: string): Promise<DevinSessionState> {
    const res = await this.check(await this.f(`${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}`, { headers: this.headers() }), "session read");
    const data = await res.json();
    return { status: String(data?.status ?? ""), status_enum: data?.status_enum ?? null, structured_output: data?.structured_output ?? null, url: data?.url };
  }
  async sendMessage(id: string, message: string): Promise<void> {
    await this.check(await this.f(`${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}/message`, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ message }) }), "session message");
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
    ...req.files.map((f) => `- ${f.name}: ATTACHMENT:"${f.url}"`),
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
    `Result. Set the session's structured output to exactly this JSON object and nothing else; it is the only thing I read:`,
    `{"done": true,`,
    ` "items": [{"text": "<short label>", "kind": "deliverable|dependency|approval|checklist", "owner_team": "<team or null>", "due_text": "<the document's words or null>", "source": {"file": "<file name exactly as above>", "locator": "<§4 | slide 9 | slide 9 (notes) | page 3>", "quote": "<one sentence or row, verbatim>"}}],`,
    early ? ` "signals": [{"quote": "<sentence, verbatim>", "file": "<file name>", "locator": "<§3 Data | slide 4>", "rule_ids": ["<rule id>"]}],` : ` "signals": [],`,
    ` "files_read": [{"name": "<file name>", "how": "<e.g. python-pptx, text, converted with soffice>"}],`,
    ` "unreadable": [{"name": "<file name>", "reason": "<why>"}]}`,
    `Update the structured output as soon as it is complete, then finish the session.`,
  );
  return lines.join("\n");
}

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
  error: string | null;
}

const TERMINAL = new Set(["finished", "expired", "blocked"]);

/** Upload the files, run one Devin session, wait for its structured output. Never throws: a failure is an outcome with status "failed". */
export async function readWithDevin(client: DevinClient, req: { paths: string[]; stage: ReadingRequest["stage"]; rules: string; signalRules?: string; user?: string | null; onLog?: (line: string) => void }): Promise<ReadingOutcome> {
  const log = req.onLog ?? (() => {});
  const names = req.paths.map((p) => basename(p));
  const fail = (error: string, session: DevinSession | null = null): ReadingOutcome => ({ status: "failed", error, session_url: session?.url ?? null, session_id: session?.session_id ?? null, items: [], signals: [], files_read: [], unreadable: [], warnings: [] });
  let session: DevinSession | null = null;
  try {
    const files: { name: string; url: string }[] = [];
    for (const p of req.paths) { files.push({ name: basename(p), url: await client.uploadAttachment(basename(p), readFileSync(p)) }); log(`uploaded ${basename(p)}`); }
    const prompt = readingPrompt({ files, stage: req.stage, rules: req.rules, signalRules: req.signalRules, user: req.user });
    session = await client.createSession({ prompt, title: `Readiness Review: read ${names.join(", ")}${req.user ? ` for ${req.user}` : ""}`, tags: ["readiness-review"], unlisted: true });
    log(`Devin session ${session.session_id} ${session.url}`);
    const deadline = Date.now() + client.timeoutMs;
    for (;;) {
      const st = await client.getSession(session.session_id);
      const output = st.structured_output;
      const ready = !!output && typeof output === "object" && ((output as any).done === true || Array.isArray((output as any).items) && (st.status_enum ? TERMINAL.has(st.status_enum) : false));
      if (ready) {
        const parsed = parseReading(output, names);
        log(`Devin read ${parsed.items.length} items, ${parsed.signals.length} signals (${parsed.files_read.map((f) => f.name).join(", ") || "no files listed"})`);
        return { ...parsed, status: "done", error: null, session_url: session.url || st.url || null, session_id: session.session_id };
      }
      if (st.status_enum && TERMINAL.has(st.status_enum)) {
        return fail(st.status_enum === "blocked" ? `Devin stopped and is waiting for input at ${session.url}; no result was written.` : `Devin session ${st.status_enum} without a result.`, session);
      }
      if (Date.now() > deadline) return fail(`Devin did not finish within ${Math.round(client.timeoutMs / 60_000)} minutes (${session.url}).`, session);
      await new Promise((r) => setTimeout(r, client.pollMs));
    }
  } catch (e) {
    return fail(e instanceof DevinError ? e.message : `Could not reach Devin: ${(e as Error).message ?? e}`, session);
  }
}

/** Options from the environment: DEVIN_API_KEY (required to enable), DEVIN_API_BASE, DEVIN_MAX_ACU, DEVIN_READ_TIMEOUT_MIN. */
export function devinFromEnv(env = process.env): DevinOptions | null {
  if (!env.DEVIN_API_KEY) return null;
  return {
    apiKey: env.DEVIN_API_KEY, baseUrl: env.DEVIN_API_BASE,
    maxAcu: env.DEVIN_MAX_ACU ? Number(env.DEVIN_MAX_ACU) : undefined,
    timeoutMs: env.DEVIN_READ_TIMEOUT_MIN ? Number(env.DEVIN_READ_TIMEOUT_MIN) * 60_000 : undefined,
  };
}
