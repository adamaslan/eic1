import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.EIC_AUDIT_APP_PORT ?? 5274);
const appOrigin = `http://localhost:${appPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: appOrigin, trace: "retain-on-failure" },
  webServer: {
    command: `npm run dev --workspace web -- --port ${appPort} --strictPort`,
    url: appOrigin,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { VITE_EIC_RELAY_ENDPOINT: "http://127.0.0.1:54321/functions/v1/eic-relay" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
