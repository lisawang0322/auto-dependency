import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadFile } from "../scripts/lib/files.js";
import { extractPlan, rowItem } from "../scripts/lib/plan-extract.js";
import { PlanDraft } from "@throughline/schemas";

const DOCS = resolve(__dirname, "../../../fixtures/ingest-142/docs");
const MD = resolve(DOCS, "Ingestion-service-POR-v3.md");
const PPTX = resolve(DOCS, "Ingestion-service-POR-v3.pptx");
const PDF = resolve(DOCS, "Ingestion-service-POR-v3.pdf");

async function run(paths: string[]) {
  const files = [];
  for (const p of paths) files.push(await loadFile(p));
  return extractPlan({ files });
}
const shape = (d: PlanDraft) => d.items.map((i) => [i.id, i.kind, i.owner_team, i.due, i.due_is_inferred]);

describe("Stage A: slide decks", () => {
  it("the .pptx gives the same plan items as the markdown POR (ids, kinds, owners, dates); only locators differ", async () => {
    const md = await run([MD]);
    const deck = await run([PPTX]);
    expect(PlanDraft.safeParse(deck).success).toBe(true);
    expect(shape(deck)).toEqual(shape(md));
    expect(deck.items.map((i) => i.text)).toEqual(md.items.map((i) => i.text));
    expect(deck.launch_date).toBe(md.launch_date);
    expect(deck.epic_keys_mentioned).toEqual(md.epic_keys_mentioned);
    expect(deck.teams.map((t) => [t.name, t.role])).toEqual(md.teams.map((t) => [t.name, t.role]));
    expect(deck.items.map((i) => i.source.locator)).toEqual(["slide 4", "slide 6", "slide 7 (notes)", "slide 8"]);
    expect(deck.files[0].read_as).toEqual(["plan_items"]);
    expect(deck.files[0].notes).toContain("10 slides");
  });

  it("every quote is text that appears on its slide (table rows: every cell)", async () => {
    const f = await loadFile(PPTX);
    const deck = extractPlan({ files: [f] });
    for (const it of deck.items) {
      const seg = f.segments!.find((s) => s.locator === it.source.locator)!;
      expect(seg).toBeTruthy();
      const onSlide = [seg.body, ...seg.rows.map((r) => r.join(" | "))].join("\n");
      for (const part of it.source.quote.split(" | ")) expect(onSlide).toContain(part);
    }
  });

  it("the approval found only in speaker notes is extracted with locator \"slide 7 (notes)\"", async () => {
    const f = await loadFile(PPTX);
    const slide7 = f.segments!.find((s) => s.locator === "slide 7")!;
    expect(slide7.body + slide7.rows.flat().join(" ")).not.toMatch(/Security will/);
    const deck = extractPlan({ files: [f] });
    const approval = deck.items.find((i) => i.kind === "approval")!;
    expect(approval).toMatchObject({ owner_team: "Security", due: "2026-11-14", text: "Security review approved" });
    expect(approval.source.locator).toBe("slide 7 (notes)");
    expect(approval.source.quote).toBe("Security will have the security review approved by Nov 14.");
  });

  it("the image-only slide gives exactly one warning", async () => {
    const deck = await run([PPTX]);
    const w = deck.warnings.filter((x) => /has no extractable text/.test(x));
    expect(w).toEqual(["Ingestion-service-POR-v3.pptx: slide 3 has no extractable text"]);
    expect(deck.warnings.length).toBe(1);
  });

  it("the PDF export gives the same items as the .pptx", async () => {
    const pptx = await run([PPTX]);
    const pdf = await run([PDF]);
    expect(shape(pdf)).toEqual(shape(pptx));
    expect(pdf.items.map((i) => [i.text, i.source.locator, i.source.quote])).toEqual(pptx.items.map((i) => [i.text, i.source.locator, i.source.quote]));
    expect(pdf.warnings).toEqual(["Ingestion-service-POR-v3.pdf: slide 3 has no extractable text"]);
  });

  it("mixed inputs: deck + checklist + team list gives the 7-item plan", async () => {
    const d = await run([PPTX, resolve(DOCS, "launch-checklist.csv"), resolve(DOCS, "team-list.yaml")]);
    expect(d.items.length).toBe(7);
    expect(d.items.filter((i) => i.kind === "checklist").map((i) => i.source.locator)).toEqual(["#4", "#6", "#9"]);
    expect(d.teams.map((t) => t.jira_project_hint)).toEqual(["INGEST", "DATA", "SEC", "SRE"]);
  });

  it("a file that cannot be read gives a warning, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rrr-"));
    const bin = join(dir, "plan.bin");
    writeFileSync(bin, Buffer.from([0, 1, 2, 255, 254, 0, 0, 9, 200, 7]));
    const legacy = join(dir, "deck.ppt");
    writeFileSync(legacy, "x");
    const d = await run([MD, bin, legacy, join(dir, "missing.pptx")]);
    expect(d.items.length).toBe(4);
    expect(d.warnings).toEqual([
      "could not read plan.bin: unknown binary format (.bin)",
      "could not read deck.ppt: legacy .ppt format is not supported; export it as .pptx or .pdf",
      "could not read missing.pptx: file not found",
    ]);
    expect(d.files.map((f) => f.notes)[1]).toBe("Nothing used from this file");
  });

  it("table rows become items only when a cell names a team", () => {
    const teams = ["Ingestion team", "SRE"];
    expect(rowItem(["Nov 18", "Ingestion service live in production", "Ingestion team"], teams, "2026-11-20")).toMatchObject({ owner: "Ingestion team", label: "Ingestion service live in production", date: { due: "2026-11-18" } });
    expect(rowItem(["Date", "Milestone", "Owner"], teams, "2026-11-20")).toBeNull();
    expect(rowItem(["Nov 20", "Launch", "—"], teams, "2026-11-20")).toBeNull();
    expect(rowItem(["SRE", "On-call rota", "the week before launch"], teams, "2026-11-20")).toMatchObject({ owner: "SRE", label: "On-call rota", date: { due: "2026-11-13", inferred: true } });
  });
});
