/** Exact date logic for the throughline-reader. All outputs are ISO YYYY-MM-DD strings. */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fourteen: 14, thirty: 30, sixty: 60, ninety: 90,
};

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toIso(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const r = new Date(t);
  return toIso(r.getUTCFullYear(), r.getUTCMonth() + 1, r.getUTCDate());
}

export function daysBetween(fromIso: string, toIso_: string): number {
  const p = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(toIso_) - p(fromIso)) / 86_400_000);
}

export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

/** Turn a Jira datetime ("2026-11-13T09:12:00.000+0000") into a date (2026-11-13). */
export function isoDateOf(dt: string | null | undefined): string | null {
  if (!dt) return null;
  const m = dt.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export interface DateMatch {
  /** Resolved ISO date, or null when the phrase could not be resolved (e.g. relative with no launch date). */
  due: string | null;
  /** The exact words matched in the text. */
  due_text: string;
  /** True when the date was computed from a relative phrase rather than written out. */
  inferred: boolean;
  /** Character span of the phrase (including a leading "by"/"on"/"before") so callers can remove it. */
  start: number;
  end: number;
}

/**
 * Find the first date phrase in a sentence. Absolute forms: 2026-11-18, Nov 18, Nov 18, 2026,
 * 18 Nov 2026, November 18th. Relative forms (resolved against launchDate): "the week before launch",
 * "two days after launch", "5 days before launch", "at launch", "on launch day", "the day before launch".
 */
export function findDatePhrase(text: string, launchDate: string | null, defaultYear?: number): DateMatch | null {
  const lead = "(?:(?:by|on|before|after|until|no later than|due)\\s+)?";
  const candidates: DateMatch[] = [];

  const push = (m: RegExpMatchArray, due: string | null, inferred: boolean) => {
    const idx = m.index ?? 0;
    candidates.push({ due, due_text: m[0].trim(), inferred, start: idx, end: idx + m[0].length });
  };

  // ISO
  for (const m of text.matchAll(new RegExp(`${lead}(\\d{4})-(\\d{2})-(\\d{2})`, "gi"))) {
    push(m, toIso(Number(m[1]), Number(m[2]), Number(m[3])), false);
  }
  // Month day[, year]
  for (const m of text.matchAll(new RegExp(`${lead}(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "gi"))) {
    const mon = MONTHS[m[1].toLowerCase().replace(".", "").slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    const year = m[3] ? Number(m[3]) : yearFor(launchDate, defaultYear);
    if (mon) push(m, toIso(year, mon, Number(m[2])), false);
  }
  // day Month [year]
  for (const m of text.matchAll(new RegExp(`${lead}(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})(?:,?\\s+(\\d{4}))?`, "gi"))) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 3)];
    const year = m[3] ? Number(m[3]) : yearFor(launchDate, defaultYear);
    if (mon) push(m, toIso(year, mon, Number(m[1])), false);
  }
  // Relative to launch
  const rel = new RegExp(
    `${lead}(?:(the)\\s+)?(?:(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty|sixty|ninety)\\s+)?(day|days|week|weeks|month|months)\\s+(before|after|prior to|past)\\s+(?:the\\s+)?launch(?:\\s+date)?`,
    "gi",
  );
  for (const m of text.matchAll(rel)) {
    const n = m[2] ? (WORD_NUM[m[2].toLowerCase()] ?? Number(m[2])) : 1;
    const unit = m[3].toLowerCase().startsWith("week") ? 7 : m[3].toLowerCase().startsWith("month") ? 30 : 1;
    const sign = /before|prior/i.test(m[4]) ? -1 : 1;
    push(m, launchDate ? addDays(launchDate, sign * n * unit) : null, true);
  }
  for (const m of text.matchAll(new RegExp(`${lead}(?:at|on|by)\\s+launch(?:\\s+day)?|\\blaunch\\s+day\\b`, "gi"))) {
    push(m, launchDate, true);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.start - b.start);
  // Prefer the earliest; if two overlap keep the longer one.
  const first = candidates[0];
  const overlapping = candidates.filter((c) => c.start < first.end);
  overlapping.sort((a, b) => b.end - b.start - (a.end - a.start));
  return overlapping[0];
}

function yearFor(launchDate: string | null, defaultYear?: number): number {
  if (launchDate) return Number(launchDate.slice(0, 4));
  if (defaultYear) return defaultYear;
  return new Date().getUTCFullYear();
}

/** Find "Launch date: 2026-11-20", "launch on Nov 20, 2026", "Target launch: 20 Nov 2026". */
export function findLaunchDate(text: string): string | null {
  const windows = [
    /launch(?:\s+date|\s+target|\s+day)?\s*[:\-–]\s*([^\n]{3,40})/i,
    /(?:target|planned|expected)\s+launch\s*(?:is|on|:)?\s*([^\n]{3,40})/i,
    /launch(?:es|ing)?\s+(?:on|is|date is)\s+([^\n.]{3,40})/i,
    /go[- ]live\s*[:\-–]?\s*(?:on\s+)?([^\n.]{3,40})/i,
  ];
  for (const re of windows) {
    const m = text.match(re);
    if (!m) continue;
    const d = findDatePhrase(m[1], null, undefined);
    if (d && d.due && !d.inferred) return d.due;
  }
  return null;
}
