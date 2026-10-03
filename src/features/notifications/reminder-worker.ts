import "server-only";
import mongoose from "mongoose";
import {
  BucketModel,
  DomainEventModel,
  MembershipModel,
  ReminderModel,
  UserModel,
} from "@/lib/db/models";
import { localDate } from "@/features/scheduling/dates";
import { nextReminderDue } from "./reminder-dates";

/** Processes one due occurrence per reminder and skips missed dates without a burst. */
export async function processDueReminders(limit = 30) {
  const now = new Date();
  const due = await ReminderModel.find({ enabled: true, deletedAt: null, nextDueAt: { $lte: now } })
    .sort({ nextDueAt: 1, _id: 1 })
    .limit(limit);
  let emitted = 0;
  for (const item of due) {
    await mongoose.connection.transaction(async (session) => {
      const reminder = await ReminderModel.findOne({
        _id: item._id,
        enabled: true,
        deletedAt: null,
        nextDueAt: { $lte: now },
      }).session(session);
      if (!reminder) return;
      const today = localDate(now, reminder.timezone);
      const next = nextReminderDue(
        {
          timezone: reminder.timezone,
          frequency: reminder.frequency,
          weekdays: reminder.weekdays,
          anchorDate: reminder.anchorDate,
          dayOfMonth: reminder.dayOfMonth,
        },
        now,
        true,
      );
      const user = await UserModel.exists({ _id: reminder.userId, status: "active" }).session(
        session,
      );
      const bucketActive =
        !reminder.bucketId ||
        (await BucketModel.exists({ _id: reminder.bucketId, status: "active" }).session(session));
      const membershipActive =
        !reminder.bucketId ||
        (await MembershipModel.exists({
          _id: reminder.membershipId,
          bucketId: reminder.bucketId,
          userId: reminder.userId,
          state: "active",
        }).session(session));
      const emit = Boolean(
        user && bucketActive && membershipActive && reminder.nextLocalDate === today,
      );
      const occurrenceKey = `reminder:${reminder._id}:${reminder.nextLocalDate}`;
      if (emit)
        await DomainEventModel.updateOne(
          { eventKey: occurrenceKey },
          {
            $setOnInsert: {
              eventKey: occurrenceKey,
              type: "reminder.due",
              bucketId: reminder.bucketId,
              entityType: "reminder",
              entityId: reminder._id,
              occurredAt: now,
              context: { recipientUserId: String(reminder.userId) },
            },
          },
          { session, upsert: true },
        );
      const changed = await ReminderModel.updateOne(
        { _id: reminder._id, revision: reminder.revision, nextLocalDate: reminder.nextLocalDate },
        {
          $set: {
            nextLocalDate: next.date,
            nextDueAt: next.dueAt,
            ...(emit ? { lastEmittedOccurrenceKey: occurrenceKey } : {}),
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      if (!changed.matchedCount) throw new Error("Reminder changed during daily processing.");
      if (emit) emitted += 1;
    });
  }
  return { checked: due.length, emitted, hasMore: due.length === limit };
}
