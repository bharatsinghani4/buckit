import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose from "mongoose";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  AuditModel,
  BucketModel,
  EmiInstallmentModel,
  EmiPlanModel,
  ExpenseModel,
  MembershipModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { conversionFor, validateReferences } from "@/features/expenses/service";
import { minorUnits } from "@/features/expenses/money";
import { z } from "zod";
import { captureBudgetUsage, reconcileBudgetThresholds } from "@/features/insights/budget-service";
import { dueInstant, installmentDate, localDate } from "./dates";
import { planEditInput, planInput, type PlanInput } from "./contracts";

const decimal = (value: string) => mongoose.Types.Decimal128.fromString(value);
const unavailable = () =>
  new ApiError(404, "RESOURCE_NOT_FOUND", "This EMI plan is not available.");

async function planDto(plan: InstanceType<typeof EmiPlanModel>, viewerId: string) {
  const [creator, counts, next, viewerMembership] = await Promise.all([
    UserModel.findById(plan.actualCreatorUserId),
    EmiInstallmentModel.aggregate([
      { $match: { planId: plan._id } },
      { $group: { _id: "$state", count: { $sum: 1 } } },
    ]),
    EmiInstallmentModel.findOne({ planId: plan._id, state: "scheduled" }).sort({
      scheduledDate: 1,
    }),
    MembershipModel.exists({
      _id: plan.creatorMembershipId,
      bucketId: plan.bucketId,
      userId: viewerId,
      state: "active",
    }),
  ]);
  const count = (state: string) => counts.find((row) => row._id === state)?.count ?? 0;
  return {
    id: String(plan._id),
    bucketId: String(plan.bucketId),
    title: plan.title,
    installmentAmount: plan.installmentAmount.toString(),
    currency: plan.currency,
    totalInstallments: plan.totalInstallments,
    previouslyPaidCount: plan.previouslyPaidCount,
    firstInstallmentDate: plan.firstInstallmentDate,
    generatedThroughNumber: plan.generatedThroughNumber,
    state: plan.state,
    revision: plan.revision,
    creatorName: creator?.displayName ?? "Former member",
    isCreator: String(plan.actualCreatorUserId) === viewerId && Boolean(viewerMembership),
    categoryId: String(plan.categoryId),
    accountId: String(plan.accountId),
    platformId: String(plan.platformId),
    categoryName: plan.referenceLabels?.category ?? "Category",
    accountName: plan.referenceLabels?.account ?? "Account",
    platformName: plan.referenceLabels?.platform ?? "Other",
    paymentMode: plan.paymentMode,
    paidByUserId: String(plan.paidByUserId),
    recordedCount: count("recorded") + plan.previouslyPaidCount,
    upcomingCount:
      count("scheduled") + Math.max(0, plan.totalInstallments - plan.generatedThroughNumber),
    unpaidCount: count("unpaid") + count("skipped"),
    nextDate:
      next?.scheduledDate ??
      (plan.generatedThroughNumber < plan.totalInstallments
        ? installmentDate(plan.firstInstallmentDate, plan.generatedThroughNumber + 1)
        : null),
  };
}

