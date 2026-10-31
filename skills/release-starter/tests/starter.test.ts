import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFile } from "../../release-reader/scripts/lib/files.js";
import { loadRules } from "../scripts/lib/config.js";
import { readSignals, projectName, addAgentSignals } from "../scripts/lib/signals.js";
import { loadDirectory, contactFor, teamOfPerson } from "../scripts/lib/directory.js";
import { suggest } from "../scripts/lib/starter.js";
import { runStarter } from "../../../scripts/lib/pipeline.js";

const DOCS = "fixtures/ingest-142/docs";
const rules = loadRules();

describe("signals from the sample PRD", () => {
  it("finds one signal per matching sentence, with its section and the teams it implies", async () => {
    const prd = await loadFile(`${DOCS}/ingestion-service-PRD.md`);
    const signals = readSignals([prd], rules);
    expect(projectName([prd])).toBe("Ingestion service");
    expect(signals.map((s) => [s.locator, s.rule_ids.join("+")])).toEqual([
      ["§1 Goals", "shared_platform"],
      ["§1 Goals", "enterprise_ga"],
      ["§2 Scope", "public_api"],
      ["§3 Data", "customer_data"],
      ["§4 Users", "user_interface"],
      ["§5 Requirements", "peak_load"],
    ]);
    expect(signals[3].quote).toMatch(/^Stores raw customer event data for 90 days/);
    expect(signals[3].teams).toEqual(["Privacy", "Legal"]);
    expect(signals[3].approvals).toEqual(["Privacy review", "Legal review"]);
    expect(signals[0].file).toBe("ingestion-service-PRD.md");
  });

  it("reads the same signals from the Word export of the PRD", async () => {
    if (!existsSync(`${DOCS}/ingestion-service-PRD.docx`)) return;
    const md = readSignals([await loadFile(`${DOCS}/ingestion-service-PRD.md`)], rules);
    const docx = readSignals([await loadFile(`${DOCS}/ingestion-service-PRD.docx`)], rules);
    expect(docx.map((s) => s.quote)).toEqual(md.map((s) => s.quote));
  });

  it("is deterministic: the same text gives the same signals", async () => {
    const prd = await loadFile(`${DOCS}/ingestion-service-PRD.md`);
    expect(readSignals([prd], rules)).toEqual(readSignals([prd], rules));
  });
});

describe("directory", () => {
  it("reads the sample directory and finds contacts by team name or alias", async () => {
    const dir = loadDirectory(await loadFile(`${DOCS}/directory.yaml`));
    expect(dir).toHaveLength(10);
    expect(contactFor(dir, "Data Platform")).toBe("Wei Zhang · eng lead");
    expect(contactFor(dir, "Product security")).toBe("Jordan Blake · security lead");
    expect(contactFor(dir, "Marketing")).toBeNull();
    expect(teamOfPerson(dir, "Omar Haddad")?.name).toBe("SRE");
    expect(teamOfPerson(dir, "Nobody")).toBeNull();
  });
  it("accepts the launch-stage team list too", async () => {
    const dir = loadDirectory(await loadFile(`${DOCS}/team-list.yaml`));
    expect(dir.map((d) => d.name)).toEqual(["Ingestion team", "Data Platform", "Security", "SRE"]);
    expect(dir[0].project).toBe("INGEST");
  });
});

