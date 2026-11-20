# EIC messaging: implementation plan

Written 2026-11-20 on `fix/hosted-messaging` (`60a0c5d`, one commit ahead of `origin/main` `44461ce`). Covers the task in `docs/eic-messaging-finish-task.md`. Nothing here is built yet.

## 1. Where things stand

| Piece | State | Source |
|---|---|---|
| E2E sealed envelopes, local encrypted vault history | Done | `packages/features/src/chat.ts` |
| Feed-snapshot relay (publish / read / chunk), signed reads, nonces | Done, v1 live | `relay-http.ts`, `relay-adapter.ts`, `hosted-relay.sql` |
| Outbox: exact signed snapshot saved before send, read-back confirmation | Done, but **send is manual** ("Retry relay send") | `relay-outbox.ts`, `chat.tsx:392` |
| Foreground catch-up (1 per min, only while a chat is open) | Done | `apps/web/app/platform/foreground-relay.ts` |
| Vouched enrollment (invite in connect link, `/enroll`) | Code on this branch; SQL + function v2 **files only, not applied** | `60a0c5d`, `supabase/local-draft/hosted-relay-v2-members.sql` |
| Recipient receipts | **Missing.** The UI says "this is not a recipient receipt" | — |
| Friend-chat entry, collapsed tech details | PR #126 (5 files, open) | `pr126` |
| Discover | PR #127 patch: signed protocol + controller + UI, **synthetic cards, in-memory whole-DB CAS store, no HTTP, no durable storage** | `pr127:1-eic-messaging-discover-codex-20261119.patch` |

**How the transport works.** Each person publishes one signed feed of *all* their outbound sealed chat envelopes. Each friend pulls that feed. There's no per-message server row and no ack. Two consequences shape this plan:
1. The feed grows with every send. The draft v2 per-publisher cap (200 rows / 4 MiB) fails closed after about 100 sends.
2. "Delivered" can only come from the recipient saying so.

The fix for both is the same thing: **recipient acks published in the recipient's own feed** (Phase 3). The sender prunes envelopes that have been acked, which bounds the feed.

## 2. Integration of #126 / #127 (once)

The patch is based on `44461ce`, the same base as this branch. It contains #126's five files plus twelve Discover files. It overlaps this branch in two files: `apps/web/app/routes/chat.tsx` and `packages/features/src/index.ts`.

**Step 1: preflight.**
```bash
cd /Users/adamaslan/code/eic1-messaging
git fetch origin pull/126/head:pr126 pull/127/head:pr127
git rev-parse pr126 pr127 origin/main
git show pr127:1-eic-messaging-discover-codex-20261119.patch > /tmp/pr127.patch
git apply --check --3way /tmp/pr127.patch; echo "exit=$?"
```
Expect `pr126` = `531e350…` and `origin/main` = `44461ce…`. If either has moved, stop and reconcile before continuing.

**Step 2: apply as one commit**, then resolve the two overlaps by hand. Keep this branch's removal of the "Set up relay feed" button and #126's Friend-chats/collapsed-details layout.
```bash
git apply --3way /tmp/pr127.patch
git status --short
```

**Step 3: verify the five #126 files match `pr126` byte for byte** (except where `chat.tsx` was merged):
```bash
for f in DISCOVER-MESSAGING-TODO.md apps/web/app/components/landing-dashboard.tsx apps/web/app/routes/connections.tsx e2e/dashboard-friend-chat.spec.ts apps/web/app/routes/chat.tsx; do
  git diff --quiet pr126 -- "$f" && echo "same  $f" || echo "DIFF  $f"
done
```
Expect `same` for every file except `chat.tsx`.

Commit message: `feat: integrate #126 + #127 source (supersedes #126)`. The PR body says #126 is superseded. Closing #126 is the owner's call.

**What gets dropped from #127:** the synthetic preview route (`discover-local-preview.tsx`, `EIC_LOCAL_DISCOVER_PREVIEW`) and the in-memory store as a production path. The pure protocol (`discover-directory.ts`), controller and UI component are kept and rebound to real storage in Phase 5. The synthetic Playwright journey is rewritten against the local relay.

## 3. Phases

Each phase lands as its own commit on this branch, with tests. The order follows dependencies.

### Phase 0: recheck live state (read-only)
- Confirm the origins still include `https://everybodyiscool.com`. Count members and keys, objects and the max generation, and compare with the baseline in `.claude/fresh-session-brief.md`.
- Confirm the deployed function version (v1) and the endpoint baked into the bundle.
```bash
sb() { npx --yes supabase@2 db query --linked --project-ref ggofnvlccqjuqemjsmas "$1"; }
sb "select origins, cardinality(public_keys) as keys from eic_relay.config"
sb "select count(*), max(generation) from eic_relay.objects"
```
No writes.