export async function listPlans(identity: DecodedIdToken, bucketId: string, state: string | null) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const plans = await EmiPlanModel.find({
    bucketId,
    ...(state && state !== "all" ? { state } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(100);
  return Promise.all(plans.map((plan) => planDto(plan, String(user._id))));
}

export async function getPlan(identity: DecodedIdToken, bucketId: string, planId: string) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const plan = await EmiPlanModel.findOne({ _id: planId, bucketId });
  if (!plan) throw unavailable();
  return planDto(plan, String(user._id));
}

export async function listInstallments(identity: DecodedIdToken, bucketId: string, planId: string) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  if (!(await EmiPlanModel.exists({ _id: planId, bucketId }))) throw unavailable();
  const entries = await EmiInstallmentModel.find({ planId, bucketId })
    .sort({ installmentNumber: 1 })
    .limit(120);
  const expenses = await ExpenseModel.find({
    _id: { $in: entries.map((entry) => entry.expenseId).filter(Boolean) },
  });
  const byId = new Map(expenses.map((expense) => [String(expense._id), expense]));
  return entries.map((entry) => ({
    id: String(entry._id),
    number: entry.installmentNumber,
    scheduledDate: entry.scheduledDate,
    originalScheduledDate: entry.originalScheduledDate,
    amount: entry.amount.toString(),
    currency: entry.currency,
    state: entry.state,
    expenseId: entry.expenseId ? String(entry.expenseId) : null,
    expenseRevision: entry.expenseId ? (byId.get(String(entry.expenseId))?.revision ?? null) : null,
    revision: entry.revision,
  }));
}

export function previewDates(input: PlanInput) {
  return Array.from(
    { length: input.totalInstallments - input.previouslyPaidCount },
    (_, index) => ({
      number: input.previouslyPaidCount + index + 1,
      date: installmentDate(input.firstInstallmentDate, input.previouslyPaidCount + index + 1),
    }),
  );
}

export async function previewPlan(identity: DecodedIdToken, bucketId: string, raw: unknown) {
  const input = planInput.parse(raw);
  minorUnits(input.installmentAmount, input.currency);
  if (Number(input.installmentAmount) <= 0)
    throw new ApiError(422, "INVALID_AMOUNT", "Enter a positive installment amount.");
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  return {
    dates: previewDates(input),
    remainingCount: input.totalInstallments - input.previouslyPaidCount,
  };
}

/** Generate a bounded, restartable slice. The plan checkpoint and unique keys prevent duplicates. */
export async function generateInstallments(planId: string, batchSize = 12) {
  const plan = await EmiPlanModel.findById(planId);
  if (!plan || plan.state !== "active" || plan.generatedThroughNumber >= plan.totalInstallments)
    return 0;
  const bucket = await BucketModel.findOne({ _id: plan.bucketId, status: "active" });
  const membership = await MembershipModel.exists({
    _id: plan.creatorMembershipId,
    state: "active",
  });
  if (!bucket || !membership) return 0;
  const start = Math.max(plan.previouslyPaidCount, plan.generatedThroughNumber) + 1;
  const end = Math.min(plan.totalInstallments, start + batchSize - 1);
  const prepared = await Promise.all(
    Array.from({ length: end - start + 1 }, async (_, index) => {
      const number = start + index;
      const date = installmentDate(plan.firstInstallmentDate, number);
      return {
        number,
        date,
        conversion: await conversionFor(
          {
            expenseDate: date,
            originalAmount: plan.installmentAmount.toString(),
            originalCurrency: plan.currency,
          },
          bucket.primaryCurrency,
          bucket.timezone,
        ),
      };
    }),
  );
  return mongoose.connection.transaction(async (session) => {
    const current = await EmiPlanModel.findOne({
      _id: planId,
      state: "active",
      generatedThroughNumber: plan.generatedThroughNumber,
    }).session(session);
    if (!current) return 0;
    const currentMembership = await MembershipModel.exists({
      _id: current.creatorMembershipId,
      state: "active",
    }).session(session);
    if (!currentMembership) return 0;
    const generationGuard = await BucketModel.updateOne(
      { _id: bucket._id, status: "active" },
      { $inc: { writeRevision: 1 } },
      { session },
    );
    if (!generationGuard.matchedCount) return 0;
    for (const item of prepared) {
      const [installment] = await EmiInstallmentModel.create(
        [
          {
            bucketId: bucket._id,
            planId: current._id,
            installmentNumber: item.number,
            actualCreatorUserId: current.actualCreatorUserId,
            creatorMembershipId: current.creatorMembershipId,
            scheduledDate: item.date,
            originalScheduledDate: item.date,
            amount: current.installmentAmount,
            currency: current.currency,
            generationVersion: current.generationVersion,
          },
        ],
        { session },
      );
      const [expense] = await ExpenseModel.create(
        [
          {
            bucketId: bucket._id,
            actualCreatorUserId: current.actualCreatorUserId,
            creatorMembershipId: current.creatorMembershipId,
            paidByUserId: current.paidByUserId,
            addedByUserId: current.actualCreatorUserId,
            expenseDate: item.date,
            description: current.title,
            notes: `EMI installment ${item.number} of ${current.totalInstallments}`,
            categoryId: current.categoryId,
            accountId: current.accountId,
            platformId: current.platformId,
            referenceLabels: current.referenceLabels,
            paymentMode: current.paymentMode,
            originalAmount: current.installmentAmount,
            originalCurrency: current.currency,
            bucketCurrency: bucket.primaryCurrency,
            conversion: item.conversion,
            postingState: "unposted",
            dueAt: dueInstant(item.date, bucket.timezone),
            scheduleTimezone: bucket.timezone,
            source: { kind: "emi", emiPlanId: current._id, emiInstallmentId: installment._id },
            originKey: `emi:${current._id}:${item.number}`,
          },
        ],
        { session },
      );
      installment.expenseId = expense._id;
      await installment.save({ session });
    }
    current.generatedThroughNumber = end;
    current.revision += 1;
    await current.save({ session });
    await BucketModel.updateOne({ _id: bucket._id }, { $inc: { exportRevision: 1 } }, { session });
    return prepared.length;
  });
}

