/**
 * Live mode end to end: the GUI → the local API server → a fake Jira Cloud (served from the fixture
 * snapshot) → saved run → next steps. No sample-data shortcuts: files are really uploaded and parsed,
 * the epic is really looked up, and the findings come from the analyzer.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeJira, type FakeJira } from "../../skills/release-reader/tests/fake-jira";
import { startServer } from "../../server/index";
import { startFakeDevin, naiveReader, type FakeDevin } from "../../server/tests/fake-devin";
import { startFakeIdp, type FakeIdp } from "../../server/tests/fake-idp";

const ROOT = resolve(import.meta.dirname, "../..");
const DOCS = join(ROOT, "fixtures/ingest-142/docs");
const file = (name: string, mimeType: string) => ({ name, mimeType, buffer: readFileSync(join(DOCS, name)) });

let jira: FakeJira, devin: FakeDevin, idp: FakeIdp, srv: Awaited<ReturnType<typeof startServer>>, tmp: string;
// One server on the proxied port 8787, so playwright.config.ts runs this file in the desktop project only.
test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "rrr-live-e2e-"));
  // The fake Jira also plays Atlassian's OAuth endpoints, so "Sign in with Atlassian" runs end to end in the popup.
  jira = await startFakeJira(join(ROOT, "fixtures/ingest-142/jira/2026-11-13"), { oauth: { clientId: "jira-app", clientSecret: "jira-secret", cloudId: "cloud-e2e" } });
  devin = await startFakeDevin({ workingPolls: 1, answer: (s) => {
    const out = naiveReader(s) as any;
    out.items.push({ text: "Load test at 2× the batch importer's peak", kind: "dependency", owner_team: "SRE", due_text: null, source: { file: "Ingestion-service-POR-v3.md", locator: "§5", quote: "Peak load at launch is 2× the batch importer's peak." } });
    return out;
  } });
  idp = await startFakeIdp();
  // Sign-in is on: the browser reaches the server through Vite's proxy on 5173, so that is the app URL the provider sends people back to.
  srv = await startServer({ port: 8787, quiet: true, creds: null, runsRoot: join(tmp, "runs"), uploadRoot: join(tmp, "up"), cacheRoot: join(tmp, "cache"), agentCacheRoot: join(tmp, "agent"), sampleDocs: DOCS, guiDist: join(tmp, "nodist"), storePath: ":memory:",
    devin: { apiKey: "cog_test", baseUrl: devin.url, pollMs: 100, timeoutMs: 20_000, defaultMode: "normal", modes: ["lite", "normal"] },
    auth: { mode: "oidc", issuer: idp.url, clientId: "app-client-id", clientSecret: "app-secret", appUrl: "http://localhost:5173", sessionSecret: "e2e-secret" },
    atlassian: { clientId: "jira-app", clientSecret: "jira-secret", appUrl: "http://localhost:5173", authBase: jira.url, apiBase: jira.url } });
});
test.afterAll(async () => { await srv?.close(); await jira?.close(); await devin?.close(); await idp?.close(); rmSync(tmp, { recursive: true, force: true }); });

/** Through the sign-in screen, the fake provider and back, landing in live mode as Lisa. The server keeps her
 *  settings between tests (one user, one store), so each test starts with the Devin question unanswered. */
