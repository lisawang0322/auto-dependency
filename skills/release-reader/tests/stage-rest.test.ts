import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanDraft } from "@rrr/schemas";
import { FixtureSource } from "../scripts/lib/jira-source.js";
import { JiraRest, JiraAuthError, runRestLoop } from "../scripts/lib/jira-rest.js";
import { resolveRelease } from "../scripts/lib/resolve.js";
import { readJira } from "../scripts/lib/read.js";
import { startFakeJira, type FakeJira } from "./fake-jira.js";

const FX = "fixtures/ingest-142";
const SNAP = `${FX}/jira/2026-11-13`;
const plan = PlanDraft.parse(JSON.parse(readFileSync(`${FX}/plan-draft.json`, "utf8")));
const READ_AT = "2026-11-13T09:00:00.000Z";

describe("--source rest (Jira Cloud REST, read-only)", () => {
  let jira: FakeJira;
  let cache: string;
  beforeAll(async () => { jira = await startFakeJira(SNAP); cache = mkdtempSync(join(tmpdir(), "rrr-rest-")); });
  afterAll(async () => { await jira.close(); rmSync(cache, { recursive: true, force: true }); });

  const creds = () => ({ site: jira.url, email: "me@example.com", token: "secret" });

  it("checks the credentials with /myself and rejects bad ones", async () => {
    const me = await new JiraRest(creds()).myself();
    expect(me.displayName).toBe("Fixture User");
    await expect(new JiraRest({ ...creds(), token: "wrong" }).myself()).rejects.toBeInstanceOf(JiraAuthError);
  });

  it("Stage B and C over REST give the same files as fixture mode", async () => {
    const fx = new FixtureSource(SNAP);
    const wantTarget = resolveRelease({ plan, source: fx, epicKey: "INGEST-142" })!;
    const wantRelease = readJira({ plan, target: wantTarget, source: fx, snapshotLabel: "2026-11-13", readAt: READ_AT })!;

    const rest = new JiraRest(creds());
    const [target, roundsB] = await runRestLoop(cache, rest, (src) => resolveRelease({ plan, source: src, epicKey: "INGEST-142" }));
    expect(target).toEqual(wantTarget);
    expect(roundsB).toBeGreaterThan(1);
    const [release] = await runRestLoop(cache, rest, (src) => readJira({ plan, target, source: src, snapshotLabel: "2026-11-13", readAt: READ_AT }));
    expect(release).toEqual(wantRelease);
    // Pagination was exercised: projects page by 2, comments by 2, searches by 10.
    expect(jira.calls.filter((c) => c.endsWith("/project/search")).length).toBeGreaterThan(1);
    expect(jira.calls.some((c) => /\/issue\/[A-Z0-9-]+\/comment$/.test(c))).toBe(true);
    expect(release.stories.length).toBe(25);
    expect(release.search_candidates.some((c) => c.key === "SRE-412")).toBe(true);
  });

  it("a second run reuses the cache and makes no calls", async () => {
    const before = jira.calls.length;
    const rest = new JiraRest(creds());
    const [target, rounds] = await runRestLoop(cache, rest, (src) => resolveRelease({ plan, source: src, epicKey: "INGEST-142" }));
    expect(rounds).toBe(1);
    expect(target.epic.key).toBe("INGEST-142");
    expect(jira.calls.length).toBe(before);
  });

  it("a missing issue is cached as an error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rrr-rest-missing-"));
    const rest = new JiraRest(creds());
    const [issue] = await runRestLoop(dir, rest, (src) => src.getIssue("NOPE-1"));
    expect(issue).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "issues/NOPE-1.json"), "utf8")).error).toMatch(/does not exist/);
    rmSync(dir, { recursive: true, force: true });
  });
});
