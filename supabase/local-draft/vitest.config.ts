import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["supabase/local-draft/proof.test.ts"], testTimeout: 30000 } });
