# Buckit

A responsive spending app for individuals and groups, built with Next.js App Router, TypeScript, Firebase Authentication and MongoDB/Mongoose.

The app currently covers access and buckets, everyday expenses, spending insights, and scheduled spending with EMI plans. The shared workspace follows the Buckit Stitch designs.

## Run locally

Use Node.js 22.16.0 or a newer 22.x release and npm 10 or newer.

```sh
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Public screens work without credentials. The [onboarding preview](http://localhost:3000/onboarding) shows the setup design with saving disabled until services are configured.

For working sign-in and persisted buckets, copy `.env.example` to `.env.local`, configure Firebase and a MongoDB replica set, then run:

```sh
npm run db:setup
npm run dev
```

See [Phase 1 implementation and setup](docs/PHASE_1_IMPLEMENTATION.md) for Firebase providers, authorized domains, email action URLs, database indexes, supported flows and limitations. [App progress](docs/APP_PROGRESS.md) tracks completed work, current changes and remaining checks. Never commit `.env.local`. No infrastructure is provisioned by this repository.

The Phase 4 daily worker is configured in `vercel.json` for 03:00 UTC. Set a random `CRON_SECRET` in the deployment environment; Vercel sends it to the protected `/api/internal/jobs/daily` route. Local development does not run the cron automatically. The UI presents an approximate daily processing window.

## Verify

```sh
npm run check
npm run build
```

`check` verifies formatting, lint, types and tests. Integration tests use an isolated temporary MongoDB replica set and download a cached test binary on first run; they never connect to your Atlas database. `npm run test:watch` runs the watcher. After a production build, `npm start` serves it locally.

Run `npm run format` to format project files with Prettier, or `npm run format:check` to check formatting without changing files. Generated files and local environment files are excluded.

## Structure

```text
docs/                       Product, system, database/API designs, roadmap and setup
src/app/                    Pages and Node.js API route handlers
src/components/             Shared brand and accessible UI primitives
src/features/identity/      Authentication, profile contracts and Phase 1 services
src/features/buckets/       Setup, invitation and workspace UI
src/lib/api/                Token verification, HTTP validation and client requests
src/features/scheduling/    EMI plans, installment schedule and daily processing
src/lib/db/                 Cached Mongoose connection and phase models
src/lib/firebase/           Separate browser and Admin SDK helpers
scripts/setup-db.ts         Explicit additive collection/index setup
public/buckit-mark.svg      Supplied Stitch vector logo
```

The existing [phase roadmap](docs/PHASE_ROADMAP.md) sequences the remaining requirements. Business services recheck active users and memberships; Paid By and Added By do not grant permissions. Money operations use decimal strings/Decimal128 and decimal arithmetic.

Dependency notes: Next.js's current lint plugins require ESLint 9, which remains pinned despite its upstream deprecation notice. The previously identified two moderate transitive npm advisories (`uuid`, `gaxios`) originate in Firebase Admin's optional Cloud Storage dependency tree. Storage is not used here; standard `npm audit fix` did not resolve them. No forced dependency overrides were applied.
