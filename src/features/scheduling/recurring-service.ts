import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  AuditModel,
  BucketModel,
  ExpenseModel,
  MembershipModel,
  RecurringPlanModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import {
  amountSchema,
  objectId,
  paymentModeSchema,
  type ExpenseInput,
} from "@/features/expenses/contracts";
import { conversionFor, validateReferences } from "@/features/expenses/service";
import { minorUnits } from "@/features/expenses/money";
import { currencies } from "@/features/identity/contracts";
import { captureBudgetUsage, reconcileBudgetThresholds } from "@/features/insights/budget-service";
import { recordDomainEvent } from "@/features/notifications/event-service";
import { dueInstant, localDate } from "./dates";
import { nextRecurringOccurrence, recurringDate, type RecurringFrequency } from "./recurring-dates";

const decimal = (value: string) => mongoose.Types.Decimal128.fromString(value);
const missing = () =>
  new ApiError(404, "RESOURCE_NOT_FOUND", "This recurring plan is unavailable.");
const planBase = z
  .object({
    title: z.string().trim().min(1).max(160),
    amount: amountSchema,
    currency: z.string().refine((value) => currencies.some((item) => item.code === value)),
    frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    startDate: z.iso.date(),
    endDate: z.iso.date().nullable().optional(),
    categoryId: objectId,
    accountId: objectId,
    platformId: objectId.optional(),
    paymentMode: paymentModeSchema,
    paidByUserId: objectId,
    recordingMode: z.enum(["confirm", "automatic"]).default("confirm"),
    reminderLeadDays: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7)]).default(1),
    reminderPurpose: z.enum(["funds", "pay", "add_expenses", "custom"]).default("funds"),
    reminderMessage: z.string().trim().max(240).default(""),
  })
  .strict();
const planInput = planBase
  .refine((value) => !value.endDate || value.endDate >= value.startDate, {
    path: ["endDate"],
    message: "End date must be after the first payment.",
  })
  .refine((value) => value.reminderPurpose !== "custom" || value.reminderMessage.length > 0, {
    path: ["reminderMessage"],
    message: "Enter a reminder message.",
  });
const planChanges = planBase
  .extend({ state: z.enum(["active", "paused", "ended"]) })
  .partial()
  .strict();
const recordInput = z.object({ paymentDate: z.iso.date().optional() }).strict();

function nextDate(plan: InstanceType<typeof RecurringPlanModel>) {
  return (
    nextRecurringOccurrence(
      plan.startDate,
      plan.frequency as RecurringFrequency,
      plan.nextIndex,
      plan.endDate,
      plan.skippedDates,
    )?.date ?? null
  );
}

function firstUpcomingIndex(startDate: string, frequency: RecurringFrequency, today: string) {
  let index = 0;
  while (recurringDate(startDate, frequency, index) < today && index < 5_000) index += 1;
  return index;
}

function dto(plan: InstanceType<typeof RecurringPlanModel>, viewerId: string) {
  return {
    id: String(plan._id),
    bucketId: String(plan.bucketId),
    title: plan.title,
    amount: plan.amount.toString(),
    currency: plan.currency,
    frequency: plan.frequency,
    startDate: plan.startDate,
    endDate: plan.endDate ?? null,
    nextDate: nextDate(plan),
    categoryId: String(plan.categoryId),
    accountId: String(plan.accountId),
    platformId: plan.platformId ? String(plan.platformId) : "",
    categoryName: plan.referenceLabels?.category ?? "Category",
    accountName: plan.referenceLabels?.account ?? "Account",
    paymentMode: plan.paymentMode,
    paidByUserId: String(plan.paidByUserId),
    recordingMode: plan.recordingMode,
    reminderLeadDays: plan.reminderLeadDays,
    reminderPurpose: plan.reminderPurpose,
    reminderMessage: plan.reminderMessage,
    state: plan.state,
    isCreator: String(plan.actualCreatorUserId) === viewerId,
    revision: plan.revision,
  };
}

