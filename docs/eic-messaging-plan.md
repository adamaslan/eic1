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

## 8. Evidence log, 2026-11-20 (follow-up to b1c07bf)

Everything here ran locally against **synthetic** vaults and an **in-memory relay** behind browser route interception. None of it is hosted Supabase evidence, and none of it proves the deployed relay. Spec: `e2e/discover-two-vault.spec.ts` (opt-in, `EIC_LOCAL_RELAY_TEST=1`; skipped otherwise, and a skip is not a pass).

### What the two-vault run proves (desktop 1280 and mobile 390, three isolated vaults)

Passed 4 of 4 consecutive runs after the fixes below, about 35 s each. Covered: not-joined state, Turnstile join, publish card, find, request, accept, chat A to B, automatic receipt with no reply from B, reply, reload (the session resumes, no passphrase prompt), offline with three retry taps (one copy, saved on device), reconnect (exactly one copy at the recipient), lost publish response (one copy, never shown as sent early), decline (request kept as declined, no sealed material, no resurrection), third-person privacy (a non-participant's directory replies contain only their own requests; no plaintext in any relay row), hide (card gone for others, chats kept and still working), locked vault (zero relay requests while locked, work resumes on unlock), no horizontal overflow at 390, and no console or page errors apart from the deliberate offline aborts.

### Defects found by that run and fixed (each has a unit test)

| Defect | Effect | Fix |
|---|---|---|
| Discover sealed connects before the vault had a relay feed | The friend imported a connection with no feed URL, so chat showed `no-feed` and could never receive | `signedDirectoryAdapter(..., prepareFeed)`; Discover passes `configureRelayFeed`. A failing step stops the request. Connections made before this fix are not repaired. |
| An open chat ignored receipt-only pulls | The sender kept seeing "Sent to relay" after the receipt was saved | `SyncResult.appliedReceipts`; `applyCatchUpOutcome` reloads on it |
| The app-wide background pass could save a message or receipt first | The open chat then read "unchanged" and lagged the vault | `RELAY_APPLIED_EVENT`, fired by the background pass, repaints an open chat |
| "Relay confirmation is pending" outlived the queue | It contradicted the delivered ticks beside it | Cleared once no sent message is queued |
| Join panel stayed after joining | Looked like Discover was still locked | Hidden once Discover has loaded |
| Request to a card that left Discover said "Try again" | Not retryable | Says "That person is no longer in Discover." and drops the card |

CodeRabbit's four open findings on #128, checked against current code: requester name from `state.cards` (valid, fixed); feed-destination check inside the CAS loop (valid, fixed through a `saveSettingsFields` guard); Turnstile widget reset after a single-use token (valid, fixed; a reset now yields a fresh token and the e2e uses single-use tokens); `hosted-self-enroll.test.ts` seeding (valid, narrow: the cap test hardcoded the restore value and the claim tests assumed an empty day; both now own their state).

### Request and accept, verified (item 2)

Sealed request and accept bind the sender key at request time. Only the listed key can accept. A pending or declined request grants nothing: no connection, no chat. Declined requests keep no sealed material and do not come back on retry. A sealed connect must carry its sender's own signed bundle, and cannot replace an existing friend's key. **Missing: block and report.** There is no code for either. Declining is not blocking, because the sender can still see the card and the card is the only gate. *(Later the same day: a local block now exists; report still does not. See "Follow-up" below.)*

### Not proved, or found and not fixed

- **transition-smoke CI is red for a reason outside the code.** `e2e/ci-preview.mjs wait` polls for the Netlify deploy-preview status and the footer build stamp. Commit `5cf8748` has zero commit statuses, so Netlify never reported a preview. PRs through #125 got `netlify/everybodyiscool/deploy-preview=success`; #126, #127 and #128 have none, and all three smoke jobs fail after about 16 minutes. Lint, tsc and vitest show `skipping` because they only run on manual dispatch, and **skipped is not passed**. Cause is on the Netlify side (not visible from here). Nothing was deployed or removed.
- ~~A draft typed in the message box is not persisted across a reload (state only).~~ Fixed in `7e6b351`, see "Follow-up" below.
- ~~The Discover route wraps the component's own window, so two "Discover" title bars show on desktop.~~ Fixed in `d40a99d`.
- A pull of a friend's never-published feed still counts as `failed: 1` in `runRelayPass` (pre-existing).
- Screenshots were taken under a mocked clock, which leaves the window fade-in at opacity 0 (a test-clock artifact, not a product defect). The capture helper forces those wrappers visible.
- 45 synthetic hosted `feeds/` objects from earlier runs were not touched. Deleting them needs a yes first.

### Follow-up, 2026-11-20 evening: block, drafts, title bar, #126 overlap

Same limits as above: synthetic vaults, in-memory relay, nothing hosted, nothing pushed or merged. The two-vault spec now also covers the three items below and passed 3 of 3 consecutive runs (about 45 to 55 s each). vitest 81 files and 845 tests pass, eslint 0 errors (the old `player-audio.tsx` warning), typecheck clean.

| Item | Status | What it does, and where |
|---|---|---|
| Block | Done, local only (`bbbadf9`) | "Block" on a profile and on an incoming request. The person goes into an encrypted vault record (`discover-blocks`, at most 500). Discover hides their card, declines their pending requests with the existing `decline` action (the relay keeps a declined request declined and drops its sealed material), and never imports an accept from them, even one I asked for before blocking. Connections and chats are untouched. A failed decline is retried on the next read. "Blocked on this device" lists them, with Unblock. |
| Report | Not built, needs an owner decision | There is no moderator, no server-side report store, and no policy for what a report triggers. Building one means a new relay action, retention rules and someone to read reports. That is a product and hosting decision, not a code gap. |
| Draft across reload | Done (`7e6b351`) | The message box is saved per chat as an encrypted settings record `chat-draft:<author>`, debounced 300 ms and written one at a time; flushed when leaving a chat; deleted before the box clears on a successful send, so a fast reload cannot bring back sent text. Chat and relay code list only `chat` records, so a draft is never published. |
| Double "Discover" title bar | Done (`d40a99d`) | The route adds a window only for the join check ("Join Discover") and the loading or error line. The e2e asserts exactly one "Discover" title. |

What the block does **not** do: my card stays visible to the person I blocked while I am listed, because every directory read returns every live card and the relay knows nothing of the block. Hiding my card from one person needs a server-side filter, which is an owner decision (it would tell the relay who blocked whom). A block on one device does not reach my other devices.

**PR #126 overlap, measured read-only** (`git merge-tree`, nothing merged or rebased). #126 has two commits on the same `main` base as this branch. Three of its five files (`DISCOVER-MESSAGING-TODO.md`, `landing-dashboard.tsx`, `e2e/dashboard-friend-chat.spec.ts`) are byte-identical here: `025b427` carried them in. `connections.tsx` auto-merges. `chat.tsx` has the only real conflict, two hunks, both relay-notice copy: #126 shortens the notice to "Encrypted chat. Check the send status below." where this branch explains the three delivery states, and #126 keeps the "Set up relay feed" hint for a button this branch removed. So #126 adds nothing this branch lacks except the shorter copy. Which copy wins, and whether #126 closes as superseded, is the owner's call.

**A lead on transition-smoke, not a conclusion.** #126's commits carry `[skip netlify]`, and the titles of #126, #127 and #128 all do. Netlify skips a build when the commit message carries that marker, which fits "no deploy-preview status on #126 to #128". This branch's own commit messages do not carry it, so on #128 that would only explain the missing preview if Netlify reads the PR title too. Unverified.

<!-- model-stamp: Claude Opus 5.5 (claude-opus-5-5) | session dd6622bc | 2026-11-20 | editor -->
