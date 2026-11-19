# Discover and messaging todo

Updated 2026-11-19. Local work is not deployed behavior.

## Messaging

- [x] Previously merged foreground chat code exists in the application. This does not establish working delivery for real users.
- [x] Prepare and independently qualify the local messaging cleanup: home Friend chats links, notes kept separate, one normal sharing action (Text my connect link), and technical/import tools collapsed. Notes persist across reload; unsigned chats remain read-only with Send disabled.
- [ ] Merge and deploy the cleanup after the applicable release checks. This PR publishes source only.
- [ ] Inspect the current relay enablement, admitted keys and permitted origins. Production assets contain a relay endpoint, but a read and preflight from the production origin returned HTTP 403 on November 19. That alone does not identify the exact setting causing rejection.
- [ ] Finish the real-user add-friend, send and arrival path without manual enrollment or check-for-messages steps.
- [ ] Verify desktop-to-phone and phone-to-desktop delivery using an authorized hosted test, including offline/reconnect/retry and visible truthful message status.
- [ ] Verify supported iPhone/browser behavior. Foreground polling is not closed-app background delivery.
- [ ] Ground capacity, retention and cost for the intended user count with measured workload assumptions. No free-scale guarantee.

Hosted disposable two-way tests passed on November 8 and 12, then the relay was switched off. Those historical tests are not proof of current real-user delivery. Existing data must remain untouched.

## Discover

- [x] Recover the original November 13 design and source-write records. The old local worktree and preview image files were lost; recovered records are not shipped code.
- [x] Build and independently qualify a local interactive prototype using sample people: browse/search, person details, request state, explicitly chosen public-card fields and easy hide. No private-profile auto-fill or persistent future opt-in.
- [ ] Finish and independently review the real signed directory and request adapter. Local protocol work is in progress separately and is not included in this PR.
- [ ] Connect the UI to a reviewed authenticated directory and durable request state. A sample request state is not a delivered invitation.
- [ ] Finish recipient-controlled accept/decline and the verified connection handshake before offering chat. A directory listing must not open a stranger inbox.
- [ ] Confirm public-card fields, listing default and audience before activation. Never upload contacts or republish existing private vault/profile content implicitly.
- [ ] Make hide remove only the person's directory listing, preserve friends/chats, and report ambiguous failures honestly.
- [ ] Review signing, principal/key admission, replay protection, expiry, abuse/rate limits, persistence, concurrency and storage limits before hosted use.
- [ ] Integrate production navigation and verify phone/desktop pixels against real permitted data. Sample people must not ship in production.

## Release boundary

This PR contains the messaging cleanup and this checklist only. It does not include the new Discover prototype or unfinished backend. It does not enable a relay, enroll keys, publish a profile, send a real message, change paid/admin settings or authorize a production deploy.

Netlify deployment is intentionally skipped for this source-only PR. Removing the skip marker or triggering a deployment is a separate release step.
