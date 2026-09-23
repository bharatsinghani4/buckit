# Buckit — API Design

Version: 0.1 · Status: Design for review · Date: 23 September 2026

Baseline: PRD.md v1.1, SYSTEM_DESIGN.md v0.2, and DB_DESIGN.md v0.1. This document defines the V1 HTTP contract for the full-stack Next.js application. It does not implement endpoints or change the other documents' review status. Route names, request shapes, pagination, and error codes are technical design choices within the agreed scope.

## 1. Scope and architecture

Browser clients call same-origin Next.js Route Handlers under `/api/v1`, running on Node.js. Handlers verify identity, validate input, and call shared domain services using Mongoose. Background processing calls the same domain rules through a separate protected internal route.

V1 includes bucket-scoped spending, refunds, budgets, EMI plans, comments, CSV import/export, global contacts, personal reminders, in-app notifications, and optional web push. There are no settlement, account-balance, application-email, Telegram, or automatic WhatsApp messaging APIs. Authentication emails remain a Firebase responsibility.

Every bucket-scoped URL identifies its bucket explicitly. Changing the selected bucket in the interface does not change the meaning of a request already addressed to another bucket. The server never obtains authorization scope from `lastBucketId`.

## 2. Authentication and permission rules

### 2.1 Authentication boundary

