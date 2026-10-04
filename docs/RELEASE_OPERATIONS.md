# Release and recovery operations

This runbook covers the operator work required for Phase 7. The application code does not create a backup service. Production release is incomplete until an operator-owned machine and encrypted storage destination are configured and a restore drill succeeds.

## Before deployment

1. Confirm the deployment has the Firebase, MongoDB, cursor-signing, push-token encryption, and cron secrets required by its enabled features. Keep values in the deployment secret manager; never place them in source control or logs.
2. Run `npm run check`, `npm run build`, and `npm run db:setup` against the intended environment. The setup command creates missing collections/indexes without dropping existing data.
3. Verify the protected daily route is configured for `03:00 UTC` (`08:30 Asia/Kolkata`) in `vercel.json`. A successful invocation reports `completed` or `partial`; a `401` means the function did not accept the authorization header. Compare the invocation time, deployment, response body, and request origin before attributing it to the scheduler.
4. Exercise archive/restore, a transfer and departure, and both deletion previews in an isolated test bucket. Do not perform permanent deletion tests in a real user's bucket.

## Backup and restore

- Atlas Free does not provide the managed backup relied upon by this design. Use MongoDB Database Tools on a trusted operator machine to take an encrypted, authenticated `mongodump` of the full database into operator-controlled storage. CSV export is not a backup. Because a Free-tier dump has no oplog capture, pause application writes for a consistent multi-collection snapshot, or use a separately validated snapshot method.
- Keep a separately protected, append-only journal of **completed and pending bucket/account deletion operations** after each backup. The journal needs only the operation kind and bucket/user ID. It must survive loss of the primary database; a tombstone stored only inside a pre-deletion dump cannot prevent resurrection.
- Monitor the timestamp and integrity of the latest backup and deletion journal. The desired 24-hour recovery point and one-working-day recovery time are targets, not verified guarantees.
- Restore into an isolated database with application traffic and jobs disabled. Reapply every deletion/anonymization instruction newer than the snapshot before allowing any user access. Mark restored affected buckets/users inaccessible first, complete their cleanup, and suppress old pending notifications and push deliveries. Recreate/verify indexes and check ownership, membership, expense/EMI, and contact-share invariants. Only then reconnect the application.
- Keep historical encrypted backups subject to an explicit retention policy. Permanent deletion blocks app access and removes current database content; it does not instantly erase every older backup copy.

## Daily operations

- Watch missed cron runs, oldest pending/retry lifecycle operation, imports, due expense backlog, unresolved conversions, push errors, Atlas storage, and connections. A `partial` response means work remains; repeated partial results need investigation.
- Bucket deletion makes the bucket inaccessible in the accepting transaction, then the leased daily worker purges bucket-scoped collections in bounded batches. Global contacts and their shares remain. Account deletion blocks app access and revokes owned contact shares immediately; the worker retries Firebase identity deletion and personal-data cleanup before final anonymization.
- A failed lifecycle step is retried with backoff so it does not block unrelated deletion jobs. Do not manually change an operation to `completed` to clear an alert.

## Current verification gap

Local integration tests exercise lifecycle commands and resumable cleanup against a temporary MongoDB replica set. No operator backup location, encrypted dump, independent deletion journal, isolated restore drill, or successful Production cron invocation has been verified yet.