### Phase 1: automatic send (queued → server-accepted)
- `sendChatMessage` stays local-first: the message is saved to the vault before any network call (status **queued**).
- New `apps/web/app/platform/relay-sender.ts` runs `prepareRelayOutbox` + `attemptRelayOutbox` automatically after each send, and drains in a loop: if newer unsent messages exist after a confirmation, it prepares again.
- Retry triggers: `online`, `visibilitychange`, app unlock, and a capped backoff (5 s → 5 min). One flight per vault via a Web Lock (`navigator.locks`), so two tabs never race. The outbox CAS already keeps the stored state safe.
- Each outbound message records `relaySeq`, the first snapshot seq that included it. **Server-accepted** = the confirmed outbox seq ≥ `relaySeq`. Fields are optional in `ChatMessageSchema`, so old records still parse.
- Remove the manual "Retry relay send" path from normal UI and keep it under the collapsed Relay details.
- A locked vault does nothing: the sender stops on lock and resumes on unlock, and pending bytes survive in the vault.

### Phase 2: app-wide receive (arrives automatically)
- Move catch-up from "the open chat only" to **all connections while the app is unlocked and visible**. A chat open in the foreground polls faster (15 s), the rest of the app slower (60 s), and a hidden tab doesn't poll at all.
- **Read budget:** the hosted reader cap is about 1200 nonces per 10 minutes (~120 per minute), *global*. Per-feed reads won't scale past a handful of people. Add a batched `heads` action: one signed read returns `{feedPath → generation}` for up to 50 feeds, and full manifests and chunks are fetched only for feeds that changed. It's one nonce per poll, not N.
- Inbound dedupe already keys on the envelope signature (`inboundMessageId`). Keep the rollback guard (never accept a lower seq).
- Unread badges on Home/Messages update from the same pass.

### Phase 3: recipient receipts (delivered) + bounded feeds
- When B applies inbound envelopes from A, B adds a sealed `chat-ack` chunk to B's own feed. It's addressed to A and holds the set of A's envelope signatures B has saved, compacted to "all ≤ seq N plus the stragglers".
- When A catches up on B's feed, A verifies and opens the ack and marks matching outbound messages `deliveredAt` (**recipient-delivered**). An ack is only written after B has saved the message to its vault, so a delivered tick means it's on B's device.
- **Pruning:** `buildChatFeedSnapshot` drops outbound envelopes acked by their recipient, plus anything older than a retention horizon (proposed 30 days; owner decision G4). This bounds feed size and makes the per-publisher cap workable.
- Acks never contain plaintext and are sealed like any envelope. The relay still sees only opaque chunks.

