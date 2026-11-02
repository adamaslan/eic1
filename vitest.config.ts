import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./apps/web/app", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/web/app/**/*.test.{ts,tsx}", "netlify/functions/**/*.test.ts"],
  },
});
