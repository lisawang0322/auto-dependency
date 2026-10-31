#!/usr/bin/env -S npx tsx
/**
 * Render a saved run as one self-contained HTML file.
 *
 *   npm run report -- runs/INGEST-142/2026-11-13.json [--out report.html]
 *
 * Default output: next to the run's stage files, runs/<epic>/<label>/report.html. Reads findings.json
 * and status.json from that folder when present (go/no-go date, which run the change notes compare with).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Run } from "@rrr/schemas";
import { renderReport } from "./lib/report.js";

const argv = process.argv.slice(2);
const runFile = argv.find((a) => !a.startsWith("--"));
const oi = argv.indexOf("--out");
if (!runFile) { console.error("usage: report.ts runs/<epic>/<label>.json [--out report.html]"); process.exit(2); }
const run = Run.parse(JSON.parse(readFileSync(runFile, "utf8")));
const label = basename(runFile, ".json");
const stageDir = join(dirname(runFile), label);
const side = (name: string) => (existsSync(join(stageDir, name)) ? JSON.parse(readFileSync(join(stageDir, name), "utf8")) : null);
const findings = side("findings.json"), status = side("status.json");
const html = renderReport(run, { goNoGo: findings?.go_no_go ?? null, comparedWith: status?.compared_with ?? null, sourceFile: runFile });
const out = oi > 0 ? argv[oi + 1] : join(stageDir, "report.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.error(`wrote ${resolve(out)} (${Math.round(html.length / 1024)} KB): ${run.findings.filter((f) => f.strength !== "weak").length} findings, ${run.teams.length} teams`);
console.log(resolve(out));
