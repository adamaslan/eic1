# Session record, 2026-11-20: Discover to chat proof (EIC #128)

Branch `fix/hosted-messaging`, from `b1c07bf` to `4f4577c` plus this file. Not pushed, not merged. Synthetic data and an in-memory relay only; nothing here is hosted evidence. The full evidence log is `docs/eic-messaging-plan.md` §8.

## Order of work

1. Checked tree ownership, then read the directory, relay client and chat code.
2. Fixed CodeRabbit's four findings on #128 (requester name, CAS-guarded feedUrl check, Turnstile reset, self-enroll test seeding).
3. Verified sealed request and accept (key binding, explicit accept, no friend-key replacement). Block and report do not exist.
4. Diagnosed transition-smoke read-only: Netlify reported no deploy-preview status on #126, #127, #128.
5. Built `e2e/discover-two-vault.spec.ts` and iterated until it passed 4 of 4 runs.
6. Updated the plan doc and wrote a paste-ready homebase section (not written into the other worktree).

## Defects the e2e found, all fixed with tests

- Discover sealed connects with no relay feed, so friends got `no-feed`.
- An open chat ignored receipt-only pulls and background-pass applies.
- A "confirmation is pending" notice outlived the queue.
- The Join panel stayed after joining.
- A request to a card that left Discover said "Try again".

## Dead ends worth keeping

- `page.clock.install` leaves the `motion` fade-in at opacity 0, so early screenshots were blank. Capture helper forces those wrappers visible.
- A reload resumes the session; it does not ask for a passphrase.
- Manual "Check for messages" does not publish a receipt; only the automatic pass does.
- A late joiner's page clock must be fast-forwarded to the relay's skew or its signed requests look stale.
- `timeout` does not exist on macOS; a `cd` inside a command persists across calls.

## Checks

vitest 80 files and 837 tests pass; eslint 0 errors (one old warning); typecheck clean.

## Still open

Block and report; draft persistence across reload; double "Discover" title bar; transition-smoke (Netlify side); 45 synthetic hosted `feeds/` objects awaiting a yes before any delete; #126 overlaps `chat.tsx`.