export async function listRecurringPlans(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const plans = await RecurringPlanModel.find({ bucketId }).sort({ createdAt: -1 }).limit(100);
  return plans.map((plan) => dto(plan, String(user._id)));
}

export async function createRecurringPlan(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
) {
  const input = planInput.parse(raw);
  if (minorUnits(input.amount, input.currency) <= 0n)
    throw new ApiError(422, "INVALID_AMOUNT", "Enter a positive amount.");
  return mutate(
    identity,
    `recurring:${bucketId}:create`,
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true);
      const firstIndex = firstUpcomingIndex(
        input.startDate,
        input.frequency,
        localDate(new Date(), bucket.timezone),
      );
      if (
        input.endDate &&
        recurringDate(input.startDate, input.frequency, firstIndex) > input.endDate
      )
        throw new ApiError(
          422,
          "NO_FUTURE_OCCURRENCE",
          "Choose an end date with at least one upcoming payment.",
        );
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: user._id,
        state: "active",
      }).session(session);
      if (!membership) throw missing();
      const references = await validateReferences(
        {
          ...input,
          expenseDate: input.startDate,
          description: input.title,
          originalAmount: input.amount,
          originalCurrency: input.currency,
          notes: "",
        },
        bucketId,
        session,
      );
      const [plan] = await RecurringPlanModel.create(
        [
          {
            ...input,
            endDate: input.endDate ?? undefined,
            bucketId,
            actualCreatorUserId: user._id,
            creatorMembershipId: membership._id,
            nextIndex: firstIndex,
            amount: decimal(input.amount),
            categoryId: references.category._id,
            accountId: references.account._id,
            platformId: references.platform?._id,
            referenceLabels: {
              category: references.category.name,
              account: references.account.name,
              platform: references.platform?.name ?? "Other",
            },
          },
        ],
        { session },
      );
      return { resourceId: String(plan._id), status: 201, data: dto(plan, String(user._id)) };
    },
    async (id, session) => {
      const user = await activeUser(identity, session);
      const plan = await RecurringPlanModel.findOne({ _id: id, bucketId }).session(session);
      if (!plan) throw missing();
      return dto(plan, String(user._id));
    },
  );
}

