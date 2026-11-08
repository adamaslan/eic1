import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

// Deno resolves this exact reviewed lockfile version. Keeping zod external makes
// the generated entry small enough for the dashboard editor without a new token.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const version = lock.packages['node_modules/zod']?.version;
if (version !== '4.6.7') throw new Error('Review the pinned Edge zod dependency before updating');
await build({
  entryPoints: ['supabase/functions/eic-relay/entry.ts'], bundle: true,
  minify: true, format: 'esm', platform: 'neutral', target: 'es2022',
  outfile: 'supabase/functions/eic-relay/index.ts',
  plugins: [{ name: 'pinned-deno-zod', setup(builder) {
    builder.onResolve({ filter: /^zod$/ }, () => ({ path: `npm:zod@${version}`, external: true }));
  } }],
});
