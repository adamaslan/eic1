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
build) as Netlify env vars scoped to production, then redeploy. Revoking the vars and
redeploying turns the feature off; stored shares remain until they expire or are
deleted, but stop being served.

What activation changes on the account (Free Legacy plan, $0 today): function
invocations for share traffic and a `shared-posts` blob store (created on first
publish). No paid features are required at current plan levels, but plan terms can
change - the meters live under Usage & billing. A daily scheduled sweep for expired
shares is deliberately NOT in this draft: phase 1 relies on lazy expiry at read time,
and adding the cron is its own activation decision later.

## Known activation blockers (resolved before the flag goes on, not draft safeguards)

- The abuse bounds are approximate: the blob store has no compare-and-swap, so
  concurrent publishers can drift past the caps. They stop bulk abuse; they are not a
  guaranteed budget bound.
- Reads are unmetered: a widely forwarded link costs function invocations + bandwidth
  per view with no per-link throttle. Free-plan meters (Usage & billing) are the only
  backstop today.

## Proposed config (defaults in lib/share-core.ts, not owner-set preferences)

- Retention: 90 days. A read that finds an EXPIRED share deletes it on sight (ordinary
  reads are never destructive). A scheduled sweep (cleanup) is deferred to a later phase.
- Size: 4 MB per shared bundle; photos recompress well under that.
- Abuse bounds (approximate - the blob store has no compare-and-swap): 10 publishes per
  client IP per hour; 500 live shares / 250 MB total. IPs are stored only as truncated
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
