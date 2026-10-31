import { defineConfig, devices } from "@playwright/test";

// Transition smoke tests. In CI they run against the Netlify deploy preview for the PR
// (DEPLOY_PREVIEW_URL); locally they start `react-router dev` and run against it.
const previewUrl = process.env.DEPLOY_PREVIEW_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["github"], ["html"]] : [["list"]],
  use: {
    baseURL: previewUrl ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: previewUrl
    ? undefined
    : {
        command: "npm run dev --workspace web",
        url: "http://localhost:5173",
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
