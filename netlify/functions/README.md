# Share relay (netlify/functions)

Short share links with real post previews. Pressing Share on a post publishes exactly
that post's signed single-post bundle; /s/<id> renders it readably with per-post og:*
tags (the iMessage card), auto-continues browsers into the app's read-only /shared/<id>
view, and "Save to my vault" runs the standard explicit import. Unshared posts never
leave the device.

## Activation (owner decision)

Everything is gated OFF by default. A deploy preview builds these functions but every
route answers 404 and nothing is written to blob storage while gated.

To activate: set `EIC_SHARE_RELAY=on` (functions) and `VITE_EIC_SHARE_RELAY=on` (app
build) as Netlify env vars scoped to production, then redeploy.

Dependency layout: `@netlify/blobs` is declared in the root package.json (and lockfile)
so the deploy build can trace it, and the wrappers import it lazily with
`await import(...)` only after the gate has passed - a gated deployment never resolves
the package at cold start (regression-tested in lib/wrappers-gate.test.ts with the
package mocked as uninstalled). Revoking the vars and
redeploying turns the feature off; stored shares remain until they expire or are
deleted, but stop being served.

What activation changes on the account (Free Legacy plan, $0 today): function
invocations for share traffic and a `shared-posts` blob store (created on first
publish). No paid features are required at current plan levels, but plan terms can
change - the meters live under Usage & billing. A daily scheduled sweep for expired
shares is deliberately NOT in this draft: lazy expiry only removes shares that are read again. Cleanup policy and scheduling
are activation blockers requiring an owner decision, not a post-release follow-up.

## Known activation blockers (resolved before the flag goes on, not draft safeguards)

- Global post count/byte accounting is not one transaction with blob creation or
  deletion. ETag CAS protects per-client rate claims, not the global storage budget.
  A reservation/rollback design and concurrency proof remain required before activation.
- Expired unread posts, rate records and absent-id revoke markers need an approved
  bounded cleanup policy before activation. No cleanup job or deletion policy is added here.
- Reads are unmetered: a widely forwarded link costs function invocations + bandwidth
  per view with no per-link throttle. Free-plan meters (Usage & billing) are the only
  backstop today.

## Proposed config (defaults in lib/share-core.ts, not owner-set preferences)

- Retention: 90 days. A read that finds an EXPIRED share deletes it on sight (ordinary
  active reads leave content unchanged). A scheduled sweep requires an owner decision.
- Size: 4 MB per shared bundle; photos recompress well under that.
- Abuse bounds: conditional ETag accounting limits 10 attempts (including invalid ones) per
  client IP per hour; global 500-share / 250 MB caps remain approximate. IPs are stored only as truncated
  SHA-256 hashes for rate windows.
- Revocation: the creator's delete key lives only in their vault. After revoke, the page
  and photo 404 within the cache window (60s page / 300s photo, must-revalidate). Note:
  a message app that already rendered the card keeps its own cached copy - revocation
  kills the link, not the recipient's already-fetched preview.

## Security posture

- The relay verifies each bundle's Ed25519 signature at publish (same Web Crypto
  primitive as the app), so unsigned or tampered content can never be stored, rendered,
  or crawled into a message card. A signer still chooses their own handle - the app's
  read view keeps the "self-asserted until saved" honesty line, and import re-verifies
  client-side as before.
- All rendered fields are HTML-escaped; og:image serves only whitelisted image types.
- The stored projection is one post + author handle/pubkey. No likes, no vault data.

## Encrypted backup sync (api-backup.ts) - Cookie Jar P3

Optional recovery of an already passphrase-encrypted vault export on another device. The
function stores that opaque ciphertext under the SHA-256 of a random recovery secret the owner
holds; the host never sees the passphrase or any plaintext, and the secret is never stored in
the browser (the Cookie Jar shows it once).

### Activation (owner decision, off by default)

Set `EIC_BACKUP_SYNC=on` (functions) and `VITE_EIC_BACKUP_SYNC=on` (app build) as Netlify env
vars scoped to production, then redeploy. While unset, every `/api/backup` method answers 404
and the blob client is never resolved (regression-tested in `lib/backup-gate.test.ts`). The
Cookie Jar hides the sync switch when the build flag is off. Revoking the vars and redeploying
turns it off; stored backups stop being served and expire on their own.

### Free-tier shape ($0 today; plan terms can change, check Usage & billing)

| Limit | Value |
|---|---|
| Per backup | 2 MB |
| Backups total | 200, and 100 MB total |
| Retention | 30 days from the last upload (an upload renews it; expired entries are removed on read) |
| Writes | 6 per hour per connection, compare-and-swap counter |

Uses one `encrypted-backups` blob store and function invocations only. No database, no new
service, no sign-up.

### Known limits (same class as the share relay's activation blockers)

- Global count/byte accounting is read-then-write, not one transaction: two simultaneous first
  uploads can briefly exceed the caps by a small margin. Caps are far below plan limits, so this
  is a budget overshoot, not a correctness bug, but it needs a reservation design before heavy use.
- Reads are unmetered per link, like shares. The secret is 256 bits, so guessing is not the risk;
  a widely copied recovery code can cost bandwidth.
- No scheduled sweep ships. `sweepExpiredBackups` exists and is tested; running it on a schedule
  is an owner decision. Until then expired entries are removed when read or replaced.
- This is a sensitive surface (crypto-adjacent storage, rate limiting). It needs owner
  confirmation before activation.