Use `Authorization: Bearer <Firebase ID token>` over HTTPS. Verify the token with Firebase Admin, map its UID to a Buckit user, and check current application access. Do not accept Firebase custom tokens or client-supplied user IDs as proof of identity. Firebase documents this custom-backend flow in its [ID-token verification guidance](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

Registration, email/password sign-in, Google sign-in, verification emails, password reset, and provider reauthentication use the Firebase client SDK. Buckit does not expose password-handling endpoints. `POST /me/bootstrap` creates the app profile after provider authentication; it cannot reactivate an account whose deletion has begun.

Verify revocation for protected requests in addition to checking Buckit's local deletion/access state. A token refresh is not recent reauthentication: sensitive operations check its verified `auth_time`. Initial recent-authentication window: five minutes for ownership transfer, permanent bucket deletion, and user-account deletion. Return `REAUTHENTICATION_REQUIRED` when it is too old.

No authentication cookies are introduced by this design. Protected responses use `Cache-Control: private, no-store`. Reject unsupported cross-origin requests; do not log authorization headers, invitation tokens, or push tokens. Firebase email-verification status is exposed to the UI, not inferred from a caller-provided field.

### 2.2 Access labels used below

| Label | Meaning |
| --- | --- |
| User | Authenticated, active Buckit account |
| Member | User with current membership in the addressed bucket |
| Owner | Member matching the bucket's current owner |
| Creator | Member who actually created the expense/plan/member budget |
| Author | Member who wrote the comment |
| Contact owner | User who created the global contact |
| Contact viewer | Contact owner or recipient with an explicit active grant |

All financial/reference/comment/budget mutations require an active bucket. Archived buckets allow authorized reads/export and explicit owner lifecycle operations. Account-deletion and membership-lifecycle services apply their own documented cleanup rules, rather than editing financial history through ordinary endpoints.

Owner status never overrides another creator's record rights. Paid By and Added By never grant editing rights. IDs must reference the expected type and bucket. Contacts use their global owner/grant rules, not the currently selected bucket.

For an inaccessible bucket/contact or an ID from another bucket, return `404 RESOURCE_NOT_FOUND` to avoid disclosing existence. For a visible record on which the caller lacks write permission, return `403 FORBIDDEN`. Recheck access on retries and paginated reads; idempotency receipts cannot bypass revoked access.

## 3. Common HTTP contract

### 3.1 Types and validation

- JSON uses camelCase and `Content-Type: application/json`.
- IDs are opaque strings in responses; database ObjectIds are serialized as strings.
- Monetary amounts, exchange rates, percentages, and calculated money are decimal strings, never JSON numbers. Counts and revisions are integers.
- Calendar dates are `YYYY-MM-DD`; timestamps are UTC ISO 8601 strings. CSV dates alone use `DD/MM/YYYY`.
- Reporting ranges use `from` inclusive and `toExclusive` exclusive. Convert the UI's inclusive end date before calling.
- Currency defaults to the bucket currency where specified. Missing account, payer, category, payment mode, date, description, or amount cannot be invented.
- PATCH uses an explicit allowlist. Omitted fields are unchanged. `null` clears only documented optional fields; required fields reject null.
- Unknown writable fields are rejected, including actual creator, source identity, stored conversion provenance, posting state, and membership ownership fields.
- Validate plain text and render it as text. Do not accept MongoDB filters, operators, regular expressions, or arbitrary sort expressions from clients.

Initial transport limits: ordinary JSON bodies 256 KiB, import chunks 512 KiB, list page size 25 by default and 100 maximum. The existing import envelope remains 5 MiB of source CSV and 5,000 rows. Return explicit errors; never truncate user content or silently drop rows. Endpoint-specific batch sizes may be reduced to fit transactional processing, with continuation returned to the client.

### 3.2 Responses

Single-resource success:

```json
{
  "data": { "id": "resource-id", "revision": 3 },
  "meta": { "requestId": "request-id" }
}
```

Lists return `data: []` and `meta: {requestId, nextCursor, hasMore}`. `nextCursor` is null on the last page. Cursors are opaque, integrity-protected, and bound to the route, caller, bucket, filters, and sort. Use stable date/ID tie-breakers. Normal live lists are not full snapshots; exports use the stronger protocol in Section 11.

Mutation status conventions:

| HTTP status | Meaning |
| --- | --- |
| 200 | Read/update/action completed; response describes committed result |
| 201 | New resource created; include a `Location` header |
| 202 | Durable operation accepted; expose operation/progress reference and access effect |
| 204 | Completed deletion/revocation with no response body |

An expense saved as Conversion needed is a successful save, not a fabricated spending total. A push failure does not turn a saved expense/comment into a failed mutation.

### 3.3 Version checks

Mutable resource responses include `revision` and an ETag such as `"r3"`. PATCH, DELETE, and existing-resource command endpoints require `If-Match: "r3"`, unless explicitly exempted below. Missing preconditions produce 428; stale revisions produce 412. The client refetches and lets the user reconcile rather than silently overwriting another change.

Creation requests, bootstrap, invitation join, and read-only preview/export calls do not require If-Match. Invitation join validates the current invitation and membership transactionally using its token. Endpoints that update a separate subresource, such as a share or membership, use that subresource's revision rather than the parent's. Preference responses use the underlying user revision; refetch on a concurrent profile change.

Composite operations such as changing an installment and its expense also accept the linked record's `expectedExpenseRevision`. Server-only lifecycle guards protect races with removal, archive, deletion, and option retirement; a matching client revision is not sufficient authorization.

### 3.4 Idempotency and retries

Require `Idempotency-Key` for state-changing POST, PATCH, PUT, and DELETE requests. Read-only POST previews and export-read operations are exempt. Scope keys by authenticated user, route/action, and relevant resource; compare a normalized request hash. Reusing a key with different input returns `409 IDEMPOTENCY_KEY_REUSED`.

Persist the result receipt with its domain mutation. For the same completed operation, return the original result/reference after checking current access; evaluate the receipt before rejecting the original now-stale If-Match revision. A concurrent still-running request returns `409 OPERATION_IN_PROGRESS` with `Retry-After`. A lost response is retried with the same key and body, not a new expense.

Creation source keys for imports and installments remain durable beyond transient receipt cleanup. A permanently removed result returns an authorized tombstone outcome where available, never recreates the resource. Operation responses contain references/minimal summaries, not an alternate store of deleted private payloads.

After 401, refresh the Firebase token once and retry. For 429/503, respect `Retry-After`, back off, and reuse the original key. Never automatically retry validation/permission errors as new operations. Do not queue offline expense writes: entries require internet access.

### 3.5 Error envelope

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Choose an account before saving.",
    "fieldErrors": [{ "path": "accountId", "code": "REQUIRED", "message": "Account is required." }],
    "retryable": false
  },
  "meta": { "requestId": "request-id" }
}
```

| HTTP | Stable codes/examples |
| --- | --- |
| 400 | `MALFORMED_REQUEST`, `INVALID_CURSOR` |
| 401 | `AUTHENTICATION_REQUIRED`, `INVALID_TOKEN` |
| 403 | `FORBIDDEN`, `ACCOUNT_INACTIVE`, `REAUTHENTICATION_REQUIRED` |
| 404 | `RESOURCE_NOT_FOUND` |
| 409 | `BUCKET_ARCHIVED`, `CURRENCY_LOCKED`, `OPTION_IN_USE`, `DUPLICATE_NAME`, `INVALID_STATE_TRANSITION`, `OWNERSHIP_TRANSFER_REQUIRED`, `EXPORT_CHANGED`, `PREVIEW_STALE`, `IDEMPOTENCY_KEY_REUSED`, `OPERATION_IN_PROGRESS` |
| 410 | `RESTORE_WINDOW_EXPIRED`, `IMPORT_SESSION_EXPIRED`, `EXPORT_TOKEN_EXPIRED` for previously authorized operations |
| 412 / 428 | `REVISION_MISMATCH` / `PRECONDITION_REQUIRED` |
| 413 | `PAYLOAD_TOO_LARGE`, `IMPORT_LIMIT_EXCEEDED` |
| 422 | `VALIDATION_FAILED`, `AMBIGUOUS_MEMBER`, `UNRESOLVED_REFERENCE`, `INVALID_CONVERSION`, `INVALID_DATE`, `UNSUPPORTED_CURRENCY` |
| 429 | `RATE_LIMITED` |
| 503 | `SERVICE_UNAVAILABLE`, `CAPACITY_UNAVAILABLE` |

Expired, revoked, and unknown invitation tokens share `404 INVITATION_UNAVAILABLE`. Errors expose no database details, secrets, inaccessible member names, or other bucket data. Conversion-provider failure normally produces a missing-conversion state, not a generic 503 for an otherwise valid expense save.

## 4. Profile, bootstrap, and capabilities

All paths in endpoint tables are relative to `/api/v1`. `{b}` means bucket ID; other placeholders identify the named resource.

| Method and path | Access | Input/result |
| --- | --- | --- |
| `POST /me/bootstrap` | Verified Firebase identity | Optional initial displayName/timezone; create missing app profile or return existing profile; 201/200 |
| `GET /me` | User | Own profile, verification status, theme/timezone, last accessible bucket, tour progress, revision |
| `PATCH /me` | User | Allowlisted displayName, timezone, theme, lastBucketId, tour progress; updated profile |
| `GET /capabilities` | User | Supported currencies and precision, payment modes, date/import rules, current size limits, trigger catalog, scheduled-processing description |
| `GET /me/deletion-preview` | User | Shared buckets needing ownership transfer and sole-owned buckets needing explicit deletion; no mutation |
| `POST /me/deletion` | User + recent auth | `confirmation: "DELETE MY ACCOUNT"`; begin irreversible access revocation/cleanup; 202 |
| `GET /operations/{operationId}` | Authorized operation actor | Safe operation state/progress for active users; no internal worker secrets |

Bootstrap derives email/UID/provider state from verified identity, not the body. A missing app profile may access bootstrap only. Capabilities report app configuration, not a promise that provider quotas are unlimited.

Profile PATCH accepts tour `{version, state, lastStep}` with `state` in `not_started`, `in_progress`, `completed`, `skipped`. Replay resets the user's tour state. Reject a lastBucketId without current access; null clears it. No separate account-type preference exists.

Account deletion requires all ownership prerequisites to be resolved first. Return the accepted result before signing the browser out; local app access is denied immediately after acceptance. The deleted user cannot use `/operations` to regain access or keep reading data. External Firebase cleanup is retryable server work; the response makes no promise of immediate physical backup erasure.

## 5. Buckets, members, invitations, and reference options

### 5.1 Buckets and membership

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets` | User | Current accessible memberships, name/currency/timezone/state, owner status; paginated |
| `POST /buckets` | User | `{name, primaryCurrency, timezone}`; create owner membership, default categories and Other platform atomically; 201 |
| `GET /buckets/{b}` | Member | Bucket DTO, revision, effective permissions, currency-lock state |
| `PATCH /buckets/{b}` | Owner | Name/timezone, or primaryCurrency only before first expense |
| `POST /buckets/{b}/archive` | Owner | Archive with expected bucket revision; read-only effect immediate |
| `POST /buckets/{b}/restore` | Owner | Restore; return pending creator-review count and daily-processing status |
| `GET /buckets/{b}/deletion-preview` | Owner | Counts and irreversible deletion explanation, bucket revision |
| `POST /buckets/{b}/deletion` | Owner + recent auth | `{confirmationName}` exactly matching current bucket name; 202, immediately inaccessible |
| `GET /buckets/{b}/members` | Member | `state=active` default; explicit `state=all` supports historical attribution, with no private email directory |
| `POST /buckets/{b}/ownership-transfer` | Owner + recent auth | `{newOwnerUserId}` referencing a current member; atomic ownership transfer |
| `POST /buckets/{b}/leave` | Member | Use membership revision; owner must transfer first or explicitly delete sole-owned bucket |
| `DELETE /buckets/{b}/members/{membershipId}` | Owner | Membership revision; cannot remove self through owner removal or remove current owner |
| `GET /buckets/{b}/activity` | Member | Cursor-paginated audit history, optional entity type/ID filter; actual actor preserved |