export async function createPlan(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
) {
  const input = planInput.parse(raw);
  minorUnits(input.installmentAmount, input.currency);
  if (Number(input.installmentAmount) <= 0)
    throw new ApiError(422, "INVALID_AMOUNT", "Enter a positive installment amount.");
  const result = await mutate(
    identity,
    `emi:${bucketId}:create`,
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session, true);
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: user._id,
        state: "active",
      }).session(session);
      if (!membership) throw unavailable();
      const refs = await validateReferences(
        {
          ...input,
          expenseDate: input.firstInstallmentDate,
          description: input.title,
          notes: "",
          originalAmount: input.installmentAmount,
          originalCurrency: input.currency,
        },
        bucketId,
        session,
      );
      const [plan] = await EmiPlanModel.create(
        [
          {
            ...input,
            bucketId,
            actualCreatorUserId: user._id,
            creatorMembershipId: membership._id,
            installmentAmount: decimal(input.installmentAmount),
            anchorDay: Number(input.firstInstallmentDate.slice(-2)),
            categoryId: refs.category._id,
            accountId: refs.account._id,
            platformId: refs.platform?._id,
            referenceLabels: {
              category: refs.category.name,
              account: refs.account.name,
              platform: refs.platform?.name ?? "Other",
            },
            generatedThroughNumber: input.previouslyPaidCount,
          },
        ],
        { session },
      );
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: "emi.plan_created",
            entityId: plan._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return { resourceId: String(plan._id), status: 201, data: { id: String(plan._id) } };
    },
    async (id) => ({ id }),
  );
  await generateInstallments(result.resourceId);
  return { ...result, data: await getPlan(identity, bucketId, result.resourceId) };
}

