# EIC acceptance audit - 2026-11-24

Audited on `main` at `257bb3e` (PR #131). This is a source and local-browser audit; it does not
change hosted services or make a production-delivery claim.

Commands run:

- `npm test -- packages/features/src/sharing.test.ts packages/features/src/connections.test.ts packages/features/src/chat-link.test.ts packages/features/src/feed-sync.test.ts` — 84 passed.
- `npx playwright test --config=playwright.ws24-unset.config.mjs e2e/chat-link.spec.ts e2e/chat-legacy-upgrade.spec.ts` — 3 passed. This config uses ports 5273/4280 by default; set `EIC_AUDIT_APP_PORT` and `EIC_AUDIT_RELAY_PORT` if those are occupied.
- `EIC_LOCAL_RELAY_TEST=1 npx playwright test --config=playwright.ws24-relay.config.mjs e2e/relay-local.spec.ts --repeat-each=5` — 5 passed. Across all runs, 11 passes followed one earlier failure at reconnect.
- `npm run lint` — 0 errors, 1 existing warning at `apps/web/app/components/player-audio.tsx:64`.
- `npm run typecheck --workspace web` — passed.
- `npm run build --workspace web` — passed.

| Item | Result | Evidence and limit |
|---|---|---|
| Signed connect link opens the intended chat; endpoint-unset sends remain local | PASS | `e2e/chat-link.spec.ts` passed 2/2 at 390×844. This proves link import and honest local-only behavior, not relay delivery. |
| Unsigned-to-signed bundle re-import keeps connection identity | PASS | Focused Vitest run passed 84/84 across sharing, connections, connect-link, and feed-sync. Assertions cover nickname/hidden/addedAt preservation, refreshed `lastImportAt`, and the documented cursor reset for bundle re-import. |
| Legacy chat-upgrade route test setup | FIXED | The old test went directly to `/unlock`, where current `main` no longer presents the create form. It now follows the homepage's “Create or open your vault” link; the E2E passes on desktop and phone. |
| Signed relay reconnect after offline send | UNVERIFIED | The memory-backed `e2e/relay-local.spec.ts` failed once at reconnect with “The saved profile changed”; its message remained saved locally and queued. Eleven subsequent runs passed. This is not a stable enough result to call reconnect acceptance complete. The failure involved synthetic in-memory transport only. |
| Piano response on a real instrument and phone | UNVERIFIED | PR #124's deferred-permission browser fixture verifies pending/cancel/denial UI, not acoustic accuracy or physical-device latency. No instrument or phone acceptance run was available in this audit. |
| Hosted two-person relay | HISTORICAL | PR #128 records a successful synthetic two-person run against the hosted relay. It was not repeated here; this audit made no hosted requests, writes, configuration changes, or deployment. |

Local browser checks used isolated ports 5273/4280 because port 5173 was already occupied by another
running server. The checked-in `playwright.ws24-unset.config.mjs` starts the app and local share relay;
`playwright.ws24-relay.config.mjs` enables the in-memory relay endpoint intercepted by the test.
Both configs use `reuseExistingServer: false`; the server on port 5173 was left running. The live-relay
cleanup of retained synthetic rows and the WS24 EIC usage-artifact cleanup remain owner-confirmation
tasks; no data was deleted.
