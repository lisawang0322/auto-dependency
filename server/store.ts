/**
 * The server's small store: users, sessions, per-user settings and keep/dismiss decisions. SQLite through
 * Node's built-in node:sqlite, one file under DATA_DIR (default out/rrr.sqlite); ":memory:" for tests.
 * Runs stay on disk under runs/ as before; this holds what used to live in the browser.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface User { id: string; issuer: string; sub: string; email: string | null; name: string; org: string; created_at: string; last_seen: string }
export interface Session { id: string; user_id: string; created_at: string; expires_at: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, issuer TEXT NOT NULL, sub TEXT NOT NULL, email TEXT, name TEXT NOT NULL, org TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(issuer, sub));
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, key));
CREATE TABLE IF NOT EXISTS decisions (user_id TEXT NOT NULL, run_key TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, run_key));
CREATE TABLE IF NOT EXISTS connections (user_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, kind));
`;

const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  // ---- users ----
  /** Find or create the user for an identity; refreshes name, email and org from the latest sign-in. */
  upsertUser(u: { issuer: string; sub: string; email: string | null; name: string; org: string }): User {
    const t = now();
    const existing = this.db.prepare("SELECT * FROM users WHERE issuer = ? AND sub = ?").get(u.issuer, u.sub) as User | undefined;
    if (existing) {
      this.db.prepare("UPDATE users SET email = ?, name = ?, org = ?, last_seen = ? WHERE id = ?").run(u.email, u.name, u.org, t, existing.id);
      return { ...existing, email: u.email, name: u.name, org: u.org, last_seen: t };
    }
    const id = "u_" + randomBytes(12).toString("hex");
    this.db.prepare("INSERT INTO users (id, issuer, sub, email, name, org, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, u.issuer, u.sub, u.email, u.name, u.org, t, t);
    return { id, ...u, created_at: t, last_seen: t };
  }
  user(id: string): User | null { return (this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined) ?? null; }

  // ---- sessions ----
  createSession(userId: string, ttlMs: number): Session {
    const id = randomBytes(32).toString("base64url");
    const t = new Date();
    const s: Session = { id, user_id: userId, created_at: t.toISOString(), expires_at: new Date(t.getTime() + ttlMs).toISOString() };
    this.db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(s.id, s.user_id, s.created_at, s.expires_at);
    return s;
  }
  /** The user behind a session id, or null when unknown or expired (expired ones are removed). */
  sessionUser(sessionId: string): User | null {
    const s = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Session | undefined;
    if (!s) return null;
    if (s.expires_at <= now()) { this.deleteSession(sessionId); return null; }
    const u = this.user(s.user_id);
    if (u) this.db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now(), u.id);
    return u;
  }
  deleteSession(sessionId: string) { this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId); }
  deleteUserSessions(userId: string) { this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId); }

  // ---- settings and decisions (what used to live in localStorage) ----
  setting<T>(userId: string, key: string): T | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : null;
  }
  setSetting(userId: string, key: string, value: unknown) {
    this.db.prepare("INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(userId, key, JSON.stringify(value), now());
  }
  decisions<T>(userId: string, runKey: string): T | null {
    const r = this.db.prepare("SELECT data FROM decisions WHERE user_id = ? AND run_key = ?").get(userId, runKey) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as T) : null;
  }
  setDecisions(userId: string, runKey: string, data: unknown) {
    this.db.prepare("INSERT INTO decisions (user_id, run_key, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, run_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(userId, runKey, JSON.stringify(data), now());
  }

  // ---- connections (phase 2 stores encrypted tokens here) ----
  connection<T>(userId: string, kind: string): T | null {
    const r = this.db.prepare("SELECT data FROM connections WHERE user_id = ? AND kind = ?").get(userId, kind) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as T) : null;
  }
  setConnection(userId: string, kind: string, data: unknown) {
    this.db.prepare("INSERT INTO connections (user_id, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(userId, kind, JSON.stringify(data), now());
  }
  deleteConnection(userId: string, kind: string) { this.db.prepare("DELETE FROM connections WHERE user_id = ? AND kind = ?").run(userId, kind); }
}
