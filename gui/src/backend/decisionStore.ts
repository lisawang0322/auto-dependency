import type { DecisionStore, RunDecisions } from "./types";

const EMPTY: RunDecisions = { decisions: {}, log: [] };

/** Keep/dismiss decisions per run, in this browser only. Falls back to memory if storage is unavailable. */
export class LocalDecisionStore implements DecisionStore {
  private memory = new Map<string, RunDecisions>();
  constructor(private prefix = "rrr:decisions:") {}
  load(runKey: string): RunDecisions {
    try {
      const raw = localStorage.getItem(this.prefix + runKey);
      if (raw) return JSON.parse(raw);
    } catch { /* private window, blocked storage */ }
    return this.memory.get(runKey) ?? structuredClone(EMPTY);
  }
  save(runKey: string, data: RunDecisions): void {
    this.memory.set(runKey, data);
    try { localStorage.setItem(this.prefix + runKey, JSON.stringify(data)); } catch { /* ignore */ }
  }
}

export class MemoryDecisionStore implements DecisionStore {
  private m = new Map<string, RunDecisions>();
  load(k: string) { return this.m.get(k) ?? structuredClone(EMPTY); }
  save(k: string, d: RunDecisions) { this.m.set(k, d); }
}
