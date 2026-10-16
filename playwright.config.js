// @ts-check
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  fullyParallel: true,
  // Every e2e test runs in its own browser profile with its own extension
  // copy, so tests are isolated and can run on several workers.
  workers: process.env.CI ? 2 : "50%",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "html",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "unit",
      testDir: "./tests/unit",
    },
    {
      name: "build",
      testDir: "./tests/e2e",
      testMatch: /build\.setup\.js/,
    },
    {
      name: "chromium",
      testDir: "./tests/e2e",
      dependencies: ["build"],
      // Media and tab events are slower while many browsers decode video in
      // parallel, so allow assertions more time to settle.
      expect: { timeout: 10000 },
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
