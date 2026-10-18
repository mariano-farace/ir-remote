import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  // Every test shares one database, and the flows create scripts in it, so
  // tests run one at a time rather than racing each other's rows.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // V1 sends a real topic prompt through OpenRouter, so a test's own
  // condition timeout (75 s, above the route's own 60 s bound) must be able to
  // run; Playwright caps every wait by the test timeout, which would otherwise
  // abort it at the default 30 s.
  timeout: Number(process.env.PLAYWRIGHT_TEST_TIMEOUT ?? 120_000),
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run start",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
