import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { ClientSession } from "mongoose";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import { BucketModel, MembershipModel, ReminderModel } from "@/lib/db/models";
import { activeUser, mutate } from "@/features/identity/service";
import { nextReminderDue, type ReminderSchedule } from "./reminder-dates";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const date = z.iso.date();
const frequency = z.enum(["daily", "weekly", "twice_weekly", "fortnightly", "monthly"]);
const reminderInput = z
  .object({
    bucketId: objectId.nullable().optional(),
    enabled: z.boolean().optional(),
    timezone: z.string().min(1).max(80).optional(),
    frequency: frequency.optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).max(2).optional(),
    anchorDate: date.optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
  })
  .strict();

function validateSchedule(input: ReminderSchedule): ReminderSchedule {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw new ApiError(422, "INVALID_TIMEZONE", "Choose a valid timezone.");
  }
  const weekdays = input.weekdays ?? [];
  if (
    (input.frequency === "weekly" && weekdays.length !== 1) ||
    (input.frequency === "twice_weekly" &&
      (weekdays.length !== 2 || weekdays[0] === weekdays[1])) ||
    (input.frequency === "fortnightly" && !input.anchorDate) ||
    (input.frequency === "monthly" && !input.dayOfMonth)
  )
    throw new ApiError(422, "INVALID_RECURRENCE", "Complete the selected reminder schedule.");
  if (input.anchorDate && !Number.isFinite(Date.parse(`${input.anchorDate}T00:00:00Z`)))
    throw new ApiError(422, "INVALID_RECURRENCE", "Choose a valid anchor date.");
  return {
    timezone: input.timezone,
    frequency: input.frequency,
    ...(input.frequency === "weekly" || input.frequency === "twice_weekly"
      ? { weekdays: [...weekdays].sort((a, b) => a - b) }
      : {}),
    ...(input.frequency === "fortnightly" ? { anchorDate: input.anchorDate } : {}),
    ...(input.frequency === "monthly" ? { dayOfMonth: input.dayOfMonth } : {}),
  };
}

function scheduleOf(reminder: InstanceType<typeof ReminderModel>): ReminderSchedule {
  return {
    timezone: reminder.timezone,
    frequency: reminder.frequency,
    weekdays: reminder.weekdays,
    anchorDate: reminder.anchorDate,
    dayOfMonth: reminder.dayOfMonth,
  };
}

function dto(reminder: InstanceType<typeof ReminderModel>) {
  return {
    id: String(reminder._id),
    bucketId: reminder.bucketId ? String(reminder.bucketId) : null,
    enabled: reminder.enabled,
    timezone: reminder.timezone,
    frequency: reminder.frequency,
    weekdays: reminder.weekdays ?? [],
    anchorDate: reminder.anchorDate ?? null,
    dayOfMonth: reminder.dayOfMonth ?? null,
    nextEligibleDate: reminder.enabled ? reminder.nextLocalDate : null,
    processingDescription:
      "Processed during the daily run; an exact delivery time is not promised.",
    revision: reminder.revision,
  };
}

async function reminderForUser(identity: DecodedIdToken, id: string, session?: ClientSession) {
  if (!objectId.safeParse(id).success)
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "This reminder is unavailable.");
  const user = await activeUser(identity, session);
  const reminder = await ReminderModel.findOne({
    _id: id,
    userId: user._id,
    deletedAt: null,
  }).session(session ?? null);
  if (!reminder) throw new ApiError(404, "RESOURCE_NOT_FOUND", "This reminder is unavailable.");
  return { user, reminder };
}

async function membershipFor(
  bucketId: string | null | undefined,
  userId: string,
  session?: ClientSession,
) {
  if (!bucketId) return null;
  const membership = await MembershipModel.findOne({
    bucketId,
    userId,
    state: "active",
  }).session(session ?? null);
  const bucket =
    membership &&
    (await BucketModel.findOne({ _id: bucketId, status: "active" }).session(session ?? null));
  if (!bucket) throw new ApiError(404, "RESOURCE_NOT_FOUND", "This bucket is unavailable.");
  return membership;
}

