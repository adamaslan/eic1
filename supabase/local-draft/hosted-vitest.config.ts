import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['supabase/local-draft/hosted-schema.test.ts','supabase/local-draft/entry-runtime.test.ts'], testTimeout: 30000 } });
