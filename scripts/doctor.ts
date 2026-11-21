#!/usr/bin/env -S npx tsx
/**
 * Preflight: is this machine ready to run a review?  npm run doctor [-- --epic KEY]
 * Checks Node, dependencies, the Python deck reader, the Jira credentials (and the epic when given).
 * Prints one line per check; exit code 1 when a required check fails.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pythonExe } from "../skills/throughline-reader/scripts/lib/files.js";
import { JiraRest, JiraAuthError, type RestCreds } from "../skills/throughline-reader/scripts/lib/jira-rest.js";

export type Level = "ok" | "warn" | "fail";
export interface Check { name: string; level: Level; detail: string }

export interface DoctorOptions {
  epic?: string | null;
  env?: NodeJS.ProcessEnv;
  root?: string;
  fetchImpl?: typeof fetch;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const root = opts.root ?? process.cwd();
  const out: Check[] = [];
  const add = (name: string, level: Level, detail: string) => out.push({ name, level, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add("Node", major >= 22 ? "ok" : "fail", `v${process.versions.node}${major >= 22 ? "" : " (need 22 or newer)"}`);
  add("Dependencies", existsSync(resolve(root, "node_modules/yaml")) && existsSync(resolve(root, "node_modules/zod")) ? "ok" : "fail", existsSync(resolve(root, "node_modules/yaml")) ? "installed" : "run npm install");

  try {
    execFileSync(pythonExe(), ["-I", "-c", "import pptx, pdfplumber"], { stdio: "pipe", cwd: root });
    add("Deck reader", "ok", `${pythonExe()} has python-pptx and pdfplumber`);
  } catch {
    add("Deck reader", "warn", ".pptx and PDF decks cannot be read: run make py-setup (markdown, docx, csv, yaml still work)");
  }

  const fixture = env.JIRA_FIXTURE_DIR;
  const creds: RestCreds | null = env.JIRA_SITE && env.JIRA_EMAIL && env.JIRA_API_TOKEN ? { site: env.JIRA_SITE, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN } : null;
  if (fixture) add("Jira", existsSync(fixture) ? "ok" : "fail", existsSync(fixture) ? `demo mode, reading the snapshot in ${fixture}` : `JIRA_FIXTURE_DIR=${fixture} does not exist`);
  else if (!creds) add("Jira", "warn", "JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN are not all set: the CLI's --source rest and the server's auto-connect are unavailable (the GUI can still take a token in its Connect step)");
  else {
    const rest = new JiraRest(creds, opts.fetchImpl);
    try {
      const me = await rest.myself();
      const projects = await rest.listProjects();
      add("Jira", "ok", `${creds.site.replace(/^https?:\/\//, "")} as ${me.displayName}; ${projects.length} visible projects${projects.length ? ": " + projects.slice(0, 8).map((p) => p.key).join(", ") + (projects.length > 8 ? ", …" : "") : ""}`);
      if (!projects.length) add("Jira projects", "warn", "no project is visible to this account; teams cannot be matched");
      if (opts.epic) {
        const issue = await rest.getIssue(opts.epic.toUpperCase(), ["summary", "issuetype", "fixVersions", "status"]);
        if (!issue) add("Epic", "fail", `${opts.epic} is not visible to this account or does not exist`);
        else {
          const type = issue.fields.issuetype?.name ?? "?";
          const fv = (issue.fields.fixVersions ?? [])[0];
          add("Epic", type.toLowerCase() === "epic" ? "ok" : "fail", `${issue.key} "${issue.fields.summary}" is ${type === "Epic" ? "an Epic" : "a " + type + ", not an Epic"}, ${issue.fields.status?.name ?? "?"}${fv ? `, fix version ${fv.name}${fv.releaseDate ? " (" + fv.releaseDate + ")" : " with no release date"}` : ", no fix version"}`);
        }
      }
    } catch (e) {
      if (e instanceof JiraAuthError) add("Jira", "fail", `credentials rejected by ${creds.site}: check JIRA_EMAIL and JIRA_API_TOKEN (id.atlassian.com → Security → API tokens)`);
      else add("Jira", "fail", `could not reach ${creds.site}: ${(e as Error).message}`);
    }
  }
  add("GUI build", existsSync(resolve(root, "gui/dist/index.html")) ? "ok" : "warn", existsSync(resolve(root, "gui/dist/index.html")) ? "gui/dist present; npm run server serves it" : "not built; npm start builds it, or use npm run gui:dev");
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const i = process.argv.indexOf("--epic");
  runDoctor({ epic: i > 0 ? process.argv[i + 1] : null }).then((checks) => {
    const mark: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
    for (const c of checks) console.log(`${mark[c.level]}  ${c.name.padEnd(14)} ${c.detail}`);
    const fails = checks.filter((c) => c.level === "fail").length;
    console.log(fails ? `${fails} check(s) failed.` : "Ready.");
    process.exit(fails ? 1 : 0);
  });
}
