import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E Configuration for MedSync + AuraHealth Browser Acceptance Suite
 * Authority: Phase 12 Specification — Real Browser E2E Only
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*browser.*\.spec\.js/,
  timeout: 60000,
  expect: {
    timeout: 10000
  },
  fullyParallel: false,
  workers: 1, // Deterministic sequential execution
  reporter: [["list"]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
