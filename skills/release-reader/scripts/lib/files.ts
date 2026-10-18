/** Read plan files of any common type into text (and rows for tabular files). */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

export interface LoadedFile {
  name: string;
  path: string;
  ext: string;
  /** Plain text rendering; for tables, one line per row joined by " | ". */
  text: string;
  /** Rows for csv/xlsx; the first row is the header. */
  rows: string[][] | null;
  /** Raw lines for csv so quotes can cite the exact line. */
  rawLines: string[] | null;
  /** Parsed object for yaml/json. */
  data: unknown | null;
}

export async function loadFile(path: string): Promise<LoadedFile> {
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  const base: LoadedFile = { name, path, ext, text: "", rows: null, rawLines: null, data: null };
  switch (ext) {
    case ".md":
    case ".txt":
    case ".markdown":
      return { ...base, text: readFileSync(path, "utf8") };
    case ".csv":
    case ".tsv": {
      const raw = readFileSync(path, "utf8");
      const rawLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const rows = rawLines.map((l) => splitCsvLine(l, ext === ".tsv" ? "\t" : ","));
      return { ...base, text: rows.map((r) => r.join(" | ")).join("\n"), rows, rawLines };
    }
    case ".xlsx":
    case ".xls": {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(readFileSync(path), { type: "buffer" });
      const rows: string[][] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
        for (const r of data) rows.push(r.map((c) => String(c ?? "").trim()));
      }
      const nonEmpty = rows.filter((r) => r.some((c) => c.length));
      return { ...base, text: nonEmpty.map((r) => r.join(" | ")).join("\n"), rows: nonEmpty };
    }
    case ".yaml":
    case ".yml": {
      const YAML = await import("yaml");
      const text = readFileSync(path, "utf8");
      return { ...base, text, data: YAML.parse(text) };
    }
    case ".json": {
      const text = readFileSync(path, "utf8");
      return { ...base, text, data: JSON.parse(text) };
    }
    case ".pdf": {
      const mod = await import("pdf-parse/lib/pdf-parse.js");
      const pdf = (mod as any).default ?? mod;
      const out = await pdf(readFileSync(path));
      return { ...base, text: String(out.text ?? "") };
    }
    case ".docx": {
      const mammoth = (await import("mammoth")).default;
      const out = await mammoth.extractRawText({ path });
      return { ...base, text: out.value };
    }
    default:
      return { ...base, text: readFileSync(path, "utf8") };
  }
}

export function splitCsvLine(line: string, sep = ","): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { cells.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