Responses distinguish user IDs from membership-episode IDs. Removal stops access immediately and suppresses the actual creator's future records before resumable cleanup. Payer or Added By departure does not remove another creator's entries. Rejoining never revives canceled schedules. Existing global contact shares survive.

Bucket deletion and user deletion are commands rather than bodies on HTTP DELETE, allowing explicit reviewable confirmation. No ordinary resource read is available once a bucket becomes deleting. `/operations` may return a minimal deletion-progress result to its initiating active user, without disclosing the removed bucket's payload.

### 5.2 Invitations

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/invitations` | Owner | Invitation metadata, expiration, revoked state; no raw stored tokens |
| `POST /buckets/{b}/invitations` | Owner | Create seven-day multi-use link; return share URL/token once; 201 |
| `DELETE /buckets/{b}/invitations/{invitationId}` | Owner | Revoke with revision; 204 |
| `POST /invitations/preview` | User; read-only | `{token}`; minimal bucket name and expiry if valid; no membership list |
| `POST /invitations/join` | User | `{token}`; join immediately after validation; 201, or 200 if already a member |

The client generates QR from the share URL or opens manual WhatsApp sharing. No email or automated WhatsApp send endpoint exists. Token verification occurs again during join. A GET/link preview never joins. Keep tokens out of request logs, analytics, and referrer propagation. Invitation creation is the explicit one-time-secret exception to response replay: a retried key returns the original invitation metadata with `secretUnavailable: true`, without creating another invitation. If its one-time link response was lost, the owner can revoke it and deliberately create another invitation with a new key. Do not store recoverable raw tokens in a generic receipt.

### 5.3 Accounts, categories, platforms

Use `{kind}` equal to `accounts`, `categories`, or `platforms`; this maps to the database option discriminator.

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/{kind}` | Member | Active options by default; `state=all` for historical filters |
| `POST /buckets/{b}/{kind}` | Owner | `{name}`, category `iconKey?`, account `ownerLabel?`; 201 |
| `PATCH /buckets/{b}/{kind}/{optionId}` | Owner | Rename or permitted kind-specific display fields |
| `POST /buckets/{b}/{kind}/{optionId}/archive` | Owner | Archive, preserving prior associations |
| `POST /buckets/{b}/{kind}/{optionId}/restore` | Owner | Reactivate archived option |
| `DELETE /buckets/{b}/{kind}/{optionId}` | Owner | Delete only if unused; otherwise `OPTION_IN_USE` with archive action hint |