describe("just starting (R17)", () => {
  it("suggests teams with role, why, when and a contact; approvals; and a first action per team", async () => {
    const prd = await loadFile(`${DOCS}/ingestion-service-PRD.md`);
    const dir = loadDirectory(await loadFile(`${DOCS}/directory.yaml`));
    const signals = readSignals([prd], rules);
    const s = suggest({ signals, rules, directory: dir });
    expect(s.teams.map((t) => `${t.team}:${t.role}`)).toEqual([
      "Data Platform:core", "QA:core", "UX:core", "VDR:approve", "Security:approve", "Privacy:approve", "Legal:approve", "SRE:consult", "Support:inform",
    ]);
    const dp = s.teams.find((t) => t.team === "Data Platform")!;
    expect(dp.contact).toBe("Wei Zhang · eng lead");
    expect(dp.signal_ids).toEqual(["g1", "g6"]); // shared platform and peak load
    expect(dp.when).toBe("now — before the design spec"); // the first core entry (g1, shared platform) supplies the wording
    expect(s.approvals.map((a) => a.name)).toEqual(["QA sign-off", "VDR", "Security review", "Privacy review", "Legal review"]);
    expect(s.next_actions).toHaveLength(9);
    expect(s.next_actions[0]).toMatchObject({ team: "Data Platform", who: "Wei Zhang (Data Platform)", when: "this week" });
  });

  it("unticking a signal drops the teams, approvals and actions only it implied", async () => {
    const prd = await loadFile(`${DOCS}/ingestion-service-PRD.md`);
    const signals = readSignals([prd], rules);
    const s = suggest({ signals, rules, directory: [], excludeSignals: ["g4"] }); // the customer-data sentence
    expect(s.teams.map((t) => t.team)).not.toContain("Privacy");
    expect(s.teams.map((t) => t.team)).not.toContain("Legal");
    expect(s.approvals.map((a) => a.name)).toEqual(["QA sign-off", "VDR", "Security review"]);
    expect(s.teams.find((t) => t.team === "Data Platform")!.contact).toBeNull();
    expect(s.next_actions.find((a) => a.team === "SRE")!.who).toBe("SRE");
  });
});

