/**
 * What a PRD lets the review check, in sample mode, with no stage to pick: alone, who to involve (teams, contacts,
 * approvals, actions); with Jira and the epic, which teams are actually on the work and which approvals have started.
 * The sample outputs were built from the same throughline-starter code the live server runs.
 */
import { test, expect, type Page } from "@playwright/test";

async function newProject(page: Page) {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  // No stage to choose and nothing to declare: step 1 is the connections, each one optional.
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByTestId("start-jira")).toContainText("connect it later");
  await page.getByRole("button", { name: "Continue" }).click();
}

test("a PRD alone: its signals → who to involve, then a directory adds names", async ({ page }) => {
  await newProject(page);

  // Step 2: the sample PRD and the signals read from it; untick the customer-data sentence.
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
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
  // A PRD needs nothing connected, so confirming runs the review; Jira can come later.
  await expect(page.getByRole("navigation", { name: "Setup" }).getByRole("button")).toHaveText(["✓Organisation", "2Files", "3Review"]);
  await page.getByRole("button", { name: "Confirm and run the review" }).click();
  await expect(page.getByRole("heading", { name: "Reading your PRD…" })).toBeVisible();

  // Step 4: next actions, stakeholder map, teams to involve, approvals; Privacy and Legal are gone with their signal.
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Untitled project · Just starting$/)).toBeVisible(); // the review is the project's page, under its name
  await expect(page.getByText("Connect your directory to see who to contact.")).toBeVisible();
  // Teams due now are cards; VDR (before code complete) and Support (before beta) are still ahead, so they wait under "Coming up".
  await expect(page.getByTestId("teams-to-involve").locator(".card")).toHaveCount(5);
  await expect(page.getByTestId("coming-up").locator("details")).toHaveCount(2);
  await expect(page.getByTestId("later-VDR")).toContainText("Before code complete · signs off: VDR");
  await expect(page.getByTestId("later-note")).toHaveText("2 more coming up · before code complete, before beta ›");
  await expect(page.getByTestId("involve-Privacy")).toHaveCount(0);
  // The cards follow the one real sequence, when to involve each team; how closely, and whether it signs off, are tags.
  await expect(page.getByTestId("teams-to-involve").locator(".role-head")).toHaveText(["Now", "Before the design review", "Before work starts"]);
  await expect(page.getByTestId("role-now").getByTestId("involve-Data Platform")).toBeVisible();
  await expect(page.getByTestId("involve-Data Platform").getByTestId("closeness")).toHaveText("Work closely");
  await expect(page.getByTestId("involve-QA").getByTestId("closeness")).toHaveText("Work closely"); // works closely and signs off
  await expect(page.getByTestId("involve-QA").getByTestId("signs-off")).toHaveText("Signs off: QA sign-off");
  await expect(page.getByTestId("involve-Security").getByTestId("closeness")).toHaveText("Consult"); // a reviewer, not a level of closeness
  await expect(page.getByTestId("involve-Security").getByTestId("signs-off")).toHaveText("Signs off: Security review");
  await expect(page.getByTestId("involve-Data Platform")).toContainText("Data Platform lead");
  await expect(page.getByTestId("stakeholder-map")).toContainText("Connect your directory for a name.");
  // Each team's card carries the approvals it owes: Security's review is on its card; Privacy's went with its signal.
  await expect(page.getByTestId("involve-Security")).toContainText("Security review");
  await expect(page.getByTestId("teams-to-involve")).not.toContainText("Privacy review");
  await expect(page.getByTestId("actions-count")).toHaveText("5 open · 0 done"); // only what is due now
  // A coming-up team's action is shown as what will be asked, with nothing to mark yet.
  await page.getByTestId("later-VDR").locator("summary").click();
  await expect(page.getByTestId("involve-VDR").getByTestId("team-later")).toContainText("File the VDR intake for this release");
  await expect(page.getByTestId("involve-VDR").getByRole("button", { name: /^Mark done/ })).toHaveCount(0);
  // One control per action, on its team's card beside the why: "Mark done". The panel lists every action's status
  // without checkboxes, and each line leads to its card.
  await expect(page.getByRole("button", { name: "Mark contacted" })).toHaveCount(0);
  await expect(page.getByTestId("next-actions").getByRole("checkbox")).toHaveCount(0);
  const dpNext = page.getByTestId("involve-Data Platform").getByTestId("team-next");
  await expect(dpNext).toContainText("Book a 30-minute intro with Data Platform");
  await dpNext.getByRole("button", { name: /^Mark done/ }).click();
  await expect(dpNext).toContainText("✓ Done");
  await expect(page.getByTestId("actions-count")).toHaveText("4 open · 1 done");
  await expect(page.getByTestId("next-actions").locator(".glance-action").first()).toHaveClass(/is-done/);
  await expect(page.getByTestId("next-actions").getByRole("button", { name: /^Book a 30-minute intro.*\(done\)\. Go to Data Platform$/ })).toBeVisible();
  // Undo puts it back, and marking it again keeps it done for the rest of the test.
  await dpNext.getByRole("button", { name: /^Undo/ }).click();
  await expect(page.getByTestId("actions-count")).toHaveText("5 open · 0 done");
  await dpNext.getByRole("button", { name: /^Mark done/ }).click();
  await expect(page.getByTestId("actions-count")).toHaveText("4 open · 1 done");

  // Connect the directory from the nudge and run again: contacts appear, the tick and the contact survive.
  await page.getByRole("button", { name: "Connect directory" }).click();
  await page.getByRole("button", { name: "Connect Employee directory" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · directory.yaml");
  // Connecting it was the point, so the review runs again by itself, now with names.
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Connect your employee directory to see who to contact on each team.")).toHaveCount(0);
  await expect(page.getByTestId("involve-Data Platform")).toContainText("Wei Zhang · eng lead");
  await expect(page.getByTestId("next-actions").locator(".glance-action").first()).toHaveClass(/is-done/);

  await expect(page.getByTestId("actions-count")).toHaveText("4 open · 1 done");
  await expect(page.getByTestId("next-actions")).toContainText("Wei Zhang (Data Platform)");
});

