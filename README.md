# eic1

Everybody is Cool: a Windows 95-style private local marketplace. Listings and photo moments are encrypted on the device with a passphrase.

- `apps/web`: React Router 8 SPA on Netlify (`npm run dev` in `apps/web`)
- `packages/*`: platform-neutral shared code (added in later milestones)

Design and build plan: see the guide in the homebase `docs/everybodyiscool/` folder.

## Current work and verification - 2026-11-16

Current source baseline: `44461ce858b9ac0926ef7846b9b49abd6f8b66fe`. This is a status
update to the existing repository entry point, not a second product roadmap. The Homebase
design guide remains the design source; [manual TODOs](docs/manual-todo.md) contains human-blocked work.

### Source delivered, not proof of production delivery

| Work | Source evidence | Remaining acceptance |
|---|---|---|
| [#123](https://github.com/adamaslan/eic1/pull/123) unsigned connection upgrade link | Merged `8a55433`; removed-link negative control failed, restored17route tests passed, related46tests/build and deployed1280/390 inspection passed | Broader signed-connect240second timeout was not proved fixed by the link change. |
| [#122](https://github.com/adamaslan/eic1/pull/122) signed two-vault fixture | Merged `9d1456a`; reload-loss negative control failed, restored fixture and application builds passed | In-memory transport is not hosted Supabase, production arrival or real-device delivery proof. |
| [#124](https://github.com/adamaslan/eic1/pull/124) piano startup feedback | Merged `44461ce`; deferred-permission control2fail/1touchpass became3pass;5piano unit tests, application build and deployed desktop/mobile feedback inspected | Pending microphone feedback only. Real instrument accuracy, owner-device startup and physical phone latency remain unverified. |

### Next work, with distinct owners

- [ ] Instinct: reconcile this status with the canonical cl24 work queue and inspect any new
  PR before release. Existing merge/review/build/effect limits remain unchanged.
- [ ] Codex: requested read-only evidence audit of signed reconnect timeout, reimport
  identity/persistence and outstanding piano acceptance. Assignment was not accepted as of03:19EST.
  No source-writer claim or new piano patch is implied. Return first failing boundary and exact evidence.
- [ ] Claude: requested read-only NWF residual-backlog audit through cl24, not an EIC writer.
  Assignment was not accepted as of03:19EST.
- [ ] Reproduce signed reconnect using the actual local disposable two-vault handler before
  claiming the240second failure fixed. Preserve signing/rotation confirmation and unsigned read-only refusal.
- [ ] Verify same-identity signed reimport preserves thread/nickname/hidden/addedAt while
  resetting sync progress; any new fix needs its own negative control, build and review.
- [ ] Validate piano response on an actual instrument and phone, recording input mode,
  permission/start state and measured physical latency separately from synthetic tone timing.
- [ ] Keep hosted relay deployment, admission, origins, retention and real arrival gates in
  [the existing relay runbook](docs/supabase-hosted-chat.md). No endpoint activation,
  database migration, paid service or permission change is authorized by this task list.

Coordination: meaningful progress and concrete blockers every8minutes while sessions are active,
through canonical cl24. A requested assignment is not pickup. Source PRs are not a completed-feature
count. No validated global backlog total is claimed; reconcile each acceptance item before counting it.
