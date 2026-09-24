# Phase 1 — Access and first bucket

Implemented on the `dev` branch from the Buckit Stitch project `2866199134258582890` and the product/API/database designs. The existing roadmap remains the scope boundary.

## Design references

The published Stitch screens reviewed were:

- Public Home (Fixed Icons): `c1f0b1b83f2f4964acf4aeeadca3723d`
- Sign In: `5d2b7e5f994e465c852c1f1ad277229b`
- Onboarding & Create Bucket: `f6a0adb1a0db42d9b3fa1baefd7ec4b4`
- Option 05 light/dark wordmark variations: `c8c9772974784ed4a9a364292b678106`
- Isometric cube logo: `069a612bdd9c4271b5c7c9d77e71ce34`

The exported screens override the older project-wide Newsreader theme with Plus Jakarta Sans and a Fraunces italic wordmark. Both fonts are self-hosted through npm packages; the supplied vector logo is in `public/buckit-mark.svg`. Icons are local SVG components. No runtime Tailwind CDN or remote font requests are needed.

Sign-up, verification, recovery, invitation acceptance and the workspace extend this visual language because those complete screens were not published in the accessible Stitch project. Illustrative spending cards remain explicitly labeled examples. Unsupported mockup claims about end-to-end encryption, bank balances, a ledger network, and versioned private-beta status are not presented as product facts.

## Routes and behavior

| Route | Behavior |
| --- | --- |
| `/` | Responsive public home with working navigation and get-started links |
| `/sign-in`, `/sign-up` | Email/password and Google authentication; password visibility; error/pending states |
| `/forgot-password` | Firebase recovery email with neutral account-existence response |
| `/verify-email` | Resend cooldown, verification refresh, and continue-for-now option |
| `/auth/action` | Custom Firebase password-reset and email-verification action handler |
| `/onboarding`, `/buckets/new` | Profile name/timezone and bucket setup; name suggestions; currency/timezone selection |
| `/join` | Paste an invitation; authenticated preview; explicit join/already-member flow; expired/revoked feedback |
| `/workspace` | Last accessible bucket, bucket switching, owner-only link/QR/manual WhatsApp sharing, profile/theme controls and replayable role-aware tour |

The workspace deliberately has no analytical totals or expense-entry controls yet. Later features are labeled as coming later. There is no mock authentication or local-storage substitute for the database.

## Service setup

1. Copy `.env.example` to `.env.local` and fill the Firebase browser and Admin configuration for the same project, plus `MONGODB_URI`, `MONGODB_DB_NAME`, and `API_CURSOR_SECRET`. Generate a random cursor secret of at least 32 bytes. Do not paste credentials into source files or commit `.env.local`.
2. In Firebase Authentication, enable Email/Password and Google. Add `localhost` and your deployed hostname to authorized domains. Configure the verification/password-reset templates' custom action URL as `http://localhost:3000/auth/action` for local development or your deployed HTTPS `/auth/action` URL. The app also supports Firebase's default hosted action handler; its continue links lead back to Buckit. Real delivery, authorized-domain configuration and Google pop-up behavior need a configured Firebase project to verify.
3. Use MongoDB Atlas or another replica set. A standalone local MongoDB server cannot run the required transactions. Configure database credentials and network access explicitly.
4. Run `npm run db:setup` once against the intended development database. It creates the Phase 1 collections and declared indexes without dropping existing indexes. The API does not create indexes on cold start. Unique indexes are part of correctness, so do not skip this step.
5. Restart `npm run dev` after changing public Firebase variables. Next.js embeds `NEXT_PUBLIC_` configuration in the browser bundle.

Without configuration, the home/auth designs render and `/onboarding` offers a labeled, unsavable setup preview. Sign-in and database actions remain unavailable. No external services, accounts, billing, email sends, or deployments are provisioned automatically.

## Backend guarantees

- Same-origin Node.js API under `/api/v1`; Firebase ID-token verification includes revocation checks. Buckit account status and current bucket membership are separate checks.
- Strict allowlisted bodies, a 256 KiB JSON limit, private/no-store responses, per-actor durable rate limiting, safe error envelopes and `If-Match` profile revisions.
- Transactions coordinate app-user and bucket guards. Bucket creation commits the owner membership, default categories, Other platform, audit event and idempotency receipt together. No payment account is silently invented.
- State-changing requests retain operation keys for a lost-response retry. Receipts hold references rather than private resource snapshots, and replay rechecks current access. There is no offline write queue.
- Invitation links contain 32-byte random tokens in URL fragments. Tokens stay in fragments across sign-in/sign-up links and are submitted to the authenticated API in JSON bodies. Only SHA-256 hashes are stored. Links last seven days, are multi-use, and never join on GET or preview. Only owners of active buckets can create them.
- The raw invitation URL is shown once. If a creation response is lost, replay returns metadata and `secretUnavailable`; the UI can deliberately create another link. Full invitation listing/revocation and member management remain Phase 2; the original lost link expires after seven days.
- Bucket list cursors are signed, expire after 30 minutes, and are tied to the requesting user and route. Lists have 25-item pages.

Notification event fan-out, lifecycle deletion/transfer operations and the remaining capability catalog are scheduled for later phases. These endpoints currently expose only the implemented Phase 1 subset.

## Verification

`npm run check` runs ESLint, TypeScript, unit tests and isolated MongoDB replica-set integration tests. The first test run downloads MongoDB 7.0.14 through `mongodb-memory-server` into its binary cache. Tests launch a temporary local database; they do not use `.env.local` or Atlas data. The cached binary can be reused offline.

Coverage includes token rejection/revocation flags, strict input and return-URL validation, body limits, transaction rollback, duplicate/replayed operations, stale revisions, app-account inactivity, cross-bucket isolation, owner/member permissions, invitation expiry/revocation/multi-use, secret handling, access loss before replay, profile/tour settings, and durable rate limits. `npm run build` checks the production bundle without credentials.

Live setup check (September 24, 2026): Atlas connectivity succeeded, and `npm run db:setup` created the Phase 1 collections and indexes. The development server loaded `.env.local`; the sign-in route returned 200, and protected API requests with missing or invalid tokens returned 401 with private/no-store caching. After Authentication was initialized in Firebase Console, the Firebase Admin read-only Authentication request succeeded, verifying the service-account connection. The user confirmed Email/Password and Google providers were enabled and localhost was authorized. Live sign-in, email delivery and the complete configured browser journey remain unverified. Unit/mocked token verification and a temporary replica set do not claim those live checks passed.

References: [Firebase web authentication](https://firebase.google.com/docs/auth/web/manage-users), [Firebase Auth API](https://firebase.google.com/docs/reference/js/auth), and the installed Next.js documentation under `node_modules/next/dist/docs/`.