export async function changePlan(
  identity: DecodedIdToken,
  bucketId: string,
  planId: string,
  action: "edit" | "end",
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const edits = action === "edit" ? planEditInput.parse(raw) : {};
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const creatorMembership = await MembershipModel.findOne({
    bucketId,
    userId: user._id,
    state: "active",
  });
  if (action === "edit" && "installmentAmount" in edits && edits.installmentAmount) {
    minorUnits(edits.installmentAmount, edits.currency ?? bucket.primaryCurrency);
    if (Number(edits.installmentAmount) <= 0)
      throw new ApiError(422, "INVALID_AMOUNT", "Enter a positive installment amount.");
  }
  if (
    action === "edit" &&
    "currency" in edits &&
    edits.currency &&
    !("installmentAmount" in edits)
  ) {
    const current = await EmiPlanModel.findOne({
      _id: planId,
      bucketId,
      actualCreatorUserId: user._id,
      creatorMembershipId: creatorMembership?._id,
    });
    if (!current) throw unavailable();
    minorUnits(current.installmentAmount.toString(), edits.currency);
  }
  const preparedConversions = new Map<
    string,
    { revision: number; conversion: Awaited<ReturnType<typeof conversionFor>> }
  >();
  if (action === "edit" && ("installmentAmount" in edits || "currency" in edits)) {
    const current = await EmiPlanModel.findOne({
      _id: planId,
      bucketId,
      actualCreatorUserId: user._id,
      creatorMembershipId: creatorMembership?._id,
      state: "active",
    });
    if (!current) throw unavailable();
    assertRevision(revision, current.revision);
    const pending = await EmiInstallmentModel.find({ planId, state: "scheduled" });
    const expenses = await ExpenseModel.find({
      _id: { $in: pending.map((item) => item.expenseId) },
      postingState: "unposted",
      deletedAt: null,
    });
    for (const expense of expenses) {
      const conversion = await conversionFor(
        {
          expenseDate: expense.expenseDate,
          originalAmount: edits.installmentAmount ?? current.installmentAmount.toString(),
          originalCurrency: edits.currency ?? current.currency,
        },
        bucket.primaryCurrency,
        bucket.timezone,
      );
      preparedConversions.set(String(expense._id), { revision: expense.revision, conversion });
    }
  }
  const result = await mutate(
    identity,
    `emi:${bucketId}:${planId}:${action}`,
    key,
    { edits, revision },
    async (session) => {
      const actor = await activeUser(identity, session);
      await bucketForUser(bucketId, actor, session, true);
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: actor._id,
        state: "active",
      }).session(session);
      const plan = await EmiPlanModel.findOne({
        _id: planId,
        bucketId,
        actualCreatorUserId: actor._id,
        creatorMembershipId: membership?._id,
        state: "active",
      }).session(session);
      if (!plan) throw unavailable();
      assertRevision(revision, plan.revision);
      if (action === "edit") {
        const merged = {
          ...edits,
          categoryId: edits.categoryId ?? String(plan.categoryId),
          accountId: edits.accountId ?? String(plan.accountId),
          platformId: edits.platformId ?? String(plan.platformId),
          paidByUserId: edits.paidByUserId ?? String(plan.paidByUserId),
          paymentMode: edits.paymentMode ?? plan.paymentMode,
          originalAmount: edits.installmentAmount ?? plan.installmentAmount.toString(),
          originalCurrency: edits.currency ?? plan.currency,
          expenseDate: plan.firstInstallmentDate,
          description: edits.title ?? plan.title,
          notes: "",
        };
        const refs = await validateReferences(merged, bucketId, session, plan);
        Object.assign(plan, edits, {
          installmentAmount: decimal(merged.originalAmount),
          currency: merged.originalCurrency,
          categoryId: refs.category._id,
          accountId: refs.account._id,
          platformId: refs.platform?._id,
          referenceLabels: {
            category: refs.category.name,
            account: refs.account.name,
            platform: refs.platform?.name ?? "Other",
          },
        });
      } else {
        plan.state = "ended";
        plan.endedAt = new Date();
      }
      plan.generationVersion += 1;
      plan.revision += 1;
      await plan.save({ session });
      const future = await EmiInstallmentModel.find({ planId, state: "scheduled" }).session(
        session,
      );
      for (const installment of future) {
        const expense = await ExpenseModel.findById(installment.expenseId).session(session);
        if (!expense || expense.postingState !== "unposted" || expense.deletedAt) continue;
        if (action === "end") {
          installment.state = "canceled";
          expense.postingState = "canceled";
        } else {
          installment.amount = plan.installmentAmount;
          installment.currency = plan.currency;
          Object.assign(expense, {
            description: plan.title,
            originalAmount: plan.installmentAmount,
            originalCurrency: plan.currency,
            paidByUserId: plan.paidByUserId,
            categoryId: plan.categoryId,
            accountId: plan.accountId,
            platformId: plan.platformId,
            referenceLabels: plan.referenceLabels,
            paymentMode: plan.paymentMode,
          });
          const prepared = preparedConversions.get(String(expense._id));
          if (prepared && prepared.revision !== expense.revision)
            throw new ApiError(
              412,
              "REVISION_MISMATCH",
              "An installment changed. Refresh and try again.",
            );
          if (prepared) expense.conversion = prepared.conversion;
        }
        installment.revision += 1;
        expense.revision += 1;
        await installment.save({ session });
        await expense.save({ session });
      }
      await BucketModel.updateOne({ _id: bucketId }, { $inc: { exportRevision: 1 } }, { session });
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: actor._id,
            action: `emi.plan_${action}`,
            entityId: plan._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return { resourceId: planId, status: 200, data: { id: planId } };
    },
    async (id) => ({ id }),
  );
  return { ...result, data: await getPlan(identity, bucketId, planId) };
}

