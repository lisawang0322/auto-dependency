/**
 * The portal: projects are kept and come back, and grow by what is added to them, with no stage to pick. Sample mode keeps
 * them in the browser; live mode on the server (server/projects.test.ts covers that side, files included).
 */
import { test, expect } from "@playwright/test";

test("a project is kept across visits and grows by what is added: home, reopen without re-reading, history, Jira, delete", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByTestId("no-projects")).toBeVisible();

  // A new project, named, given a PRD and reviewed.
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByLabel("Project name").fill("Ingestion service");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByTestId("agent-read").click();
  await expect(page.getByRole("heading", { name: "What we read in your PRD" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Confirm and run the review" }).click();
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });

  // Once reviewed there are no tabs: the review is the project's page. Where it stands is read from what it has.
  await expect(page.getByRole("navigation", { name: "Setup" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Project" })).toHaveCount(0);
  await expect(page.getByTestId("phase")).toHaveText("Just starting");
  await expect(page.getByTestId("lifecycle").getByRole("button", { name: "Change stage" })).toHaveCount(0);
  // What would let it check more, with the reason the files give.
  await expect(page.getByTestId("next-up")).toContainText("See who's actually on the work");
  await expect(page.getByTestId("next-up")).toContainText("INGEST-142");
  await expect(page.getByTestId("actions-count")).toHaveText("6 open · 0 done"); // what is due now; three teams are coming up
  await expect(page.getByTestId("project-links")).toContainText("Files and reading");
  await expect(page.getByTestId("save-state")).toHaveText("Saved");

  // Home: the card says where it is and what is open.
  await page.getByRole("button", { name: "‹ All projects" }).click();
  const card = page.getByTestId("project-Ingestion service");
  await expect(card).toContainText("Just starting");
  await expect(card).toContainText("6 open actions");
  await expect(card).toContainText("9 teams to involve");

  // A reload keeps it; opening it lands on its page, the review, with nothing read again.
  await page.reload();
  await page.getByRole("button", { name: "Open Ingestion service" }).click();
  await expect(page.getByTestId("next-up")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible();
  await expect(page.getByTestId("agent-reading")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/p\/p\w+$/);

  // History: the review kept as a record, with what it found, among the events; newest first.
  await page.getByTestId("project-links").getByRole("button", { name: /^History/ }).click();
  const history = page.getByTestId("history");
  const record = page.getByTestId("record-starting");
  await expect(record).toContainText("Who to involve");
  await expect(record).toContainText("6 open actions");
  await expect(record).toContainText("current");
  await expect(history).toContainText("Devin read 1 file");
  await expect(history.locator("li").last()).toContainText("Project created");

  // Growing is adding, not a new setup: connect Jira from the suggestion, and the review runs again with who is on the work.
  await page.getByRole("button", { name: "‹ Overview" }).first().click();
  await page.getByTestId("next-up").getByRole("button", { name: "Connect Jira" }).click();
  await expect(page.getByRole("navigation", { name: "Setup" })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect Jira", exact: true }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("phase")).toHaveText("Building");

  // The first review is still there, as it was, and opens read-only.
  await page.getByTestId("project-links").getByRole("button", { name: /^History/ }).click();
  await expect(record).not.toContainText("current");
  await expect(page.getByTestId("record-building")).toContainText("current");
  await record.getByRole("button", { name: "Open this review" }).click();
  const view = page.getByTestId("record-view");
  await expect(view).toContainText("A past review, shown as it was");
  await expect(view.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible();
  await expect(view.getByTestId("next-actions").getByRole("checkbox").first()).toBeDisabled(); // a past review keeps its own list, read-only
  await view.getByRole("button", { name: "‹ History" }).click();
  await expect(page.getByTestId("record-view")).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toHaveText("Saved");
  await page.getByRole("button", { name: "‹ All projects" }).click();
  await expect(card).toContainText("Building");

  // Delete asks first, then removes it.
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(card).toContainText("This cannot be undone");
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("no-projects")).toBeVisible();
});

test("a launch review is kept as a record with its status, and opens read-only after the project grows", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "launch documents" }).click();
  await page.getByTestId("agent-read").click();
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible({ timeout: 15_000 });
  // A plan of record asks for the launch check, which needs Jira: confirming goes to connect it, and connecting runs the review.
  await page.getByRole("button", { name: "Confirm and connect Jira" }).click();
  await page.getByRole("button", { name: "Connect Jira", exact: true }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("phase")).toHaveText("Preparing to launch");
  await page.getByTestId("project-links").getByRole("button", { name: /^History/ }).click();
  const record = page.getByTestId("record-launching");
  await expect(record).toContainText("Launch review · Nov 13 run");
  await expect(record).toContainText("Amber");
  await expect(record).toContainText("4 open actions");

  // The project grows (a PRD joins the files) and is reviewed again: the first launch review stays, as it was.
  await page.getByRole("button", { name: "‹ Overview" }).first().click();
  await page.getByTestId("project-links").getByRole("button", { name: "Files and reading" }).click();
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and run the review" }).click();
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("project-links").getByRole("button", { name: /^History/ }).click();
  await expect(record).toHaveCount(2);
  await expect(record.last()).not.toContainText("current");
  await record.last().getByRole("button", { name: "Open this review" }).click();
  const view = page.getByTestId("record-view");
  await expect(view.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible();
  await view.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(view.getByRole("region", { name: "Finding detail" })).toContainText("A past record");
  await expect(view.getByRole("button", { name: "Keep — add to my actions" })).toHaveCount(0);
  await expect(view.getByTestId("next-actions").getByRole("checkbox").first()).toBeDisabled();
});

test("setting up goes step by step, and back goes a step back: the link, the step bar and the browser's Back", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  const steps = page.getByRole("navigation", { name: "Setup" });
  await expect(steps.getByRole("button")).toHaveText(["1Organisation", "2Files", "3Review"]); // Jira is optional, not a step
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await expect(steps.getByRole("button", { name: /Organisation/ })).toHaveText("✓Organisation");

  // The link at the top goes back a step; the browser's Back returns to where you were.
  await page.getByRole("button", { name: "‹ Step 1: Organisation" }).first().click();
  await expect(page.getByRole("heading", { name: "Set up your project" })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await page.getByRole("button", { name: "launch documents" }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and connect Jira" }).click();
  // Only a plan of record: its launch check is the one thing that needs Jira first, so confirming opens the connections.
  const toFiles = page.getByRole("button", { name: "‹ Step 2: Files" }).last();
  await expect(toFiles).toBeVisible();
  await toFiles.click();
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await page.goBack();
  await expect(toFiles).toBeVisible();
  // Jira was the last thing missing: connecting it runs the review, and the step bar is gone with the setup.
  await page.getByRole("button", { name: "Connect Jira", exact: true }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  const results = page.getByRole("heading", { name: /Launch Nov 20/ });
  await expect(results).toBeVisible({ timeout: 15_000 });
  await expect(steps).toHaveCount(0);

  // Once reviewed, the review is the project's page: the files are a link beside it, back comes back to it,
  // and the browser's Back walks the screens.
  await page.getByTestId("project-links").getByRole("button", { name: "Files and reading" }).click();
  await expect(page.getByRole("heading", { name: "Add what you have" })).toBeVisible();
  await page.getByRole("button", { name: "‹ Overview" }).click();
  await expect(page.getByTestId("next-up")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Add what you have" })).toBeVisible();
  await page.goBack();
  await expect(results).toBeVisible();

  // Back from a project comes home.
  await page.getByRole("button", { name: "‹ All projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "‹ All projects" })).toBeVisible(); // the project is open again
  await expect(page.getByTestId("save-state")).toHaveText("Saved"); // nothing was lost by leaving quickly
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByTestId("project-Untitled project")).toContainText("Preparing to launch");
});