describe("building (R18) on the sample Jira snapshot", () => {
  let tmp: string;
  const run = async (files: string[]) => {
    tmp = mkdtempSync(join(tmpdir(), "rrr-starter-test-"));
    try {
      return (await runStarter({ stage: "building", files, epicKey: "INGEST-142", source: { kind: "fixture", dir: "fixtures/ingest-142/jira/2026-11-13" }, label: "2026-11-13", runsRoot: tmp, analyzedAt: "2026-11-13T09:10:00.000Z" })).starter;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  };

  it("tells covered, unclear and missing teams apart, from assignees and projects", async () => {
    const st = await run([`${DOCS}/ingestion-service-PRD.md`, `${DOCS}/directory.yaml`]);
    expect(st.epic).toBe("INGEST-142");
    expect(st.snapshot_label).toBe("2026-11-13");
    const by = Object.fromEntries(st.coverage.map((c) => [c.team, c]));
    expect(by["Data Platform"]).toMatchObject({ state: "covered" });
    expect(by["Data Platform"].people).toContain("Anika Rao");
    expect(by["Security"]).toMatchObject({ state: "covered", people: ["Fatima Noor", "Jordan Blake"] });
    expect(by["SRE"].state).toBe("covered");
    for (const t of ["UX", "Privacy", "Legal", "VDR", "Support"]) expect(by[t].state, t).toBe("missing");
    expect(by["QA"].state).toBe("missing"); // INGEST-170 is unowned, so it is the approval row that flags it
    expect(by["Privacy"].contact).toBe("Ken Adeyemi · privacy counsel");
  });

  it("finds each approval's ticket and owner, or says none was found", async () => {
    const st = await run([`${DOCS}/ingestion-service-PRD.md`, `${DOCS}/directory.yaml`]);
    const by = Object.fromEntries(st.approval_status.map((a) => [a.name, a]));
    expect(by["Security review"]).toMatchObject({ state: "started", ticket: "SEC-881" });
    expect(by["Security review"].detail).toContain("Fatima Noor");
    expect(by["QA sign-off"]).toMatchObject({ state: "no_owner", ticket: "INGEST-170" });
    expect(by["Privacy review"]).toMatchObject({ state: "not_started", ticket: null });
    expect(by["Privacy review"].detail).toBe("No ticket found in INGEST");
    expect(by["VDR"].state).toBe("not_started");
    const texts = st.next_actions.map((a) => a.text);
    expect(texts).toContain("Get an owner for INGEST-170 (Test plan for ingestion launch); the QA sign-off has no one on it");
    expect(texts.some((t) => t.startsWith("Bring Privacy onto the work"))).toBe(true);
    expect(texts.some((t) => t.includes("Security review"))).toBe(false); // started: no action
    expect(st.next_actions.find((a) => a.team === "Privacy")!.who).toBe("Ken Adeyemi (Privacy)");
  });

  it("without a directory, teams are matched by project only and nobody gets a name", async () => {
    const st = await run([`${DOCS}/ingestion-service-PRD.md`]);
    expect(st.directory_given).toBe(false);
    const by = Object.fromEntries(st.coverage.map((c) => [c.team, c]));
    expect(by["Security"].state).toBe("covered"); // Security is unresolved (SEC vs SECOPS), but SEC-881 is linked from the epic
    expect(by["Security"].tickets).toContain("SEC-881"); // SEC-890 is linked from a story too
    expect(by["Data Platform"].state).toBe("covered");
    expect(by["Privacy"].contact).toBeNull();
    expect(st.next_actions.find((a) => a.team === "Privacy")!.who).toBe("Privacy");
  });
});

describe("agent-read signals (--agent-signals)", () => {
  const PRD = "ingestion-service-PRD.md";
  it("adds a quoted sentence under a known rule, with that rule's teams; drops bad quotes and unknown rules", async () => {
    const prd = await loadFile(`${DOCS}/${PRD}`);
    const found = readSignals([prd], rules);
    const { signals, warnings } = addAgentSignals([prd], rules, found, [
      { quote: "Aggregates are kept indefinitely.", file: PRD, rule_ids: ["customer_data"] },
      { quote: "Stores raw customer event data for 90 days so failed events can be replayed.", file: PRD, rule_ids: ["customer_data", "no_such_rule"] },
      { quote: "Legal wants a DPIA before beta.", file: PRD, rule_ids: ["customer_data"] },
      { quote: "No billing changes.", file: PRD, rule_ids: ["billing"] },
      { quote: "No billing changes.", file: "other.md", rule_ids: ["customer_data"] },
    ]);
    expect(signals).toHaveLength(found.length + 1);
    const added = signals[signals.length - 1];
    expect(added).toMatchObject({ id: `g${found.length + 1}`, file: PRD, locator: "§3 Data", rule_ids: ["customer_data"], teams: ["Privacy", "Legal"], approvals: ["Privacy review", "Legal review"] });
    expect(signals[3].rule_ids).toEqual(["customer_data"]); // the duplicate of an existing signal added nothing
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toMatch(/^Agent signal "Stores raw customer event data.*: unknown rule id no_such_rule ignored/);
    expect(warnings[1]).toBe(`Dropped agent signal "Legal wants a DPIA before beta.": its quote was not found in ${PRD}.`);
    expect(warnings[2]).toMatch(/unknown rule id billing ignored/);
    expect(warnings[3]).toBe('Dropped agent signal "No billing changes.": no known rule id.');
    expect(warnings[4]).toBe('Dropped agent signal "No billing changes.": file other.md is not one of the inputs.');
    expect(readSignals([prd], rules)).toEqual(found); // the rule-detected list is untouched
  });

  it("flows through runStarter into the saved run, and --exclude can untick it like any signal", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "rrr-starter-agent-"));
    try {
      const agentSignals = [{ quote: "Aggregates are kept indefinitely.", file: PRD, rule_ids: ["customer_data"] }];
      const out = await runStarter({ stage: "starting", files: [`${DOCS}/${PRD}`, `${DOCS}/directory.yaml`], runsRoot, label: "2026-11-13", agentSignals });
      const mine = out.starter.signals.find((s) => s.quote === "Aggregates are kept indefinitely.")!;
      expect(mine.rule_ids).toEqual(["customer_data"]);
      expect(out.starter.warnings.filter((w) => /agent signal/i.test(w))).toEqual([]);
      const unticked = await runStarter({ stage: "starting", files: [`${DOCS}/${PRD}`, `${DOCS}/directory.yaml`], runsRoot, label: "2026-11-14", agentSignals, excludeSignals: [mine.id] });
      expect(unticked.starter.excluded_signals).toEqual([mine.id]);
      expect(unticked.starter.teams.map((t) => t.team)).toEqual(out.starter.teams.map((t) => t.team)); // Privacy and Legal were already implied by §3
    } finally { rmSync(runsRoot, { recursive: true, force: true }); }
  });
});
