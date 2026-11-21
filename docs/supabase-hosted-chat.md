# EIC encrypted Supabase relay

Implementation branch based on EIC main 1c5f333. Reuses reviewed Homebase72 handoff tree1246680f, actual signed feed/chunk protocol and encrypted local vault. No second mailbox protocol.

## Scope and gates

Initial migration creates only private eic_relay schema, service-only RPCs and config. New config starts disabled with no keys/origins. No automatic cleanup or existing-data deletion. Per-reader120 nonce insertions/minute and1200 outstanding rows, global10000 rows/32MiB logical-object budget serialized at DB admission. This is a logical payload budget, not exact physical PostgreSQL disk usage. Full quota fails closed and preserves local messages. Migrations deliberately fail on conflicting objects rather than silently replacing someone else's work.

Runtime uses Supabase-provided server env for RPC and verifies EIC Ed25519 signatures. Browser never receives an admin key. Allowlists contain EIC signing public keys only, never passwords. Existing function JWT gateway configuration must be matched explicitly to the signed protocol before activation. Anonymous direct tables/RPCs remain denied.

Client endpoint is build-time VITE_EIC_RELAY_ENDPOINT. Without it, manual-only UI remains. Enabling the endpoint shows publish/retry/check actions, no timers/background polling beyond the existing open-chat foreground check. The relay feed URL is prepared automatically before a connect link is shared or accepted, and never replaces another feed destination. Existing Wi-Fi/cellular policy is honored. A relay commit is never recipient delivery or a read receipt.

## Vouched enrollment (v2, not yet deployed)

There is no public enrollment. Access goes to members only:

- **Roots:** keys already in `eic_relay.config.public_keys` are seeded into `eic_relay.members` by the v2 migration. `public_keys` stays a manual override.
- **Invites:** a connect link from a vault with a feed carries a relay invite `{id, expiresAt}`. The author's share key signs it (domain `eic-relay-invite:v1:`), outside the signed card subset. Invites last 14 days, and the relay rejects any invite that claims to last longer.
- **Enroll:** accepting the link calls `POST /enroll` with the invite and a fresh proof of possession over `enroll:{ts}:{nonce}:{inviteId}`. The relay checks both signatures and freshness, then a single-use nonce in the invitee's `replay/` namespace, then `eic_relay_enroll` under one lock. That last step admits the key only if the inviter is a member and the invite, inviter and global caps hold. An existing member gets `member` back and the invite is not spent. Denials return 403. Enrollment failure never blocks the connection, which is saved locally first.
- **Consequence:** a brand-new vault can't relay until a member connects with it. Two non-members who connect can't relay until one of them connects with a member.

Quotas are columns on `eic_relay.config`, tunable with one UPDATE: `max_members` 1000, `invites_per_member` 10, `uses_per_invite` 3, `feed_max_rows` 200, `feed_max_bytes` 4 MiB. **These values are proposed and unconfirmed.** The per-publisher feed cap sits on top of the global 10,000-row / 32 MiB cap, so one enrolled key can't fill the relay for everyone.

**Cap and retention interact.** Every publish writes new immutable `objects/<seq>/` rows, and nothing removes superseded snapshots yet. A publisher therefore reaches `feed_max_rows` after about `feed_max_rows / (1 + threads)` sends, and its relay publishes then fail closed (local messages are kept). The cap and the retention decision below must be settled together before broad use.

## Deploy and verify

1. Fresh catalog inventory for intended project and source review.
2. Only after explicit owner approval, apply the reviewed supabase/local-draft/hosted-relay.sql once (already applied on the hosted project), then supabase/local-draft/hosted-relay-v2-members.sql. **Apply v2 SQL before deploying the v2 function**: the v2 entry calls `eic_relay_is_member`, and without it every request returns 503. This file is deliberately outside the CLI migrations directory; a routine db push must not apply it. Validate RLS/RPC permissions/config disabled.
3. Build server bundle from entry.ts with esbuild. index.ts is generated, never edit independently. Deploy only this function, with server credentials supplied by Supabase runtime.
4. Configure approved public signing keys and exact production/test origins. Keep disabled until hosted negative tests, actual concurrency, storage/read bounds and retention decision are verified.
5. Build app with endpoint, validate two independent browser vaults: contact exchange, send/pull/decrypt, response in reverse direction, offline/reload/retry/locked behavior, desktop/mobile. Inspect ciphertext-only server rows and browser bundle/response for secrets. No claim online chat is working until actual arrival proof.

## Current verification

Current-main baseline552unit tests; client3focused tests; app strict typecheck/build. Hosted-schema PGlite proof adds config/role denials, reader rate and byte ceiling tests. PGlite is not hosted Supabase, multi-session concurrency or deployed UI proof. All hosted status must be separately recorded.

## Retention decision pending

Proposed only: remove expired signed-read anti-replay markers after10minutes; replaced/unreferenced encrypted snapshots after7days; never current snapshots/local vault messages/other tables. No such cleanup included or executed until owner decides. Caps mean no indefinite growth, but reaching a cap stops online relay until authorized maintenance.

## Chat screen: v1 vs v2

The chat route picks its controls from `VITE_EIC_RELAY_ENDPOINT` at build time.

- **Unset (default):** v1. "Text a chat link" and "Text the N older ones" are the delivery path.
- **Set:** v2. Those v1 buttons are removed. Send stores the message locally, then commits an encrypted snapshot to the relay. "Check for messages" pulls replies and "Retry relay send" resends the saved snapshot without retyping. There is no setup button: the feed URL is prepared when you share or accept a connect link, and accepting a member's link enrolls your key.

Turning v2 on before the relay is deployed and enabled leaves chat with no working delivery path, because v1 is hidden. Set the variable only after the deployed disabled/negative tests pass.
