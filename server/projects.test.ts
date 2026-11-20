import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "./index.js";

const DOCS = resolve("fixtures/ingest-142/docs");

describe("projects: kept across the project's life", () => {
  let srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-projects-"));
    srv = await startServer({ port: 0, quiet: true, creds: null, storePath: ":memory:", devin: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), sampleDocs: DOCS });
  });
  afterAll(async () => { await srv.close(); rmSync(tmp, { recursive: true, force: true }); });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(srv.url + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };

  it("creates, keeps a file once, reads it on later runs without sending it, saves, lists and deletes", async () => {
    expect((await api("GET", "/api/projects")).data).toEqual({ projects: [] });
    const p = (await api("POST", "/api/projects", { name: "  Ingestion service  " })).data;
    expect(p).toMatchObject({ name: "Ingestion service", data: {} });

    // The file is uploaded once, into the project.
    const up = await api("POST", `/api/projects/${p.id}/files`, { name: "Ingestion-service-POR-v3.md", content_base64: readFileSync(join(DOCS, "Ingestion-service-POR-v3.md")).toString("base64") });
    expect(up.status).toBe(200);
    expect(up.data.stored).toMatch(/^[0-9a-f]{8}-Ingestion-service-POR-v3\.md$/);

    // Later reads name the stored file; no content travels.
    const files = [{ name: "Ingestion-service-POR-v3.md", kind: "plan", project: p.id, stored: up.data.stored }];
    const r1 = await api("POST", "/api/plan", { files });
    expect(r1.status).toBe(200);
    expect(r1.data.plan.items.length).toBeGreaterThan(0);
    const r2 = await api("POST", "/api/plan", { files });
    expect(r2.data.plan.items).toEqual(r1.data.plan.items);
    // A name that is not this project's file, or a path, is refused.
    expect((await api("POST", "/api/plan", { files: [{ ...files[0], stored: "../../etc/passwd" }] })).status).toBe(400);
    expect((await api("POST", "/api/plan", { files: [{ ...files[0], project: "nope" }] })).status).toBe(404);

    // The GUI's state is saved and comes back; the list is newest first.
    const q = (await api("POST", "/api/projects", { name: "" })).data;
    expect(q.name).toBe("Untitled project");
    expect((await api("PUT", `/api/projects/${p.id}`, { name: "Ingestion service", data: { stage: "launching", epic: "INGEST-142" } })).status).toBe(200);
    expect((await api("GET", `/api/projects/${p.id}`)).data.data).toEqual({ stage: "launching", epic: "INGEST-142" });
    expect((await api("GET", "/api/projects")).data.projects.map((x: any) => x.name)).toEqual(["Ingestion service", "Untitled project"]);
    expect((await api("PUT", "/api/projects/nope", { name: "x", data: {} })).status).toBe(404);

    // Deleting removes the project and its files.
    const dir = join(tmp, "up", "projects", p.id);
    expect(existsSync(dir) && readdirSync(dir).length).toBe(1);
    expect((await api("DELETE", `/api/projects/${p.id}`)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect((await api("GET", "/api/projects")).data.projects.map((x: any) => x.name)).toEqual(["Untitled project"]);
  });
});
