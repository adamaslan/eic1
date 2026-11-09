import { defineConfig, devices } from "@playwright/test";

// Transition smoke tests. In CI they run against the Netlify deploy preview for the PR
// (DEPLOY_PREVIEW_URL); locally they start `react-router dev` and run against it.
// EIC_TARGET_URL targets any deployed instance (the post-publish production gate in
// prod-verify.yml / `npm run verify:prod`); it wins over DEPLOY_PREVIEW_URL.
const targetUrl = process.env.EIC_TARGET_URL ?? process.env.DEPLOY_PREVIEW_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["github"], ["html"]] : [["list"]],
  use: {
    baseURL: targetUrl ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  // Locally the share relay runs as its own node server on :4180 (same share-core.ts
  // the Netlify functions wrap (lib/share-core.ts)) and the app is pointed at it. Against a deploy preview
  // or prod (targetUrl set), app and relay share one origin, so nothing extra boots.
  // reuseExistingServer stays FALSE everywhere, not just CI: reusing a long-running
  // server once masked a stale import in the relay stand-in, so every run boots fresh
  // servers. The relay's stdout/stderr (with its pid and bound port) is preserved in
  // e2e/logs/local-relay.log (outside test-results, which Playwright clears each run).
  webServer: targetUrl
    ? undefined
    : [
        {
          command: "npm run dev --workspace web",
          url: "http://localhost:5173",
          timeout: 120_000,
          reuseExistingServer: false,
          env: { VITE_EIC_RELAY_BASE: "http://localhost:4180", VITE_EIC_SHARE_RELAY: "on" },
        },
        {
          command: "mkdir -p e2e/logs && node e2e/support/local-relay-server.mjs >> e2e/logs/local-relay.log 2>&1",
          url: "http://localhost:4180/healthz",
          timeout: 30_000,
          reuseExistingServer: false,
          env: { PORT: "4180", APP_ORIGIN: "http://localhost:5173" },
        },
      ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
