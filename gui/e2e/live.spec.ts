/**
 * Live mode end to end: the GUI → the local API server → a fake Jira Cloud (served from the fixture
 * snapshot) → saved run → review screen. No sample-data shortcuts: files are really uploaded and parsed,
 * the epic is really looked up, and the findings come from the analyzer.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeJira, type FakeJira } from "../../skills/release-reader/tests/fake-jira";
import { startServer } from "../../server/index";

const ROOT = resolve(import.meta.dirname, "../..");
const DOCS = join(ROOT, "fixtures/ingest-142/docs");
const file = (name: string, mimeType: string) => ({ name, mimeType, buffer: readFileSync(join(DOCS, name)) });

let jira: FakeJira, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
// One server on the proxied port 8787, so playwright.config.ts runs this file in the desktop project only.
test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "rrr-live-e2e-"));
  jira = await startFakeJira(join(ROOT, "fixtures/ingest-142/jira/2026-11-13"));
  srv = await startServer({ port: 8787, quiet: true, creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), sampleDocs: DOCS, guiDist: join(tmp, "nodist") });
});
test.afterAll(async () => { await srv?.close(); await jira?.close(); rmSync(tmp, { recursive: true, force: true }); });

test("uploads real files, connects with a token, reads Jira and reviews", async ({ page }) => {
  await page.goto("/?backend=live");
  await expect(page.locator(".tag")).toHaveText(/Live/);

  // Step 1: real uploads, really parsed by Stage A.
  await page.locator("#plan-files").setInputFiles([file("Ingestion-service-POR-v3.md", "text/markdown"), file("launch-checklist.csv", "text/csv"), file("team-list.yaml", "application/yaml")]);
  await expect(page.getByRole("heading", { name: "Extracted plan" })).toBeVisible();
  await expect(page.locator(".plan-table tbody tr")).toHaveCount(7);
  await expect(page.getByText("Owners: from your files")).toBeVisible();
  await page.getByRole("button", { name: "Confirm plan and connect Jira" }).click();

  // Step 2: credentials form → the server checks them against Jira.
  await page.getByRole("button", { name: "Connect to Jira" }).click();
  await page.getByRole("textbox", { name: "Site" }).fill(jira.url);
  await page.getByLabel("Atlassian account email").fill("me@example.com");
  await page.getByLabel("API token").fill("wrong");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("rejected the credentials");
  await page.getByLabel("API token").fill("secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected to Jira")).toBeVisible();
  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("Found in Jira", { exact: true })).toBeVisible();
  await expect(page.getByText("4 of 4 teams resolved")).toBeVisible();
  await expect(page.getByText("From your team list").first()).toBeVisible();

  // Run: Stage C over REST, analyzer, status, saved run.
  await page.getByRole("button", { name: "Run review" }).click();
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("open-findings")).toHaveText("4");
  await expect(page.getByTestId("team-SRE").getByTestId("team-status")).toHaveText("Late");
  await expect(page.getByTestId("team-SRE")).toContainText("First run");
  await expect(page.getByRole("button", { name: /Approval still open: Security review approved/ })).toBeVisible();
  await expect(page.getByText("Raise ingestion cluster quota")).toBeVisible();
});