Trim names and enforce case-insensitive uniqueness within kind/bucket, including archived options. Keep the default Other platform available. No `accountType` field is accepted. New selection of archived references is rejected; unchanged associations on existing scheduled entries remain valid. Historical labels follow DB_DESIGN.md.

## 6. Expenses, refunds, conversion, and comments

### 6.1 Expense endpoints

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/expenses` | Member | Filtered cursor-paginated entries; deleted excluded by default |
| `POST /buckets/{b}/expenses` | Member | Expense input below; 201 with derived state and conversion |
| `GET /buckets/{b}/expenses/{expenseId}` | Member | Full Expense DTO, comment count, permissions, revision |
| `PATCH /buckets/{b}/expenses/{expenseId}` | Creator | Edit allowed financial/display fields; re-evaluate affected periods/conversion/state |
| `DELETE /buckets/{b}/expenses/{expenseId}` | Creator | Soft-delete; 200 with ID, deletedAt, restoreUntil, revision |
| `POST /buckets/{b}/expenses/{expenseId}/restore` | Creator | Restore within 30 days with current access and valid lifecycle; updated Expense DTO |
| `PUT /buckets/{b}/expenses/{expenseId}/conversion` | Creator | Explicit manual amount or rate; update conversion and eligible posting state |
| `POST /buckets/{b}/expenses/{expenseId}/archive-resolution` | Creator | `{decision: "post" or "cancel"}`; allowed only for archive-review entries |
| `POST /buckets/{b}/conversion-preview` | Member; read-only | Date/originalAmount/currency; estimate/applicable rate or unavailable result; never saves an expense |

Filters: `from`, `toExclusive`, `categoryId`, `platformId`, `accountId`, `paymentMode`, `paidByUserId`, plain-text `q`, `status`, cursor, limit. Status accepts `actual`, `scheduled`, `pending_processing`, `conversion_needed`, `archive_review`, or `all`; it is a presentation filter, not a writable state. `deleted=only` supports the caller's recoverable records and requires creator filtering. Canceled lifecycle entries are history rather than ordinary expense-list rows.

### 6.2 Expense input example

Illustrative IDs below are placeholders, not literal valid database IDs.

```json
{
  "expenseDate": "2026-09-23",
  "description": "Groceries",
  "paidByUserId": "member-user-id",
  "categoryId": "groceries-category-id",
  "accountId": "hdfc-common-account-id",
  "platformId": "other-platform-id",
  "paymentMode": "upi",
  "originalAmount": "2000.00",
  "originalCurrency": "INR",
  "notes": "Weekly shopping"
}
```

Date, description, payer, category, account, paymentMode, and nonzero originalAmount are required. Missing originalCurrency defaults to bucket primary currency. Missing platformId resolves to Other; notes default empty. Payment modes are `upi`, `cash`, `neft`, `imps`, `credit_card`. The server sets actualCreatorUserId and addedByUserId to the caller for manual creation. Direct expense PATCH cannot change either attribution field.

Optional `refundOfExpenseId` links a negative entry to an accessible same-bucket positive expense. The form may prefill category/payer from the original, but sends the resulting resolved fields and permits corrections. Negative amounts represent credits/refunds, not salary or a stored account balance. Count them on their own dates.

Example response shape:

```json
{
  "data": {
    "id": "expense-id",
    "bucketId": "bucket-id",
    "revision": 1,
    "expenseDate": "2026-09-23",
    "description": "Groceries",
    "actualCreatorUserId": "importer-or-creator-id",
    "paidByUserId": "member-user-id",
    "addedByUserId": "importer-or-creator-id",
    "originalAmount": "2000.00",
    "originalCurrency": "INR",
    "bucketCurrency": "INR",
    "postingState": "posted",
    "reviewState": "none",
    "displayStatus": "actual",
    "conversion": {
      "status": "final",
      "method": "identity",
      "convertedAmount": "2000.00",
      "rate": "1",
      "manualFixed": false
    },
    "permissions": { "canEdit": true, "canDelete": true, "canComment": true }
  },
  "meta": { "requestId": "request-id" }
}
```

The complete DTO additionally includes resolved option IDs/labels, paymentMode, notes, source kind/links, safe user display objects, timestamps, applicable dueAt/restoreUntil, and resolution actions. Do not return internal origin keys, worker leases, or notification-provider errors. Permissions assist the UI; every mutation reauthorizes independently.

### 6.3 State and conversion behavior

Current/past valid expenses post during submission when converted. Future entries are unposted commitments and become eligible at their date's start in bucket timezone; the next daily run posts them. A future entry stays separate from actual spending even when reporting a future period. A due entry awaiting processing exposes its reason; no payment confirmation is required.

Manual conversion input is exactly one of:

```json
{ "method": "manual_amount", "convertedAmount": "8425.50" }
```

```json
{ "method": "manual_rate", "rate": "84.255" }
```

Validate bucket-currency precision, sign, and positive derived rate. The server derives rate/provenance for manual amount; clients cannot claim provider provenance. A fixed future manual conversion does not post the future expense early. Resolving an eligible current/past missing conversion can post during the request, except an archive-review entry still requires its explicit resolution command. An attempted archive `post` without final usable conversion returns `422 INVALID_CONVERSION` and leaves review pending.

Date/amount/currency edits invalidate incompatible prior conversion. The request may include a replacement `manualConversion` using the same union above, or the server resolves the appropriate provider rate and returns Conversion needed if unavailable. Never reuse a rate from the wrong expense date silently. Moving an expense into the future removes its current actual-spending effect transactionally. EMI-linked date edits must use the installment command so obligation and expense remain synchronized.

Display-state priority: deleted/canceled lifecycle state, archive review, conversion needed for due entries, future scheduled, due pending processing, actual. Future missing estimates appear as scheduled with `estimateUnavailable: true`; they do not falsely reduce current totals. All aggregations require posted, final-converted, nondeleted records.

### 6.4 Comments

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/expenses/{expenseId}/comments` | Member | Nondeleted comments with author/time, cursor pagination |
| `POST /buckets/{b}/expenses/{expenseId}/comments` | Member | `{body}`; 201; event targets all other current members |
| `PATCH /buckets/{b}/expenses/{expenseId}/comments/{commentId}` | Author | `{body}`, revision check; retain editedAt |
| `DELETE /buckets/{b}/expenses/{expenseId}/comments/{commentId}` | Author | Revision check; 204 |

