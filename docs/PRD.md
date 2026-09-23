# Buckit — Product Requirements Document

Version: 1.1 · Status: Finalized V1 requirements, updated with approved changes · Date: 23 September 2026

This document records the agreed V1 product requirements, including the approved technology, daily-processing and notification changes following v1.0. It supersedes v1.0 and the earlier unapproved draft. SYSTEM_DESIGN.md describes the architecture; database and API designs will be separate documents. Technical choices must preserve these product rules.

## 1. Product purpose

Buckit is a responsive web app for individuals and groups to record, understand, and plan spending. Users organize spending into independent buckets such as Personal, Common, or House Expenses. Shared visibility, configurable budgets, scheduled expenses, and EMI tracking help members understand where money goes without calculating debts between them.

The product should remain useful to individuals and groups while staying simple, visual, and quick to use. The initial release is non-commercial and will be shared with friends and family, with no monetization. Contacts provide a separate personal directory with selective sharing among associated users.

### Goals

- Make recording and finding expenses straightforward on phones and computers.
- Provide consistent spending totals within each bucket.
- Support shared and member-specific budgets without splitting expenses.
- Distinguish actual spending from scheduled commitments.
- Preserve the user's familiar spreadsheet workflow through CSV import/export.
- Give users control over notification delivery for each trigger.
- Target ₹0 operating cost for the MVP within documented service allowances.

### V1 exclusions

- Expense splitting, debts between members, repayments, and settlements.
- Income tracking, live account balances, and bank transaction synchronization.
- Offline entry or saving.
- Receipt scanning, automatic merchant logos, and title-based category prediction.
- Complex loan calculations, down payments, financing fees, and early-closure calculations.
- Budget rollover, weekly budgets, and a dedicated yearly budget period.
- A combined spending dashboard across buckets.
- Application emails, email digests and automatic email invitations. Firebase authentication emails remain in scope.
- Telegram, SMS and automated WhatsApp notifications. Manual WhatsApp invitation sharing remains in scope.
- Exact-time scheduled delivery or guaranteed midnight posting; V1 uses daily background processing.

### Approved implementation constraints

- Next.js and TypeScript for the full-stack application, with a Node.js backend hosted on Vercel.
- MongoDB Atlas with Mongoose for application data.
- Firebase Authentication for email/password, Google sign-in and verification/password-reset emails; Firebase Cloud Messaging for optional web push.
- Daily scheduled processing within the free hosting plan's permitted timing precision.
- No purchased domain is required for V1; use the hosting-provided HTTPS URL.
- Service allowances and best-effort delivery must be respected without enabling charges automatically. Detailed limits and operational choices belong in SYSTEM_DESIGN.md.

## 2. Core concepts

| Concept | Meaning |
| --- | --- |
| Bucket | Independent spending workspace with members, currency, and timezone |
| Bucket owner | Single member responsible for bucket administration |
| Expense owner | Actual creator of an expense; for CSV entries, the importer |
| Paid By | Bucket member who paid for an expense; controls member-budget matching |
| Added By | Displayed attribution, normally the creator; may differ on owner-run imports |
| Account | Bucket-specific named payment source, such as HDFC Personal or Cash |
| Platform | Merchant/place of purchase, such as Amazon, D-Mart, or Other |
| Scheduled expense | Future commitment that becomes spending automatically on its date |
| EMI plan | Fixed monthly installment schedule belonging to a bucket |

Account and account type are merged into one Account field. There is no separate beneficiary field. For negative entries, Paid By identifies the member receiving the credit, with this meaning explained in the interface.

## 3. Membership and permissions

| Action | Bucket owner | Other current member |
| --- | --- | --- |
| View bucket expenses, budgets, and EMI plans | Yes | Yes |
| Manage bucket settings and invitations | Yes | No |
| Manage accounts, categories, and platforms | Yes | No |
| Remove another member | Yes | No |
| Leave a bucket | After transferring ownership if others remain | Yes |
| Add an expense | Yes | Yes |
| Edit/delete/restore an expense | Own records only | Own records only |
| Comment on any expense | Yes | Yes |
| Edit/delete a comment | Own comments only | Own comments only |
| Manage shared budgets | Yes | No |
| Manage member-specific budgets | Own member budgets | Own member budgets |
| Create an EMI plan | Yes | Yes |
| Manage an EMI plan | Own plans only | Own plans only |
| Import/export expenses | Yes | Yes |
| Create missing reference options during import | Yes | No |
| Attribute imported Added By to another member | Yes | No |
| Archive/restore/permanently delete bucket | Yes | No |
| Resolve overdue entries after bucket restoration | Own entries only | Own entries only |

