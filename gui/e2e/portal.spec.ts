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

  // The same places all through the project's life; the overview is the hub: stage, next step, checklist, latest review.
  const nav = page.getByRole("navigation", { name: "Project" });
  await expect(nav.getByRole("button")).toHaveText(["Overview", "Plan", "Connections", "Review", "History"]);
  await nav.getByRole("button", { name: "Overview" }).click();
  await expect(page.getByTestId("lifecycle")).toContainText("Just starting");
  await expect(page.getByTestId("next-up")).toContainText("This stage is reviewed");
  await expect(page.getByTestId("latest-review")).toContainText("9 open actions");
  await expect(page.getByTestId("checklist")).toContainText("Everything just starting needs is in place");
  await expect(page.getByTestId("save-state")).toHaveText("Saved");

  // Home: the card says where it is and what is open.
  await page.getByRole("button", { name: "‹ All projects" }).click();
  const card = page.getByTestId("project-Ingestion service");
  await expect(card).toContainText("Just starting");
  await expect(card).toContainText("9 open actions");
  await expect(card).toContainText("9 teams to involve");

  // A reload keeps it; opening it lands on the overview with nothing read again, and the review is one click away.
  await page.reload();
  await page.getByRole("button", { name: "Open Ingestion service" }).click();
  await expect(page.getByTestId("next-up")).toBeVisible();
  await page.getByTestId("latest-review").getByRole("button", { name: "Open the review" }).click();
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
  // It stays on the overview: the checklist now asks for what building needs.
  await expect(page.getByTestId("overview-notice")).toContainText("Your files and connections are kept");
  await expect(page.getByTestId("stage-chip")).toHaveText("Stage: Building");
  await expect(page.getByTestId("check-read")).toContainText("not read for this stage yet");
  await expect(page.getByTestId("next-up")).toContainText("Read your files");
  await expect(page.getByTestId("latest-review")).toContainText("No review at this stage yet");
  await expect(page.getByTestId("latest-review")).toContainText("Earlier reviews");
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
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
  await page.getByRole("button", { name: "Check what's missing for launch" }).click();
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 15_000 });
  const nav = page.getByRole("navigation", { name: "Project" });
  await nav.getByRole("button", { name: "History" }).click();
  const record = page.getByTestId("record-launching");
  await expect(record).toContainText("Launch review · Nov 13 run");
  await expect(record).toContainText("Amber");
  await expect(record).toContainText("4 open actions");
  // Back a stage from the stage tab: the launch review stays, as it was.
  await nav.getByRole("button", { name: "Overview" }).click();
  await page.getByTestId("lifecycle").getByRole("button", { name: "Change stage" }).click();
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

test("setting up goes step by step, and back goes a step back: the link, the step bar and the browser's Back", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  const steps = page.getByRole("navigation", { name: "Setup" });
  await expect(steps.getByRole("button")).toHaveText(["1Stage", "2Plan", "3Connections", "4Review"]);
  await page.getByRole("radio", { name: /Team forming/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Step 2 of 4")).toBeVisible();
  await expect(steps.getByRole("button", { name: /Stage/ })).toHaveText("✓Stage");

  // The link at the top goes back a step; the browser's Back returns to where you were.
  await page.getByRole("button", { name: "‹ Step 1: Stage" }).first().click();
  await expect(page.getByRole("radio", { name: /Team forming/ })).toBeChecked();
  await page.goBack();
  await expect(page.getByText("Step 2 of 4")).toBeVisible();
  await page.getByRole("button", { name: "Use sample files" }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();
  await expect(page.getByText("Step 3 of 4")).toBeVisible();
  await page.getByRole("button", { name: "‹ Step 2: Plan" }).last().click();
  await expect(page.getByText("Step 2 of 4")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Step 3 of 4")).toBeVisible();
  await page.getByRole("button", { name: "Connect Jira" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Check my team and approvals" }).click();
  await expect(page.getByRole("navigation", { name: "Project" })).toBeVisible({ timeout: 15_000 });

  // Once reviewed, it is a workspace: back from a section goes to the overview, and the browser's Back walks the screens.
  const nav = page.getByRole("navigation", { name: "Project" });
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("button", { name: "‹ Overview" }).first().click();
  await expect(page.getByTestId("next-up")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Add what you have" })).toBeVisible();
  await page.goBack();
  await expect(nav.getByRole("button", { name: "Review" })).toHaveAttribute("aria-current", "page");

  // Back from a project comes home.
  await page.getByRole("button", { name: "‹ All projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "Project" })).toBeVisible();
  await expect(page.getByTestId("save-state")).toHaveText("Saved"); // nothing was lost by leaving quickly
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByTestId("project-Untitled project")).toContainText("Building");
});
