import "server-only";
import {
  BucketModel,
  DomainEventModel,
  MembershipModel,
  RecurringPlanModel,
  UserModel,
} from "@/lib/db/models";
import { localDate } from "@/features/scheduling/dates";
import {
  daysBefore,
  recurringDate,
  type RecurringFrequency,
} from "@/features/scheduling/recurring-dates";

/** Remind only for today's upcoming occurrence; retries cannot create duplicates. */
export async function processRecurringReminders(limit = 1_000, deadline = Date.now() + 5_000) {
  const plans = RecurringPlanModel.find({ state: "active" }).sort({ createdAt: 1 }).cursor();
  let emitted = 0;
  let hasMore = false;
  for await (const plan of plans) {
    if (emitted >= limit || Date.now() >= deadline) {
      hasMore = true;
      break;
    }
    const [bucket, user, membership] = await Promise.all([
      BucketModel.findOne({ _id: plan.bucketId, status: "active" }),
      UserModel.exists({ _id: plan.actualCreatorUserId, status: "active" }),
      MembershipModel.exists({ _id: plan.creatorMembershipId, state: "active" }),
    ]);
    if (!bucket || !user || !membership) continue;
    const due = recurringDate(plan.startDate, plan.frequency as RecurringFrequency, plan.nextIndex);
    if (plan.endDate && due > plan.endDate) continue;
    const reminderDate = daysBefore(due, plan.reminderLeadDays ?? 1);
    if (reminderDate !== localDate(new Date(), bucket.timezone)) continue;
    const dueLabel = new Intl.DateTimeFormat("en-IN", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(`${due}T00:00:00Z`));
    const fallback =
      plan.reminderPurpose === "pay"
        ? `Pay ${plan.title} on ${dueLabel}.`
        : plan.reminderPurpose === "add_expenses"
          ? `Add your ${plan.title} payment to Buckit.`
          : `Check that ${plan.referenceLabels?.account ?? "your account"} has enough money for ${plan.title} on ${dueLabel}.`;
    const result = await DomainEventModel.updateOne(
      { eventKey: `reminder:recurring:${plan._id}:${due}:${plan.reminderLeadDays}` },
      {
        $setOnInsert: {
          eventKey: `reminder:recurring:${plan._id}:${due}:${plan.reminderLeadDays}`,
          type: "reminder.due",
          bucketId: plan.bucketId,
          entityType: "recurringPlan",
          entityId: plan._id,
          occurredAt: new Date(),
          context: {
            recipientUserId: String(plan.actualCreatorUserId),
            message: plan.reminderMessage || fallback,
          },
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount) emitted += 1;
  }
  return { emitted, hasMore };
}
