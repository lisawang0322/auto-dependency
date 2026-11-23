import type { DecisionStore, RunDecisions } from "./types";

const EMPTY: RunDecisions = { decisions: {}, log: [], actionsDone: {} };

/** Keep/dismiss decisions per run, in this browser only (sample mode). Falls back to memory if storage is unavailable. */
export class LocalDecisionStore implements DecisionStore {
  private memory = new Map<string, RunDecisions>();
  constructor(private prefix = "rrr:decisions:") {}
  async load(runKey: string): Promise<RunDecisions> {
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

/** Live mode: decisions live on the server, per signed-in person (GET/PUT /api/decisions/:key). */
export class ServerDecisionStore implements DecisionStore {
  private cache = new Map<string, RunDecisions>();
  async load(runKey: string): Promise<RunDecisions> {
    const hit = this.cache.get(runKey);
    if (hit) return hit;
    try {
      const res = await fetch(`/api/decisions/${encodeURIComponent(runKey)}`);
      if (res.ok) { const d = (await res.json()) as RunDecisions; this.cache.set(runKey, d); return d; }
    } catch { /* offline: start empty */ }
    return structuredClone(EMPTY);
  }
  save(runKey: string, data: RunDecisions): void {
    this.cache.set(runKey, data);
    fetch(`/api/decisions/${encodeURIComponent(runKey)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      .then((r) => { if (!r.ok) console.warn(`decisions for ${runKey} were not saved (${r.status})`); })
      .catch((e) => console.warn(`decisions for ${runKey} were not saved`, e));
  }
}

export class MemoryDecisionStore implements DecisionStore {
  private m = new Map<string, RunDecisions>();
  async load(k: string) { return this.m.get(k) ?? structuredClone(EMPTY); }
  save(k: string, d: RunDecisions) { this.m.set(k, d); }
}
