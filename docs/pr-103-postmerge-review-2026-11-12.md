# PR #103 post-merge review — disabled encrypted Supabase relay

Reviewed: 2026-11-12, against `origin/main` @ `252b0b4` (PR #103 merged 2026-11-09 as `0906bec`).
PR #103 was already merged when this review started, so nothing here is a merge gate. It is a
review of merged code, with one fix and a list of what is still open.

## Roles

| Role | Identity |
|---|---|
| PR #103 author | Not recoverable: every commit carries the repo owner's git identity, so no model is recorded. Treated as unknown. |
| Nonce-reclaim fix author | Claude Haiku 5.5 (`dcbc22f`, branch `fix/relay-nonce-reclaim`, never opened as a PR) |
| This review, hardening commit, this doc | Claude Sonnet 5.5 |
| Merger of this follow-up | **Not assigned.** The author must not merge. Needs a different model or the owner. |

## Verdict

PR #103's code held up under direct testing. Nothing was exploitable and the feature is still
disabled by default. I found **one real defect that was already known but unmerged, plus one gap in
that fix.** Most of the remaining risk is process, not code.

## What was run (all local, clean `npm ci` in a fresh worktree)

| Check | Result |
|---|---|
| `npx vitest run` (all workspaces) | 697 / 697 |
| `npm run typecheck --workspace web` (runs `react-router typegen` first) | clean |
| `npx eslint` on relay sources, `supabase/functions`, `chat.tsx` | clean |
| Hosted-schema + entry-runtime PGlite suite | 12 / 12 before; 17 / 17 after |
| Local PGlite proof suite | 6 / 6 |
| Playwright `relay-local.spec.ts` | **not run** (needs a dev server; opt-in) |
| Deployed preview, real Supabase, multi-session concurrency | **not run** (out of scope; the PR itself lists these as still required) |

My first test run showed 184 failures. That was my mistake: I had symlinked `node_modules` from the
main checkout, which made `@veil/*` resolve to a different branch. I discarded that run and
re-ran on a clean install. It is not a finding about the PR.

## Issues

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | High (availability) | Signed-read nonce rows (`replay/…`) were never reclaimed. A reader that made 1200 reads in its lifetime could never read again, and at 10000 total rows every write (publish, CAS state flip) was refused until rows were deleted by hand. The host-scheduled `sweepExpiredNonces` is never called in production. | **Fixed here** (cherry-picked `dcbc22f`) |
| 2 | Medium | The fix for #1 matched only `^[0-9]+$`. The read gate accepts any finite `ts` and stores `String(ts)`, so a fractional timestamp is a legal row that was **never reclaimed**. A reader sending fractional `ts` still wedged at "Reader capacity reached". Reproduced on PGlite before changing anything. | **Fixed here** |
| 3 | Low | The fix also relied on `AND` evaluating the regex before `data::numeric`. SQL does not guarantee that order. A `CASE` makes it explicit. No failure was reproduced on this PGlite version. | **Hardened here** |
| 4 | Low (test quality) | The "fresh nonces are not reclaimed" test asserted only `.rejects.toThrow()`. The store wraps every DB error in one generic error, so it would also pass if the trigger were broken. It now asserts `Reader capacity reached` on the raw RPC. | **Fixed here** |
| 5 | Medium (process) | `lint`, `tsc` and `vitest` are gated to `workflow_dispatch` only. They never run on a PR or on `main`. On #103 all three showed `SKIPPED`, so the "all green" on the PR is only the Playwright preview smoke and the credential scan. This is a deliberate owner choice ("run locally before publication"), so I did not change it. | **Open, owner decision** |
| 6 | Medium (process) | The hosted-SQL and proof suites need `EIC_PGLITE_MODULE`, an undeclared local install. They run in no CI job, so the SQL trigger and RPCs are only ever verified by hand. | **Open, owner decision** |
| 7 | Low | The PR body says no merge clearance was claimed and independent review qualification was still required. It merged about 27 minutes after the preview smoke finished (06:11 to 06:38 UTC), within two seconds of CodeRabbit's neutral status appearing. Nothing here suggests that was wrong, but there is no record that the stated gate was met. | **Open, note only** |
| 8 | Low (design) | `attemptRelayOutbox` reports `pending` forever if the relay holds a *different* manifest than the saved one (for example a newer `seq` published from another device). It never reconciles or surfaces the conflict. Not a data-loss bug, since the pending bytes are preserved, but the user gets no way out. | **Open, needs a design call** |
| 9 | Nit | `relayEndpoint` allows plain `http:` only for `localhost` and `127.0.0.1`, not `[::1]`. | **Open, nit** |

## Standing qualifications on this follow-up

- Issues 1–4 are verified **locally on PGlite only**. PGlite is in-process Postgres, not hosted
  Supabase, and says nothing about multi-session concurrency. The reclaim runs under the existing
  advisory lock, but that was not tested with concurrent writers.
- The 10-minute reclaim horizon assumes the Edge gate's 5-minute freshness window
  (`RELAY_READ_MAX_AGE_MS`) stays smaller. Changing one without the other reopens nonce replay.
- Reclaim is bounded per insert (500 per reader, 1000 global). A table full of fresh nonces is
  still refused. That is intended: only expired rows are reclaimed.
- No hosted schema, function or account was touched. `hosted-relay.sql` is still a local draft.

## Re-run it yourself

**Step 1 — unit suite and typecheck (CI never runs these).**

```bash
cd ~/code/.worktrees/eic1/review-103-postmerge && npm ci && npx vitest run && npm run typecheck --workspace web
```

Expect: `Tests  697 passed (697)`, then a clean typecheck.

**Step 2 — install PGlite outside the repo, then run both SQL suites.**

```bash
mkdir -p /tmp/pglite-eic && cd /tmp/pglite-eic && npm init -y >/dev/null && npm i @electric-sql/pglite --no-audit --no-fund
```

```bash
cd ~/code/.worktrees/eic1/review-103-postmerge
export EIC_PGLITE_MODULE=/tmp/pglite-eic/node_modules/@electric-sql/pglite/dist/index.js
npx vitest run -c supabase/local-draft/hosted-vitest.config.ts && npx vitest run -c supabase/local-draft/vitest.config.ts
```

Expect: `Tests  17 passed (17)` then `Tests  6 passed (6)`.

**Step 3 — verify the worktree is clean of scratch files.**

```bash
git -C ~/code/.worktrees/eic1/review-103-postmerge status --short
```

Expect: no output once committed.

## Open follow-ups (owner decisions)

- [ ] 🖱 **Decision (#5):** keep lint/tsc/vitest manual-only, or run them on `pull_request`. If
      on, the change is the `if:` line on the three jobs in `.github/workflows/ci.yml`.
- [ ] 🖱 **Decision (#6):** wire the PGlite suites into CI, which means declaring `@electric-sql/pglite`
      as a dev dependency, or keep them local-only and say so in `supabase/local-draft/README.md`.
- [ ] 🖱 **Design (#8):** decide what the outbox should do when the relay's manifest differs from
      the saved one.
- [ ] **Before ever enabling the relay**, the PR's own list still applies: deployed disabled and
      negative tests, real multi-session concurrency, a retention decision, and two real browser
      vaults through the deployed function.