Owner status does not grant permission to edit another member's expense, comment, member-specific budget, or EMI plan.

Leaving or removal revokes bucket access but preserves historical expenses and attribution. It does not transfer expense ownership. Historical references to former members remain readable. Ownership transfer changes bucket administration, not ownership of individual records.

On voluntary departure, removal, or user-account deletion, remove that actual creator's future manual expenses and EMI installments and stop their plans from generating more. Preserve historical records and retain their member-specific budgets as read-only history. Apply this rule to actual ownership, not Paid By or displayed Added By: records created by someone else remain even if their payer leaves. Lifecycle cleanup is a defined system action, not permission for other members to edit those records.

## 4. Authentication and onboarding

- Public email/password registration, verification, sign-in, sign-out, and password recovery.
- Google sign-in when supported by the selected no-cost authentication service.
- A public home page introduces Buckit and offers sign-up/sign-in and a clear get-started path.
- New users create or join a bucket before entering the main spending workspace.
- Creating a bucket requires a name, primary currency, and timezone.
- A short guided tour begins after the first bucket is created or joined.
- Tour steps introduce the bucket selector, Add expense, dashboard, budgets, invitations where permitted, and other navigation.
- Tour controls include Next, Back where applicable, Skip, and replay from Help.
- Steps respect permissions and device layout; do not point members to unavailable owner controls.

## 5. Buckets and invitations

- Users can create and belong to multiple buckets.
- The currently selected bucket controls dashboard, expenses, accounts, categories, platforms, budgets, and EMI views.
- The selected bucket is visibly identified, including during expense entry.
- Login restores the last-used accessible bucket. If inaccessible, offer another accessible bucket or create/join onboarding.
- Invitations are shared as links, through manual WhatsApp sharing, or as QR codes. Automatic email invitation delivery is deferred beyond V1.
- WhatsApp sharing opens the user's sharing flow; automated WhatsApp messaging is not required.
- QR codes encode the same invitation link and inherit its validity rules.
- A valid invitation permits immediate joining after authentication; owner approval is not required.
- Invitations expire after seven days. Owners can revoke them or generate new ones. Link/QR invitations support multiple joins until expiration or revocation. There is no automatic address-targeted email invitation flow in V1.
- Push notifications cannot invite people who have never opened and enabled Buckit; use the shareable link/QR flow for onboarding.
- The primary currency becomes fixed after the first expense, including a scheduled or imported entry.

### Archival and restoration

- Only the owner can archive or restore a bucket. Archival makes it read-only, preserving reports and export while pausing automatic posting and bucket-related reminders.
- Upon restoration, each actual expense creator is shown their overdue scheduled entries and decides whether to post or cancel them. The bucket owner cannot decide for other creators.
- Overdue entries remain pending and outside actual spending until their creator resolves them. Future scheduling resumes through the normal daily runs; do not automatically post the pending backlog.

### Permanent bucket deletion

- Permanent deletion is included in V1 and is owner-only.
- Require confirmation by typing the bucket's name and explicitly warn that its expenses, comments, budgets, EMI records, and other bucket data will become unrecoverable.
- Stop all bucket processing and revoke bucket access/invitations. This is distinct from recoverable expense deletion.
- Global contacts and their existing shares remain unaffected.

### User-account deletion

- Require ownership transfer for shared buckets before deleting the user's Buckit account. A sole-owned bucket can be permanently deleted through the explicit bucket-deletion flow.
- Revoke sign-in and access, remove the user's personal contacts and shares, and preserve shared historical expense records under a Deleted user label.
- Apply departure cleanup to future records and plans. Named payment accounts such as HDFC Personal are separate from the user's Buckit account.

## 6. Expense entry and reference options