export async function listReminders(identity: DecodedIdToken) {
  const user = await activeUser(identity);
  const reminders = await ReminderModel.find({ userId: user._id, deletedAt: null }).sort({
    createdAt: -1,
    _id: -1,
  });
  return reminders.map(dto);
}

export async function createReminder(identity: DecodedIdToken, raw: unknown, key: string) {
  const input = reminderInput.parse(raw);
  const user = await activeUser(identity);
  const schedule = validateSchedule({
    timezone: input.timezone ?? user.timezone,
    frequency: input.frequency ?? "daily",
    weekdays: input.weekdays,
    anchorDate: input.anchorDate,
    dayOfMonth: input.dayOfMonth,
  });
  return mutate(
    identity,
    "me/reminders/create",
    key,
    input,
    async (session) => {
      const currentUser = await activeUser(identity, session);
      const membership = await membershipFor(input.bucketId, String(currentUser._id), session);
      const next = nextReminderDue(schedule, new Date());
      const [reminder] = await ReminderModel.create(
        [
          {
            userId: currentUser._id,
            bucketId: input.bucketId ?? undefined,
            membershipId: membership?._id,
            enabled: input.enabled ?? true,
            ...schedule,
            nextLocalDate: next.date,
            nextDueAt: next.dueAt,
          },
        ],
        { session },
      );
      return {
        resourceId: String(reminder._id),
        status: 201,
        data: dto(reminder),
        location: `/api/v1/me/reminders/${reminder._id}`,
      };
    },
    async (id, session) => dto((await reminderForUser(identity, id, session)).reminder),
  );
}

export async function changeReminder(
  identity: DecodedIdToken,
  id: string,
  action: "edit" | "delete",
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const input = action === "edit" ? reminderInput.parse(raw) : {};
  return mutate(
    identity,
    `me/reminders/${id}/${action}`,
    key,
    { input, revision },
    async (session) => {
      const { user, reminder } = await reminderForUser(identity, id, session);
      assertRevision(revision, reminder.revision);
      if (action === "delete") {
        await ReminderModel.updateOne(
          { _id: id, userId: user._id, revision: reminder.revision, deletedAt: null },
          { $set: { enabled: false, deletedAt: new Date() }, $inc: { revision: 1 } },
          { session },
        );
        return { resourceId: id, status: 204, data: null };
      }
      const edits = input as z.infer<typeof reminderInput>;
      const schedule = validateSchedule({ ...scheduleOf(reminder), ...edits });
      const nextBucketId = edits.bucketId === undefined ? reminder.bucketId : edits.bucketId;
      const membership =
        nextBucketId && String(nextBucketId) === String(reminder.bucketId)
          ? await MembershipModel.findOne({
              _id: reminder.membershipId,
              userId: user._id,
              state: "active",
            }).session(session)
          : await membershipFor(
              nextBucketId ? String(nextBucketId) : null,
              String(user._id),
              session,
            );
      if (nextBucketId && !membership)
        throw new ApiError(404, "RESOURCE_NOT_FOUND", "This bucket is unavailable.");
      const next = nextReminderDue(schedule, new Date());
      const obsoleteFields = Object.fromEntries(
        (["weekdays", "anchorDate", "dayOfMonth"] as const)
          .filter((field) => !(field in schedule))
          .map((field) => [field, ""]),
      );
      const updated = await ReminderModel.findOneAndUpdate(
        { _id: id, userId: user._id, revision: reminder.revision, deletedAt: null },
        {
          $set: {
            ...schedule,
            bucketId: nextBucketId ?? null,
            membershipId: membership?._id ?? null,
            enabled: edits.enabled ?? reminder.enabled,
            nextLocalDate: next.date,
            nextDueAt: next.dueAt,
          },
          $unset: obsoleteFields,
          $inc: { revision: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!updated)
        throw new ApiError(412, "REVISION_MISMATCH", "This reminder changed. Refresh and retry.");
      return { resourceId: id, status: 200, data: dto(updated) };
    },
    async (resourceId, session) =>
      action === "delete"
        ? null
        : dto((await reminderForUser(identity, resourceId, session)).reminder),
  );
}
