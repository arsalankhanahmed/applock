import { defineConfig, devices } from "@playwright/test";

/**
 * Black-box UI automation. Runs against an already running AuditX stack (docker compose, or
 * `uvicorn` + `celery` + `next start`). Every spec creates its own company through the public API,
 * so runs are repeatable and never touch demo data.
 */
// E2E_EVIDENCE=1 records a screenshot, video and trace of every test (for demos and audit evidence).
const evidence = Boolean(process.env.E2E_EVIDENCE);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: evidence ? "on" : "retain-on-failure",
    screenshot: evidence ? "on" : "only-on-failure",
    video: evidence ? "on" : "off",
    launchOptions: process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
});