export async function changeInstallment(
  identity: DecodedIdToken,
  bucketId: string,
  planId: string,
  installmentId: string,
  action: "skip" | "reschedule",
  raw: unknown,
  key: string,
  revision: string | null,
) {
  const date = action === "reschedule" ? (raw as { expenseDate?: string })?.expenseDate : undefined;
  if (action === "reschedule" && !z.iso.date().safeParse(date).success)
    throw new ApiError(422, "INVALID_DATE", "Choose a valid installment date.");
  const prepared =
    action === "reschedule"
      ? await (async () => {
          const user = await activeUser(identity);
          const bucket = await bucketForUser(bucketId, user);
          const membership = await MembershipModel.findOne({
            bucketId,
            userId: user._id,
            state: "active",
          });
          const plan = await EmiPlanModel.findOne({
            _id: planId,
            bucketId,
            actualCreatorUserId: user._id,
            creatorMembershipId: membership?._id,
            state: "active",
          });
          const installment =
            plan &&
            (await EmiInstallmentModel.findOne({ _id: installmentId, planId, state: "scheduled" }));
          const expense =
            installment &&
            (await ExpenseModel.findOne({
              _id: installment.expenseId,
              postingState: "unposted",
              deletedAt: null,
            }));
          if (!expense) throw unavailable();
          assertRevision(revision, expense.revision);
          return {
            revision: expense.revision,
            conversion: await conversionFor(
              {
                expenseDate: date!,
                originalAmount: expense.originalAmount.toString(),
                originalCurrency: expense.originalCurrency,
              },
              bucket.primaryCurrency,
              bucket.timezone,
            ),
          };
        })()
      : null;
  const result = await mutate(
    identity,
    `emi:${planId}:${installmentId}:${action}`,
    key,
    { date, revision },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true);
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: user._id,
        state: "active",
      }).session(session);
      const plan = await EmiPlanModel.findOne({
        _id: planId,
        bucketId,
        actualCreatorUserId: user._id,
        creatorMembershipId: membership?._id,
        state: "active",
      }).session(session);
      const installment =
        plan &&
        (await EmiInstallmentModel.findOne({
          _id: installmentId,
          planId,
          bucketId,
          state: "scheduled",
        }).session(session));
      const expense =
        installment &&
        (await ExpenseModel.findOne({
          _id: installment.expenseId,
          postingState: "unposted",
          deletedAt: null,
        }).session(session));
      if (!plan || !installment || !expense) throw unavailable();
      assertRevision(revision, expense.revision);
      if (prepared && prepared.revision !== expense.revision)
        throw new ApiError(
          412,
          "REVISION_MISMATCH",
          "This installment changed. Refresh and try again.",
        );
      if (action === "skip") {
        installment.state = "skipped";
        expense.postingState = "canceled";
      } else {
        installment.scheduledDate = date!;
        expense.expenseDate = date!;
        expense.dueAt = dueInstant(date!, bucket.timezone);
        expense.conversion = prepared!.conversion;
      }
      installment.revision += 1;
      expense.revision += 1;
      await installment.save({ session });
      await expense.save({ session });
      await BucketModel.updateOne({ _id: bucketId }, { $inc: { exportRevision: 1 } }, { session });
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: `emi.installment_${action}`,
            entityId: installment._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return { resourceId: installmentId, status: 200, data: { id: installmentId } };
    },
    async (id) => ({ id }),
  );
  return result;
}

