# Profile studio: staged work, not a 25-feature completion claim

Owner request: Home access, background color, control what is shown, favorite song/book, and work toward 25 useful profile additions. This is separate from graph, journal and drawing work.

## A: explicit asks first

1. Home navigation opens My profile.
2. Editable display name and bio, with existing caps.
3. Background color chooser using the existing four zero-byte themes.
4. Name accent chooser (not a new titlebar theme).
5. Built-in profile font chooser.
6. Favorite song metadata, no streaming or embeds.
7. Favorite book metadata.
8. Per-field selection for an explicit feed profile, with an exact preview.
9. Separate encrypted private profile and selected-feed profile, independently retained.
The studio also has a Classic-view UI toggle and private save/discard controls. These are safeguards, not counted as extra profile features.

These are nine capabilities, not twenty-five. Multiple colors and checkboxes are not counted separately. Only A is implemented in this branch.

## B: proposed next focused increment (not built yet)

10. Local avatar image chooser with honest encoded-byte cap.
11. Avatar remove/reset that preserves unrelated content.
12. Local sticker chooser from small built-in assets.
13. Move a selected sticker with keyboard and touch controls.
14. Resize a selected sticker with bounded controls.
15. Change sticker stacking order.
16. Remove one or all stickers, with confirmation for all.

## C: proposed next focused increment (not built yet)

17. Favorite song reference link, safe HTTPS only and click-to-open.
18. Favorite book reference link, same constraints.
19. Interests list with a strict count and size cap.
20. A short status line, independently selectable for sharing.
21. A currently-reading field, separate from favorite book.
22. A currently-listening field, metadata only.
23. A website field, HTTPS and explicit external-open behavior.
24. A copyable text profile card built from the same selection, with a byte preview before copy.

25. A local profile size meter that reports final serialized bytes and asset bytes, with export-limit warnings.

B/C require their own tests and review packets. Revisit usefulness rather than padding this list if owner priorities change. Links and additional fields must not leak into the draft's feed profile by default. No local-player integration is planned here; coordinate separately before touching the MP3 work.

## Privacy and wire behavior

- Private draft lives in encrypted `settings` record `profile-studio:<authorId>`. Generic backups include it encrypted, like all other settings. Record IDs and kinds are not encrypted, as before.
- Feed generation reads only the existing `profile:<authorId>` record. Saving a draft, including its selections, cannot update that feed record.
- The explicit Update selected feed profile button projects selected fields to the existing v1 profile record. It uploads nothing. A future feed export includes that record. No share-file or connect-link behavior changes: those still omit profiles.
- Display name, author ID and normal signature/sequence metadata remain in the selected feed profile. Their inclusion is disclosed. Deselecting everything does not make the identity anonymous.
- Favorite song/book are labeled lines in the existing v1 bio. This preserves old-reader signatures and parsing. The combined bio must fit 500 characters; overflow blocks update, never truncates. Hidden fields are absent from bytes, including assets.
- Existing saved profiles seed drafts without removing their already-shared content. They remain as-is until explicit update. No saved profile is silently migrated or published.
- Deselecting then updating replaces the next feed snapshot, not existing files or copies held by others. No recall promise. A private save does not retract a previous selected feed profile.
- The selected preview uses exactly the projection used by Update. It is not a claim that it matches an older exported file. The owner page separately labels its saved private draft.

## Feature fate and rollback

- Runtime option: Classic profile view hides the editor and leaves private draft and feed snapshot untouched. Uncheck to restore studio. This is a UI fallback, not a privacy control and not a claim of old visual semantics: saved background and assets still render.
- To remove content from a FUTURE feed snapshot, uncheck its selector and explicitly update the selected feed profile, then export a new feed through the existing flow. Old files and remote copies remain readable. No remote revocation service exists.
- Code rollback to pre-studio main leaves old readers able to render the selected snapshot (plain profile v1) and restore backups (only the already-supported settings/profile kinds). Draft is retained but invisible to old code, never interpreted as a profile record. Restore this change to edit it again.
- A code revert does not undo already-selected profile contents. Do not claim that reverting retracts shared data. Never wipe the vault to disable this feature.
- All new dependencies: none. All work is npm-only. No server, paid API, admin setting or secret added.

## Render-path matrix

ProfileRoute hooks run before all early returns. Locked: existing desktop redirect; load: Loading; missing handle/profile: honest absent state with Connections route; read failure: alert, no empty success; owner: studio plus saved draft; connection: existing read-only view. Async work is canceled on route/vault change. Browser test runs loaded editor -> edited -> saved -> projected -> discarded on one mounted instance, then reloads for persistence.

Remaining verification before delivery: independent exact-head technical review, different-family review vote, CI and stamped deploy preview, preview phone/desktop pixels, post-merge production proof. No self-merge.
