export const notificationGroups = [
  {
    title: "Expenses",
    description: "New spending and changes in your buckets",
    triggers: ["expense.added", "expense.edited", "expense.deleted"],
  },
  {
    title: "Comments",
    description: "Conversations on shared expenses",
    triggers: ["comment.added"],
  },
  {
    title: "Members",
    description: "People joining, leaving, or changing ownership",
    triggers: [
      "membership.joined",
      "membership.left",
      "membership.removed",
      "bucket.ownership_transferred",
    ],
  },
  {
    title: "Budgets",
    description: "Selected spending thresholds",
    triggers: ["budget.threshold_reached"],
  },
  {
    title: "Scheduled & EMI",
    description: "Posting, conversion, reviews, and plan changes",
    triggers: [
      "scheduled.posted",
      "scheduled.conversion_needed",
      "scheduled.archive_review_required",
      "emi.plan_changed",
      "emi.installment_skipped",
      "emi.plan_ended",
    ],
  },
  {
    title: "Contacts",
    description: "Personal contact shares and changes",
    triggers: ["contact.shared", "contact.updated", "contact.share_revoked"],
  },
  {
    title: "Reminders",
    description: "Your personal expense-entry reminders",
    triggers: ["reminder.due"],
  },
] as const;

export const notificationTriggers = notificationGroups.flatMap((group) => group.triggers);
export type NotificationTrigger = (typeof notificationTriggers)[number];

export const triggerLabels: Record<NotificationTrigger, string> = {
  "expense.added": "New expense",
  "expense.edited": "Expense edited",
  "expense.deleted": "Expense deleted",
  "comment.added": "New comment",
  "membership.joined": "Member joined",
  "membership.left": "Member left",
  "membership.removed": "Member removed",
  "bucket.ownership_transferred": "Ownership transferred",
  "budget.threshold_reached": "Budget threshold reached",
  "scheduled.posted": "Scheduled expense posted",
  "scheduled.conversion_needed": "Conversion needed",
  "scheduled.archive_review_required": "Archive review needed",
  "emi.plan_changed": "EMI plan changed",
  "emi.installment_skipped": "Installment skipped",
  "emi.plan_ended": "EMI plan ended",
  "contact.shared": "Contact shared",
  "contact.updated": "Shared contact updated",
  "contact.share_revoked": "Contact access ended",
  "reminder.due": "Personal reminder",
};
