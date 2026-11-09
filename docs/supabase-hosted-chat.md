# EIC encrypted Supabase relay

Implementation branch based on EIC main 1c5f333. Reuses reviewed Homebase72 handoff tree1246680f, actual signed feed/chunk protocol and encrypted local vault. No second mailbox protocol.

## Scope and gates

Initial migration creates only private eic_relay schema, service-only RPCs and config. New config starts disabled with no keys/origins. No automatic cleanup or existing-data deletion. Per-reader120 nonce insertions/minute and1200 outstanding rows, global10000 rows/32MiB logical-object budget serialized at DB admission. This is a logical payload budget, not exact physical PostgreSQL disk usage. Full quota fails closed and preserves local messages. Migrations deliberately fail on conflicting objects rather than silently replacing someone else's work.

Runtime uses Supabase-provided server env for RPC and verifies EIC Ed25519 signatures. Browser never receives an admin key. Allowlists contain EIC signing public keys only, never passwords. Existing function JWT gateway configuration must be matched explicitly to the signed protocol before activation. Anonymous direct tables/RPCs remain denied.

Client endpoint is build-time VITE_EIC_RELAY_ENDPOINT. Without it, manual-only UI remains. Enabling the endpoint shows explicit setup/publish/retry/check actions, no timers/background polling. Setup refuses to replace another feed destination. Reshare the signed connection bundle after setting a new feed URL. Both reader/publisher keys need owner admission; no public enrollment. Existing Wi-Fi/cellular policy is honored. A relay commit is never recipient delivery or a read receipt.

## Deploy and verify

1. Fresh catalog inventory for intended project and source review.
2. Only after explicit owner approval, apply the reviewed supabase/local-draft/hosted-relay.sql once. This file is deliberately outside the CLI migrations directory; a routine db push must not apply it. Validate RLS/RPC permissions/config disabled.
3. Build server bundle from entry.ts with esbuild. index.ts is generated, never edit independently. Deploy only this function, with server credentials supplied by Supabase runtime.
4. Configure approved public signing keys and exact production/test origins. Keep disabled until hosted negative tests, actual concurrency, storage/read bounds and retention decision are verified.
5. Build app with endpoint, validate two independent browser vaults: contact exchange, send/pull/decrypt, response in reverse direction, offline/reload/retry/locked behavior, desktop/mobile. Inspect ciphertext-only server rows and browser bundle/response for secrets. No claim online chat is working until actual arrival proof.

## Current verification

Current-main baseline552unit tests; client3focused tests; app strict typecheck/build. Hosted-schema PGlite proof adds config/role denials, reader rate and byte ceiling tests. PGlite is not hosted Supabase, multi-session concurrency or deployed UI proof. All hosted status must be separately recorded.

## Retention decision pending

Proposed only: remove expired signed-read anti-replay markers after10minutes; replaced/unreferenced encrypted snapshots after7days; never current snapshots/local vault messages/other tables. No such cleanup included or executed until owner decides. Caps mean no indefinite growth, but reaching a cap stops online relay until authorized maintenance.