async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/?backend=live");
  await expect(page.getByRole("heading", { name: "Sign in with your company account" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("user-chip")).toHaveText("Lisa Wang");
  await expect(page.locator(".tag").first()).toHaveText(/Live/);
  await page.request.put("/api/settings", { data: { agent_consent: "unknown" } });
  await page.reload();
  await expect(page.getByTestId("user-chip")).toHaveText("Lisa Wang");
}

test("uploads real files, connects with a token and a directory export, reads Jira and reviews", async ({ page }) => {
  await signIn(page);

  // Step 1: the stage.
  await page.getByRole("radio", { name: /Preparing to launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2: real uploads, really parsed by Stage A. No team list yet. Devin is offered once a document is in, and declined here.
  await page.locator("#plan-files").setInputFiles([file("Ingestion-service-POR-v3.md", "text/markdown"), file("launch-checklist.csv", "text/csv")]);
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator(".plan-table tbody tr")).toHaveCount(7);
  await expect(page.getByText("Owners: inferred from Jira")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();

  // Step 3: Sign in with Atlassian in a popup: the provider approves, the callback page messages the opener and closes.
  await page.getByRole("button", { name: "Connect Jira" }).click();
  await expect(page.getByRole("dialog")).toContainText("Sign in with Atlassian");
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Continue to Atlassian" }).click()]);
  await popup.waitForEvent("close", { timeout: 15_000 });
  await expect(page.getByTestId("app-jira").getByTestId("app-state")).toHaveText(/Connected · read-only · .* · via Atlassian sign-in/);
  expect(jira.calls).toContain("POST /oauth/token");
  expect(await page.evaluate(() => document.querySelector("#jira-token"))).toBeNull(); // no token form when OAuth is set up

  // The employee directory: in live mode an export file stands in for the connector.
  await page.getByRole("button", { name: "Connect Employee directory" }).click();
  await expect(page.getByRole("button", { name: "Accept" })).toBeDisabled();
  await page.locator("#directory-file").setInputFiles(file("team-list.yaml", "application/yaml"));
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Connected · read-only · team-list.yaml");

  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("Found in Jira", { exact: true })).toBeVisible();
  await expect(page.getByText("4 of 4 teams resolved")).toBeVisible();
  await expect(page.getByText("From your team list").first()).toBeVisible();

  // Run: Stage C over REST, analyzer, status, saved run.
  await page.getByRole("button", { name: "Run readiness review" }).click();
  await expect(page.getByRole("heading", { name: /Launch Nov 20/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("open-findings")).toHaveText("4");
  await expect(page.getByTestId("next-actions").getByRole("checkbox")).toHaveCount(4);
  await expect(page.getByTestId("team-SRE").getByTestId("team-status")).toHaveText("Late");
  await expect(page.getByTestId("team-SRE")).toContainText("First run");
  await page.getByRole("button", { name: /Approval still open: Security review approved/ }).click();
  await expect(page.getByRole("region", { name: "Finding detail" }).getByText("(from your directory)")).toBeVisible();
  await expect(page.getByText("Raise ingestion cluster quota")).toBeVisible();

  // Keep a finding: the decision is saved on the server under this person, not in the browser.
  await page.getByRole("button", { name: "Keep — add to my actions" }).click();
  const runs = await (await page.request.get("/api/runs/INGEST-142")).json() as { id: string }[];
  const runId = runs[runs.length - 1].id; // live runs are labelled with today's date
  await expect.poll(async () => {
    const res = await page.request.get(`/api/decisions/${encodeURIComponent(`INGEST-142/${runId}`)}`);
    const d = await res.json();
    return Object.values(d.decisions as Record<string, { kind: string }>).map((x) => x.kind);
  }).toEqual(["kept"]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("rrr:decisions")))).toEqual([]);
});

test("building stage over the API: PRD + directory upload, the real epic, coverage and approvals", async ({ page }) => {
  await signIn(page);
  await page.getByRole("radio", { name: /Team forming/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#plan-files").setInputFiles([file("ingestion-service-PRD.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), file("directory.yaml", "application/yaml")]);
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(0)).toHaveValue("prd");
  await expect(page.getByRole("combobox", { name: "Read as" }).nth(1)).toHaveValue("teams");
  await expect(page.getByTestId("signals").getByRole("checkbox")).toHaveCount(6);
  await expect(page.getByText("10 teams, 21 people")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and connect apps" }).click();

  // Jira is still connected on the server from the first test; otherwise connect as before.
  const state = page.getByTestId("app-jira").getByTestId("app-state");
  if (!/Connected/.test(await state.textContent() ?? "")) {
    await page.getByRole("button", { name: "Connect Jira" }).click();
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("button", { name: "Continue to Atlassian" }).click()]);
    await popup.waitForEvent("close", { timeout: 15_000 });
  }
  await expect(state).toHaveText(/Connected · read-only/);
  await expect(page.getByTestId("app-directory").getByTestId("app-state")).toHaveText("Covered by directory.yaml from your files");
  await page.getByRole("button", { name: "Use INGEST-142" }).click();
  await expect(page.getByText("Found in Jira", { exact: true })).toBeVisible();
  await expect(page.getByTestId("needed-teams")).toContainText("3 of 9 have a Jira project");
  await page.getByRole("button", { name: "Check my team and approvals" }).click();
  await expect(page.getByRole("heading", { name: "Who's missing, and what hasn't started" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("covered-count")).toHaveText("3 of 9");
  await expect(page.getByTestId("coverage-Privacy")).toContainText("Ken Adeyemi · privacy counsel");
  await expect(page.getByTestId("approval-QA sign-off")).toContainText("INGEST-170");
  await expect(page.getByTestId("next-actions")).toContainText("Ken Adeyemi (Privacy)");
});

test("Devin reads the uploads once the person allows it, and the connect step shows it as connected", async ({ page }) => {
  await signIn(page);
  await page.getByRole("radio", { name: /Preparing to launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // No offer before a document exists; the files come first.
  await expect(page.getByTestId("agent-consent")).toHaveCount(0);
  const before = devin.sessions.length;
  await page.locator("#plan-files").setInputFiles([file("Ingestion-service-POR-v3.md", "text/markdown"), file("launch-checklist.csv", "text/csv")]);
  // Upload alone reads with the rules only; nothing goes to Devin until the person clicks.
  await expect(page.getByRole("heading", { name: "Plan we read" })).toBeVisible();
  // The offer, now that there is something to read. Allowing it is remembered for the session.
  await expect(page.getByTestId("agent-consent")).toContainText("Devin can read these files");
  await page.locator("#agent-mode-consent").selectOption("lite");
  await page.getByRole("button", { name: "Let Devin read my files" }).click();
  await expect(page.getByTestId("agent-consent")).toHaveCount(0);
  await expect(page.locator(".plan-table tbody tr")).toHaveCount(7);
  await expect(page.getByText("Devin has not read these files yet")).toBeVisible();
  expect(devin.sessions.length).toBe(before);
  await expect(page.getByTestId("agent-panel")).toContainText("Ready for Devin to read");
  await page.getByTestId("agent-read").click();
  await expect(page.getByTestId("agent-reading")).toContainText("Devin is reading your files");
  await expect(page.getByTestId("agent-result")).toContainText("Devin (lite) read 4 plan items from Ingestion-service-POR-v3.md (text)", { timeout: 20_000 });
  expect(devin.sessions[devin.sessions.length - 1].devin_mode).toBe("lite");
  await expect(page.getByTestId("agent-result").getByRole("link", { name: /open the Devin session/ })).toHaveAttribute("href", /app\.devin\.ai\/sessions\//);
  // The rules' 7 plus the one only Devin found; the document went to Devin once, the csv did not go at all.
  await expect(page.locator(".plan-table tbody tr")).toHaveCount(8);
  await expect(page.locator(".plan-table tbody tr", { hasText: "Load test at 2× the batch importer's peak" })).toHaveCount(1);
  expect(devin.sessions.length).toBe(before + 1);
  expect(devin.uploads.map((u) => u.name)).toEqual(["Ingestion-service-POR-v3.md"]);

  // Changing how a file is read drops the reading (rules only again) and offers to read again; the repeat is served from the cache.
  await page.locator("select[id^=kind-]").first().selectOption("prd");
  await expect(page.getByTestId("agent-result")).toHaveCount(0);
  await expect(page.locator(".plan-table tbody tr")).toHaveCount(7);
  await expect(page.getByTestId("agent-read")).toHaveText("Read with Devin");
  expect(devin.sessions.length).toBe(before + 1);
  await page.getByTestId("agent-read").click();
  await expect(page.getByTestId("agent-result")).toContainText("from an earlier reading of the same file", { timeout: 20_000 });
  await expect(page.locator(".plan-table tbody tr")).toHaveCount(8);
  expect(devin.sessions.length).toBe(before + 1);

  await page.getByRole("button", { name: "Confirm and connect apps" }).click();
  await expect(page.getByTestId("app-devin").getByTestId("app-state")).toHaveText("Connected · set up by your company · reads your plan files in lite mode");
  await page.getByRole("button", { name: "Disconnect Devin" }).click();
  await expect(page.getByTestId("app-devin").getByTestId("app-state")).toHaveText("Not connected");
});

test("the answer about Devin is kept on the server across reloads, and signing out returns to the sign-in screen", async ({ page }) => {
  await signIn(page);
  await page.getByRole("radio", { name: /Preparing to launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Use sample files" }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByTestId("agent-consent")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("user-chip")).toHaveText("Lisa Wang");
  await page.getByRole("radio", { name: /Preparing to launch/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("agent-consent")).toHaveCount(0); // remembered server-side, not asked again
  await page.getByRole("button", { name: "Use sample files" }).click();
  await expect(page.getByText("Devin not used")).toBeVisible();
  await expect(page.getByTestId("agent-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in with your company account" })).toBeVisible();
  const res = await page.request.get("/api/settings");
  expect(res.status()).toBe(401);
});
