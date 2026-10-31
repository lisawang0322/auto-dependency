/**
 * Live mode end to end: the GUI → the local API server → a fake Jira Cloud (served from the fixture
 * snapshot) → saved run → next steps. No sample-data shortcuts: files are really uploaded and parsed,
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

test("uploads real files, connects with a token and a directory export, reads Jira and reviews", async ({ page }) => {
  await page.goto("/?backend=live");
  await expect(page.locator(".tag")).toHaveText(/Live/);

  // Step 1: the stage.
  await page.getByRole("radio", { name: /Preparing to launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: real uploads, really parsed by Stage A. No team list yet.
  await page.locator("#plan-files").setInputFiles([file("Ingestion-service-POR-v3.md", "text/markdown"), file("launch-checklist.csv", "text/csv")]);
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible();
  await expect(page.locator(".plan-table tbody tr")).toHaveCount(7);
  await expect(page.getByText("Owners: inferred from Jira")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();

  // Step 3: credentials form → the server checks them against Jira.
  await page.getByRole("button", { name: "Connect Jira" }).click();
  await page.getByRole("textbox", { name: "Site" }).fill(jira.url);
  await page.getByLabel("Atlassian account email").fill("me@example.com");
  await page.getByLabel("API token").fill("wrong");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("rejected the credentials");
  await page.getByLabel("API token").fill("secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("app-jira").getByTestId("app-state")).toHaveText(/Connected · read-only/);

  // The employee directory: in live mode an export file stands in for the connector.
  await page.getByRole("button", { name: "Connect Employee directory" }).click();
  await expect(page.getByRole("button", { name: "Accept" })).toBeDisabled();
  await page.locator("#directory-file").setInputFiles(file("team-list.yaml", "application/yaml"));
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · team-list.yaml");

  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("Found in Jira", { exact: true })).toBeVisible();
  await expect(page.getByText("4 of 4 teams resolved")).toBeVisible();
  await expect(page.getByText("From your team list").first()).toBeVisible();

  // Run: Stage C over REST, analyzer, status, saved run.
  await page.getByRole("button", { name: "Run readiness review" }).click();
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("open-findings")).toHaveText("4");
  await expect(page.getByTestId("next-actions").getByRole("checkbox")).toHaveCount(4);
  await expect(page.getByTestId("team-SRE").getByTestId("team-status")).toHaveText("Late");
  await expect(page.getByTestId("team-SRE")).toContainText("First run");
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(page.getByRole("region", { name: "Finding detail" }).getByText("(from your directory)")).toBeVisible();
  await expect(page.getByText("Raise ingestion cluster quota")).toBeVisible();
});

test("building stage over the API: PRD + directory upload, the real epic, coverage and approvals", async ({ page }) => {
  await page.goto("/?backend=live");
  await page.getByRole("radio", { name: /Team forming/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#plan-files").setInputFiles([file("ingestion-service-PRD.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), file("directory.yaml", "application/yaml")]);
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(0)).toHaveValue("prd");
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(1)).toHaveValue("teams");
  await expect(page.getByTestId("signals").getByRole("checkbox")).toHaveCount(6);
  await expect(page.getByText("10 teams · 21 people")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();

  // Jira is still connected on the server from the first test; otherwise connect as before.
  const state = page.getByTestId("app-jira").getByTestId("app-state");
  if (!/Connected/.test(await state.textContent() ?? "")) {
    await page.getByRole("button", { name: "Connect Jira" }).click();
    await page.getByRole("textbox", { name: "Site" }).fill(jira.url);
    await page.getByLabel("Atlassian account email").fill("me@example.com");
    await page.getByLabel("API token").fill("secret");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await expect(state).toHaveText(/Connected · read-only/);
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Covered by directory.yaml from your files");
  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("Found in Jira", { exact: true })).toBeVisible();
  await expect(page.getByTestId("needed-teams")).toContainText("3 of 9 have a Jira project");
  await page.getByRole("button", { name: "Check my team and approvals" }).click();
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("covered-count")).toHaveText("3 of 9");
  await expect(page.getByTestId("coverage-Privacy")).toContainText("Ken Adeyemi · privacy counsel");
  await expect(page.getByTestId("approval-QA sign-off")).toContainText("INGEST-170");
  await expect(page.getByTestId("next-actions")).toContainText("Ken Adeyemi (Privacy)");
});