No comments on deleted expenses or archived buckets. New-comment notifications exclude the commenter and obey each recipient's in-app/push preferences. Editing/deleting a comment does not impersonate authors or create an additional comment-added event.

## 7. Budgets and reporting

### 7.1 Budgets

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/budgets` | Member | Visible shared/member budgets, optional scope/state filter |
| `POST /buckets/{b}/budgets` | Owner for shared; member for own | Budget input; 201 |
| `GET /buckets/{b}/budgets/{budgetId}` | Member | Definition, revision, permissions |
| `PATCH /buckets/{b}/budgets/{budgetId}` | Shared owner or member creator | Definition changes; invalidate/recompute affected usage |
| `DELETE /buckets/{b}/budgets/{budgetId}` | Shared owner or member creator | Delete budget, suppress pending alerts; 204 |
| `GET /buckets/{b}/budgets/{budgetId}/usage` | Member | `month=YYYY-MM` for monthly, or stored custom period; usage/incomplete counts/threshold history |

Input: `name`, `scope` (`shared` or `member`), nonempty unique `categoryIds`, positive `limitAmount`, `periodType` (`monthly` or `custom`), custom `from`/`toExclusive`, and `thresholdPercentages` (default empty). Member scope is always the caller; do not accept another memberUserId. Scope/creator identity is immutable after creation. Shared budgets match all payers; member budgets match Paid By to their creator. All budgets remain visible to members.

Threshold suggestions are `"50"`, `"75"`, `"85"`, `"90"`, `"95"`, `"100"`; none is preselected. Accept positive custom percentages with bounded decimal precision; canonicalize/deduplicate equivalents. Once handled in a period, a threshold is not reset by refund, budget edit, or removal/re-addition of that threshold. Existing usage at budget creation is the initial baseline; creating a budget is not an expense-crossing event. Changing categories/limit explicitly recomputes usage and applies the same before/after crossing rules for unhandled selected thresholds.

Usage DTO: `currency`, `from`, `toExclusive`, `limitAmount`, `usedAmount`, `remainingAmount`, `exceededAmount`, `usagePercent`, `incompleteCount`, `financialRevision`, `handledThresholds`. Signed refunds may produce negative usedAmount. No rollover or global sum of overlapping budgets is returned.

### 7.2 Dashboard and reports

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/dashboard` | Member | `period=month\|quarter\|year\|custom`, anchorDate or custom range; current month default |
| `GET /buckets/{b}/reports/spending` | Member | Range and expense filters; `groupBy=category\|account\|platform\|payment_mode\|member\|day\|month` |

Dashboard returns a coherent snapshot with `asOf`, `financialRevision`, normalized range, bucket timezone/currency, actual total, category/trend/member breakdowns, budget summaries, recent entries, EMI summary, and separate scheduled/pending/conversion/review counts and values. Cap embedded lists and return continuation links; totals cover the requested range, not just displayed rows.

Use one consistent snapshot or validate/retry the shared revision across panels. For current-period comparisons, return the explicit equal-elapsed comparison range, current/previous signed totals, absolute change, and percentage where meaningful. Return null plus a reason when a percentage is undefined (for example zero comparison total); do not invent infinite growth. Clearly mark incomplete totals when conversion is unresolved. Estimates and EMI obligations never enter actual spending.

