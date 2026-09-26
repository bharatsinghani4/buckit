# Buckit — saved phase roadmap and design preferences

Source: user-approved sequencing supplied on 23 September 2026. This file preserves project context for future work. Use it alongside PRD.md; phases sequence implementation and do not remove later V1 requirements.

| Phase                              | What we develop                                                                                                                | Screens to design                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **1. Access and first bucket**     | Firebase authentication, user profile, create/join bucket, invitation links, bucket selection, basic navigation                | Public home, sign in, sign up, verification, password reset, onboarding, create bucket, invitation acceptance, app shell |
| **2. Everyday expenses**           | Accounts/categories/platforms, expense entry, refunds, currency conversion, filtering, editing, deletion/restoration, comments | Expense list, add/edit expense, expense detail, deleted expenses, reference settings, member/invitation management       |
| **3. Spending insights**           | Dashboard, reports, shared/member budgets, consistent totals and incomplete-data indicators                                    | Dashboard, reports, budget list, create/edit budget, budget detail                                                       |
| **4. Scheduled spending and EMIs** | Daily processing, scheduled posting, EMI plans/installments, conversion resolution, skipped/unpaid obligations                 | Scheduled expenses, EMI list, create/edit plan, plan detail, overdue/conversion review                                   |
| **5. Notifications and reminders** | In-app inbox, per-trigger preferences, optional push, personal reminders                                                       | Notification inbox, notification settings, push setup, reminder management                                               |
| **6. Contacts and CSV**            | Personal contacts and selective sharing, validated imports, consistent exports                                                 | Contact list/detail/editor, sharing selector, import preview/resolution/progress, export options                         |
| **7. Lifecycle and release**       | Archive/restore, ownership transfer, departures, permanent deletion, recovery, accessibility and end-to-end verification       | Bucket lifecycle settings, transfer/leave/remove flows, account deletion, restoration review                             |

## Persistent design preferences

- Modern, sleek, minimalistic and premium, with a light feel in color, text density and usability.
- Retain the direction of the current colors; use subtle animations.
- Current implementation reference: src/app/globals.css uses light background #F6F7F2, foreground #172F28, muted text #53655D and accent #226950.
- Avoid text-heavy screens. Favor concise labels, whitespace, clear hierarchy and progressive disclosure.
- Apply accessibility from Phase 1; Phase 7 includes the final comprehensive accessibility and end-to-end verification, not its first implementation.

## Phase 1 design interpretation

Basic invitation creation/sharing belongs to Phase 1 so create/join works end to end. Full member and invitation management belongs to Phase 2. A welcome workspace and basic navigation belong to Phase 1; expense workflows and analytical dashboards remain in their later phases.
