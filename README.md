# Buckit

Foundation for the spending app specified in [`docs/PRD.md`](docs/PRD.md), [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md), [`docs/DB_DESIGN.md`](docs/DB_DESIGN.md), and [`docs/API_DESIGN.md`](docs/API_DESIGN.md).

## Local development

Use Node.js **22.16.0 or a newer 22.x release**, with npm 10 or newer. `.nvmrc` records the tested baseline. Dependencies are pinned and `package-lock.json` records the resolved tree.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. The placeholder landing page and build work without credentials. For production locally, run `npm run build` and then `npm start`.

## Configuration

Copy `.env.example` to `.env.local` when connecting services. Never commit real credentials. Configuration is checked when a helper is called, so an unconfigured service cannot silently initialize.

- MongoDB: set `MONGODB_URI` and `MONGODB_DB_NAME`. Use an Atlas database user scoped to the application database. The cached Mongoose helper uses at most five connections per warm instance, disables buffering and automatic collection/index creation, and clears failed initial connection attempts for retry. Future transactions require a replica set; local standalone MongoDB is insufficient. Collections/indexes must be created by explicit future migration tooling.
- Firebase browser: copy the web-app values into `NEXT_PUBLIC_FIREBASE_*`. These public values are embedded at build time; rebuild after changing them. Enable the required authentication providers and authorized domains in Firebase when implementing sign-in.
- Firebase Admin: set the server-only project ID, service-account email, and private key for the same Firebase project. The helper accepts literal `\n` escapes in the PEM. Never put Admin secrets in public variables.
- Push and scheduling: VAPID and cron variables are reserved for implementation. No service worker, push registration, job endpoint, or cron schedule is enabled.

## Checks

```sh
npm run check
npm run build
```

`check` runs ESLint, Next.js route type generation/TypeScript, and Vitest. `npm run test:watch` starts the test watcher. The initial tests use a mocked driver to cover shared in-flight database connections, retry after failure, and missing configuration. Live service connections and product behavior require later integration tests.

Dependency notes: Next.js's current React/accessibility/import lint plugins require ESLint 9, so it is pinned despite its upstream deprecation notice. As of scaffold verification, `npm audit` reports two moderate transitive findings (`uuid` and `gaxios`) under Firebase Admin's optional Cloud Storage dependency tree; `npm audit fix` does not resolve them. Storage is not used by the scaffold. Recheck upstream updates before enabling service-backed features; no forced major-version dependency overrides are applied.

## Layout

```text
docs/                    Product, system, database, API designs
src/app/                 App Router shell and public landing page
src/components/          Shared presentation components
src/features/            Reserved feature boundaries (see its README)
src/lib/config/          Configuration validation
src/lib/db/              Server-only cached Mongoose connection
src/lib/firebase/        Separate browser and Admin SDK helpers
public/                  Static public assets
```

This is a foundation only. Authentication flows, Mongoose schemas, API routes, domain services, jobs, FX calls, and spending screens are not implemented. Firebase helpers initialize SDKs; they do not authorize Buckit users.

## Implementation boundaries

- Keep Mongoose and Firebase Admin in Node.js server modules. Future APIs live under `/api/v1`; the future scheduler uses `/api/internal/jobs/daily`.
- Verify Firebase bearer tokens including revocation, then enforce active application-account, membership, lifecycle, and actual-creator checks. Paid By, Added By, and bucket ownership do not replace creator permissions.
- Protected responses must be private/no-store. Add these headers with the actual protected endpoints; the public page can be statically rendered.
- Use decimal strings in contracts, Decimal128 in storage, and decimal arithmetic for financial calculations. Do not calculate monetary amounts with JavaScript Number.
- Implement transactions, lifecycle guards, revisions and durable idempotency before exposing writes. Keep external provider calls outside retryable transactions.
- Daily scheduling needs a secret-protected handler, bounded work, leases and checkpoints before enabling a Vercel cron. Do not add in-memory timers or an empty successful job endpoint.

## Hosting

The project uses the standard Next.js build and Node.js runtime, suitable for Vercel's Next.js preset. Set Node 22.x and service environment variables in the target environment. No cloud resources are provisioned and no deployment or billing changes are performed by this scaffold. Verify the documented no-cost service allowances before provisioning.

Framework setup references: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation) and [Firebase Admin setup](https://firebase.google.com/docs/admin/setup).
