# Supabase relay: local preparation and verification

The current implementation and activation gates are in [docs/supabase-hosted-chat.md](../../docs/supabase-hosted-chat.md). The original local-draft SQL remains a separate proof fixture, not the migration to deploy.

## Implemented, not activated

The server-only `supabase-relay-store.ts` implements `RelayAtomicStore` through injected RPC calls. The reviewed schema draft is `supabase/local-draft/hosted-relay.sql`: private RLS tables, service-only RPCs, generation-based CAS, immutable retry validation, literal-prefix pagination, disabled configuration, total row/logical-byte caps and per-reader nonce admission. No automatic cleanup is included. It is deliberately outside supabase/migrations, so ordinary CLI migration commands do not apply it. Hosted installation, retention scheduling, activation and negative/concurrency proof still require explicit owner approval.

The HTTP handler verifies signed publish/read/chunk requests before store access, with an explicit nonempty signing-key allowlist, exact-origin CORS, streamed 2 MiB request cap and generic errors. CORS is not authentication. `supabase/functions/eic-relay/entry.ts` supplies the Deno listener, disabled-config gate and runtime-only Supabase credentials. RPC success handling includes PostgREST's empty HTTP204 replies for void functions.

The feature index exports the client and outbox. The chat UI shows explicit setup, publish/retry and receive controls only when `VITE_EIC_RELAY_ENDPOINT` is set. Without that variable, manual handoff remains unchanged. There are no timers or background polling. The client has bounded bodies, deadlines, a fixed endpoint, no redirects or ambient cookies, and honors the existing network policy.

Outbox preparation encrypts an exact signed snapshot in the local vault under CAS before transport. Retrying keeps its bytes and sequence. Only a verified exact signed readback clears pending state under CAS. Confirmation is a relay commit, not recipient delivery or a read receipt. Local messages stay in the vault. Locking cannot unsend ciphertext already handed off. Another device advancing the same identity still requires explicit reconciliation.

## Reproducible local verification

Ordinary `npm test` covers protocol, adapter, HTTP, client and outbox boundaries. `e2e/relay-local.spec.ts` covers two disposable browser vaults using a memory-backed signed HTTP handler, with desktop/mobile send, decrypt, reply, dedupe, outage, reload and exact retry. It is not a Supabase or SQL browser proof. Run it with `EIC_LOCAL_RELAY_TEST=1 VITE_EIC_RELAY_ENDPOINT=http://127.0.0.1:54321 npm run test:e2e -- e2e/relay-local.spec.ts` against the local dev server. It is explicitly skipped in ordinary preview/production smoke, where the app endpoint is unset. Report that exclusion rather than counting it as deployed delivery proof.

Install PGlite outside the repository in a disposable directory, then run:

```sh
EIC_PGLITE_MODULE=/absolute/local/node_modules/@electric-sql/pglite/dist/index.js \
  npx vitest run --config supabase/local-draft/vitest.config.ts
EIC_PGLITE_MODULE=/absolute/local/node_modules/@electric-sql/pglite/dist/index.js \
  npx vitest run --config supabase/local-draft/hosted-vitest.config.ts
```

The first suite uses the original local SQL fixture. The second applies the actual production migration and checks disabled configuration, privileges, reader isolation/rate, logical byte capacity, CAS, immutable writes, pagination, signed protocol and two local vaults. Its entry regression models PostgREST HTTP204 void replies and checks a nonempty publish commits. PGlite is in-process PostgreSQL, not hosted Supabase or multi-session concurrency evidence. Ordinary CI does not install it.

Build the dashboard-compatible Edge entry with:

```sh
node supabase/functions/eic-relay/build.mjs
```

The generated ignored `index.ts` imports only `npm:zod@4.6.7` externally, matching the reviewed lockfile. Other runtime code is bundled. Re-review dependency updates; never edit the generated file independently. Supabase supports versioned npm imports: https://supabase.com/docs/guides/functions/dependencies.

## Remaining activation gates

- Confirm owner authority and the exact intended account/project before hosted setup.
- Independently review the final source and satisfy the required review qualification.
- Inventory existing catalog objects, then apply only the reviewed migration. It deliberately fails on conflicts.
- Verify deployed disabled behavior, negative signatures/origins/permissions, JWT gateway compatibility and real multi-session admission under concurrency.
- Decide retention before activation. Proposal only: expired nonces after10minutes, unreferenced snapshots after7days, never current snapshots or local messages. No cleanup has been implemented or authorized here.
- Prove two actual browser vaults exchange/decrypt in both directions through the deployed SQL-backed function, including offline/reload/retry and lock behavior. Inspect ciphertext-only storage and no browser admin secret.

No new EIC login, Realtime, push, recipient acknowledgement or public share relay is included. The signed feed/chunk protocol is not Homebase72's per-envelope fetch/ack mailbox. Do not claim those capabilities or temporary retention.
