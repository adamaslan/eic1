# Task: finish EIC messaging (adamaslan/eic1)

Written 2026-11-20. Read with `.claude/fresh-session-brief.md` (vouched-enrollment design, hosted facts, dead ends).

## Goal

Messaging should work like Instagram or WhatsApp. You find or add a friend, open the conversation and send, and the message arrives on its own. The normal user flow has no JSON sharing, no copied keys, no manual enrollment and no admin steps. Keep EIC's Win95 style and make it work well on phones.

Deliver working code. Another plan or handoff does not count.

## Starting point (check before writing)

- Worktree is `/Users/adamaslan/code/eic1-messaging`, branch `fix/hosted-messaging` (commit `60a0c5d`, vouched enrollment). Check the current branch and the work the last writer left before changing anything.
- **PR #127** (`handoff/eic-messaging-discover-codex-20261119`) is a packet of source, patches and handoff notes, not a finished integration. Recover it and integrate it **once**.
- **PR #126** (`fix/eic-message-entry-and-todo-20261119`) is open and unmerged. The #127 patch already includes #126's files, so never apply both. Account for #126 without duplicating its changes.
- Preserve unrelated work, including the untracked `e2e/hosted-relay-scratch.spec.ts` and `.claude/*.md`.

## Requirements

### Connection and enrollment
- [ ] Connection setup and authenticated relay enrollment happen safely inside the app (vouched invite, then enroll).
- [ ] Never put private keys or privileged server credentials in the client.
- [ ] Do not solve enrollment by opening unrestricted access.

### Encryption and storage
- [ ] Messages stay end-to-end encrypted.
- [ ] History lives in each device's encrypted local vault.
- [ ] Supabase is a temporary delivery hub, not a plaintext chat archive.

### Transport, receipts and UI
- [ ] Wire the real hosted transport, receipt handling and UI.
- [ ] Show three distinct states: **queued**, **server-accepted** and **recipient-delivered**.
- [ ] Handle offline delivery, retry, duplicates, reconnect, refresh and a locked vault without losing messages or reporting false success.
- [ ] Existing connections upgrade without losing history.

### Discover
- [ ] Build a real Discover: no synthetic people and no storage that lives only in browser memory. The flow is find people, add or connect, then chat.
- [ ] Discoverability is easy to turn off, and turning it off doesn't break existing chats.
- [ ] Private information stays private. Being visible does not let strangers message someone automatically.

## Proof required

Local tests or a relay acceptance response alone do not prove recipient delivery.

- [ ] Two separate hosted test clients connect the normal way, A sends to B, B decrypts and saves, and B replies to A.
- [ ] Test the phone layout, offline/reconnect, reload, duplicates, and locked/unlocked vault behavior.
- [ ] Include screenshots and the exact build and test output.
- [ ] Don't promise background delivery on iPhone unless it was demonstrated.

## Process

1. Recheck the live configuration before changing it. At the last check the production origin `https://everybodyiscool.com` was already allowed.
2. Fix bugs, then run focused regressions, typecheck and build:
   ```bash
   cd /Users/adamaslan/code/eic1-messaging && npm test && npm run lint \
     && npm run typecheck --workspace web && npm run build --workspace web
   ```
3. Return one integrated, **non-draft** PR and a short note on remaining work.
4. Don't stop at docs or green tests.

## Approval gates (stop and name the blocked step)

This is a sensitive surface (auth, crypto, rate limiting). If hosted acceptance needs any of the following, finish the independent code work and name the exact step that is blocked:

- an unapproved deployment (edge function v2, hosted schema migration)
- an access or configuration change
- an action by a real user

Don't deploy, spend money or open messaging to real users without the applicable approval. Owner confirmation is required before merge.
