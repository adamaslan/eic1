# Username profile URLs with sign-in

Status: proposal only. No runtime implementation, account change, database migration or profile publication is included in this PR.

## Requested experience

Adam requested a profile address such as `https://everybodyiscool.com/chiantihimbo`: choosing a profile name should give the person a page at `everybodyiscool.com/<username>`, with sign-in required before viewing it. His follow-up asks for this Markdown document and a PR, not implementation yet.

`chiantihimbo` is the supplied URL example. This document does not reserve that name or bind it to any identity.

## Current support, checked November 26, 2026

Source baseline: `f4083c070bcaf39c512ac44be2e27ef4bc6ee77d`.

- The actual requested URL displayed the app's Not found / 404 page in a browser. It does not currently resolve to a profile.
- `apps/web/app/routes.ts` declares `/profile` for the current person's profile and `/profile/:authorId` for an imported profile. It does not declare a root-level username route.
- `apps/web/app/layouts/desktop.tsx` requires an unlocked browser-local vault for these profile routes. A locked visit goes to `/unlock`; it does not preserve the requested path in that redirect.
- `apps/web/app/routes/profile.tsx` loads the current private profile draft or a profile stored in the local vault by author ID. A missing imported profile is reported as missing, not fetched from a global username directory.
- `apps/web/app/routes/connections.tsx` saves a self-chosen handle in local settings. That is not a globally unique username claim or a cross-device account.
- Discover has signed directory and membership code, but its existence does not establish a globally unique username registry, hosted profile store or completed authentication system for this feature. Do not assume its current visibility rules satisfy this request.

The new texted connect links are separate: a query link carries a public card and opens an explicit connect flow. That is not a permanent `/username` profile URL.

## Target journey

1. A person chooses an available username while signed in and sees the exact profile URL before publishing anything.
2. A visitor opens `/<username>`.
3. A signed-out visitor sees a sign-in screen, not profile fields. Successful sign-in returns to that exact local profile path. Cancelled or failed sign-in reveals nothing.
4. The service resolves the username to its verified owner and enforces the selected access policy before serving profile fields or assets.
5. An allowed visitor sees only fields the owner deliberately chose to share. An unavailable, hidden or disallowed profile gets a safe, useful state. Nobody silently connects or sends a message.
6. Refresh, back navigation, manual lock, account switching and expiry retain correct destination and access checks without leaking the prior person's profile.

This must work on a fresh browser/device, not only when the owner already imported a profile into that device's vault.

## Product decisions still open

### What does sign-in mean?

- **Current vault unlock:** keeps today's device-local identity model, but unlocking any newly created vault is not proof of membership or ownership of a globally claimed name.
- **Account-backed membership:** supports a stable name and profile across devices, but needs an agreed identity/recovery system and authorized server work. It must not require uploading a vault passphrase or private encryption keys.

Recommendation for the complete requested experience: account-backed membership with explicit binding between the account, signing identity and username. This is a recommendation, not an approved auth change. A client-only route alias can be a prototype, not completion of the feature.

### Who may view a signed-in profile?

The request establishes a sign-in gate but does not say whether every signed-in member or only accepted connections may view the page. Decide that audience before implementing access control. Sign-in alone must never be presented as a connections-only privacy guarantee.

Also settle which fields belong on this page. Reuse explicit profile-sharing selections; do not publish a private draft bio, posts, journal, contact details or hidden profile fields by default.

## Proposed implementation stages

### 1. Resolve identity, access and storage

- Pick the sign-in meaning and allowed audience above.
- Specify server-enforced authenticated reads, ownership claims, recovery and revocation. A client redirect alone is not access control for hosted profile data.
- Decide where the deliberately shared profile projection is stored and whether it is encrypted for approved viewers. Keep private vault data separate.
- Reuse existing directory/relay capabilities only after verifying their actual contracts and limits. Any migration, live data write, account/admin change or spend needs its own applicable approval.

### 2. Define username ownership

Suggested starting rules, pending product review: case-insensitive normalized lookup, a documented bounded ASCII character set, atomic uniqueness and a stable owner ID separate from the username. Do not claim a name just because a local handle matches it.

Reserve every existing first-segment route, including profile, unlock, feed, market, chat, connections, discover, tools, draw, vault, graph, shared, stickers, music-library, learn-piano, compose, showcase, item, API paths and static assets. Add explicit rules for rename redirects, deletion, reclaim cooldown and impersonation/confusable names. Duplicate legacy handles need a visible resolution flow, not automatic reassignment.

### 3. Add routing and sign-in return

- Keep named application routes ahead of a final one-segment username route; do not break the existing catch-all or asset routing.
- Preserve only a validated same-origin local return path. Reject protocol-relative URLs, external URLs, encoded bypasses and recursive sign-in loops.
- On sign-out/lock, remove visible profile data and clear access-specific caches. Recheck access after resume or switching accounts.
- Keep `/profile` as the current person's editing entry point and make its relationship to `/<username>` clear.

### 4. Implement the profile reader and publication controls

- Resolve the server-owned username binding and enforce read permission before returning the profile projection.
- Explicit publish/update/hide controls explain audience and exactly which fields leave the vault. A username claim is not approval to publish everything.
- Use safe rendering for bios and decorations. Protect claims and updates against replay, races and unauthorized ownership changes.
- Before sign-in, link previews, page metadata, HTML, assets, APIs and caches must not expose protected profile fields. A neutral sign-in page is sufficient; a public photo/name preview would be a separate choice.
- Apply private/no-store caching where appropriate. `noindex` may reduce indexing but is not security. Keep usernames and session details out of unnecessary analytics/logging.

## Acceptance evidence before calling this done

- Fresh signed-out desktop and phone visits to an owned `/<username>` reach sign-in without protected fields in UI, HTML, metadata or responses.
- Successful sign-in returns to the intended profile; wrong credentials, cancellation, expiry, lock and sign-out disclose nothing.
- Two isolated identities prove allowed and denied viewing for the chosen audience. Direct API/asset access cannot bypass the gate.
- The correct profile loads on another device without importing a JSON file. Private/unselected fields remain absent.
- Atomic duplicate-name claims have one winner; normalization, reserved names, rename/delete, hidden/missing profiles and malformed paths are covered.
- Existing landing, music, profile editor, connect links and other routes still work. Unsafe return URLs are rejected.
- Current-head application build, focused failing-then-passing regressions, applicable security review, hosted desktop/phone pixels and production checks are separate recorded gates. A Markdown merge or a locally working route is not deployed feature acceptance.

## Scope of this PR

Documentation only. No names reserved, profiles published, account system selected, auth guard changed, database migrated or hosted behavior enabled. This feature request is separate from the pending 50 EIC ideas decision.
