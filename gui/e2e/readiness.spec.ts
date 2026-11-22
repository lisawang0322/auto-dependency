/**
 * Launch readiness with no plan of record: each team is checked for what the PRD's commitments ask of it (on the work,
 * its sign-offs done) against Jira, by the epic's release date. A launch checklist can still be added; it is never needed.
 */
import { test, expect } from "@playwright/test";

test("a PRD and Jira are enough to tell which teams are ready to launch", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByTestId("start-jira").getByRole("button", { name: "Connect Jira" }).click();
  await page.getByTestId("start-jira").getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and run the review" }).click({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 15_000 });

  // The suggestion runs the check at once; a checklist is the quieter alternative.
  const next = page.getByTestId("next-up");
  await expect(next).toContainText("Ready to launch?");
  await expect(next.getByRole("button", { name: "Add a launch checklist" })).toBeVisible();
  await next.getByRole("button", { name: "Check launch readiness" }).click();
  await expect(page.getByRole("heading", { name: "Launch Nov 20: not ready" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("phase")).toHaveText("Preparing to launch");
  await expect(page.getByTestId("path-launch")).toHaveClass(/done/);
  await expect(page.getByTestId("ready-count")).toHaveText("2 of 9");
  await expect(page.getByTestId("readiness-tile")).toContainText("6 blocking · 1 at risk");

  // Each team says why, grouped worst first; every team is due now, nothing is "coming up".
  await expect(page.getByTestId("coming-up")).toHaveCount(0);
  await expect(page.getByTestId("role-blocking").getByTestId("coverage-QA").getByTestId("readiness-why")).toHaveText("Nobody on the work · QA sign-off has no owner (INGEST-170)");
  const security = page.getByTestId("role-at_risk").getByTestId("coverage-Security");
  await expect(security.getByTestId("readiness")).toHaveText("At risk");
  await expect(security.getByTestId("readiness-why")).toHaveText("Security review in progress (SEC-881)");
  await expect(page.getByTestId("role-ready").getByTestId("coverage-Data Platform").getByTestId("readiness-why")).toHaveText("On the work");

  // Dropping a team takes it out of the count, and it stays on the page to reopen.
  const legal = page.getByTestId("coverage-Legal");
  await legal.getByRole("button", { name: "Drop Legal", exact: true }).click();
  await legal.getByLabel("Why drop Legal", { exact: true }).fill("No new contract terms");
  await legal.getByRole("button", { name: "Drop", exact: true }).click();
  await expect(page.getByTestId("ready-count")).toHaveText("2 of 8");
  await expect(page.getByTestId("role-dropped").getByTestId("coverage-Legal")).toBeVisible();

  // Kept with the project, and recorded as what it was.
  await page.reload(); // the address is the project's: it opens again as it was
  await expect(page.getByRole("heading", { name: "Launch Nov 20: not ready" })).toBeVisible();
  await page.getByTestId("project-links").getByRole("button", { name: /^History/ }).click();
  await expect(page.getByTestId("history")).toContainText("Launch readiness · INGEST-142");
  await page.getByRole("button", { name: "‹ Overview" }).first().click();

  // A checklist is still welcome: offered on the page, in the same dialog.
  await page.getByRole("button", { name: "Add it" }).click();
  await expect(page.getByRole("dialog", { name: "Add a launch checklist" })).toBeVisible();
});
