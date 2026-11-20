/**
 * Where projects live between visits. Live mode keeps them on the server, per signed-in person, files included
 * (uploaded once, read by name on every later run). Sample mode keeps them in this browser; sample files need no contents.
 */
import type { ProjectData, ProjectRecord, ProjectStore, UploadedFile } from "./types";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: method !== "GET" ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `${res.status} on ${path}`);
  return data as T;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What is saved for a file: never the browser File itself. */
export function storableFiles(files: UploadedFile[]): UploadedFile[] { return files.map(({ file: _f, ...rest }) => rest); }

export class ServerProjectStore implements ProjectStore {
  readonly kind = "server" as const;
  async list() { return (await call<{ projects: ProjectRecord[] }>("GET", "/api/projects")).projects; }
  async create(name: string, data: ProjectData = {}) { return call<ProjectRecord>("POST", "/api/projects", { name, data }); }
  async save(id: string, name: string, data: ProjectData) { await call("PUT", `/api/projects/${id}`, { name, data }); }
  async remove(id: string) { await call("DELETE", `/api/projects/${id}`); }
  async uploadFile(id: string, file: File) { return (await call<{ stored: string }>("POST", `/api/projects/${id}/files`, { name: file.name, content_base64: toBase64(await file.arrayBuffer()) })).stored; }
}

const KEY = "rrr.projects";
export class BrowserProjectStore implements ProjectStore {
  readonly kind = "browser" as const;
  private read(): ProjectRecord[] { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } }
  private write(list: ProjectRecord[]) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode: projects last for this visit */ } }
  async list() { return this.read().sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }
  async create(name: string, data: ProjectData = {}) {
    const now = new Date().toISOString();
    const rec: ProjectRecord = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim() || "Untitled project", created_at: now, updated_at: now, data };
    this.write([rec, ...this.read()]);
    return rec;
  }
  async save(id: string, name: string, data: ProjectData) { this.write(this.read().map((r) => (r.id === id ? { ...r, name, data, updated_at: new Date().toISOString() } : r))); }
  async remove(id: string) { this.write(this.read().filter((r) => r.id !== id)); }
  async uploadFile() { return null; }
}