export async function listScheduled(identity: DecodedIdToken, bucketId: string) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const today = localDate(new Date(), bucket.timezone);
  const membership = await MembershipModel.findOne({ bucketId, userId: user._id, state: "active" });
  const expenses = await ExpenseModel.find({
    bucketId,
    postingState: "unposted",
    deletedAt: null,
  })
    .sort({ expenseDate: 1 })
    .limit(100);
  return expenses.map((item) => ({
    id: String(item._id),
    description: item.description,
    expenseDate: item.expenseDate,
    amount: item.originalAmount.toString(),
    currency: item.originalCurrency,
    sourceKind: item.source?.kind ?? "manual",
    conversionStatus: item.conversion?.status ?? "missing",
    canResolve:
      String(item.actualCreatorUserId) === String(user._id) &&
      String(item.creatorMembershipId) === String(membership?._id),
    revision: item.revision,
    status:
      item.reviewState === "archive_review_required"
        ? "review_required"
        : item.expenseDate <= today && item.conversion.status === "missing"
          ? "conversion_needed"
          : item.expenseDate <= today
            ? "pending_processing"
            : "scheduled",
  }));
}

export async function processDaily(limit = 100) {
  let generated = 0;
  let posted = 0;
  let conversionNeeded = 0;
  const deadline = Date.now() + 45_000;
  const stalledPlans: mongoose.Types.ObjectId[] = [];
  while (Date.now() < deadline) {
    const plan = await EmiPlanModel.findOne({
      state: "active",
      _id: { $nin: stalledPlans },
      $expr: { $lt: ["$generatedThroughNumber", "$totalInstallments"] },
    }).sort({ createdAt: 1 });
    if (!plan || generated >= limit) break;
    const count = await generateInstallments(String(plan._id), Math.min(12, limit - generated));
    if (!count) {
      stalledPlans.push(plan._id);
      continue;
    }
    generated += count;
  }
  const legacy = await ExpenseModel.find({
    postingState: "unposted",
    dueAt: null,
    deletedAt: null,
  }).limit(limit);
  for (const expense of legacy) {
    const bucket = await BucketModel.findById(expense.bucketId);
    if (bucket)
      await ExpenseModel.updateOne(
        { _id: expense._id, dueAt: null },
        {
          $set: {
            dueAt: dueInstant(expense.expenseDate, expense.scheduleTimezone || bucket.timezone),
          },
        },
      );
  }
  const due = await ExpenseModel.find({
    postingState: "unposted",
    deletedAt: null,
    reviewState: "none",
    dueAt: { $lte: new Date() },
  })
    .sort({ dueAt: 1, _id: 1 })
    .limit(limit);
  for (const candidate of due) {
    if (Date.now() >= deadline) break;
    const bucket = await BucketModel.findById(candidate.bucketId);
    if (!bucket || bucket.status !== "active") continue;
    if (candidate.expenseDate > localDate(new Date(), bucket.timezone)) continue;
    const conversion =
      candidate.conversion?.manualFixed && candidate.conversion?.convertedAmount
        ? {
            status: "final",
            method: candidate.conversion.method,
            convertedAmount: candidate.conversion.convertedAmount,
            rate: candidate.conversion.rate,
            rateDate: candidate.conversion.rateDate,
            manualFixed: true,
          }
        : await conversionFor(
            {
              expenseDate: candidate.expenseDate,
              originalAmount: candidate.originalAmount.toString(),
              originalCurrency: candidate.originalCurrency,
            },
            bucket.primaryCurrency,
            bucket.timezone,
          );
    await mongoose.connection.transaction(async (session) => {
      const expense = await ExpenseModel.findOne({
        _id: candidate._id,
        revision: candidate.revision,
        postingState: "unposted",
        deletedAt: null,
        reviewState: "none",
      }).session(session);
      if (!expense) return;
      const membership = await MembershipModel.exists({
        _id: expense.creatorMembershipId,
        state: "active",
      }).session(session);
      const currentBucket = await BucketModel.findOne({
        _id: expense.bucketId,
        status: "active",
      }).session(session);
      if (
        !currentBucket ||
        !membership ||
        (expense.source?.kind === "emi" &&
          !(await EmiPlanModel.exists({ _id: expense.source.emiPlanId, state: "active" }).session(
            session,
          )))
      )
        return;
      const postingGuard = await BucketModel.updateOne(
        { _id: currentBucket._id, status: "active" },
        { $inc: { writeRevision: 1 } },
        { session },
      );
      if (!postingGuard.matchedCount) return;
      if (conversion.status === "missing") {
        expense.conversion = conversion;
        expense.revision += 1;
        await expense.save({ session });
        conversionNeeded += 1;
        return;
      }
      const before = await captureBudgetUsage(
        String(expense.bucketId),
        [expense.expenseDate],
        session,
      );
      expense.conversion = conversion;
      expense.postingState = "posted";
      expense.postedAt = new Date();
      expense.revision += 1;
      await expense.save({ session });
      if (expense.source?.emiInstallmentId)
        await EmiInstallmentModel.updateOne(
          { _id: expense.source.emiInstallmentId, state: "scheduled" },
          { $set: { state: "recorded" }, $inc: { revision: 1 } },
          { session },
        );
      if (expense.source?.emiPlanId) {
        const plan = await EmiPlanModel.findById(expense.source.emiPlanId).session(session);
        if (
          plan?.generatedThroughNumber === plan?.totalInstallments &&
          !(await EmiInstallmentModel.exists({
            planId: plan._id,
            state: { $ne: "recorded" },
          }).session(session))
        ) {
          plan.state = "completed";
          plan.revision += 1;
          await plan.save({ session });
        }
      }
      await BucketModel.updateOne(
        { _id: expense.bucketId },
        { $inc: { financialRevision: 1, exportRevision: 1 } },
        { session },
      );
      await reconcileBudgetThresholds(
        String(expense.bucketId),
        [expense.expenseDate],
        before,
        session,
      );
      await AuditModel.create(
        [
          {
            bucketId: expense.bucketId,
            actorUserId: expense.actualCreatorUserId,
            actorKind: "system",
            action: "scheduled.posted",
            entityId: expense._id,
          },
        ],
        { session },
      );
      posted += 1;
    });
  }
  const [unfinishedPlan, dueBacklog] = await Promise.all([
    EmiPlanModel.exists({
      state: "active",
      $expr: { $lt: ["$generatedThroughNumber", "$totalInstallments"] },
    }),
    ExpenseModel.exists({
      postingState: "unposted",
      deletedAt: null,
      reviewState: "none",
      "conversion.status": { $ne: "missing" },
      dueAt: { $lte: new Date() },
    }),
  ]);
  return {
    generated,
    posted,
    conversionNeeded,
    checked: due.length,
    hasRemainingWork: Boolean(unfinishedPlan || dueBacklog),
  };
}