| Field | Requirement |
| --- | --- |
| Date | Required; supports past, present, and future dates |
| Description | Required title/description |
| Paid By | Required; selectable bucket member |
| Added By | Automatic for manual entry; imported attribution rules apply |
| Category | Required; exactly one category |
| Platform | Always populated; defaults to Other |
| Payment Mode | Required: UPI, Cash, NEFT, IMPS, or Credit Card |
| Account | Required; selected bucket account |
| Amount | Required nonzero monetary amount; positive spending or negative credit/refund |
| Currency | Defaults to bucket primary currency; supported alternatives allowed |
| Notes | Optional |

- Account names are user-defined by the owner, e.g. HDFC Personal, HDFC Common, ICICI Savings, and Cash.
- Accounts are shared within the bucket and can have an optional owner label. They do not represent live balances.
- Only the owner creates/manages categories and platforms. Categories start with useful defaults and show suitable icons.
- Platform means the merchant or place of purchase, not a payment app. Other is available by default.
- Required fields can be prefilled, but no expense is saved without a resolved account, payment mode, and payer.
- Paid By can differ from the actual creator without changing edit rights.
- Support expense search and combined filtering by date, category, platform, account, payment mode, and payer.
- Deleted expenses stop affecting reports and budgets immediately. Their creator can restore them for 30 days.
- Record an activity history identifying actual changes and actors; displayed attribution must not overwrite this history.
- Archive used accounts/categories/platforms: preserve historical labels and filtering, but prevent their selection for new entries. Unused options can be deleted. Existing scheduled associations remain valid.
- Block duplicate names within each reference-option type and bucket, ignoring capitalization and surrounding spaces.

### Credits and refunds

- Negative entries record credits/refunds against an account and reduce net spending and matching budget usage; they do not establish a live account balance. Reject zero amounts. Salary and other income remain outside V1.
- Permit standalone negative entries and optional links to original expenses.
- For a linked refund, copy Category and Paid By from the original by default so it reduces the same member's budget; allow the creator to correct these values.
- Count a refund on its own date, without rewriting the original month's spending.
- Example: a ₹2,000 purchase and a −₹500 refund in the same period result in ₹1,500 net spending; both records remain visible.

## 7. Scheduling and currency

### Scheduled expenses

- Future-dated manual, imported, and EMI entries are scheduled commitments.
- Scheduled amounts are separate from actual spending, including when viewing a future reporting period.
- At the start of the expense date in the bucket's timezone, the entry becomes eligible for automatic posting. It becomes recorded spending during the next daily processing run, without payment confirmation, subject to conversion and lifecycle exceptions below.
- Preserve the original expense date for reports and budgets even if processing happens on a later day or in another month.
- Due entries awaiting the daily run show Pending daily processing and remain separate from actual spending. Present an approximate processing window, not a guaranteed minute or midnight completion.
- Background processing runs daily. Normal delays can approach a day plus scheduling variation; outages can extend them. Resume unfinished work without duplicating financial effects.
- Manual current/past expense entry, comments and other user actions are processed when submitted; they do not wait for the daily background run.
- Monthly schedules use the last valid day when the intended day is absent, then return to the intended day in subsequent months. A 31st-day schedule uses February's last day and returns to 31 March.
- Each entry must contribute at most once, including after delayed processing or retries.
- Automatic recording follows the schedule; it is not bank verification.

### Currency conversion

- Preserve original amount/currency and the bucket-currency equivalent.
- Use the expense date's rate, or the latest available published rate on or before that date.
- Preserve the applied rate and rate date so historical totals do not fluctuate with current rates.
- Allow a manual rate override to match the actual bank charge.
- If a usable rate cannot be obtained, only the expense creator can enter the converted amount in the bucket currency; derive and store the exchange rate from the original and converted amounts. Do not silently treat currencies as equivalent.
- Future entries show an estimated equivalent using the latest available rate. Finalize during posting using the original expense date's applicable rate, not the processing date's rate, unless a manual rate is fixed.
- A due entry without conversion is marked Conversion needed until its creator resolves it. Reports explicitly flag incomplete totals and do not treat the unresolved entry as zero or present an estimate as finalized spending.
- Supported currency coverage and provider selection are technical design work; this fallback behavior is fixed.

## 8. Budgets

