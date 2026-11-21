/** Keyword extraction and matching. Same stop list as the reader's scoped search, so a plan item's
 *  search terms and its matching terms are the same words. */

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "on", "at", "to", "by", "with", "is", "are", "be", "as", "from", "into",
  "place", "passed", "done", "ready", "live", "documented", "raised", "reviewed", "approved", "completed", "team", "x", "2x",
]);

/** 2–4 distinctive keywords from a plan item, excluding the owning team's own words. The first is the lead term. */
export function keywordsFor(itemText: string, ownerTeam: string | null, max = 4): string[] {
  const owner = new Set((ownerTeam ?? "").toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
  const words = itemText.toLowerCase().replace(/[^a-z0-9\- ]+/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (STOP.has(w) || owner.has(w) || w.length < 2) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\- ]+/g, " ").split(/\s+/).filter(Boolean).map((t) => t.replace(/-/g, ""));
}

/** A keyword matches a token when they are equal or one is a prefix of the other (≥3 characters, or the
 *  whole keyword when it is shorter): "prod" ~ "production", "db" ~ "dba", "on-call" ~ "oncall". */
export function termMatches(keyword: string, token: string): boolean {
  const kw = keyword.replace(/-/g, "");
  if (kw === token) return true;
  if (kw.length < 3) return token.startsWith(kw);
  if (token.length < 3) return false;
  return token.startsWith(kw) || kw.startsWith(token);
}

export interface Score {
  /** matched keywords / all keywords */
  score: number;
  matched: string[];
  /** the first keyword (the lead term) matched */
  lead: boolean;
  /** score ≥ 0.5 and the lead term matched */
  accepted: boolean;
}

export function scoreText(keywords: string[], text: string): Score {
  const toks = tokens(text);
  const matched = keywords.filter((kw) => toks.some((t) => termMatches(kw, t)));
  const score = keywords.length ? matched.length / keywords.length : 0;
  const lead = keywords.length > 0 && matched.includes(keywords[0]);
  return { score, matched, lead, accepted: score >= 0.5 && lead };
}

export function scoreLabel(s: Score, n: number): string {
  return `${s.matched.length}/${n} keywords${s.matched.length ? ": " + s.matched.join(", ") : ""}${s.lead ? "" : " (lead term missing)"}`;
}

/** Fill {placeholders}. Unknown placeholders are left as is so a template typo is visible. */
export function fill(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}
