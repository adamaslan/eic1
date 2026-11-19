# EIC messaging and Discover: Codex handoff

Prepared 19 November 2026, 16:16 America/New_York. This is a source handoff, not a release or an integrated implementation PR.

## Readiness

Messaging is not verified ready for two people on the hosted app. Passing local tests do not prove hosted delivery. Do not mark this complete from this PR, a local screenshot, a successful build, or a server health check.

- Repository main last verified: `44461ce858b9ac0926ef7846b9b49abd6f8b66fe`.
- Open messaging cleanup PR: https://github.com/adamaslan/eic1/pull/126 . Its exact source head is `531e35034cf6823bd1dc83fc3818d07481b49111`. It is not merged or deployed as of the source check for this handoff.
- The cleanup improves Friend chats entry, separates notes, reduces normal sharing controls to the connect-link action, and collapses delivery details. It does not itself fix hosted transport.
- Earlier read-only Supabase inspection on 19 November at 14:21 found messaging enabled, two admitted signing keys whose ownership was not verified, and only localhost:5180 allowed as an origin. The production origin was absent. This is a timestamped finding, not a fresh configuration guarantee. No settings were changed.
- Discover has local signed protocol, encrypted-vault helpers, controller, UI and an injected-transport adapter. The local preview uses synthetic people, browser-memory storage and real signatures. It has no default hosted endpoint, durable database binding, production route or real-person enrollment proof.

## What the source packet contains

`2-eic-messaging-discover-codex-source-20261119.tgz` contains selected changed source files only, preserving repository-relative paths. `1-eic-messaging-discover-codex-20261119.patch` represents the same selected source changes against the exact main above. The packet includes the five files already published in PR126 and the twelve unpublished Discover files, including exports and local test configuration. The archive also includes a per-file SHA-256 manifest.

The repository's unchanged files, dependencies, media, credentials, build outputs, local databases and test artifacts are not inside the packet. Start from the repository, not an empty directory. Nothing in this packet requires a credential or live service to run its local tests.

### Avoid double-applying PR126

Choose one route:

1. From exact main `44461ce858b9ac0926ef7846b9b49abd6f8b66fe`, review the patch, then run `git apply --check 1-eic-messaging-discover-codex-20261119.patch` and `git apply 1-eic-messaging-discover-codex-20261119.patch`. This includes PR126; do not cherry-pick126 again.
2. From PR126's exact head, extract the archive into a separate temporary directory, compare its files with your tree, then copy only reviewed changes into the checkout. The five126 files should already match. Do not apply the main-based patch wholesale to126.

If main or126 has moved, stop and reconcile the diff before applying. Do not overwrite another writer's source. The manifest checks packet bytes, not whether those bytes are correct for a newer tree.

Inspect extraction paths first with `tar -tzf 2-eic-messaging-discover-codex-source-20261119.tgz`. Extract into an empty temporary directory, then run `sha256sum -c SOURCE-SHA256SUMS` from that directory. Do not extract straight over a dirty checkout.

## Local checks on the assembled source

Fresh checks on the selected combined tree on 19 November:

- Protocol/controller/chat tests: 37 passed across three files.
- Discover Playwright journey: 1 passed. Covers synthetic browse/search/profile, signed connection request, explicit listing fields, hide, unchanged chat access and phone-width layout.
- Web typecheck: passed.
- Web application production build: passed with the local-preview flag deliberately set. Synthetic preview route is excluded by the production guard.

Commands, after installing repository dependencies with its normal workspace setup:

```sh
npx vitest run packages/features/src/discover-directory.test.ts apps/web/app/platform/discover-controller.test.ts apps/web/app/routes/chat.test.tsx
npx playwright test -c playwright.discover-local.config.ts
npm run typecheck --workspace web
EIC_LOCAL_DISCOVER_PREVIEW=1 npm run build --workspace web
```