## 8. EMI plans and installment commands

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/emi-plans` | Member | State filter; plan summaries and generation status |
| `POST /buckets/{b}/emi-plans/preview` | Member; read-only | Validate plan and show bounded remaining schedule, with pagination where needed |
| `POST /buckets/{b}/emi-plans` | Member | Create definition and generation checkpoint; 201 with ready/processing progress |
| `GET /buckets/{b}/emi-plans/{planId}` | Member | Plan, counts/amounts, revision, generation state |
| `PATCH /buckets/{b}/emi-plans/{planId}` | Creator | Future defaults/schedule corrections with explicit preview revision; never rewrite posted history |
| `POST /buckets/{b}/emi-plans/{planId}/end` | Creator | Cancel future entries; preserve past and unpaid history |
| `GET /buckets/{b}/emi-plans/{planId}/installments` | Member | Cursor-paginated obligations and linked expense states |
| `POST /buckets/{b}/emi-plans/{planId}/installments/{installmentId}/reschedule` | Creator | `{expenseDate, expectedExpenseRevision}`; synchronize one obligation/entry |
| `POST /buckets/{b}/emi-plans/{planId}/installments/{installmentId}/skip` | Creator | Expected linked expense revision; unpaid/skipped obligation with no spending |

Plan input: `title`, positive `installmentAmount`, `currency`, positive integer `totalInstallments`, `previouslyPaidCount` default 0, `firstInstallmentDate`, category/account/platform/paymentMode/paidByUserId. The original first date defines the anchor; previouslyPaidCount must be between zero and totalInstallments. Preview makes the remaining dates explicit. No prior expenses are generated for the previous paid count.

Plan previews may include `planId` and expected revision to preview a correction; return the intended affected future installment IDs/count and a validation token. Creation and correction recheck references/lifecycle; the token is not authorization. Immutable creator, bucket, source identity, and recorded installment history cannot be patched through a plan.

Generation is checkpointed in bounded batches. Incomplete setup is visible and resumes through scheduled work; do not claim all installments exist until done. Unique installment identities prevent duplicate generation. The daily processor records due installments automatically, preserving original dates.

Skipping/rescheduling applies only to eligible unrecorded obligations. A recorded payment is corrected through its expense, keeping the obligation synchronized. Deleting a payment uses expense DELETE and makes its obligation unpaid; restoring uses expense restore. A soft-deleted payment must not be silently revived by reschedule or generation. Ending a plan never deletes recorded payments. No API accepts `paidCount` as an arbitrary replacement for installment history after creation.

## 9. Global contacts and selective sharing

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /contacts` | User | Owned and active nonhidden shared contacts; `view=all\|owned\|shared`, q, cursor |
| `POST /contacts` | User | Name/serviceType/phone, optional email/address/notes; private initially; 201 |
| `GET /contacts/{contactId}` | Contact viewer | Current details and viewer permissions |
| `PATCH /contacts/{contactId}` | Contact owner | Edit allowed details; recipients see same record |
| `DELETE /contacts/{contactId}` | Contact owner | Delete/revoke grants and pending content delivery; 204 |
| `GET /contacts/share-candidates` | User | Search/paginate associated existing users; only mutually shared bucket names |
| `GET /contacts/{contactId}/shares` | Contact owner | Explicit recipients/grant state, no unrelated memberships |
| `POST /contacts/{contactId}/shares` | Contact owner | `{recipientUserIds}`; validate all candidates then add/reactivate grants atomically within batch limit |
| `DELETE /contacts/{contactId}/shares/{shareId}` | Contact owner | Share revision; revoke one grant; 204 |
| `POST /contacts/{contactId}/hide` | Shared recipient | Share revision; hide from own list without editing/revoking owner's contact |

Share response contains per-recipient share IDs/revisions. Existing active grants are idempotent and do not generate repeat share notifications. Grant creation requires a current common bucket at commit time. A later departure/bucket deletion does not revoke existing shares. Never offer a global application-user directory. Recipient requests cannot further share or change contact details. Reject a batch with invalid recipients with authorized field errors rather than silently sharing with only some users.

## 10. Notification preferences, inbox, devices, and reminders

### 10.1 Trigger catalog and preferences

Initial supported preference keys:

| Family | Independent keys |
| --- | --- |
| Expenses | `expense.added`, `expense.edited`, `expense.deleted` |
| Comments | `comment.added` |
| Membership | `membership.joined`, `membership.left`, `membership.removed`, `bucket.ownership_transferred` |
| Budgets | `budget.threshold_reached` |
| Scheduling/EMI | `scheduled.posted`, `scheduled.conversion_needed`, `scheduled.archive_review_required`, `emi.plan_changed`, `emi.installment_skipped`, `emi.plan_ended` |
| Contacts | `contact.shared`, `contact.updated`, `contact.share_revoked` |
| Personal reminders | `reminder.due` |

This catalog maps the approved trigger families; additions must be exposed explicitly in capabilities/settings. Restoration of an expense uses the expense-edited family. Avoid duplicate expense-added and scheduled-posted notifications for the same posting transition. Import creation/export produces none, including import-caused budget alerts. A later independent action on an imported expense follows its normal action trigger.

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /me/notification-preferences` | User | Trigger map and revision, each value `{inApp, push}` |
| `PATCH /me/notification-preferences` | User | Partial trigger map; each provided trigger supplies both booleans |
| `GET /notifications` | User | Authorized inbox items; unread/all filter and cursor |
| `GET /notifications/unread-count` | User | Count using the same current-access filter as inbox |
| `POST /notifications/read` | User | Bounded `{notificationIds}`; mark own items read; idempotent, no If-Match needed |
| `PUT /me/push-installations/{installationId}` | User | Token and current permission; create/update binding; first registration has no If-Match, updates require registration revision |
| `DELETE /me/push-installations/{installationId}` | User | Revoke own binding with revision; 204 |
| `GET /me/push-installations` | User | Own safe device metadata/state, never raw tokens |

In-app defaults on and push off. Push requires intentional browser permission and a valid device registration. Neither channel is mandatory. Preference changes suppress unsent disabled work; enabling does not replay past events. Device registration does not independently enable every trigger. API success registering a token does not guarantee browser/OS delivery.

Inbox DTO: ID, trigger, safe title, occurredAt, readAt, authorized target descriptor. Return no private text after access loss. Push text is generic with an opaque target; authenticated reads supply current content. Membership/contact access-ended notices can state that access ended without linking to now-inaccessible details. Logout attempts device revocation before Firebase sign-out; registration version/user checks also protect account switches and stale delivery jobs.

### 10.2 Personal reminders

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /me/reminders` | User | Own reminder definitions and next eligible dates |
| `POST /me/reminders` | User | Recurrence input; 201 |
| `PATCH /me/reminders/{reminderId}` | Owner of reminder | Edit recurrence/timezone/enabled state, with revision |
| `DELETE /me/reminders/{reminderId}` | Owner of reminder | Delete and suppress pending occurrences; 204 |

