/**
 * The portal: projects are kept and come back. Sample mode keeps them in the browser; live mode on the server
 * (server/projects.test.ts covers that side, files included).
 */
import { test, expect } from "@playwright/test";

test("a project is kept across visits: home, reopen without re-reading, history, the next stage, delete", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByTestId("no-projects")).toBeVisible();

  // A new project, named, set up and reviewed.
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Ingestion service");
  await page.getByRole("radio", { name: /Just starting/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Use sample files" }).click();
  await page.getByTestId("agent-read").click();
  await expect(page.getByRole("heading", { name: "What we read in your PRD" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();
  await page.getByRole("button", { name: "Find who to involve" }).click();
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });

  // Once reviewed it is a workspace: an overview, the places to keep it current, and where it is in its life.
  const nav = page.getByRole("navigation", { name: "Project" });
  await expect(nav.getByRole("button")).toHaveText(["Overview", "Files and plan", "Connections", "Stage and organisation", "History"]);
  await expect(page.getByTestId("lifecycle")).toContainText("Just starting");
  await expect(page.getByTestId("save-state")).toHaveText("Saved");

  // Home: the card says where it is and what is open.
  await page.getByRole("button", { name: "‹ All projects" }).click();
  const card = page.getByTestId("project-Ingestion service");
  await expect(card).toContainText("Just starting");
  await expect(card).toContainText("9 open actions");
  await expect(card).toContainText("9 teams to involve");

  // A reload keeps it; opening it lands on the overview with nothing read again.
  await page.reload();
  await page.getByRole("button", { name: "Open Ingestion service" }).click();
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible();
  await expect(page.getByTestId("agent-reading")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/p\/p\w+$/);

  // History: the review kept as a record, with what it found, among the events; newest first.
  await nav.getByRole("button", { name: "History" }).click();
  const history = page.getByTestId("history");
  const record = page.getByTestId("record-starting");
  await expect(record).toContainText("Who to involve");
  await expect(record).toContainText("9 open actions");
  await expect(record).toContainText("9 teams to involve");
  await expect(record).toContainText("current");
  await expect(history).toContainText("Devin read 1 file");
  await expect(history.locator("li").last()).toContainText("Project created");

  // The next stage keeps the files and asks for what it needs.
  await nav.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Move to building" }).click();
  await expect(page.getByTestId("plan-notice")).toContainText("Your files and connections are kept");
  await expect(page.getByTestId("stage-chip")).toHaveText("Stage: Building");
  await expect(page.locator(".file-row .name")).toHaveText(["ingestion-service-PRD.md"]); // the file is kept
  await expect(page.getByRole("heading", { name: "What we read in your PRD" })).toHaveCount(0); // its reading was for the last stage

  // The just-starting review is still there, as it was, and opens read-only.
  await nav.getByRole("button", { name: "History" }).click();
  await expect(record).not.toContainText("current");
  await expect(history).toContainText("Moved from Just starting to Building");
  await record.getByRole("button", { name: "Open this review" }).click();
  const view = page.getByTestId("record-view");
  await expect(view).toContainText("A past review, shown as it was");
  await expect(view.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible();
  await expect(view.getByTestId("involve-Data Platform").getByRole("button", { name: "Mark contacted" })).toBeDisabled();
  await expect(view.getByRole("button", { name: "Change stage" })).toHaveCount(0);
  await view.getByRole("button", { name: "‹ History" }).click();
  await expect(page.getByTestId("record-view")).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.getByRole("button", { name: "‹ All projects" }).click();
  await expect(card).toContainText("Building");
  await expect(card).toContainText("Not reviewed yet");

  // Delete asks first, then removes it.
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(card).toContainText("This cannot be undone");
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("no-projects")).toBeVisible();
});

test("a launch review is kept as a record with its status, and opens read-only after the stage changes", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("radio", { name: /Preparing to launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Use sample files" }).click();
  await page.getByTestId("agent-read").click();
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();
  await page.getByRole("button", { name: "Connect Jira" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Run readiness review" }).click();
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 15_000 });
  const nav = page.getByRole("navigation", { name: "Project" });
  await nav.getByRole("button", { name: "History" }).click();
  const record = page.getByTestId("record-launching");
  await expect(record).toContainText("Launch review · Nov 13 run");
  await expect(record).toContainText("Amber");
  await expect(record).toContainText("4 open actions");
  // Back a stage from the stage tab: the launch review stays, as it was.
  await nav.getByRole("button", { name: "Stage and organisation" }).click();
  await page.getByRole("radio", { name: /Team forming/ }).check();
  await nav.getByRole("button", { name: "History" }).click();
  await record.getByRole("button", { name: "Open this review" }).click();
  const view = page.getByTestId("record-view");
  await expect(view.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible();
  await view.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(view.getByRole("region", { name: "Finding detail" })).toContainText("A past record");
  await expect(view.getByRole("button", { name: "Keep — add to my actions" })).toHaveCount(0);
  await expect(view.getByTestId("next-actions").getByRole("checkbox").first()).toBeDisabled();
});