export async function changeRecurringPlan(
  identity: DecodedIdToken,
  bucketId: string,
  planId: string,
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const changes = planChanges.parse(raw);
  if (!Object.keys(changes).length) throw new ApiError(422, "EMPTY_CHANGES", "Choose a change.");
  return mutate(
    identity,
    `recurring:${bucketId}:${planId}:edit`,
    key,
    { changes, revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true);
      const plan = await RecurringPlanModel.findOne({
        _id: planId,
        bucketId,
        actualCreatorUserId: user._id,
      }).session(session);
      if (!plan) throw missing();
      assertRevision(revision, plan.revision);
      if (plan.state === "ended")
        throw new ApiError(409, "PLAN_ENDED", "An ended plan cannot be edited.");
      const membership = await MembershipModel.exists({
        _id: plan.creatorMembershipId,
        userId: user._id,
        bucketId,
        state: "active",
      }).session(session);
      if (!membership) throw missing();
      const merged = { ...plan.toObject(), ...changes };
      if (merged.endDate && merged.endDate < merged.startDate)
        throw new ApiError(422, "INVALID_END_DATE", "End date must be after the first payment.");
      if (
        (changes.amount || changes.currency) &&
        minorUnits(changes.amount ?? plan.amount.toString(), merged.currency) <= 0n
      )
        throw new ApiError(422, "INVALID_AMOUNT", "Enter a positive amount.");
      if (merged.reminderPurpose === "custom" && !merged.reminderMessage)
        throw new ApiError(422, "REMINDER_MESSAGE_REQUIRED", "Enter a custom reminder message.");
      const scheduleChanged =
        (changes.startDate && changes.startDate !== plan.startDate) ||
        (changes.frequency && changes.frequency !== plan.frequency);
      if (scheduleChanged) {
        const latestRecorded = await ExpenseModel.findOne({ "source.recurringPlanId": plan._id })
          .sort({ createdAt: -1 })
          .session(session);
        if (latestRecorded)
          throw new ApiError(
            409,
            "SCHEDULE_LOCKED",
            "Pause this plan and create a new schedule after payments have been recorded.",
          );
      }
      const referenceChanged = ["categoryId", "accountId", "platformId", "paidByUserId"].some(
        (field) => field in changes,
      );
      const references = referenceChanged
        ? await validateReferences(
            {
              expenseDate: merged.startDate,
              description: merged.title,
              originalAmount: changes.amount ?? plan.amount.toString(),
              originalCurrency: merged.currency,
              paidByUserId: String(merged.paidByUserId),
              categoryId: String(merged.categoryId),
              accountId: String(merged.accountId),
              platformId: merged.platformId ? String(merged.platformId) : undefined,
              paymentMode: merged.paymentMode,
              notes: "",
            } as ExpenseInput,
            bucketId,
            session,
            { categoryId: plan.categoryId, accountId: plan.accountId, platformId: plan.platformId },
          )
        : null;
      plan.set({
        ...changes,
        ...(changes.amount ? { amount: decimal(changes.amount) } : {}),
        ...(changes.endDate === null ? { endDate: undefined } : {}),
        ...(references
          ? {
              referenceLabels: {
                category: references.category.name,
                account: references.account.name,
                platform: references.platform?.name ?? "Other",
              },
            }
          : {}),
        ...(scheduleChanged
          ? {
              skippedDates: [],
              nextIndex: firstUpcomingIndex(
                merged.startDate,
                merged.frequency,
                localDate(new Date(), bucket.timezone),
              ),
            }
          : {}),
      });
      if (
        changes.state === "active" &&
        plan.state === "active" &&
        plan.recordingMode === "automatic" &&
        !scheduleChanged
      ) {
        const today = localDate(new Date(), bucket.timezone);
        while (nextDate(plan) && nextDate(plan)! < today && plan.nextIndex < 5_000)
          plan.nextIndex += 1;
      }
      if (!nextDate(plan)) plan.state = "ended";
      plan.revision += 1;
      await plan.save({ session });
      return { resourceId: planId, status: 200, data: dto(plan, String(user._id)) };
    },
    async (id, session) => {
      const user = await activeUser(identity, session);
      const plan = await RecurringPlanModel.findOne({ _id: id, bucketId }).session(session);
      if (!plan) throw missing();
      return dto(plan, String(user._id));
    },
  );
}

export async function skipRecurringPayment(
  identity: DecodedIdToken,
  bucketId: string,
  planId: string,
  dueDate: string,
  key: string,
  revision: string | null,
) {
  return mutate(
    identity,
    `recurring:${bucketId}:${planId}:${dueDate}:skip`,
    key,
    { dueDate, revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true);
      const plan = await RecurringPlanModel.findOne({
        _id: planId,
        bucketId,
        actualCreatorUserId: user._id,
      }).session(session);
      if (!plan) throw missing();
      assertRevision(revision, plan.revision);
      if (plan.state !== "active")
        throw new ApiError(409, "PLAN_NOT_ACTIVE", "Only active plans have payments to skip.");
      const today = localDate(new Date(), bucket.timezone);
      if (dueDate <= today)
        throw new ApiError(409, "PAYMENT_NOT_FUTURE", "Only future payments can be skipped.");
      let scheduled = false;
      for (let index = plan.nextIndex; index < plan.nextIndex + 5_000; index++) {
        const date = recurringDate(plan.startDate, plan.frequency as RecurringFrequency, index);
        if (date >= dueDate) {
          scheduled = date === dueDate;
          break;
        }
      }
      if (
        !scheduled ||
        (plan.endDate && dueDate > plan.endDate) ||
        plan.skippedDates.includes(dueDate)
      )
        throw new ApiError(409, "PAYMENT_UNAVAILABLE", "This payment is no longer scheduled.");
      plan.skippedDates.push(dueDate);
      plan.revision += 1;
      if (!nextDate(plan)) plan.state = "ended";
      await plan.save({ session });
      return { resourceId: planId, status: 200, data: dto(plan, String(user._id)) };
    },
    async (id, session) => {
      const user = await activeUser(identity, session);
      const plan = await RecurringPlanModel.findOne({ _id: id, bucketId }).session(session);
      if (!plan) throw missing();
      return dto(plan, String(user._id));
    },
  );
}