- All budgets belong to one bucket and are visible to all current members.
- Shared budgets are created/edited/deleted by the bucket owner and match expenses from all payers.
- Member-specific budgets are created/edited/deleted by the member they belong to and match Paid By to that member.
- Both kinds select one or more categories and an amount in the bucket currency.
- Periods are monthly or custom date ranges; no automatic carry-forward.
- Show used, remaining, and exceeded amounts clearly.
- Count actual expenses within the budget dates, using their bucket-currency amounts. Scheduled commitments remain separate.
- An expense can match more than one budget but counts once in overall spending. Do not add overlapping budgets together as if they were a single spending total.

Example: Bharat and Anjali each spend in Personal. Bharat's member budget includes only entries paid by Bharat. A shared Personal-category budget includes both. All their expenses count once in the bucket's monthly spending.

### Budget alerts

- Offer 50%, 75%, 85%, 90%, 95%, and 100% as available thresholds, with none preselected. Support custom percentages per budget.
- Each selected threshold triggers at most once per budget period. Refunds followed by further spending do not retrigger a threshold already reached in that period.
- If one change crosses multiple selected thresholds, issue one alert showing the highest crossed threshold and mark the crossed thresholds as handled.
- Shared-budget alerts target all current bucket members; member-specific alerts target the budget's creator. Deliver only through each recipient's enabled channels.

## 9. EMI plans

- Any member can create a plan and select the bucket it belongs to.
- Store title, installment amount/currency, installment count, monthly schedule, category, platform, account, payment mode, and payer.
- Automatically generate individual entries against the installment dates, owned by the plan creator.
- Count installments as expenses when the daily run posts them after their due dates become eligible, retaining each installment's original expense date. Do not also count the financed purchase amount.
- Allow adding an existing plan with a previously paid count; generate only remaining installments and do not create prior expenses automatically.
- Permit correction of an individual installment payment without introducing variable-rate loan calculations.
- Plan changes affect future installments by default, preserving recorded expenses. Ending a plan cancels its future entries and preserves history. The creator can separately correct individual recorded installments.
- Rescheduling an installment changes its date without shifting other installments.
- Skipping an installment creates no spending and leaves an unpaid obligation, separately visible from upcoming scheduled installments.
- Deleting a recorded installment removes that expense and restores the unpaid obligation; it must not immediately be recreated by scheduling. Restoring the expense reverses that result.
- Show active/completed plans, recorded installments, upcoming dates, remaining counts/amounts, and skipped/unpaid obligations.
- Previously recorded installments are schedule-based records, not bank-confirmed payments.

## 10. Comments

- Every current bucket member can add comments to any expense, regardless of payer or creator.
- Preserve comment author and timestamp. Only its author can edit/delete a comment.
- A newly added comment is a notification trigger for all other current bucket members, excluding the commenter.
- Channel delivery follows each recipient's notification preferences; neither channel is mandatory.
- Export comments in the corresponding expense row, including author/time context.
- CSV imports never recreate comments or impersonate their authors.

## 11. Notifications and reminders

### Delivery preferences

- Provide independent In-app and Push toggles for each supported notification trigger.
- Users can choose either channel, both, or neither for each trigger.
- Preferences govern delivery; comments do not bypass preferences.
- Optional notifications initially have In-app enabled and Push disabled. Push requires deliberate opt-in and permission on each device.
- Firebase verification and password-recovery emails remain separate from optional notification preferences.
- Application emails, email digests, automatic email invitations and Telegram are not included in V1. No push-digest feature is implied by the removal of email digests.
- Imports/exports do not generate notifications in either channel. On-screen import results and internal activity history are not notification delivery.
- Bulk-imported expense creation must not fan out into ordinary expense-added notifications.
- Import-caused budget threshold crossings also remain silent; record them as handled so a later unrelated change does not replay those alerts.
- User-action notifications can be generated immediately, with a bounded immediate push attempt. Scheduled reminders and retry work follow daily background processing. Failed push delivery must not cause a successfully saved expense/comment to be reported as unsaved.
- Disabling a channel suppresses its unsent notifications. Enabling it does not replay previously suppressed events. Recheck permissions before dispatch.

### In-app experience

- Provide a notification bell, unread count, history and read state, with links to authorized app content.
- Users see in-app notifications when they open/use Buckit; this channel does not itself create device alerts outside the app.
- Only create inbox notifications for enabled in-app triggers. Push-only selections do not create unintended inbox copies.

### Optional web push

