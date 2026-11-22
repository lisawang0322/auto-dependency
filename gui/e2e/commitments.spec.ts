import { test, expect, type Page } from "@playwright/test";

/**
 * Commitments (PRD "Commitments: one list the checks share"): one project growing on the sample, by what is added to it.
 * The Security review the PRD implies is carried from the first review to launch, Jira finds its ticket, the launch
 * finding says where it was first written down, and an approval the PM drops early stays dropped.
 */

/** Adds a sample set on the files step, reads it and confirms; when nothing is left to connect, confirming runs the review. */
const read = async (page: Page, set: "a PRD" | "launch documents") => {
  await page.getByRole("button", { name: set, exact: true }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: /^Confirm and/ }).click();
};

test("a commitment is carried from the PRD to launch, and a drop holds", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Ingestion service");
  await page.getByRole("button", { name: "Continue" }).click();
  await read(page, "a PRD");
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });

  // The PRD's teams and approvals are the project's first commitments, each on its team's card.
  // The panel holds the checklist: one line per action, each leading to its team's card.
  const glance = page.getByTestId("next-actions");
  await expect(glance.locator(".glance-action")).toHaveCount(6); // due now; VDR, Legal and Support are coming up
  await expect(glance.getByRole("button", { name: "Go to Security" })).toBeVisible();
  const security = page.getByTestId("involve-Security");
  await expect(security).toContainText("Security review");
  await expect(security).toContainText("Committed since Starting · ingestion-service-PRD.md §2 Scope");

  // The PM drops one approval on its team's card, with a reason; Legal is coming up, so its card opens from that list.
  await page.getByTestId("later-Legal").locator("summary").click();
  const legal = page.getByTestId("involve-Legal");
  await legal.getByRole("button", { name: "Drop Legal review" }).click();
  await legal.getByLabel("Why drop Legal review").fill("No new contract terms");
  await legal.getByRole("button", { name: "Drop", exact: true }).click();
  await expect(legal).toContainText("Dropped: No new contract terms");
  await expect(legal).toContainText("Dropped: No new contract terms");

  // With Jira: the same commitments, now checked against the work. SEC-881 carries the Security review; the drop holds.
  await page.getByTestId("next-up").getByRole("button", { name: "Connect Jira" }).click();
  await page.getByRole("button", { name: "Connect Jira", exact: true }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  const secCard = page.getByTestId("coverage-Security");
  await expect(secCard).toBeVisible({ timeout: 15_000 });
  await expect(secCard).toContainText("SEC-881");
  await expect(secCard).toContainText("Tracked");
  await expect(secCard).toContainText("since Starting");
  await page.getByTestId("later-Legal").locator("summary").click(); // before beta: still coming up while building
  await expect(page.getByTestId("coverage-Legal")).toContainText("Dropped: No new contract terms");
  await expect(page.getByTestId("coverage-QA")).toContainText("No owner");
  await expect(glance.getByRole("button", { name: "Go to QA" })).toHaveCount(2); // QA's two actions, both on its card
  await expect(glance).toContainText("Get an owner for INGEST-170");

  // With the plan of record: the POR's "Security review approved" is the same commitment, and its finding says so.
  // Added in a dialog over the project, not on the files page: reading it runs the review with every check.
  await page.getByTestId("next-up").getByRole("button", { name: "Add a launch checklist" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a launch checklist" });
  await expect(dialog.getByTestId("por-read")).toBeDisabled();
  await dialog.getByRole("button", { name: "the sample launch documents" }).click();
  await dialog.getByTestId("por-read").click();
  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(page.getByTestId("commitment-since")).toContainText("Committed since Starting · ingestion-service-PRD.md §2 Scope");
  await expect(page.getByTestId("commitment-since")).toContainText("new public API");

  // One review with every check: the launch card for Security carries what the PRD and Jira say about it.
  const secFacts = page.getByTestId("prd-facts-Security");
  await expect(secFacts).toContainText("Signs off: Security review");
  await expect(secFacts).toContainText("Covered");
  await expect(secFacts).toContainText("Jordan Blake");
  // The teams only the PRD names are cards too, after the launch teams; the drop still holds there.
  const prdTeams = page.getByTestId("prd-teams");
  await expect(prdTeams).toContainText("Also in your PRD");
  await expect(prdTeams.getByTestId("coverage-QA")).toContainText("No owner");
  await expect(prdTeams.getByTestId("coverage-Legal")).toContainText("Dropped: No new contract terms");
  await expect(prdTeams.getByTestId("coverage-Security")).toHaveCount(0); // on its launch card instead
  // The checklist holds both: the launch findings' actions and the PRD's.
  await expect(glance.getByRole("button", { name: "Go to SRE" }).first()).toBeVisible();
  await expect(glance).toContainText("Get an owner for INGEST-170");
  await expect(page.getByTestId("actions-count")).toHaveText(/^14 open/);
});