Input: optional bucketId, enabled, timezone, and frequency. Weekly needs one weekday; twice_weekly two distinct weekdays; fortnightly an anchor date; monthly a day from 1–31; daily no weekday selector. Use ISO weekdays 1–7. Bucket-scoped reminders require current membership and retain its episode. Return `nextEligibleDate` and a daily processing description, not an exact guaranteed delivery time. Reminders are fixed-schedule and not conditional on expense entry. Archive pauses related reminders; do not replay stale reminder bursts.

## 11. CSV import and export

### 11.1 Template and import endpoints

Template headers, in order:

`Date, Description, PaidBy, Category, Platform, Payment Mode, Bank Account, Amount, Currency, Added By, Notes, Comments, Status`

| Method and path | Access | Contract |
| --- | --- | --- |
| `GET /buckets/{b}/imports/template` | Member | UTF-8 CSV header/template with download filename; no expense content |
| `GET /buckets/{b}/imports/guidance` | Member | Column rules/defaults, limits, permission rules, ignored fields, required acknowledgments |
| `POST /buckets/{b}/imports` | Member | File metadata, hash, headers, row count; create preview session; 201 |
| `PUT /buckets/{b}/imports/{sessionId}/chunks/{chunkNumber}` | Importer | Rows with stable row numbers, <=512 KiB; validated staging only |
| `PATCH /buckets/{b}/imports/{sessionId}/resolution` | Importer | Mappings, row corrections/exclusions, duplicate decisions, proposed new options; session revision |
| `POST /buckets/{b}/imports/{sessionId}/validate` | Importer; read-only domain preview | Server validation/summary with current preview revision/digest; staging validation metadata may update |
| `GET /buckets/{b}/imports/{sessionId}` | Importer | State/progress/counts and preview revision |
| `GET /buckets/{b}/imports/{sessionId}/rows` | Importer | Filtered paginated row outcomes/errors/defaults |
| `POST /buckets/{b}/imports/{sessionId}/confirm` | Importer | Freeze explicit valid rows/exclusions, duplicate choices, defaults acknowledgment, expected preview digest; 200 |
| `POST /buckets/{b}/imports/{sessionId}/commit-next` | Importer | Commit next bounded confirmed batch; return progress and continuation flag |
| `POST /buckets/{b}/imports/{sessionId}/cancel` | Importer | Stop uncommitted work; committed expenses remain |

Chunks contain `{rowNumber, cells}` with original column text, not trusted pre-authorized expenses. The browser can parse locally for preview, but the server validates every submitted row and mapping. A same chunk number with different content requires an explicit revised staging operation; never overwrite already committed rows. Sequential chunk upload uses returned session revisions. `validate` is exempt from financial idempotency but cannot create references/expenses or alter confirmed input.

Guidance explicitly states:

- Missing/blank Currency uses bucket currency; Platform uses Other; Added By uses importer; Notes is empty.
- Missing Date, Description, or Amount is an error. Missing payer/account/category/payment mode must be resolved before acceptance.
- DD/MM/YYYY date parsing is strict. Negative credits and future scheduling are supported; zero original amount is not.
- Comments is ignored with a warning. Status is derived, never trusted from CSV.
- Importer always owns entries. Only bucket owner may select another current/former member for Added By or create missing reference options.
- Ambiguous/unknown member names require explicit mapping. Do not create members automatically.
- Duplicate warnings require a deliberate include/skip decision; identical legitimate purchases are possible.
- Conversion can be unavailable; accepted unresolved entries are shown as needing conversion, not silently skipped or given zero equivalents.
- No import/export notifications, including import-caused budget threshold alerts.

Each preview row returns normalized input, defaultsApplied, warnings, fieldErrors, duplicate candidates limited to authorized records, and resolution state. Confirmation identifies exactly which ready rows are included and which are excluded. Recheck permissions/reference state at every commit; return `PREVIEW_STALE` for changes requiring renewed review.

Commit response includes cumulative committed/excluded/failed/pending counts, outcomes for the current batch, and `hasMore`. Batch failure rolls back that batch, not earlier successful batches. Client drives bounded commit requests while open; if interrupted, reload progress and resume uncommitted rows with their existing source keys. No promise that a 5,000-row import fits a single request or completes after the browser closes. No background in-memory work is assumed after a response.

### 11.2 Export protocol

| Method and path | Access | Contract |
| --- | --- | --- |
| `POST /buckets/{b}/exports/preview` | Member; read-only | `{filters, scope: "filtered" or "all", includeScheduled: false}`; exact columns and explanatory counts |
| `POST /buckets/{b}/exports/start` | Member; read-only | Same selection; signed export token with revision/filter binding and expiry |
| `POST /buckets/{b}/exports/page` | Member; read-only | `{exportToken, cursor?}`; bounded row DTOs, cursor, hasMore |
| `POST /buckets/{b}/exports/complete` | Member; read-only | Export token plus final signed cursor; validate completed traversal and unchanged revision |