- Push may notify users when Buckit's tab is closed, subject to supported browsers/devices, permission, connectivity and operating-system restrictions. Delivery is best effort, not guaranteed.
- Ask permission only after an intentional user action. Detect unsupported devices and explain the limitation without blocking app use.
- Supported iPhone/iPad web push requires adding Buckit to the Home Screen; provide brief guidance. This adds neither a native app nor offline expense entry.
- Default lock-screen text is generic, such as “You have a new update in Buckit.” Do not expose amounts, titles, names, comment text or contact details there.
- Opening a notification requires normal authentication/access checks and loads current authorized data. Lost access must not reveal cached content.
- Support per-device registration and safe cleanup on logout/account switching. A user's enabled devices can receive push while an in-app event remains one item per user.
- If push is denied or unavailable, retain access to the app and any enabled in-app notifications. Do not silently enable another channel or send email instead.

### Trigger coverage

Provide independently configurable triggers covering expense additions/edits/deletions, new comments, membership changes, budget alerts, EMI/scheduled-expense events, contact sharing, and personal reminders. Budget thresholds follow Section 8. Comment recipients exclude the commenter. Notification delivery must respect both current access and recipient settings and must not expose private contact information to unrelated users.

### Personal reminders

- Users set fixed expense-entry reminders: daily, weekly, twice weekly, every two weeks, or monthly.
- Users choose applicable days/recurrence, interpreted in their own timezone, independent of bucket timezone. V1 sends due reminders during the daily processing window rather than at an exact user-selected time.
- Reminders are personal and follow the configured notification channels.
- Reminders are not conditional on whether the user already entered an expense.
- Monthly reminders use the last-valid-day rule. Bucket-related reminders pause while that bucket is archived.

## 12. CSV workflow

### Template

Preserve these column names and order:

`Date, Description, PaidBy, Category, Platform, Payment Mode, Bank Account, Amount, Currency, Added By, Notes, Comments, Status`

| Column | Import/export behavior |
| --- | --- |
| Date | DD/MM/YYYY; required; future dates create scheduled entries |
| Description | Required expense description |
| PaidBy | Resolve to a member of the selected bucket |
| Category | Resolve to a category; owner can create after preview |
| Platform | Default Other if missing/blank; owner can create after preview |
| Payment Mode | Required valid method, supplied in file or resolved before import |
| Bank Account | Maps to Account; owner can create after preview |
| Amount | Required original-currency amount |
| Currency | Default bucket currency if missing/blank |
| Added By | Default importer if missing/blank; owner-only alternate attribution |
| Notes | Optional; missing/blank becomes empty |
| Comments | Export-only; ignored on import with an explicit explanation |
| Status | Export identifies actual versus scheduled entries; import derives state from Date and lifecycle/conversion rules, not an editable CSV status |

### Attribution and ownership

- The importer always owns imported expense records and is retained as the actual import actor.
- Bucket owners can provide another member as Added By without transferring edit/delete rights.
- Ordinary members cannot attribute imported records to another creator. Conflicting values must be corrected during preview, not silently accepted.
- Resolve names explicitly when ambiguous. Do not guess between members with the same name.
- Historical rows may reference former bucket members as PaidBy or, for owner-run imports, Added By without restoring access. Unknown names must be resolved before import; never create members from CSV names.
- Explain displayed attribution versus actual importer ownership in preview and record details.

### Import experience

1. Select the bucket and download the template or choose a CSV file.
2. Show concise import guidance explaining all defaults and blank-value behavior, required fields, date format, ownership, currency conversion, negative amounts, scheduling, ignored Comments, and derived Status.
3. Parse and preview individual rows with clear validation errors and duplicate warnings.
4. Resolve missing values and member/reference mappings. Allow assigning common required values to affected rows where appropriate.
5. Show owner-only creation of missing accounts, categories, and platforms before confirmation.
6. Explicitly confirm which valid rows will be imported and which will be excluded; no silent row loss.
7. Create separate normal expenses against their dates and show successes, skips, and errors on screen.

Missing Date, Description, or Amount must be corrected rather than invented. Required payer/account/category/payment-mode values must be resolved before a row is accepted. Duplicate warnings are advisory until the user makes an explicit choice.

### Export behavior

