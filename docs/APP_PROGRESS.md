# Buckit progress

Updated: 26 September 2026.

Update this file with each development phase or significant fix. Record what changed, the checks actually run, and any work still unverified before finishing the task. Keep prior verification distinct from checks run for the latest change.

## Completed

- Foundation on `dev`: Next.js, TypeScript, npm, Firebase client/Admin, MongoDB models, API routing, and tests.
- Phase 1: public home, authentication, account recovery/verification, onboarding, bucket creation/selection, invitations, workspace, profile, and tour.
- Live development connections: Firebase Authentication and MongoDB Atlas verified; Phase 1 indexes created.
- Phase 1 code pushed previously in commit `e15e7e0`.

## Current local work (not pushed)

- Added Tailwind v4 and prefixed daisyUI. Existing visual rules now use Tailwind `@apply`; the remaining CSS declarations are palette tokens and reduced-motion/keyframe rules. Radix Select replaces visible native selects/datalists. Lucide remains the icon library.
- Balanced dark mode with Stitch's charcoal/neutral surface range and mint accent. Small 14px supporting text is 12px.
- Applied the approved roughly 20% spacing reduction: auth form padding 42→34px, workspace horizontal padding 40→32px, field gaps 20→16px, sidebar section gaps 28→22px.
- Added a theme toggle to the home, auth, onboarding, invitation, and workspace headers. Choice survives reload and sign-out in local storage. Profile appearance saves to the API too.
- Fixed the home/onboarding/workspace headers in view, fixed the workspace sidebar, and added compact/expand, hover expansion, and pin state that survives reload. Compact state keeps the logo and navigation icons visible.
- Kept the workspace sidebar expanded while its bucket menu is open, moved the pin icon to the right of “Your space,” and removed the separate Pinned button. The compact sidebar hides the pin, keeps an explicit expand button for touch screens, and also expands on hover. Centered native dialogs explicitly after Tailwind reset styles.
- The workspace reuses its loaded bucket list when selection or profile state changes, preventing a second `/buckets` call on load and bucket selection. Concurrent identical GET requests share one in-flight request; later refreshes still fetch current data.
- Fit sign-in and sign-up content within a 390×667 viewport and the desktop first fold. Shorter viewports may scroll to preserve usable controls.
- Profile writes retry once after a stale revision when the same fields have not changed elsewhere; conflicting field edits still ask for review.
- Review fixes: theme and sidebar controls remain usable when browser storage is denied, and a saved theme is not briefly overwritten during startup. The compact sidebar has an explicit expand button for touch screens, closes after its bucket menu is dismissed outside the sidebar, and Radix selects use their visible field labels as accessible names.
- Dropdowns opened inside native dialogs now portal into that dialog's top layer so timezone and appearance options appear above the backdrop. Dialog centering uses fixed insets and auto margins, keeping popper positioning relative to the viewport.
- Added the existing Buckit mark as the app favicon and made the theme toggle circular.
- Added exact-pinned Prettier with `npm run format` and `npm run format:check`, formatted the source, styles, configuration, and docs, and included formatting verification in `npm run check`. Generated files, Next's regenerated `AGENTS.md`, and local env files are excluded.
- Added HTTP integration coverage for all Phase 1 route families and fixed unknown GET endpoints returning 400 instead of 404. Improved client errors for failed token refresh and malformed server responses.
- Do not push changes. The user will push them.

## Next phases

See [PHASE_ROADMAP.md](PHASE_ROADMAP.md). Phase 2 covers expenses, reference settings, refunds, and member management. Phases 3–7 cover insights, scheduled spending, notifications, contacts/CSV, and lifecycle/release work.

## Verification

- Latest formatting pass: `npm run format` completed; `npm run check` passed Prettier verification, lint, typecheck, and 42 tests; `npm run build` passed.
- Latest favicon and theme-toggle update: `npm run check` passed lint, typecheck, and 42 tests; `npm run build` passed and generated `/icon.svg`.
- Latest dialog-dropdown fix: `npm run check` passed lint, typecheck, and 42 tests; `npm run build` passed. The signed-in modal interaction still needs browser verification with an authenticated session.
- `npm run check`: lint, typecheck, and 42 tests passed. `npm run build` passed. The route integration test exercises bootstrap, profile GET/PATCH and stale revisions, bucket create/list/read, capabilities, invitation create/preview/join, member permissions, and unknown routes against a temporary replica set. Client tests verify in-flight GET deduplication without combining writes; browser preference tests cover denied storage.
- Local browser before the latest review fixes: desktop and 390×667 mobile sign-in/up, theme persistence across reload, and dark home visuals checked. The touch expand control, denied-storage fallback, and conflict retry flow still need browser verification.
- Production public sign-in returned 200; unauthenticated GET/PATCH `/api/v1/me` returned expected 401 with private/no-store caching. The production code has not received these local fixes.
- Live authenticated local and production journeys, Google popup, and email delivery still need an existing user session or a user-controlled test account. No production account data was created during this work.
