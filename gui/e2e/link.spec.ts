/**
 * A team the reading could not find on the work is not always missing: its Jira project may be named so the reading cannot
 * tie it to the team. The person links the project on the team's card and the review checks again with it.
 */
import { test, expect } from "@playwright/test";

test("linking a missed team's Jira project by hand re-checks it: UX's screens are in Product Design", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByTestId("start-jira").getByRole("button", { name: "Connect Jira" }).click();
  await page.getByTestId("start-jira").getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and run the review" }).click({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 15_000 });

  const ux = page.getByTestId("coverage-UX");
  await expect(ux).toContainText("Missing");
  await expect(page.getByTestId("actions-count")).toHaveText("7 open · 0 done");
  const link = page.getByTestId("team-link-UX");
  await expect(link).toContainText("The reading may have missed the team's Jira project");
  await link.getByRole("button", { name: "Link its Jira project" }).click();
  await link.getByLabel("Jira project for UX").selectOption("DSGN");
  await link.getByRole("button", { name: "Link and re-check" }).click();

  // The review runs again with the link: UX is on the work, its "bring UX onto the work" action is gone.
  await expect(ux).toContainText("DSGN-31 linked · Mira Santos", { timeout: 15_000 });
  await expect(ux).not.toContainText("Missing");
  await expect(page.getByTestId("team-link-UX")).toContainText("Linked by you: DSGN");
  await expect(page.getByTestId("actions-count")).toHaveText("6 open · 0 done");
  // A covered team without a link offers nothing to fix.
  await expect(page.getByTestId("team-link-Security")).toHaveCount(0);

  // Unlinking goes back to what the reading found.
  await page.getByTestId("team-link-UX").getByRole("button", { name: "Unlink" }).click();
  await expect(ux).toContainText("Missing", { timeout: 15_000 });
});
