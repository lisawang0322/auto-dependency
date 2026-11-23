/** Jira issue-key extraction. */
export const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export function extractIssueKeys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ISSUE_KEY_RE)) out.add(m[0]);
  return [...out].sort();
}

export function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

/** Project keys named as "project KEY" or "Jira project KEY" in a sentence. */
export function explicitProjectKeys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bproject\s+([A-Z][A-Z0-9]{1,9})\b/g)) out.add(m[1]);
  return [...out].sort();
}
