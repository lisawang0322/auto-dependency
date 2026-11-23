import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:5173", ...devices["Desktop Chrome"] },
  webServer: { command: "npx vite --port 5173 --strictPort", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // live.spec.ts starts one API server on the proxied port, so it runs on desktop only.
    { name: "phone", use: { ...devices["Pixel 7"] }, testIgnore: /live\.spec\.ts/ },
  ],
});
