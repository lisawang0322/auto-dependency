import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOCS = resolve(import.meta.dirname, "../../fixtures/ingest-142/docs");
const POR = { name: "Ingestion-service-POR-v3.md", mimeType: "text/markdown", buffer: readFileSync(resolve(DOCS, "Ingestion-service-POR-v3.md")) };
const CHECKS = { name: "launch-checklist.csv", mimeType: "text/csv", buffer: readFileSync(resolve(DOCS, "launch-checklist.csv")) };

test("walks plan documents → connect Jira (resolving SEC) → review", async ({ page }) => {
  await page.goto("/?fast=1");

  // Step 1: upload the POR and the checklist but no team list, so Security will be ambiguous.
  const confirm = page.getByRole("button", { name: "Confirm plan and connect Jira" });
  await expect(confirm).toBeDisabled();
  await page.locator("#plan-files").setInputFiles([POR, CHECKS]);
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(0)).toHaveValue("plan");
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(1)).toHaveValue("checks");
  await expect(page.getByText("4 plan items · 1 approval · 2 dependencies")).toBeVisible();
  await expect(page.getByText("9 checks · 3 apply to this release")).toBeVisible();
  await expect(page.getByText("Not found — owners are inferred from Jira assignees.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Extracted plan" })).toBeVisible();
  const rows = page.locator(".plan-table tbody tr");
  await expect(rows).toHaveCount(7);
  // NEW: source quote on expand
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

  // Step 2: connect, pick the epic, resolve the ambiguous Security team.
  await expect(page.getByRole("heading", { name: "Connect Jira" })).toBeVisible();
  const run = page.getByRole("button", { name: "Run review" });
  await expect(run).toBeDisabled();
  await page.getByRole("button", { name: "Connect with Atlassian" }).click();
  await expect(page.getByRole("dialog")).toContainText("Create, edit, comment on or move issues");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Connected to Jira")).toBeVisible();
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
  await expect(page.getByText("All 4 teams: INGEST, DATA, SEC, SRE")).toBeVisible();
  await expect(page.getByText("Owners", { exact: true })).toBeVisible();
  await expect(page.getByText("Inferred from Jira assignees")).toBeVisible();
  await expect(run).toBeEnabled();
  await run.click();

  // Progress, then the review.
  await expect(page.getByRole("heading", { name: "Reading Jira…" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Launch Nov 20 · 7 days out/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("release-status")).toHaveText("Amber");
  await expect(page.getByTestId("open-findings")).toHaveText("4");
  await expect(page.getByText("1 weak finding hidden")).toBeVisible();
  await expect(page.getByText("Load test sign-off mentioned, not tracked")).toHaveCount(0);
  await page.getByRole("button", { name: "Show weak" }).click();
  await expect(page.getByText("Load test sign-off mentioned, not tracked")).toBeVisible();
  await page.getByRole("button", { name: "Hide weak" }).click();

  // Keep the security finding: its owner lands on the go/no-go card.
  await page.getByRole("button", { name: /Security approval is still open/ }).click();
  await expect(page.getByRole("heading", { name: "Security approval is still open" })).toBeVisible();
  const detail = page.getByRole("region", { name: "Finding detail" });
  await expect(detail.getByText("SEC-881", { exact: true })).toBeVisible();
  await expect(detail.getByText("In Review · linked to INGEST-142 (is blocked by)")).toBeVisible();
  await expect(detail.getByText("Source: POR §4")).toBeVisible();
  await expect(detail.getByText("(inferred from Jira assignee)")).toBeVisible();
  await page.getByRole("button", { name: "Keep — chase Security" }).click();
  await expect(page.locator(".owner-row")).toContainText(["Security"]);

  // Dismiss the rollback finding with a required reason: the Ingestion team goes back to On track.
  const ingest = page.getByTestId("team-INGEST");
  await expect(ingest.getByTestId("team-status")).toHaveText("At risk");
  await ingest.getByRole("button", { name: /No rollback plan/ }).click();
  await expect(page.getByText("Searched INGEST, DATA, SEC and SRE for a matching ticket or linked doc.")).toBeVisible();
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeDisabled();
  await page.getByLabel("Reason for dismissing (required, logged)").fill("Rollback is covered by the feature flag");
  await dismiss.click();
  await expect(ingest.getByTestId("team-status")).toHaveText("On track");
  await expect(page.getByTestId("open-findings")).toHaveText("2");
  await expect(page.getByRole("heading", { name: "Decision log" })).toBeVisible();
  await expect(page.locator(".log-row").first()).toContainText("Dismissed \"No rollback plan\" — Rollback is covered by the feature flag");

  // The SRE finding shows its linkage gap; the other gap is listed separately.
  await page.getByRole("button", { name: /SRE capacity due two days after launch/ }).click();
  await expect(page.getByText(/Linkage gap: INGEST-142 isn't linked to SRE-412/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Other linkage gaps" })).toBeVisible();
  await expect(page.getByText("Raise ingestion cluster quota")).toBeVisible();

  // Earlier run is read-only and keeps its own status.
  const runSwitcher = page.getByRole("group", { name: "Status by run" });
  await expect(runSwitcher.getByRole("button", { name: /Nov 13 · latest · Amber/ })).toBeVisible();
  await runSwitcher.getByRole("button", { name: /Nov 10 · Amber/ }).click();
  await expect(page.getByText("Earlier run, shown read-only.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /10 days out/ })).toBeVisible();
  await expect(page.getByTestId("team-SRE").getByTestId("team-status")).toHaveText("On track");
  await expect(page.getByTestId("team-SRE")).toContainText("First run");
  await runSwitcher.getByRole("button", { name: /Nov 13 · latest/ }).click();
  await expect(page.getByTestId("team-SRE")).toContainText("Since Nov 10: On track → Late");

  // Decisions survive a reload (localStorage), and the kept finding can be reopened.
  await page.reload();
  await page.goto("/?fast=1");
  await page.getByRole("button", { name: "Use sample files" }).click();
  await page.getByRole("button", { name: "Confirm plan and connect Jira" }).click();
  await page.getByRole("button", { name: "Connect with Atlassian" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("From your team list").first()).toBeVisible();
  await page.getByRole("button", { name: "Run review" }).click();
  await expect(page.getByRole("heading", { name: /7 days out/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".owner-row")).toContainText(["Security"]);
  await page.getByRole("button", { name: /Security approval is still open/ }).click();
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("Nothing kept yet.")).toBeVisible();
});

test("works at phone width with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?fast=1");
  await page.getByRole("button", { name: "Use sample files" }).click();
  await expect(page.getByRole("heading", { name: "Extracted plan" })).toBeVisible();
  // No horizontal page scroll: the plan table scrolls inside its own wrapper.
  const scrolled = await page.evaluate(() => { window.scrollTo(10000, 0); return window.scrollX; });
  expect(scrolled).toBe(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  const btn = page.getByRole("button", { name: "Confirm plan and connect Jira" });
  const box = await btn.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