- Export individual expenses using the template columns, original amount, and original currency.
- Combine an expense's comments in one correctly escaped CSV cell, with authors and timestamps.
- Include Notes and displayed Added By.
- An expense CSV is not a lossless backup: it does not preserve structured comment threads, full EMI plans, deletion history, or all conversion metadata. Reimported foreign expenses can receive recalculated rates.
- Default export to current expense filters; offer all entries in the selected bucket. Exclude deleted entries.
- Include scheduled entries only when the user selects Include scheduled expenses. Status distinguishes scheduled versus actual rows. Skipped/canceled installments are obligations/history rather than recorded expenses and must not appear as actual spending rows.

## 13. Contacts and selective sharing

- Contacts are global to the user, independent of bucket selection.
- Fields include name, service/type, phone, and optional email, address, and notes, with call/WhatsApp shortcuts where appropriate.
- A contact begins private to its creator.
- Share opens a searchable list of existing Buckit users who currently share at least one bucket with the creator.
- Display only bucket names common to both users; do not reveal unrelated memberships or the application's entire user directory.
- Allow selecting one or more recipients. Only creator and selected recipients see the contact.
- Only the creator can edit/delete/share further/revoke access. Recipients can view/use and remove the contact from their own view.
- Previously granted sharing remains after a common bucket membership ends, until revoked.
- Updates apply to the shared contact rather than creating independently editable copies.

## 14. Dashboard, navigation, and presentation

### Bucket dashboard

- Default to the current month, with monthly, quarterly, yearly, and custom periods.
- Show actual spending in the bucket currency, equivalent-period comparisons, category breakdown, and spending trend.
- Show budget usage/remaining amounts, recent expenses, scheduled commitments, and EMI information.
- Provide member spending breakdowns for shared buckets without calculating debts.
- For an ongoing period, compare equivalent elapsed portions, e.g. this month through the 15th against the previous month through the 15th.
- Keep scheduled/estimated values visually separate from actual/finalized values. Surface entries pending daily processing or manual conversion so users can understand incomplete totals.
- Avoid misleading empty charts; show concise setup prompts.

### Navigation and usability

- Bucket navigation: Dashboard, Expenses, Budgets, EMIs, Accounts, and appropriate settings.
- Global navigation: Contacts, notification preferences, personal reminders, profile/help.
- Keep Add expense prominent and the selected bucket visible.
- Use concise labels, category icons, progress bars, and readable charts rather than text-heavy screens.
- Support keyboard navigation, readable contrast, labeled controls, and charts that do not rely on color alone.
- Show validation near affected fields and clear loading, success, empty, and error states.

## 15. Quality and operational requirements

- Enforce bucket membership and record ownership on every protected action, not only through hidden buttons.
- Enforce contact-sharing access independently from bucket access.
- Preserve monetary precision and apply consistent currency-aware rounding.
- Prevent duplicate expenses and duplicate delivery from retried scheduling/import operations.
- Reflect edits, deletions, restoration, and conversion changes consistently across lists, budgets, and reports.
- Resume daily scheduled processing after temporary downtime without counting future entries early or duplicating records. Expose processing delay instead of implying precise execution.
- Validate CSV content and protect spreadsheet exports from executable formula content.
- Keep credentials and private user/contact data out of logs and unauthorized views.
- Show actionable failures when free-service allowances or connectivity prevent an operation; do not report unsaved records as saved.
- Define backup, recovery, monitoring, and service-limit behavior during system design.

## 16. V1 acceptance scenarios

