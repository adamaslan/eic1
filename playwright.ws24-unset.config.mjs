import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.EIC_AUDIT_APP_PORT ?? 5273);
const relayPort = Number(process.env.EIC_AUDIT_RELAY_PORT ?? 4280);
const appOrigin = `http://localhost:${appPort}`;
const relayOrigin = `http://localhost:${relayPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: appOrigin, trace: "retain-on-failure" },
  webServer: [
    {
      command: `npm run dev --workspace web -- --port ${appPort} --strictPort`,
      url: appOrigin,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { VITE_EIC_RELAY_BASE: relayOrigin },
    },
    {
      command: "node e2e/support/local-relay-server.mjs",
      url: `${relayOrigin}/healthz`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: { PORT: String(relayPort), APP_ORIGIN: appOrigin },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
