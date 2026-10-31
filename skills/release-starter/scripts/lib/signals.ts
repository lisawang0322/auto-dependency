/**
 * Read a PRD (or any plan file) for signals: sentences that match a rule in templates/signals.yaml.
 * Each signal keeps its quote and where it was found, so the person can untick a wrong one.
 */
import type { Signal } from "@rrr/schemas";
import type { LoadedFile } from "../../../release-reader/scripts/lib/files.js";
import { splitSections, candidateSentences } from "../../../release-reader/scripts/lib/plan-extract.js";
import type { SignalRules, Rule } from "./config.js";

interface Compiled { rule: Rule; res: RegExp[] }

function compile(rules: SignalRules): Compiled[] {
  return rules.rules.map((rule) => ({ rule, res: rule.patterns.map((p) => new RegExp(p, "i")) }));
}

const TITLE_SUFFIX = /\s*[—–:-]?\s*(PRD|one[- ]pager|product requirements(?: document)?|brief)\s*(v?\d+(\.\d+)?)?\s*$/i;

/** The project's name: the first markdown H1, a short first line (a Word or PDF title), the first slide's title, or the file stem. */
export function projectName(files: LoadedFile[]): string {
  for (const f of files) {
    const h1 = f.text.match(/^#\s+(.+)$/m);
    if (h1) return h1[1].replace(TITLE_SUFFIX, "").trim() || h1[1].trim();
    if (f.segments?.length && f.segments[0].heading) return f.segments[0].heading.trim();
    const first = f.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("<!--"));
    if (first && first.length < 80 && !/[.:;]$/.test(first)) return first.replace(TITLE_SUFFIX, "").trim() || first;
  }
  const f = files[0];
  return f ? f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(TITLE_SUFFIX, "").trim() : "New project";
}

/** Sections of a file: markdown headings, or slides for a deck. */
function sectionsOf(f: LoadedFile): { locator: string; body: string }[] {
  if (f.segments?.length) return f.segments.map((s) => ({ locator: `${s.locator}${s.heading ? " " + s.heading : ""}`, body: [s.body, ...s.rows.map((r) => r.join(" | "))].join("\n") }));
  return splitSections(f.text).map((s) => ({ locator: s.number ? `§${s.number}${s.heading ? " " + s.heading : ""}` : s.heading || s.locator, body: s.body }));
}

/** Join wrapped lines into paragraphs (bullets stay one per line), so a markdown PRD and its Word export give the same sentences. */
export function unwrap(body: string): string {
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^([-*•]|\d+[.)])\s+/.test(line);
    if (!line) { out.push(""); continue; }
    if (bullet || !out.length || out[out.length - 1] === "") out.push(line);
    else out[out.length - 1] += " " + line;
  }
  return out.join("\n");
}

export function readSignals(files: LoadedFile[], rules: SignalRules): Signal[] {
  const compiled = compile(rules);
  const out: Signal[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const sec of sectionsOf(f)) {
      for (const sentence of candidateSentences(unwrap(sec.body))) {
        const hits = compiled.filter((c) => c.res.some((re) => re.test(sentence)));
        if (!hits.length) continue;
        const key = sentence.toLowerCase().replace(/\s+/g, " ");
        if (seen.has(key)) continue; // the same sentence twice (e.g. a summary slide) is one signal
        seen.add(key);
        const teams: string[] = [], approvals: string[] = [];
        for (const h of hits) {
          for (const t of h.rule.teams) if (!teams.includes(t.team)) teams.push(t.team);
          for (const a of h.rule.approvals ?? []) if (!approvals.includes(a.name)) approvals.push(a.name);
        }
        out.push({ id: `g${out.length + 1}`, quote: sentence, file: f.name, locator: sec.locator, rule_ids: hits.map((h) => h.rule.id), teams, approvals });
      }
    }
  }
  return out;
}