| Scenario | Expected result |
| --- | --- |
| Switch from Common to Personal | Every bucket-scoped view switches; global Contacts does not |
| Member opens owner controls | Administrative mutations are unavailable and rejected if attempted |
| Bharat records an expense paid by Anjali | Everyone sees it; Bharat owns it; Anjali's matching member budget counts it |
| Owner imports Added By = Anjali | Attribution shows Anjali; importer remains actual actor and expense owner |
| Import original eight-column sheet | Currency defaults to bucket currency; Added By defaults to importer; new optional fields are handled transparently |
| Import 100 rows | 100 separate dated entries; no notification fan-out, including import-caused budget alerts |
| Import unknown platform | Owner can preview/create; ordinary member must map to an existing option |
| Add a comment | Other members receive only their enabled channels; commenter receives no self-notification |
| Disable both channels for a trigger | No notification for that trigger in either channel |
| Expense matches two budgets | Both budget views update; bucket spending increases once |
| Future expense reaches its date | It becomes eligible in bucket timezone and posts once during daily processing without confirmation, retaining its original expense date |
| Skip an EMI installment | No spending; unpaid obligation remains; other dates stay unchanged |
| Add an existing EMI plan through EMI setup | Previously paid count is retained; only remaining installments generate entries |
| Delete and restore an expense within 30 days | Totals reverse then recover the entry's effect, including negative amounts; restoration is limited to its actual creator |
| Share a contact with an associated user | Only authorized users see it; unrelated bucket names stay hidden |
| Leave or be removed from a bucket | Access ends; creator-owned future entries are removed and plans stopped; history and prior contact shares remain |
| Import historical entries referencing former members | Attribution resolves without granting access or creating users |
| Record a ₹500 refund against a ₹2,000 expense | Negative row remains visible; net spending is ₹1,500 if in the same period |
| Budget has no selected alert thresholds | No threshold alerts are generated |
| Cross several selected thresholds in one expense | One notification shows the highest crossed threshold; no repeated alerts in that period |
| Schedule a monthly entry for the 31st | February uses its last day; March returns to the 31st |
| End an EMI plan | Future installments canceled; historical payments retained |
| Due foreign expense has no usable rate | Conversion needed is visible; creator enters converted amount; reports flag incomplete totals until resolved |
| Restore an archived bucket | Future daily scheduling resumes; each creator resolves only their own pending overdue entries |
| Export with Include scheduled expenses disabled | Only matching actual expenses; no deleted rows |
| Permanently delete a bucket | Owner confirms name; bucket data becomes unrecoverable; global contacts unaffected |
| Delete a user account | Ownership transfer enforced; sign-in revoked; personal contacts/shares removed; shared history shows Deleted user |
| Enable Push for a trigger | Device permission is requested intentionally; delivery targets only enabled, authorized registrations |
| Deny or lack push support | App remains usable with enabled in-app notifications; no email fallback |
| Use an iPhone/iPad for push | Home Screen setup guidance is shown for supported devices |
| View lock-screen notification | Generic text; private expense/contact content stays inside authenticated Buckit |
| Daily run posts a previous month's installment | Spending is attributed to the installment's original month, not the processing month |
| Share a bucket invitation | Link, manual WhatsApp share or QR; no automatic email is sent |

## 17. Technical design boundaries

V1 product behavior is finalized in this document. The following implementation work belongs in subsequent designs and does not reopen or silently alter the agreed scope:

- Configure the approved Next.js/TypeScript/Node.js/Vercel and MongoDB/Mongoose stack, Firebase authentication/web push, and exchange-rate integration; document actual allowances and currency coverage.
- Specify secure permission enforcement, lifecycle cleanup, notification delivery, and reliable scheduled processing, including timezones and retry behavior.
- Define monetary precision, conversion storage, CSV size limits and parsing, and validation messages consistent with the rules above.
- Define backup/recovery, permanent-deletion execution, operational monitoring, and handling of service-limit failures.
- Map these requirements to database structures and API contracts, including explicit states for scheduled, pending restoration, conversion-needed, skipped, and deleted records.

If a technical constraint would change user-visible behavior or require spending, present the tradeoff for approval rather than silently reducing functionality or enabling charges.

## 18. Finalization and document sequence

This PRD is updated to v1.1 under the user's instruction to align it with the recent approved decisions. The earlier finalized v1.0 is superseded. Subsequent requirement changes should update the version and corresponding designs together.

SYSTEM_DESIGN.md already exists for review and reflects the approved stack and communication choices. Once it is accepted, recommend DB_DESIGN.md next, followed by API_DESIGN.md. Create and finalize each separately only when requested. This PRD update does not authorize creating those documents or implementing the app.

### Revision summary: v1.1

- Clarified the non-commercial friends-and-family initial release and approved technology constraints.
- Replaced application email with optional web push; retained in-app notifications and Firebase authentication emails; excluded Telegram.
- Deferred automatic email invitations in favor of link/QR/manual sharing.
- Replaced exact-time background promises with daily processing and explicit pending states while preserving financial dates.
- Added push permission, device support, privacy and failure behavior, with corresponding acceptance scenarios.
