# Transition-smoke test inventory — 2026-11-03

This inventory records the regression tests and local checks for the C2 transition-smoke safety change. It is based on the isolated `codex/c2-transition-smoke-20261103` worktree, branched from `eic1/main` at `3153e87e8de099ccba4beec2859e2832db94743d`.

## New transition-smoke guard tests

Run with:

```bash
node --test e2e/ci-preview.test.mjs
```

| Test | Expected behavior |
|---|---|
| Checkout guard accepts the PR head and rejects a different merge-ref commit | In a temporary Git repo, the exact PR-head commit passes. A real synthetic merge commit differs from that head and fails with a diagnostic telling CI to restore the `head.sha` checkout pin. |
| Served head stamp passes when provider status is unavailable | A matching footer stamp passes even when the deploy-provider status request fails; provider status remains diagnostic. |
| Green provider status and a stale served stamp never satisfy the gate | A successful provider status plus the wrong served stamp continues polling and fails at the overall deadline. |
| Every command receives the smaller per-call and remaining attempt budgets | Simulated hung status/probe calls receive bounded timeouts no greater than the configured per-call or remaining attempt budget; the overall deadline terminates the poll. |
| A hung probe process is terminated at its per-command timeout | A child process that would otherwise remain alive is stopped within the configured timeout and kill grace. |

The current run passed all five guard tests. The budget regression requires more than one poll attempt after a full attempt budget is consumed, so the test catches premature exit before the overall deadline. These tests do not claim that a Netlify preview for this branch was published or exercised.

## Existing Vitest files

`npm test` runs the 39 files below. The recorded run passed **423 tests across 39 files**.

### Web app

- `apps/web/app/pending-links.test.ts`
- `apps/web/app/platform/session-persist.test.ts`
- `apps/web/app/platform/session.test.ts`
- `apps/web/app/platform/sync-actions.test.tsx`
- `apps/web/app/platform/sync-fetcher.test.ts`
- `apps/web/app/platform/use-social.test.ts`
- `apps/web/app/review-regressions.test.tsx`
- `apps/web/app/routes/chat.test.tsx`
- `apps/web/app/routes/profile-view.test.tsx`
- `apps/web/app/runtime-watch.test.ts`

### Crypto package

- `packages/crypto/src/envelope.test.ts`
- `packages/crypto/src/vault-crypto.test.ts`

### Features package

- `packages/features/src/calendar.test.ts`
- `packages/features/src/chat-link.test.ts`
- `packages/features/src/chat-relay.test.ts`
- `packages/features/src/chat.test.ts`
- `packages/features/src/compose.test.ts`
- `packages/features/src/connections.test.ts`
- `packages/features/src/export.test.ts`
- `packages/features/src/feed-sync.test.ts`
- `packages/features/src/graph-filters.test.ts`
- `packages/features/src/graph.test.ts`
- `packages/features/src/journal-share.test.ts`
- `packages/features/src/journal.test.ts`
- `packages/features/src/music.test.ts`
- `packages/features/src/paint.test.ts`
- `packages/features/src/palette-png.test.ts`
- `packages/features/src/profile-assets.test.ts`
- `packages/features/src/profile-studio.test.ts`
- `packages/features/src/profile.test.ts`
- `packages/features/src/relay-adapter.test.ts`
- `packages/features/src/selectors.test.ts`
- `packages/features/src/share-link.test.ts`
- `packages/features/src/sharing.test.ts`
- `packages/features/src/social.test.ts`
- `packages/features/src/use-vault-items.test.ts`

### Media and vault packages

- `packages/media/src/policy.test.ts`
- `packages/vault/src/backup.test.ts`
- `packages/vault/src/vault.test.ts`

## Commands and local results

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | Passed; installed 236 packages in the isolated worktree. npm printed a deprecation warning for ESLint 9.39.5. |
| `node --test e2e/ci-preview.test.mjs` | Passed; 5/5 transition-smoke guard tests, including the multi-attempt deadline regression added after independent review. |
| `HEAD_SHA=$(git rev-parse HEAD) node e2e/ci-preview.mjs assert-head` | Passed against the original local main head `3153e87e8de099ccba4beec2859e2832db94743d`; the synthetic merge-ref mismatch is covered separately by the guard test. |
| `npm test` | Passed; 423 tests across 39 files. |
| `npm run lint` | Passed. |
| `npm run typecheck --workspace web` | Passed. |
| `git diff --check` | Passed. |

CodeRabbit identified that an exhausted per-attempt budget could also exhaust the sleep calculation even while the overall deadline remained. The poll now sleeps against the overall deadline, and the budget test asserts repeated attempts. After that fix, the focused guard tests (5/5), full Vitest (423/423), lint, and `git diff --check` passed. The branch's CI has rerun for the new head; see the PR checks for its live result.

## Not yet verified

- Exact-head remote CI for the updated head `3baf6f9d46cc119c85e43be1e95ba98ca8def461` is pending.
- A live Netlify deploy preview for the updated head has not completed its transition-smoke check yet.
- The 15-minute overall readiness timeout and 30-second per-attempt budget are tested with deterministic fake commands; the child-process termination test exercises a real local hung subprocess.
