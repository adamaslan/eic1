import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": new URL("./apps/web/app", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/web/app/**/*.test.{ts,tsx}"],
  },
});
