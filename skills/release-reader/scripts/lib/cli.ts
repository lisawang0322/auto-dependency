/** Tiny argv parser: --key value, --key (flag), --list a b c, repeatable --read-as x=y. */
export interface ParsedArgs {
  opts: Record<string, string>;
  multi: Record<string, string[]>;
  lists: Record<string, string[]>;
  flags: Set<string>;
}
export function parseArgs(argv: string[], spec: { lists: string[]; flags: string[] }): ParsedArgs {
  const out: ParsedArgs = { opts: {}, multi: {}, lists: {}, flags: new Set() };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith("--")) { i++; continue; }
    const key = a.slice(2);
    if (spec.flags.includes(key)) { out.flags.add(key); i++; continue; }
    if (spec.lists.includes(key)) {
      const vals: string[] = [];
      i++;
      while (i < argv.length && !argv[i].startsWith("--")) vals.push(argv[i++]);
      out.lists[key] = (out.lists[key] ?? []).concat(vals);
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) { out.flags.add(key); i++; continue; }
    out.opts[key] = val;
    (out.multi[key] ??= []).push(val);
    i += 2;
  }
  return out;
}