The browser test expects an installed Chrome channel. Test infrastructure must resolve workspace packages to the checkout being tested, not a different local source tree. An initial run in preparation failed due to an incorrectly shared dependency tree; the corrected isolated resolution passed without changing application code.

These are local results, not CI or hosted build results. No fresh full-suite, hosted two-person messaging test, real-phone test or capacity test was completed for this handoff. Earlier simulated two-vault messaging tests and disposable hosted experiments are historical evidence only.

## Remaining work, in execution order

### 1. Reconcile source and preserve ownership

- Recheck current main,126 and this handoff before coding. Review the existing repository guidance and active writer assignments.
- Choose whether126 lands separately or is incorporated once. Preserve its review history and do not silently close or merge it.
- Keep any new implementation on a focused branch. This handoff does not approve a merge, deploy, service activation, new access or paid work.

### 2. Make hosted messaging possible, then prove it

- Recheck deployed client build identity and the actual relay configuration. Resolve the pending production-origin decision with the owner before changing it. Adding an origin can start resource-consuming traffic.
- Resolve enrollment/key admission for real people without manually admitting unidentified keys. Verify whose keys are admitted rather than guessing from their presence.
- Complete the normal add-friend/connect-card handshake. Acceptance must establish the intended encrypted messaging connection; a directory request or accepted row alone is not a chat connection.
- Verify a message actually arrives in the recipient's unlocked hosted client, with correct sender, text and delivery state. Verify the reverse direction too.
- Test reconnect, retry, duplicate/replay handling, offline/locked/closed-tab behavior and phone browsers. State the actual delivery limits in normal UI. Do not promise background push or closed-app delivery without implementing and proving it.
- Never label local persistence as a delivered message. Keep errors and undelivered status visible.

### 3. Turn the signed Discover reference into a service

- Implement an authenticated HTTP transport and durable atomic storage for the signed protocol. The current compare-and-set whole-directory state is a bounded local reference, not a production throughput design.
- Preserve request authentication, sequence/replay protection, recipient-only acceptance/decline, atomicity and failure handling. Test concurrent requests, stale sequences, duplicate commands, rejected signatures and storage errors.
- Wire accepted requests to a verified connect-card/connection handshake, not automatic messaging permission.
- Keep default visibility hidden. Publish only owner-chosen fields. No contact upload, private-profile autofill or inferred public bio.
- Preserve hiding semantics: remove directory visibility without deleting friends or chats. Confirm publish/hide/request via server readback before reporting success.
- Add the real production Discover route only after its data source and authority are settled. Do not expose the synthetic route or seed cards in production.

### 4. Review, test and release separately

- Add HTTP/storage integration tests and a disposable, explicitly authorized hosted acceptance run. Use synthetic identities and no private messages.
- Review data retention/deletion, rate limits, abuse controls, observability and expected cost before activating a public directory or admitting traffic.
- Measure capacity before making any scale claim. No 1,000-user, retention or cost guarantee exists.
- Obtain independent review and exact-head CI/build evidence under the repository's current requirements. This packet is not approval.
- Seek the specific owner decisions still needed for hosted changes. Do not change relay origins, enrollment, billing, secrets or production settings merely because the code is present.

## Sources and boundaries

- Messaging cleanup and previous todo: https://github.com/adamaslan/eic1/pull/126 . The included DISCOVER-MESSAGING-TODO.md is historical context; this dated handoff adds the recovered local implementation and current remaining-work order.
- Relay configuration was inspected read-only in the existing project dashboard: https://supabase.com/dashboard/project/ggofnvlccqjuqemjsmas/editor/17677?schema=eic_relay . Recheck current values before any decision; do not infer key ownership.
- Production-origin permission remains unanswered. No merge, deployment, endpoint/config change, real-user message, new authorization, account change, cleanup or paid action is authorized by this document.

The handoff PR and commit use `[skip netlify]` so publication of the packet does not request a Netlify deploy. Removing that marker or pushing a later unmarked commit can trigger deployment, so treat that as a separate release decision.
