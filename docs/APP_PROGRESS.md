# Buckit progress

Updated: 28 September 2026.

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
- Kept the workspace sidebar expanded while its bucket menu is open, moved the pin icon to the right of “Your space,” and removed the separate Pinned button. The compact sidebar hides the pin and sidebar toggle; hover or tapping the logo expands it. Centered native dialogs explicitly after Tailwind reset styles.
- The workspace reuses its loaded bucket list when selection or profile state changes, preventing a second `/buckets` call on load and bucket selection. Concurrent identical GET requests share one in-flight request; later refreshes still fetch current data.
- Fit sign-in and sign-up content within a 390×667 viewport and the desktop first fold. Shorter viewports may scroll to preserve usable controls.
- Profile writes retry once after a stale revision when the same fields have not changed elsewhere; conflicting field edits still ask for review.
- Review fixes: theme and sidebar controls remain usable when browser storage is denied, and a saved theme is not briefly overwritten during startup. The compact sidebar expands when its logo is activated on touch or keyboard, closes after its bucket menu is dismissed outside the sidebar, and Radix selects use their visible field labels as accessible names.
- Dropdowns opened inside native dialogs now portal into that dialog's top layer so timezone and appearance options appear above the backdrop. Dialog centering uses fixed insets and auto margins, keeping popper positioning relative to the viewport.
- Added the existing Buckit mark as the app favicon and made the theme toggle circular.
- Added exact-pinned Prettier with `npm run format` and `npm run format:check`, formatted the source, styles, configuration, and docs, and included formatting verification in `npm run check`. Generated files, Next's regenerated `AGENTS.md`, and local env files are excluded.
- Added HTTP integration coverage for all Phase 1 route families and fixed unknown GET endpoints returning 400 instead of 404. Improved client errors for failed token refresh and malformed server responses.
- Phase 2 local implementation: the shared workspace shell now opens the expense ledger, expense form/detail, recently deleted records, reference settings, and member/invitation management. It keeps the Phase 1 brand, theme toggle, bucket selector, and sidebar behavior. The expense ledger has bucket-currency actual/scheduled summaries, incomplete conversion status, search, combined filters, and pagination. Expense detail includes linked refunds, comments, and an activity timeline.
- Phase 2 API/data layer: bucket accounts/categories/platforms; owner create, rename, archive, restore, and unused deletion; current members and owner removal; invitation metadata and revocation; expenses with signed refunds, creator/payer/added-by attribution, date-aware currency conversion and manual overrides, scheduled vs posted state, 30-day soft deletion/restoration, and member comments. Financial writes update bucket revisions and audit/operation receipts. The creator's membership episode is stored so leaving and rejoining does not restore old edit rights. Canonical reference routes match the API design; the initial `/options/` paths remain aliases.
- Added a conversion preview and explicit conversion update endpoint. Rate failure saves an unresolved expense rather than equating different currencies. Future entries remain scheduled for Phase 4's daily processor. Historical reference labels remain on the expense when an option is renamed or archived.
- Phase 2 Stitch parity pass: rebuilt the active ledger hierarchy with month control, actual/conversion/scheduled cards, compact filters and chips, account/mode details, distinct refund/scheduled/conversion rows, and an inline conversion action. Reorganized Add Expense into amount, date/details, payment, and payer/notes sections with expense/credit and foreign-currency modes. Restructured detail into transaction, specifications, comments, refunds, and activity regions; added the recovery explanation/deadline/search, reference governance cards, and member/invitation security context. Invitation links now show creator names and offer a QR dialog; expense and comment deletion use explanatory dialogs. Phase 1 brand, sidebar, and theme remain shared.
- Workspace-scoped GET caching now reuses completed reads for 60 seconds across section navigation and invalidates bucket data after mutations; identical in-flight requests remain deduplicated by the API client. Help & Tour steps use local state and a browser preference rather than profile API writes.
- Do not push changes. The user will push them.

## Next phases

See [PHASE_ROADMAP.md](PHASE_ROADMAP.md). Phase 3 covers insights and budgets. Phase 4 adds daily processing and EMIs; phases 5–7 cover notifications, contacts/CSV, and lifecycle/release work. Some Stitch screens carry a Phase 2 label despite depicting those later-phase features; the approved roadmap governs implementation scope. The revised Phase 2 UI still needs live authenticated visual and interaction QA; no signed-in browser session was available during this pass. Provider-rate behavior also remains unverified, and MongoDB Phase 2 indexes need `npm run db:setup` in the target environment.

## Verification

- Latest Stitch parity pass: `npm run check` passed formatting, lint, TypeScript, and 47 tests; `npm run build` passed. The local server returned HTTP 200 for `/workspace?view=expenses`, but the browser redirected to sign-in, so the authenticated screens could not be visually verified. Workspace cache tests cover reuse, invalidation, expiry, and retry.
- Phase 2 local: `npm run check` passed Prettier, ESLint, TypeScript, and 45 tests; `npm run build` passed. The HTTP integration test covers option setup/archive/restore, expense creation/editing/filtering, manual conversion, linked refunds/activity, comments, soft deletion/restoration, invitation revocation, member removal, and rejoin permissions against a temporary MongoDB replica set. Currency arithmetic has direct tests. The existing local dev server responded with HTTP 200 at `/workspace?view=expenses`. Live Firebase sign-in, authenticated visual QA, Frankfurter provider responses, and target-database index setup remain unverified.
- Latest sidebar correction: the compact sidebar no longer renders any sidebar-toggle button; the logo expands it for touch and keyboard access. `npm run check` passed formatting, lint, typecheck, and 42 tests; `npm run build` passed. The signed-in sidebar interaction still needs browser verification.
- Latest formatting pass: `npm run format` completed; `npm run check` passed Prettier verification, lint, typecheck, and 42 tests; `npm run build` passed.
- Latest favicon and theme-toggle update: `npm run check` passed lint, typecheck, and 42 tests; `npm run build` passed and generated `/icon.svg`.
- Latest dialog-dropdown fix: `npm run check` passed lint, typecheck, and 42 tests; `npm run build` passed. The signed-in modal interaction still needs browser verification with an authenticated session.
- `npm run check`: lint, typecheck, and 42 tests passed. `npm run build` passed. The route integration test exercises bootstrap, profile GET/PATCH and stale revisions, bucket create/list/read, capabilities, invitation create/preview/join, member permissions, and unknown routes against a temporary replica set. Client tests verify in-flight GET deduplication without combining writes; browser preference tests cover denied storage.
- Local browser before the latest review fixes: desktop and 390×667 mobile sign-in/up, theme persistence across reload, and dark home visuals checked. The touch expand control, denied-storage fallback, and conflict retry flow still need browser verification.
- Production public sign-in returned 200; unauthenticated GET/PATCH `/api/v1/me` returned expected 401 with private/no-store caching. The production code has not received these local fixes.
- Live authenticated local and production journeys, Google popup, and email delivery still need an existing user session or a user-controlled test account. No production account data was created during this work.
