import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOCS = resolve(import.meta.dirname, "../../fixtures/ingest-142/docs");
const POR = { name: "Ingestion-service-POR-v3.md", mimeType: "text/markdown", buffer: readFileSync(resolve(DOCS, "Ingestion-service-POR-v3.md")) };
const CHECKS = { name: "launch-checklist.csv", mimeType: "text/csv", buffer: readFileSync(resolve(DOCS, "launch-checklist.csv")) };

/** Step 1: the stage picker. */
async function pickLaunching(page: Page) {
  await expect(page.getByRole("heading", { name: "Where is your project right now?" })).toBeVisible();
  const cont = page.getByRole("button", { name: "Continue" });
  await expect(cont).toBeDisabled();
  await expect(page.getByRole("radio", { name: /Just starting/ })).toBeEnabled();
  await page.getByRole("radio", { name: /Preparing to launch/ }).check();
  const prep = page.getByTestId("prep");
  await expect(prep).toContainText("Plan of record (doc or slides)");
  await expect(prep).toContainText("Access to Jira and the release epic");
  await expect(prep.locator(".need")).toHaveCount(4);
  await expect(page.getByTestId("stage-chip")).toHaveText("Stage: Preparing to launch");
  await cont.click();
}

/** Step 3: the simulated Jira consent. */
async function connectJira(page: Page) {
  await page.getByRole("button", { name: "Connect Jira" }).click();
  await expect(page.getByRole("dialog")).toContainText("Create, edit, comment on or move issues");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-jira").getByTestId("app-state")).toHaveText(/Connected · read-only/);
}

