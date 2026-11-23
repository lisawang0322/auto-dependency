const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-18" → "Nov 18". Anything else is returned as given. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const p = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(toIso) - p(fromIso)) / 86_400_000);
}

export function clock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "by 2026-11-14" → "by Nov 14": ISO dates inside a sentence, shown the way the rest of the screen shows them. */
export function prettyDates(s: string): string {
  return s.replace(/\d{4}-\d{2}-\d{2}/g, (d) => fmtDate(d));
}
