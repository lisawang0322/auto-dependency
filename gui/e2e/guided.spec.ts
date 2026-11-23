/**
 * Setup without stages or declarations: Jira is an optional connection on step 1, like the organisation; the files are
 * uploaded as they are and read for what they are; confirming runs whatever can run, and the panel shows the path.
 */
import { test, expect } from "@playwright/test";

test("Jira connected on step 1 is used at once: the first review includes who is on the work", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  const jiraCard = page.getByTestId("start-jira");
  await expect(jiraCard).toContainText("connect it later");
  await jiraCard.getByRole("button", { name: "Connect Jira" }).click();
  await jiraCard.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("start-jira-state")).toContainText("Connected · read-only");
  await page.getByRole("button", { name: "Continue" }).click();

  // Files: nothing to sort or tick; the reading works out what each file is.
  await expect(page.getByText("Anything that describes the project, in any format.")).toBeVisible();
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and run the review" }).click({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("path-involve")).toHaveClass(/done/);
  await expect(page.getByTestId("path-coverage")).toHaveClass(/done/);
  await expect(page.getByTestId("path-launch")).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("next-up")).toContainText("Ready to launch?");
  // Its why is a tooltip, kept inside the panel, which scrolls and would cut it off.
  await page.getByTestId("next-up").locator(".info-btn").hover();
  const tip = page.getByTestId("next-up").locator(".info-tip");
  await expect(tip).toBeVisible();
  const [t, g] = [await tip.boundingBox(), await page.locator(".glance").boundingBox()];
  expect(t!.x).toBeGreaterThanOrEqual(g!.x);
  expect(t!.x + t!.width).toBeLessThanOrEqual(g!.x + g!.width);

  // Adding a launch checklist is a dialog over the project; leaving it changes nothing.
  await page.getByTestId("next-up").getByRole("button", { name: "Add a launch checklist" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a launch checklist" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("next-up").getByRole("button", { name: "Add a launch checklist" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible();
});

test("Jira skipped: a PRD and a plan of record review what they can now; Jira is offered next, not required", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByRole("button", { name: "launch documents" }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and run the review" }).click({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("path-involve")).toHaveClass(/done/);
  await expect(page.getByTestId("path-coverage")).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("path-launch")).toHaveClass(/later/);
  await expect(page.getByTestId("next-up")).toContainText("See who's actually on the work");
});
