import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "discover-local.spec.ts", workers: 1, timeout: 60000,
  expect: { timeout: 10000 }, use: { baseURL: "http://localhost:5185", channel: "chrome", launchOptions: { args: ["--no-sandbox"] } },
  webServer: { command: "EIC_LOCAL_DISCOVER_PREVIEW=1 npm run dev --workspace web -- --host 127.0.0.1 --port 5185", url: "http://localhost:5185", reuseExistingServer: false, timeout: 60000 },
});