test("walks get started → your plan → connect apps (resolving SEC) → next steps", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await pickLaunching(page);

  // Step 2: upload the POR and the checklist but no team list, so Security will be ambiguous.
  await expect(page.getByRole("heading", { name: "Add what you have" })).toBeVisible();
  const confirm = page.getByRole("button", { name: "Confirm and connect apps" });
  await expect(confirm).toBeDisabled();
  await page.locator("#plan-files").setInputFiles([POR, CHECKS]);
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(0)).toHaveValue("plan");
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(1)).toHaveValue("checks");
  await expect(page.getByText("4 plan items · 1 approval · 2 dependencies")).toBeVisible();
  await expect(page.getByText("9 checks · 3 apply to this release")).toBeVisible();
  await expect(page.getByText("Not found — you'll get team names, not people.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible();
  const rows = page.locator(".plan-table tbody tr");
  await expect(rows).toHaveCount(7);
  await page.getByRole("button", { name: "Show source" }).nth(3).click();
  await expect(page.getByTestId("quote-p4")).toContainText("SRE capacity and on-call will be in place the week before launch.");
  // inferred date is flagged until edited
  await expect(page.getByText("is a guess. Confirm the date.")).toHaveCount(4); // SRE item + 3 relative checklist dates
  await expect(page.getByText('POR says "the week before launch" — Nov 13 is a guess. Confirm the date.')).toBeVisible();
  await page.getByLabel("Due date for SRE capacity and on-call in place").fill("2026-11-12");
  await expect(page.getByText("is a guess. Confirm the date.")).toHaveCount(3);
  await expect(page.getByText("Edited · was Nov 13")).toBeVisible();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // Step 3: the gallery. Jira is required; apps the company has not enabled are greyed out; the rest are shown only.
  await expect(page.getByRole("heading", { name: "Connect the tools your teams use" })).toBeVisible();
  await expect(page.getByTestId("app-jira")).toContainText("Required");
  await expect(page.getByTestId("app-directory")).toContainText("Recommended");
  await expect(page.getByTestId("app-asana").getByTestId("app-state")).toHaveText("Not enabled by your company");
  await expect(page.getByTestId("app-confluence").getByTestId("app-state")).toHaveText("Shown for the design · not built yet");
  await expect(page.getByRole("button", { name: "Unavailable Confluence" })).toBeDisabled();
  const run = page.getByRole("button", { name: "Run readiness review" });
  await expect(run).toBeDisabled();
  await expect(page.getByText("Connect Jira to continue")).toBeVisible();
  await connectJira(page);
  await expect(page.getByRole("heading", { name: "Which work in Jira is this?" })).toBeVisible();
  await page.getByRole("button", { name: "Use INGEST-142" }).click();
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
  await expect(page.getByText("Step 4 · next steps · Preparing to launch")).toBeVisible();
  await expect(page.getByTestId("release-status")).toHaveText("Amber");
  await expect(page.getByTestId("open-findings")).toHaveText("4");

  // Next actions (R16): one per shown finding, tickable, with who / when / why.
  const actions = page.getByTestId("next-actions");
  await expect(actions.getByRole("checkbox")).toHaveCount(4);
  await expect(page.getByTestId("actions-count")).toHaveText("4 open · 0 done");
  await expect(actions).toContainText("Ask Security to get SEC-881 approved and moved to Done before go/no-go (Nov 13).");
  await expect(actions).toContainText("Security");
  await actions.getByRole("checkbox").first().check();
  await expect(page.getByTestId("actions-count")).toHaveText("3 open · 1 done");

  await expect(page.getByText("1 weak finding hidden")).toBeVisible();
  await expect(page.getByText(/claimed in a comment only/)).toHaveCount(0);
  await page.getByRole("button", { name: "Show weak" }).click();
  await expect(page.getByTestId("team-INGEST").getByText(/claimed in a comment only/)).toBeVisible();
  await expect(actions.getByRole("checkbox")).toHaveCount(5);
  await page.getByRole("button", { name: "Hide weak" }).click();

  // Keep the security finding: it stays in the actions, marked kept; the detail shows its suggested next action.
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(page.getByRole("heading", { name: /Approval still open: Security review approved/ })).toBeVisible();
  const detail = page.getByRole("region", { name: "Finding detail" });
  await expect(detail.getByTestId("suggested-action")).toContainText("Ask Security to get SEC-881 approved");
  await expect(detail.getByText("SEC-881", { exact: true })).toBeVisible();
  await expect(detail.getByText(/In Review · due 2026-11-14 · linked to INGEST-142 \(is blocked by\)/)).toBeVisible();
  await expect(detail.getByText("Source: POR §4")).toBeVisible();
  await expect(detail.getByText("(inferred from Jira assignee)")).toBeVisible();
  await page.getByRole("button", { name: "Keep — add to my actions" }).click();
  await expect(actions.getByRole("checkbox")).toHaveCount(4);
  await expect(actions.locator(".action-row").first()).toContainText("· kept");
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
  await expect(actions.getByRole("checkbox")).toHaveCount(3);
  await expect(page.getByTestId("actions-count")).toHaveText("2 open · 1 done");
  await expect(page.getByRole("heading", { name: "Decision log" })).toBeVisible();
  await expect(page.locator(".log-row").first()).toContainText("Dismissed \"No ticket for: Rollback plan documented\" — Rollback is covered by the feature flag");

  // The SRE finding shows its linkage gap; the other gap is listed separately.
  await page.getByRole("button", { name: /SRE-412 is due 2026-11-22, after launch/ }).click();
  await expect(page.getByText(/Linkage gap: INGEST-142 isn't linked to SRE-412/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Other linkage gaps" })).toBeVisible();
  await expect(page.getByText("Raise ingestion cluster quota")).toBeVisible();

  // Earlier run is read-only and keeps its own status; the actions stay those of the latest run.
  const runSwitcher = page.getByRole("group", { name: "Status by run" });
  await expect(runSwitcher.getByRole("button", { name: /Nov 13 · latest · Amber/ })).toBeVisible();
  await runSwitcher.getByRole("button", { name: /Nov 10 · Amber/ }).click();
  await expect(page.getByText("Earlier run, shown read-only.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /10 days out/ })).toBeVisible();
  await expect(page.getByText("Actions come from the latest run (Nov 13).")).toBeVisible();
  await expect(page.getByTestId("team-SRE").getByTestId("team-status")).toHaveText("On track");
  await expect(page.getByTestId("team-SRE")).toContainText("First run");
  await runSwitcher.getByRole("button", { name: /Nov 13 · latest/ }).click();
  await expect(page.getByTestId("team-SRE")).toContainText("Since Nov 10: On track → Late");

  // The footer leads back to the earlier steps.
  await page.getByRole("button", { name: "Change stage" }).click();
  await expect(page.getByRole("heading", { name: "Where is your project right now?" })).toBeVisible();
  await page.getByRole("button", { name: "4. Next steps" }).click();
  await expect(page.getByRole("heading", { name: /7 days out/ })).toBeVisible();

  // Decisions and ticks survive a reload (localStorage), and the kept finding can be reopened.
  await page.reload();
  await page.goto("/?fast=1&backend=sample");
  await pickLaunching(page);
  await page.getByRole("button", { name: "Use sample files" }).click();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();
  await connectJira(page);
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Covered by team-list.yaml from your files");
  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("From your team list").first()).toBeVisible();
  await page.getByRole("button", { name: "Run readiness review" }).click();
  await expect(page.getByRole("heading", { name: /7 days out/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("actions-count")).toHaveText("2 open · 1 done");
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(page.getByRole("region", { name: "Finding detail" }).getByText("(from your team list)")).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByRole("button", { name: "Keep — add to my actions" })).toBeVisible();
});

test("connecting the employee directory stands in for a team list, and disconnecting it undoes that", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await pickLaunching(page);
  await page.locator("#plan-files").setInputFiles([POR]);
  await expect(page.getByText("Owners: inferred from Jira")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();
  await connectJira(page);
  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("Unresolved — pick one")).toBeVisible();

  await page.getByRole("button", { name: "Connect Employee directory" }).click();
  await expect(page.getByRole("dialog")).toContainText("Read names, titles, teams and reporting lines");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · directory.yaml");
  await expect(page.getByText("From your team list").first()).toBeVisible();
  await expect(page.getByText("4 of 4 teams resolved")).toBeVisible();

  // The directory shows up on the plan step as a file it added, and owners now come from it.
  await page.getByRole("button", { name: "2. Your plan" }).click();
  await expect(page.getByText("via Employee directory")).toBeVisible();
  await expect(page.getByText("Owners: from your directory")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();

  await page.getByRole("button", { name: "Disconnect Employee directory" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Not connected");
  await expect(page.getByText("Unresolved — pick one")).toBeVisible();
  await expect(page.getByRole("button", { name: "3. Connect apps" })).toBeEnabled();
});

test("works at phone width with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?fast=1&backend=sample");
  await pickLaunching(page);
  await page.getByRole("button", { name: "Use sample files" }).click();
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible();
  // No horizontal page scroll: the plan table scrolls inside its own wrapper.
  const scrolled = await page.evaluate(() => { window.scrollTo(10000, 0); return window.scrollX; });
  expect(scrolled).toBe(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  const btn = page.getByRole("button", { name: "Confirm and connect apps" });
  const box = await btn.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await btn.click();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
});
