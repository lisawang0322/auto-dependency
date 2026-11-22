import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOCS = resolve(import.meta.dirname, "../../fixtures/ingest-142/docs");
const POR = { name: "Ingestion-service-POR-v3.md", mimeType: "text/markdown", buffer: readFileSync(resolve(DOCS, "Ingestion-service-POR-v3.md")) };
const CHECKS = { name: "launch-checklist.csv", mimeType: "text/csv", buffer: readFileSync(resolve(DOCS, "launch-checklist.csv")) };

/** Step 1: no stage to pick and nothing to declare; Jira is offered beside the organisation, optional, and Continue is
 *  always open. */
async function pickLaunching(page: Page) {
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByTestId("start-jira")).toContainText("Connect Jira");
  await expect(page.getByTestId("start-jira")).toContainText("connect it later");
  await expect(page.getByTestId("stage-chip")).toHaveCount(0); // nothing read yet, so nothing to say where it stands
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Step 3: the simulated Jira consent. */
async function connectJira(page: Page) {
  await page.getByRole("button", { name: "Connect Jira", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Create, edit, comment on or move issues");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-jira").getByTestId("app-state")).toHaveText(/Connected · read-only/);
}

test("walks get started → your plan → connect apps (resolving SEC) → next steps", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await pickLaunching(page);

  // Step 2: upload the POR and the checklist but no team list, so Security will be ambiguous.
  await expect(page.getByRole("heading", { name: "Add what you have" })).toBeVisible();
  const confirm = page.getByRole("button", { name: /^Confirm and / }); // its label follows what was read
  await expect(confirm).toBeDisabled();
  await page.locator("#plan-files").setInputFiles([POR, CHECKS]);
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(0)).toHaveValue("plan");
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(1)).toHaveValue("checks");
  // Nothing is read until asked: the files sit with their "Read as" and a question about Devin.
  await expect(page.getByRole("heading", { name: "Plan we read" })).toHaveCount(0);
  await expect(page.getByTestId("agent-consent")).toContainText("Devin will read these files");
  await page.getByTestId("agent-read").click();
  await expect(page.getByText("4 commitments found · 4 teams named · epic INGEST-142")).toBeVisible();
  await expect(page.getByText("3 of 9 checks apply to this release")).toBeVisible();
  await expect(page.getByText("Not found — you'll get team names, not people.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible();
  // The stakeholder map follows the reading: the four teams the plan names, none grounded (no directory, no team list yet).
  await expect(page.getByTestId("stakeholders")).toContainText("Who this involves");
  await expect(page.locator("[data-testid^=stk-]")).toHaveCount(4);
  await expect(page.getByTestId("stk-SRE")).toContainText("named in the plan only");
  await expect(page.getByTestId("stk-Security")).toContainText("1 approval");
  const rows = page.locator(".plan-table tbody tr");
  await expect(rows).toHaveCount(7);
  await page.getByRole("button", { name: "Show source" }).nth(3).click();
  await expect(page.getByTestId("quote-p4")).toContainText("SRE capacity and on-call will be in place the week before launch.");
  // inferred date is flagged until edited
  await expect(page.locator("[data-testid^=inferred-p]")).toHaveCount(4); // SRE item + 3 relative checklist dates
  await expect(page.getByTestId("inferred-note")).toContainText("4 dates were inferred");
  await page.getByLabel("Due date for SRE capacity and on-call in place").fill("2026-11-12");
  await expect(page.locator("[data-testid^=inferred-p]")).toHaveCount(3);
  await expect(page.getByText("Edited · was Nov 13")).toBeVisible();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // Step 3: the gallery. Jira is required; apps the company has not enabled are greyed out; the rest are shown only.
  await expect(page.getByRole("heading", { name: "Connect the tools your teams use" })).toBeVisible();
  await expect(page.getByTestId("app-jira")).toContainText("Required");
  await expect(page.getByTestId("app-directory")).toContainText("Recommended");
  // Apps that cannot be connected are folded away and carry no button.
  await page.getByTestId("more-apps").locator("summary").click();
  await expect(page.getByTestId("app-asana").getByTestId("app-state")).toHaveText("Not enabled by your company");
  await expect(page.getByTestId("app-confluence").getByTestId("app-state")).toHaveText("Not available yet");
  await expect(page.getByTestId("app-confluence").getByRole("button")).toHaveCount(0);
  const run = page.getByRole("button", { name: "Run the review" });
  await expect(run).toBeDisabled();
  await expect(page.getByText("Connect Jira to continue")).toBeVisible();
  await connectJira(page);
  await expect(page.getByRole("heading", { name: "Which work in Jira is this?" })).toBeVisible();
  // The plan names one epic, so the field is filled in already.
  await expect(page.locator("#epic-key")).toHaveValue("INGEST-142");
  await expect(page.getByText("Found in Jira (sample data)")).toBeVisible();
  await expect(page.getByText("25 stories · 41 comments · links into DATA, SEC, SRE")).toBeVisible();
  await expect(page.getByText("Unresolved — pick one")).toBeVisible();
  await expect(page.getByText("Choice required")).toBeVisible();
  await expect(page.getByText("3 of 4 teams resolved")).toBeVisible();
  await expect(run).toBeDisabled();
  const sec = page.getByLabel("Jira project for Security");
  await expect(sec.locator("option")).toContainText(["Choose a project…", "SEC · Security Engineering", "SECOPS · Security Operations", "Don't search this team"]);
  await sec.selectOption("SEC");
  await expect(page.getByText("Chosen by you")).toBeVisible();
  await expect(page.getByText("4 of 4 teams resolved")).toBeVisible();
  await expect(run).toBeEnabled();
  await run.click();

  // Progress, then step 4.
  await expect(page.getByRole("heading", { name: "Reading your plan and Jira…" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Launch Nov 20 · 7 days out/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Untitled project · Preparing to launch$/)).toBeVisible();
  await expect(page.getByTestId("throughline-status")).toHaveText("Amber");
  await expect(page.getByTestId("open-findings")).toHaveText("4");

  // Next actions (R16): one per shown finding, with who / when, listed in the panel. An action is marked done on its
  // finding, beside the evidence; its line in the panel opens that finding.
  const actions = page.getByTestId("next-actions");
  await expect(actions.locator(".glance-action")).toHaveCount(4);
  await expect(actions.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByTestId("actions-count")).toHaveText("4 open · 0 done");
  await expect(actions).toContainText("Ask Security to get SEC-881 approved and moved to Done before go/no-go (Nov 13).");
  await expect(actions).toContainText("Security");
  await actions.locator(".glance-action").first().getByRole("button").click();
  await page.getByTestId("suggested-action").getByRole("button", { name: "Mark done" }).click();
  await expect(page.getByTestId("suggested-action")).toContainText("✓ Done");
  await expect(page.getByTestId("actions-count")).toHaveText("3 open · 1 done");

  await expect(page.getByText("1 comment-only finding hidden")).toBeVisible();
  await expect(page.getByText(/claimed in a comment only/)).toHaveCount(0);
  await page.getByRole("button", { name: "Show comment-only" }).click();
  await expect(page.getByTestId("team-INGEST").getByText(/claimed in a comment only/)).toBeVisible();
  await expect(actions.locator(".glance-action")).toHaveCount(5);
  await page.getByRole("button", { name: "Hide comment-only" }).click();

  // Keep the security finding: it stays in the actions, marked kept; the detail shows its suggested next action.
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  const detail = page.getByRole("region", { name: "Finding detail" });
  await expect(detail.getByRole("heading", { name: /Approval still open: Security review approved/ })).toBeAttached(); // for screen readers; the row above shows it
  await expect(detail.getByTestId("suggested-action")).toContainText("Ask Security to get SEC-881 approved");
  await expect(detail.getByText("SEC-881", { exact: true })).toBeVisible();
  await expect(detail.getByText(/In Review · due 2026-11-14 · linked to INGEST-142 \(is blocked by\)/)).toBeVisible();
  await expect(detail.getByText("Source: POR §4")).toBeVisible();
  await expect(detail.getByText("(inferred from Jira assignee)")).toBeVisible();
  await page.getByRole("button", { name: "Keep — add to my actions" }).click();
  await expect(actions.locator(".glance-action")).toHaveCount(4);
  await expect(actions.locator(".glance-action").first()).toContainText("· kept");
  // Keeping moves on to the next open finding; the kept one shows its decision when reopened.
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(detail.getByText("Kept — in your next actions")).toBeVisible();

  // Dismiss the rollback finding with a required reason: it leaves the actions and the Ingestion team goes back to On track.
  const ingest = page.getByTestId("team-INGEST");
  await expect(ingest.getByTestId("team-status")).toHaveText("At risk");
  await ingest.getByRole("button", { name: /No ticket for: Rollback plan documented/ }).click();
  await expect(page.getByText("Searched INGEST, DATA, SEC and SRE for a matching ticket or linked doc.")).toBeVisible();
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeDisabled();
  await page.getByLabel("Reason for dismissing (required, logged)").fill("Rollback is covered by the feature flag");
  await dismiss.click();
  await expect(ingest.getByTestId("team-status")).toHaveText("On track");
  await expect(page.getByTestId("open-findings")).toHaveText("2");
  await expect(actions.locator(".glance-action")).toHaveCount(3);
  await expect(page.getByTestId("actions-count")).toHaveText("2 open · 1 done");
  await expect(page.getByRole("heading", { name: "Decision log" })).toBeVisible();
  await expect(page.locator(".log-row").first()).toContainText("Dismissed \"No ticket for: Rollback plan documented\" — Rollback is covered by the feature flag");

  // The SRE finding shows its linkage gap; the other gap is listed separately.
  await page.getByRole("button", { name: /SRE-412 is due 2026-11-22, after launch/ }).click();
  await expect(page.getByText(/Not linked: INGEST-142 isn't linked to SRE-412/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Related tickets not linked to the epic" })).toBeVisible();
  await expect(page.getByText("Raise ingestion cluster quota")).toBeVisible();

  // Earlier run is read-only and keeps its own status; the actions stay those of the latest run.
  const runSwitcher = page.getByRole("group", { name: "Status by run" });
  await expect(runSwitcher.getByRole("button", { name: /Nov 13 · latest · Amber/ })).toBeVisible();
  await runSwitcher.getByRole("button", { name: /Nov 10 · Amber/ }).click();
  await expect(page.getByText("Earlier run, shown read-only.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /10 days out/ })).toBeVisible();
  // The why is a tooltip: hidden until the "i" is hovered or focused.
  const why = page.getByText(/Your next actions are always the latest run's \(Nov 13\)\./);
  await expect(why).toBeHidden();
  await page.locator(".notice-grey .info-btn").first().hover();
  await expect(why).toBeVisible();
  await expect(page.getByTestId("team-SRE").getByTestId("team-status")).toHaveText("On track");
  await expect(page.getByTestId("team-SRE")).toContainText("First run");
  await runSwitcher.getByRole("button", { name: /Nov 13 · latest/ }).click();
  await expect(page.getByTestId("team-SRE")).toContainText("Since Nov 10: On track → Late");

  // The review is the project's page; where it stands is read from the plan of record, and the organisation is a step away.
  await expect(page.getByTestId("phase")).toHaveText("Preparing to launch");
  await expect(page.getByTestId("lifecycle").getByRole("button", { name: "Change stage" })).toHaveCount(0);
  await page.getByTestId("project-links").getByRole("button", { name: "Connections" }).click();
  await page.getByRole("button", { name: "‹ Overview" }).first().click();
  await expect(page.getByRole("heading", { name: /7 days out/ })).toBeVisible();

  // Decisions and ticks survive a reload (localStorage), and the kept finding can be reopened.
  await page.reload();
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await pickLaunching(page);
  await page.getByRole("button", { name: "launch documents" }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and connect Jira" }).click();
  // With the team list among the files every team resolves, so connecting Jira, the one thing missing, runs the review.
  await page.getByRole("button", { name: "Connect Jira", exact: true }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("heading", { name: /7 days out/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("actions-count")).toHaveText("2 open · 1 done");
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(page.getByRole("region", { name: "Finding detail" }).getByText("(from your team list)")).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByRole("button", { name: "Keep — add to my actions" })).toBeVisible();
});

test("connecting the employee directory stands in for a team list, and disconnecting it undoes that", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await pickLaunching(page);
  await page.locator("#plan-files").setInputFiles([POR]);
  await page.getByTestId("agent-read").click();
  await expect(page.getByText("Owners: inferred from Jira")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and connect Jira" }).click();
  await connectJira(page);
  // The plan names one epic, so the field is filled in already.
  await expect(page.getByText("Unresolved — pick one")).toBeVisible();

  await page.getByRole("button", { name: "Connect Employee directory" }).click();
  await expect(page.getByRole("dialog")).toContainText("Read names, titles, teams and reporting lines");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · directory.yaml");
  // The directory resolved Security, the last thing missing, so the review runs, with owners from the directory.
  await expect(page.getByRole("heading", { name: /7 days out/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(page.getByRole("region", { name: "Finding detail" }).getByText("(from your directory)")).toBeVisible();

  // The directory is credited for teams and people, not listed among the uploads, and owners come from it.
  await page.getByTestId("project-links").getByRole("button", { name: "Files and reading" }).click();
  await expect(page.getByText("From your organisation's directory (step 1)")).toBeVisible();
  await expect(page.locator(".file-list")).not.toContainText("Employee directory"); // a connection, not one of the uploads
  await expect(page.getByText("Owners: from your directory")).toBeVisible();

  // Disconnecting it, from Connections, undoes that: Security is unresolved again.
  await page.getByRole("button", { name: "‹ Overview" }).click();
  await page.getByTestId("project-links").getByRole("button", { name: "Connections" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · directory.yaml");
  await page.getByRole("button", { name: "Disconnect Employee directory" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Not connected");
  await expect(page.getByText("Unresolved — pick one")).toBeVisible();
});

test("works at phone width with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await pickLaunching(page);
  await page.getByRole("button", { name: "launch documents" }).click();
  await page.getByTestId("agent-read").click();
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible();
  // No horizontal page scroll: the plan table scrolls inside its own wrapper.
  const scrolled = await page.evaluate(() => { window.scrollTo(10000, 0); return window.scrollX; });
  expect(scrolled).toBe(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  const btn = page.getByRole("button", { name: "Confirm and connect Jira" });
  const box = await btn.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await btn.click();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
});

test("the employee directory connects on step 1, before any document, and grounds the teams the reading names", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await expect(page.getByTestId("start-directory-state")).toHaveText("Not connected");
  // Two layers from sign-ins the person already has, or an export; the demo simulates the first two.
  await expect(page.getByTestId("directory-sources").locator(".plain-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Use Microsoft Entra ID" }).click();
  await expect(page.getByTestId("start-directory-state")).toHaveText("Connected · read-only · Microsoft Entra ID · sample");
  await expect(page.getByTestId("source-entra")).toContainText("10 teams, 21 people");
  await page.getByRole("button", { name: "Use Jira projects" }).click();
  await expect(page.getByTestId("start-directory-state")).toHaveText("Connected · read-only · Microsoft Entra ID · sample + Jira projects · sample-company.atlassian.net");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "launch documents" }).click();
  await expect(page.getByText(/your organisation's directory/)).toBeVisible();
  await page.getByTestId("agent-read").click();
  // While Devin reads, a progress bar says how far along it is.
  await expect(page.getByRole("progressbar", { name: "Reading progress" })).toBeVisible();
  await expect(page.getByText("Owners: from your directory")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("stk-SRE")).toContainText("In your directory");
  // Reading Jira's projects connected Jira too, and the plan names the epic: nothing is left to connect, so confirming runs the review.
  await page.getByRole("button", { name: "Confirm and run the review" }).click();
  await expect(page.getByRole("heading", { name: /7 days out/ })).toBeVisible({ timeout: 15_000 });
  // Connections shows the same directory.
  await page.getByTestId("project-links").getByRole("button", { name: "Connections" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · Microsoft Entra ID · sample + Jira projects · sample-company.atlassian.net");
});

test("an export can stand in for the directory on step 1, and removing it clears the connection", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("button", { name: "Upload an export" }).click();
  await expect(page.getByRole("dialog")).toContainText("Read names, titles, teams and reporting lines");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("start-directory-state")).toHaveText("Connected · read-only · directory.yaml");
  await expect(page.getByRole("button", { name: "Use Microsoft Entra ID" })).toBeEnabled(); // layers can still be added
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("start-directory-state")).toHaveText("Not connected");
});