Export tokens are short-lived signed capabilities bound to the user/bucket/filter/exportRevision; they never replace current authorization. They require no new durable export collection. Initial token lifetime is 30 minutes, returned as expiresAt. Expiration requires restarting the export rather than continuing a potentially stale snapshot.

Each page uses a short consistent read of expenses/comments/labels and verifies exportRevision. Completion confirms the same revision after the last page. `409 EXPORT_CHANGED` means discard assembled rows and restart; the UI must not download a mixed snapshot. Changes to exported user labels/anonymization also invalidate the export. Any access loss stops reads immediately.

The browser builds/downloads CSV only after successful completion. Use original amounts/currencies, DD/MM/YYYY dates, displayed Added By, notes, and comments with author/timestamp context in one escaped cell. Status distinguishes actual/scheduled/pending/review/conversion states; exclude deleted/canceled/skipped obligations. Only actual entries are exported unless Include scheduled is selected. Protect textual cells from spreadsheet formula execution while preserving genuine signed numeric Amount values. CSV is not a lossless backup of plans, author identities, audit, or conversion snapshots.

## 12. Scheduled processing and service operations

Internal route: `GET /api/internal/jobs/daily`, used only by the configured scheduler. It is the exception to public read-only GET semantics and is not exposed as a user action. Authenticate with a server-only scheduler secret, disable caching, and reject browser/Firebase user credentials. Keep this route outside `/api/v1`.

The handler leases/checkpoints bounded work: materialize unfinished plans, post eligible expenses, resolve automatic rate attempts where applicable, generate due reminder events, retry notification delivery, and run lifecycle cleanup. Use the shared domain services and unique operation/source keys. Overlapping calls cannot double-post. Do not place tokens, full records, or private data in operational responses.

Return a compact result such as `{runId, state, processedCounts, hasRemainingWork}`. A time-budget stop persists progress and returns without claiming the queue is empty. An active lease returns a safe no-op result. Failed external delivery is retried independently of committed financial state. There is no minute-level, exact-midnight, or exact-reminder-hour promise; normal work resumes in the next daily window.

No public endpoint forces posting of another user's future expenses, runs arbitrary jobs, exports the whole database, or resets budget threshold history. Operator recovery uses protected operational tooling and the same guards, not a hidden owner privilege.

## 13. Cross-cutting workflows and integrity

| Workflow | Required guarantee |
| --- | --- |
| Expense mutation | Expense, EMI link if any, budget effects, audit, event intent, and receipt commit together |
| Scheduled posting | Original date retained, usable final conversion, no archive-review bypass, one contribution |
| Membership removal | Access and future-processing eligibility stop before cleanup; creator rather than payer determines cleanup |
| Import | Confirmed rows only, per-row source identity, no notifications, no silent defaults beyond disclosed rules |
| Comment addition | Real author preserved, all other current members considered, channel preferences honored |
| Budget crossing | Highest newly crossed selected threshold in one event; all crossed marked handled; import suppression durable |
| Contact sharing | Association checked at grant, explicit grants used afterward; bucket changes do not revoke them |
| Permanent deletion | Confirmation and recent auth, immediate access denial, resumable cleanup/tombstone recovery |

Persist financial state before attempting push. Do not call FX or FCM from retryable database transaction callbacks. API receipts and display statuses never replace the database's lifecycle guards. No endpoint exposes unrestricted raw collections or client-selected aggregation pipelines.

Rate-limit by authenticated actor and sensitive action, using shared durable coordination where required across server instances. Return 429 with Retry-After rather than relying on process-local counters. Apply tighter limits to invitation preview/join, recipient search, imports, and provider-backed conversion previews. Rate limits and transport limits are operating controls, not a claim of unlimited free hosting capacity.

## 14. Contract verification and handoff

Before implementation sign-off, contract/integration tests must cover:

1. Token rejection, deleted app users, reauthentication, cross-bucket IDs, and owner-versus-creator permissions.
2. Stale revisions, duplicate idempotency keys, lost responses, and replay after resource/access deletion.
3. Decimal precision, negative amounts, required account/payer/payment mode, default platform/currency, and read-only ownership fields.
4. Future/current date transitions, daily lag, missing/manual FX, archive backlog, and membership-departure races.
5. EMI generation retries, installment correction/skip, deletion/restoration, and no duplicate financed-purchase spending.
6. Shared/member budget matching, overlapping categories, import suppression, and once-per-period thresholds.
7. Commenter exclusion, independent channel toggles, no push-only inbox copy, device rebinding, and generic push payloads.
8. Associated contact search, retained shares after bucket departure/deletion, revoke/hide permissions, and no unrelated directory leakage.
9. Legacy CSV defaults, ambiguous names, owner-only attribution/reference creation, chunk limits, partial commits, ignored Comments, and resumable imports.
10. Export revision changes, access revocation, formula-safe text, original currencies, comments, and scheduled inclusion.
11. Permanent bucket/user deletion, ownership prerequisites, interrupted cleanup, and non-replay of old notifications after recovery.

These are required implementation checks, not tests claimed to have run for this document. The four requested design documents now exist. Review and finalize API_DESIGN.md before moving to an implementation plan or an executable API specification; no additional document or application implementation is created by this step.