async function recordOccurrence(
  planId: string,
  paymentDate: string | undefined,
  key: string,
  expectedRevision?: number,
  existingSession?: ClientSession,
) {
  const candidate = await RecurringPlanModel.findById(planId);
  if (!candidate) throw missing();
  const dueDate = nextDate(candidate);
  if (!dueDate) throw new ApiError(409, "PLAN_COMPLETE", "No more payments are scheduled.");
  const bucket = await BucketModel.findById(candidate.bucketId);
  if (!bucket || bucket.status !== "active") throw missing();
  const today = localDate(new Date(), bucket.timezone);
  if (dueDate > today) throw new ApiError(409, "NOT_DUE", "This payment is not due yet.");
  const expenseDate = paymentDate ?? dueDate;
  if (expenseDate > today)
    throw new ApiError(422, "FUTURE_PAYMENT", "Choose today or a past payment date.");
  const conversion = await conversionFor(
    {
      expenseDate,
      originalAmount: candidate.amount.toString(),
      originalCurrency: candidate.currency,
    },
    bucket.primaryCurrency,
    bucket.timezone,
  );
  let recorded: { id: string; dueDate: string; expenseDate: string; status: string } | null = null;
  const perform = async (session: ClientSession) => {
    const plan = await RecurringPlanModel.findOne({
      _id: planId,
      nextIndex: candidate.nextIndex,
      state: "active",
      ...(expectedRevision ? { revision: expectedRevision } : {}),
    }).session(session);
    if (!plan || nextDate(plan) !== dueDate)
      throw new ApiError(412, "PLAN_CHANGED", "This plan changed. Refresh and try again.");
    const activeBucket = await BucketModel.findOne({
      _id: plan.bucketId,
      status: "active",
    }).session(session);
    const membership = await MembershipModel.exists({
      _id: plan.creatorMembershipId,
      userId: plan.actualCreatorUserId,
      bucketId: plan.bucketId,
      state: "active",
    }).session(session);
    if (!activeBucket || !membership) throw missing();
    const before = await captureBudgetUsage(String(plan.bucketId), [expenseDate], session);
    const posted = conversion.status !== "missing";
    const [expense] = await ExpenseModel.create(
      [
        {
          bucketId: plan.bucketId,
          actualCreatorUserId: plan.actualCreatorUserId,
          creatorMembershipId: plan.creatorMembershipId,
          addedByUserId: plan.actualCreatorUserId,
          paidByUserId: plan.paidByUserId,
          expenseDate,
          description: plan.title,
          notes: "",
          categoryId: plan.categoryId,
          accountId: plan.accountId,
          platformId: plan.platformId,
          referenceLabels: plan.referenceLabels,
          paymentMode: plan.paymentMode,
          originalAmount: plan.amount,
          originalCurrency: plan.currency,
          bucketCurrency: activeBucket.primaryCurrency,
          conversion,
          postingState: posted ? "posted" : "unposted",
          postedAt: posted ? new Date() : null,
          scheduleTimezone: activeBucket.timezone,
          dueAt: dueInstant(expenseDate, activeBucket.timezone),
          source: { kind: "recurring", recurringPlanId: plan._id, recurringDueDate: dueDate },
          originKey: `recurring:${plan._id}:${dueDate}`,
        },
      ],
      { session },
    );
    const occurrence = nextRecurringOccurrence(
      plan.startDate,
      plan.frequency as RecurringFrequency,
      plan.nextIndex,
      plan.endDate,
      plan.skippedDates,
    );
    plan.nextIndex = (occurrence?.index ?? plan.nextIndex) + 1;
    plan.revision += 1;
    if (!nextDate(plan)) plan.state = "ended";
    await plan.save({ session });
    await BucketModel.updateOne(
      { _id: plan.bucketId },
      {
        $set: { currencyLockedAt: activeBucket.currencyLockedAt ?? new Date() },
        $inc: { financialRevision: 1, exportRevision: 1 },
      },
      { session },
    );
    await reconcileBudgetThresholds(String(plan.bucketId), [expenseDate], before, session);
    await AuditModel.create(
      [
        {
          bucketId: plan.bucketId,
          actorUserId: plan.actualCreatorUserId,
          action: "expense.created",
          entityId: expense._id,
          operationKey: key,
        },
      ],
      { session },
    );
    await recordDomainEvent(session, {
      eventKey: `expense.added:${key}`,
      type: "expense.added",
      actorUserId: plan.actualCreatorUserId,
      bucketId: plan.bucketId,
      entityType: "expense",
      entityId: expense._id,
    });
    recorded = {
      id: String(expense._id),
      dueDate,
      expenseDate,
      status: posted ? "recorded" : "conversion_needed",
    };
  };
  if (existingSession) await perform(existingSession);
  else await mongoose.connection.transaction(perform);
  return recorded!;
}

