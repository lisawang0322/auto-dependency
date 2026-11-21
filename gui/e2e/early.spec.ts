/**
 * The early stages in sample mode: "Just starting" (PRD → teams, contacts, approvals, actions) and
 * "Team forming, work underway" (PRD + Jira → team coverage and approval status). The sample outputs
 * were built from the same throughline-starter code the live server runs.
 */
import { test, expect, type Page } from "@playwright/test";

async function pickStage(page: Page, name: RegExp) {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("radio", { name }).check();
  await page.getByRole("button", { name: "Continue" }).click();
}

async function connectJira(page: Page) {
  await page.getByRole("button", { name: "Connect Jira" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-jira").getByTestId("app-state")).toHaveText(/Connected · read-only/);
}

test("just starting: PRD signals → who to involve, then a directory adds names", async ({ page }) => {
  await pickStage(page, /Just starting/);
  await expect(page.getByText("A PRD or one-pager is enough to start. Add an org chart if you have one.")).toBeVisible();

  // Step 2: the sample PRD and the signals read from it; untick the customer-data sentence.
  await page.getByRole("button", { name: "Use sample files" }).click();
  await expect(page.getByRole("combobox", { name: "Read as" })).toHaveValue("prd");
  await page.getByTestId("agent-read").click();
  await expect(page.getByText("6 lines point to a team or an approval")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What we read in your PRD" })).toBeVisible();
  const signals = page.getByTestId("signals");
  await expect(signals.getByRole("checkbox")).toHaveCount(6);
  await expect(signals).toContainText("Stores raw customer event data for 90 days");
  await expect(signals).toContainText("§3 Data · points to Privacy, Legal");
  await signals.locator("#sig-g4").uncheck();
  await expect(page.getByRole("heading", { name: "Plan we read" })).toHaveCount(0);
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();

  // Step 3: nothing is required at this stage.
  await expect(page.getByText("Nothing is required at your stage")).toBeVisible();
  await expect(page.getByTestId("app-jira")).not.toContainText("Required");
  await expect(page.getByText("Connecting your directory turns team suggestions into names.")).toBeVisible();
  const run = page.getByRole("button", { name: "Find who to involve" });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByRole("heading", { name: "Reading your PRD…" })).toBeVisible();

  // Step 4: next actions, stakeholder map, teams to involve, approvals; Privacy and Legal are gone with their signal.
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Review · Just starting")).toBeVisible();
  await expect(page.getByText("Connect your employee directory to see who to contact on each team.")).toBeVisible();
  await expect(page.getByTestId("teams-to-involve").locator(".card")).toHaveCount(7);
  await expect(page.getByTestId("involve-Privacy")).toHaveCount(0);
  await expect(page.getByTestId("role-core").getByTestId("involve-Data Platform")).toBeVisible(); // grouped under "Work with closely"
  await expect(page.getByTestId("role-core")).toContainText("Work with closely");
  await expect(page.getByTestId("involve-Data Platform")).toContainText("Data Platform lead — connect your directory for a name");
  await expect(page.getByTestId("stakeholder-map")).toContainText("connect your directory for a name");
  await expect(page.getByTestId("approvals")).toContainText("Security review");
  await expect(page.getByTestId("approvals")).not.toContainText("Privacy review");
  await expect(page.getByTestId("actions-count")).toHaveText("7 open · 0 done");
  await page.getByTestId("involve-Data Platform").getByRole("button", { name: "Mark contacted" }).click();
  await expect(page.getByTestId("involve-Data Platform").getByRole("button", { name: "Contacted" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("next-actions").getByRole("checkbox").first().check();
  await expect(page.getByTestId("actions-count")).toHaveText("6 open · 1 done");

  // Connect the directory from the nudge and run again: contacts appear, the tick and the contact survive.
  await page.getByRole("button", { name: "Connect directory" }).click();
  await page.getByRole("button", { name: "Connect Employee directory" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · directory.yaml");
  await page.getByRole("button", { name: "Find who to involve" }).click();
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Connect your employee directory to see who to contact on each team.")).toHaveCount(0);
  await expect(page.getByTestId("involve-Data Platform")).toContainText("Wei Zhang · eng lead");
  await expect(page.getByTestId("involve-Data Platform").getByRole("button", { name: "Contacted" })).toBeVisible();
  await expect(page.getByTestId("actions-count")).toHaveText("6 open · 1 done");
  await expect(page.getByTestId("next-actions")).toContainText("Wei Zhang (Data Platform)");
});

test("building: PRD + Jira → which needed teams are missing and which approvals have no ticket or owner", async ({ page }) => {
  await pickStage(page, /Team forming/);
  await page.getByRole("button", { name: "Use sample files" }).click();
  await page.getByTestId("agent-read").click();
  await expect(page.getByTestId("signals").getByRole("checkbox")).toHaveCount(6);
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();

  // Step 3: Jira is required; the needed teams and their projects show once the epic is found.
  await expect(page.getByText(/Jira is required for your stage/)).toBeVisible();
  await expect(page.getByTestId("app-jira")).toContainText("Required");
  const run = page.getByRole("button", { name: "Check my team and approvals" });
  await expect(run).toBeDisabled();
  await connectJira(page);
  // The plan names one epic, so the field is filled in already.
  await expect(page.getByText("Found in Jira (sample data)")).toBeVisible();
  await expect(page.getByTestId("needed-teams")).toContainText("3 of 9 have a Jira project");
  await expect(page.getByTestId("needed-teams")).toContainText("Privacy → assignee only");
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByRole("heading", { name: "Reading your plan and Jira…" })).toBeVisible();

  // Step 4: coverage and approvals.
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("covered-count")).toHaveText("3 of 9");
  await expect(page.getByTestId("not-started-count")).toHaveText("3 of 5");
  await expect(page.getByTestId("coverage-Security")).toContainText("Covered");
  await expect(page.getByTestId("coverage-Security")).toContainText("SEC-881 linked");
  await expect(page.getByTestId("coverage-Privacy")).toContainText("Missing");
  await expect(page.getByTestId("coverage-Privacy")).toContainText("Privacy lead — connect your directory for a name");
  await expect(page.getByTestId("approval-QA sign-off")).toContainText("No owner");
  await expect(page.getByTestId("approval-QA sign-off")).toContainText("INGEST-170");
  await expect(page.getByTestId("approval-Security review")).toContainText("In progress");
  await expect(page.getByTestId("approval-Privacy review")).toContainText("Not started");
  await expect(page.getByTestId("actions-count")).toHaveText("10 open · 0 done");
  await expect(page.getByTestId("next-actions")).toContainText("Get an owner for INGEST-170 (Test plan for ingestion launch); the QA sign-off has no one on it");
  await expect(page.getByText("No Jira project for Privacy, Legal, UX, QA, VDR, Support: checked by assignee only.")).toBeVisible();
});