### Phase 4: zero-setup connections and upgrade of existing ones
- On first unlock after upgrade, run `configureRelayFeed` silently. It's idempotent and never replaces a different feed URL.
- Accepting a connect link enrolls the accepter, as on this branch, and shows status instead of failing silently: "Connected · enrolling…" → "Ready to chat" / "Couldn't join the relay. Retrying." The retry is automatic.
- Existing connections with a pubkey: nothing changes in vault history. If a peer's stored feed URL is a legacy (non-relay) feed, read both until the peer's relay feed appears.
- Unsigned (legacy file) connections stay read-only with the existing upgrade link (#123). History stays.
- Re-sharing a link from an existing member embeds a fresh invite, so an old friend who never enrolled is fixed by the next link exchange.

### Phase 5: real Discover
- **Storage:** new tables in `eic_relay`, `directory_cards(principal pk, pubkey, card jsonb, expires_at)` and `directory_requests(from, to, status, sealed_card, updated_at)`. Each is a per-row atomic write with a unique `(from, to)`. This replaces #127's whole-database CAS, and the SQL goes in a new local-draft file.
- **Endpoint:** a new `directory` action in `relay-http.ts` reusing `DirectoryService`'s checks (signature, seq replay, 30 commands/min). The admission check binds a principal to a **member** pubkey.
- **Visibility is hidden by default.** Publishing is an explicit toggle with owner-chosen fields only (name, handle, bio: #127's `Card`). No contacts, no autofill. Hiding deletes the card row only; connections and chats aren't touched. Every publish/hide is confirmed by reading it back.
- **Request → connect:** a request carries the requester's connect card (pubkey, authorId, relay feed, invite) **sealed to the target's pubkey**, so only the target can read it. Accepting creates the connection locally and returns the accepter's sealed connect card to the requester. Either side's client then completes the normal signed connection. Declined or pending requests grant nothing, and a visible card alone never lets anyone message.
- **Bootstrapping strangers:** in vouched enrollment, someone with no member friend can't join. See decision G3.
- UI: a `Discover` route in the desktop layout. Search, profile card, Request / Accept / Decline, and a "Show me in Discover" toggle in Settings.

### Phase 6: phones and Win95 polish
- Chat: full-height layout using `100dvh`, a composer that sticks above the on-screen keyboard (`visualViewport`), `env(safe-area-inset-*)`, tap targets ≥ 44 px, and no horizontal scroll at 360 px.
- Status ticks in Win95 style: ⏳ queued, ✓ accepted, ✓✓ delivered, ⚠ failed with a "Retrying" note. A long press or tap on a message shows the exact state text.
- Discover and Messages lists collapse to one column under 640 px.
- Copy: "Messages arrive while EIC is open. Closed-app or background delivery on iPhone isn't supported." No push promise.

## 4. Tests

| Layer | What it covers | Command |
|---|---|---|
| Unit (vitest) | sender loop, relaySeq/status derivation, ack seal/apply, pruning, `heads`, directory SQL-backed store, sealed request cards, lock/unlock stop/resume, duplicate/replayed acks | `npm test` |
| SQL (PGlite) | members + directory tables, quotas, per-row atomicity, concurrent request/accept | `npx vitest run -c supabase/local-draft/hosted-vitest.config.ts` |
| Local e2e (2 browser contexts, in-memory relay) | discover → request → accept → A→B → B saves → ack → ✓✓ at A → B→A; offline (`context.setOffline`) → queued → reconnect → delivered; reload mid-send; duplicate publish; locked B → unlock → arrives; 390×844 viewport screenshots | `npx playwright test e2e/relay-local.spec.ts e2e/discover-local.spec.ts` |
| Typecheck / lint / build | — | `npm run lint && npm run typecheck --workspace web && npm run build --workspace web` |
| **Hosted acceptance** | two separate local client builds (origin `localhost:5180` is allowed) against the **hosted** relay v2: normal connect, A→B decrypted and saved at B, ✓✓ at A, B→A, phone viewport, offline/reload/locked. Synthetic identities, cleanup of own rows only | `EIC_HOSTED_RELAY_SCRATCH=1 EIC_TARGET_URL=http://localhost:5180 npx playwright test e2e/hosted-relay-scratch.spec.ts` (rewritten: no SQL admit/revoke) |

Only the last row proves recipient delivery. It's blocked on G1 and G2.

## 5. Decisions and approval gates

| # | Gate | Recommendation |
|---|---|---|
| G1 | Apply `hosted-relay-v2-members.sql` + directory SQL to hosted Supabase | Needed for any hosted proof. Additive, with a written undo |
| G2 | Deploy `eic-relay` v2 (enroll, heads, directory, acks are client-side only) | Same gate as G1, deployed right after it |
| G3 | **How strangers from Discover join when neither side is a member** | Keep vouching as the default. Add Turnstile-gated self-enrollment with a daily global quota (e.g. 25/day) and the same per-key feed cap. The alternative "ask a friend for a link" breaks the Instagram-like goal |
| G4 | Quotas: 1000 members, 10 invites/member, 3 uses/invite, 200 rows / 4 MiB per feed, 30-day unacked retention | Use as written. Tunable by one `UPDATE` without a redeploy |
| G5 | Hosted acceptance run that sends synthetic messages on prod | Approve together with G1/G2 |
| G6 | Merge (sensitive: auth, crypto, rate limits) and Netlify production deploy | Owner confirmation after cross-model review |

Code for all phases can be finished and tested locally without any of G1–G6. When a phase needs a gate, it stops there and names it.

## 6. Out of scope / not promised
- Background or closed-app delivery, and web push.
- Group chats, media in chat, multi-device sync of one identity.
- Raising global caps beyond 10,000 rows / 32 MiB (owner decision, cost).

## 7. Order of work

1. Phase 0 (read-only check), then integrate #126/#127 (§2).
2. Phases 1 → 2 → 3: core delivery, provable locally end to end.
3. Phase 4: upgrade path.
4. Phase 5: Discover. Needs the G3 answer before the enrollment piece. The rest proceeds.
5. Phase 6: mobile polish and screenshots.
6. Open one non-draft PR with evidence, then wait for G1/G2/G5 before the hosted run.