export async function confirmRecurringPayment(
  identity: DecodedIdToken,
  bucketId: string,
  planId: string,
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const input = recordInput.parse(raw);
  return mutate(
    identity,
    `recurring:${bucketId}:${planId}:confirm`,
    key,
    { input, revision },
    async (session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session, true);
      const plan = await RecurringPlanModel.findOne({
        _id: planId,
        bucketId,
        actualCreatorUserId: user._id,
      }).session(session);
      if (!plan) throw missing();
      assertRevision(revision, plan.revision);
      if (plan.recordingMode !== "confirm")
        throw new ApiError(409, "AUTOMATIC_PLAN", "This payment is recorded automatically.");
      const recorded = await recordOccurrence(
        planId,
        input.paymentDate,
        key,
        plan.revision,
        session,
      );
      return { resourceId: recorded.id, status: 201, data: recorded };
    },
    async (id, session) => {
      const expense = await ExpenseModel.findOne({
        _id: id,
        bucketId,
        "source.recurringPlanId": planId,
      }).session(session);
      if (!expense) throw missing();
      return {
        id,
        dueDate: expense.source.recurringDueDate,
        expenseDate: expense.expenseDate,
        status: expense.conversion.status === "missing" ? "conversion_needed" : "recorded",
      };
    },
  );
}

export async function processAutomaticRecurring(limit = 20, deadline = Date.now() + 5_000) {
  const plans = RecurringPlanModel.find({ state: "active", recordingMode: "automatic" })
    .sort({ createdAt: 1 })
    .cursor();
  let recorded = 0;
  let hasMore = false;
  for await (const plan of plans) {
    if (recorded >= limit || Date.now() >= deadline) {
      hasMore = true;
      break;
    }
    const bucket = await BucketModel.findOne({ _id: plan.bucketId, status: "active" });
    if (!bucket || !nextDate(plan) || nextDate(plan)! > localDate(new Date(), bucket.timezone))
      continue;
    try {
      await recordOccurrence(
        String(plan._id),
        undefined,
        `recurring:auto:${plan._id}:${nextDate(plan)}`,
        plan.revision,
      );
      recorded += 1;
    } catch (error) {
      if (!(error instanceof ApiError && [404, 409, 412].includes(error.status))) throw error;
    }
  }
  return { recorded, hasMore };
}