test("a PRD, then Jira: the review adds which needed teams are missing and which approvals have no ticket or owner", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByTestId("agent-read").click();
  await expect(page.getByTestId("signals").getByRole("checkbox")).toHaveCount(6);
  await page.getByRole("button", { name: "Confirm and run the review" }).click();
  await expect(page.getByRole("heading", { name: "Who to involve, and what to do first" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("stage-chip")).toHaveText("Just starting");

  // What would let it check more: Jira and the epic the PRD names. Connecting it from there runs the review again.
  await expect(page.getByTestId("next-up")).toContainText("See who's actually on the work");
  await expect(page.getByTestId("next-up")).toContainText("INGEST-142");
  await page.getByTestId("next-up").getByRole("button", { name: "Connect Jira" }).click();
  await expect(page.getByText(/All optional\./)).toBeVisible();
  await expect(page.getByTestId("app-jira")).not.toContainText("Required");
  await page.getByRole("button", { name: "Connect Jira", exact: true }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("heading", { name: "Reading your plan and Jira…" })).toBeVisible();

  // Step 4: coverage and approvals.
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("covered-count")).toHaveText("3 of 9");
  await expect(page.getByTestId("not-started-count")).toHaveText("3 of 5");
  await expect(page.getByTestId("coverage-Security")).toContainText("Covered");
  await expect(page.getByTestId("coverage-Security")).toContainText("SEC-881 linked");
  await expect(page.getByTestId("coverage-Privacy")).toContainText("Missing");
  await expect(page.getByTestId("coverage-Privacy")).toContainText("Privacy lead");
  await expect(page.getByTestId("approval-QA sign-off")).toContainText("No owner");
  await expect(page.getByTestId("approval-QA sign-off")).toContainText("INGEST-170");
  await expect(page.getByTestId("approval-Security review")).toContainText("In progress");
  await expect(page.getByTestId("approval-Privacy review")).toContainText("Not started");
  // Building, everything up to code complete is due; Legal and Support (before beta) are still coming up.
  await expect(page.getByTestId("actions-count")).toHaveText("7 open · 0 done");
  await expect(page.getByTestId("coming-up").locator("details")).toHaveCount(2);
  await expect(page.getByTestId("next-actions")).toContainText("Get an owner for INGEST-170 (Test plan for ingestion launch); the QA sign-off has no one on it");
  await expect(page.getByText("No Jira project for Privacy, Legal, UX, QA, VDR, Support: checked by assignee only.")).toBeVisible();

  // Where it stands is read from what it has now: work tracked in Jira. Next, the launch check, once there is a plan of record.
  await expect(page.getByTestId("stage-chip")).toHaveText("Building");
  await expect(page.getByTestId("next-up")).toContainText("Ready to launch?");
  // Connections, done, are a quiet link at the foot of the page, with the epic and the needed teams.
  await page.getByTestId("project-links").getByRole("button", { name: "Connections" }).click();
  await expect(page.getByText("Found in Jira (sample data)")).toBeVisible();
  await expect(page.getByTestId("needed-teams")).toContainText("3 of 9 have a Jira project");
  await expect(page.getByTestId("needed-teams")).toContainText("Privacy → assignee only");
  await expect(page.getByTestId("app-jira").getByTestId("app-state")).toHaveText(/Connected · read-only/);
});

test("with Jira already connected, a PRD gets both checks at once", async ({ page }) => {
  await page.goto("/?fast=1&backend=sample");
  await page.getByRole("button", { name: "New project" }).first().click();
  // Jira's projects as the directory connects Jira too.
  await page.getByRole("button", { name: "Use Jira projects" }).click();
  await expect(page.getByTestId("start-directory-state")).toContainText("Jira projects");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "a PRD", exact: true }).click();
  await page.getByTestId("agent-read").click();
  await page.getByRole("button", { name: "Confirm and run the review" }).click();

  // The PRD names INGEST-142 and Jira is connected: who to involve comes with who is on the work, in one review.
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("navigation", { name: "Setup" })).toHaveCount(0);
  await expect(page.getByTestId("coverage-Security")).toContainText("Covered");
});
