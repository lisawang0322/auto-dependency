import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { InvolveRole } from "@rrr/schemas";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES = resolve(HERE, "../../templates/signals.yaml");

export interface RuleTeam { team: string; role: InvolveRole; why: string; when: string; action?: string; action_when?: string; action_why?: string }
export interface RuleApproval { name: string; team: string; why: string; start: string; keywords: string[] }
export interface Rule { id: string; patterns: string[]; teams: RuleTeam[]; approvals?: RuleApproval[] }
export interface CoverageTemplates {
  team_missing: string; team_missing_when: string; team_unclear: string; team_unclear_when: string;
  approval_not_started: string; approval_not_started_when: string; approval_no_owner: string; approval_no_owner_when: string;
}
export interface SignalRules { rules: Rule[]; coverage: CoverageTemplates }

export function loadRules(path = DEFAULT_RULES): SignalRules {
  const data = YAML.parse(readFileSync(path, "utf8")) as SignalRules;
  if (!Array.isArray(data?.rules)) throw new Error(`${path}: expected a top-level "rules" list`);
  for (const r of data.rules) {
    if (!r.id || !Array.isArray(r.patterns) || !Array.isArray(r.teams)) throw new Error(`${path}: rule ${r.id ?? "?"} needs id, patterns and teams`);
    for (const p of r.patterns) new RegExp(p, "i"); // throws on a bad pattern, with the pattern in the message
  }
  return data;
}
