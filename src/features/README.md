# Feature modules

Folders reserve the domain boundaries from the design documents. Add UI, input contracts, policies, and services here as each feature is implemented. Server services must import `server-only`; keep browser-safe types separate. Route handlers should validate and delegate to these services.

Phase 1 now implements authentication UI, profile and bucket services, invitation creation/joining, and the initial workspace. See `docs/PHASE_1_IMPLEMENTATION.md` for the implemented API subset, setup and verification. Financial operations and background workers remain in later phases.

- `identity`: profile/bootstrap and account access
- `buckets`: membership, invitations, archive and ownership
- `reference-data`: accounts, categories, platforms
- `expenses`: expenses, refunds and creator permissions
- `scheduling`: calendar eligibility and daily orchestration
- `emi`: plans and installment obligations
- `currency`: provider adapters and stored conversion snapshots
- `reports`: consistent actual-spending read models
- `budgets`: shared/member budgets and threshold state
- `comments`: expense comments and author permissions
- `notifications`: inbox, preferences, devices and push intents
- `contacts`: personal directory and explicit global shares
- `reminders`: personal recurrence definitions
- `csv`: import staging and consistent exports
- `lifecycle`: deletion, recovery and departure cleanup
