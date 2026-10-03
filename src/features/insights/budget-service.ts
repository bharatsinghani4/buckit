import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose, { type ClientSession } from "mongoose";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  AuditModel,
  BudgetModel,
  BudgetPeriodModel,
  BucketModel,
  ExpenseModel,
  MembershipModel,
  OptionModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import { fromMinor, minorUnits } from "@/features/expenses/money";
import { objectId } from "@/features/expenses/contracts";
import { budgetEditInput, budgetInput } from "./contracts";
import { nextMonth, todayInZone, units, usageMath } from "./calculations";
import { recordDomainEvent } from "@/features/notifications/event-service";

const missing = () => new ApiError(404, "RESOURCE_NOT_FOUND", "This budget is not available.");
const decimal = (amount: string) => mongoose.Types.Decimal128.fromString(amount);
type BudgetRecord = {
  _id: mongoose.Types.ObjectId;
  id: string;
  bucketId: mongoose.Types.ObjectId;
  name: string;
  scope: "shared" | "member";
  createdByUserId: mongoose.Types.ObjectId;
  memberUserId?: mongoose.Types.ObjectId;
  categoryIds: mongoose.Types.ObjectId[];
  limitAmount: mongoose.Types.Decimal128;
  periodType: "monthly" | "custom";
  startDate?: string;
  endDateExclusive?: string;
  thresholdPercentages: string[];
  state: string;
  revision: number;
};
type HandledThreshold = { percentage: string; handledAt: Date; reason: string };

function rangeFor(
  budget: { periodType: string; startDate?: string; endDateExclusive?: string },
  month: string,
) {
  if (budget.periodType === "custom")
    return { from: budget.startDate!, toExclusive: budget.endDateExclusive!, key: "custom" };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new ApiError(422, "INVALID_MONTH", "Choose a valid month.");
  return { from: `${month}-01`, toExclusive: `${nextMonth(month)}-01`, key: month };
}

async function budgetDto(
  budget: BudgetRecord,
  userId: string,
  currency: string,
  session?: ClientSession,
) {
  const [owner, categories] = await Promise.all([
    UserModel.findById(budget.createdByUserId).session(session ?? null),
    OptionModel.find({ bucketId: budget.bucketId, _id: { $in: budget.categoryIds } }).session(
      session ?? null,
    ),
  ]);
  const labels = new Map(categories.map((category) => [String(category._id), category.name]));
  return {
    id: String(budget._id),
    name: budget.name,
    scope: budget.scope,
    categoryIds: budget.categoryIds.map(String),
    categoryNames: budget.categoryIds.map((id: unknown) => labels.get(String(id)) ?? "Category"),
    limitAmount: budget.limitAmount.toString(),
    currency,
    periodType: budget.periodType,
    from: budget.startDate ?? null,
    toExclusive: budget.endDateExclusive ?? null,
    thresholdPercentages: budget.thresholdPercentages ?? [],
    state: budget.state,
    ownerName: owner?.displayName ?? "Former member",
    canManage:
      budget.state === "active" &&
      (budget.scope === "shared"
        ? String(
            (await BucketModel.findById(budget.bucketId).session(session ?? null))?.ownerUserId,
          ) === userId
        : String(budget.createdByUserId) === userId),
    revision: budget.revision,
  };
}

async function usageFor(
  budget: BudgetRecord,
  currency: string,
  financialRevision: number,
  month: string,
  today: string,
  session?: ClientSession,
) {
  const range = rangeFor(budget, month);
  const match = {
    bucketId: new mongoose.Types.ObjectId(String(budget.bucketId)),
    categoryId: { $in: budget.categoryIds },
    ...(budget.scope === "member" ? { paidByUserId: budget.memberUserId } : {}),
    expenseDate: { $gte: range.from, $lt: range.toExclusive },
    deletedAt: null,
  };
  const [actual, incompleteCount, period] = await Promise.all([
    ExpenseModel.aggregate([
      {
        $match: {
          ...match,
          postingState: "posted",
          "conversion.status": "final",
          "conversion.convertedAmount": { $exists: true },
        },
      },
      { $group: { _id: null, amount: { $sum: "$conversion.convertedAmount" } } },
    ]).session(session ?? null),
    ExpenseModel.countDocuments({
      ...match,
      expenseDate: { $gte: range.from, $lt: range.toExclusive, $lte: today },
      "conversion.status": "missing",
      postingState: "unposted",
    }).session(session ?? null),
    BudgetPeriodModel.findOne({ budgetId: budget._id, periodKey: range.key }).session(
      session ?? null,
    ),
  ]);
  const used = units(actual[0]?.amount?.toString() ?? "0", currency);
  const limit = units(budget.limitAmount.toString(), currency);
  return {
    currency,
    from: range.from,
    toExclusive: range.toExclusive,
    limitAmount: budget.limitAmount.toString(),
    ...usageMath(used, limit, currency),
    incompleteCount,
    financialRevision,
    handledThresholds: (period?.handledThresholds ?? []).map((item: HandledThreshold) => ({
      percentage: item.percentage,
      handledAt: item.handledAt.toISOString(),
      reason: item.reason,
    })),
  };
}

export async function listBudgets(
  identity: DecodedIdToken,
  bucketId: string,
  month: string,
  scope: string | null = null,
  state: string | null = null,
) {
  if (scope && !["shared", "member"].includes(scope))
    throw new ApiError(422, "INVALID_SCOPE", "Choose a valid budget scope.");
  if (state && !["active", "historical", "all"].includes(state))
    throw new ApiError(422, "INVALID_STATE", "Choose a valid budget state.");
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const selectedMonth = month || todayInZone(bucket.timezone).slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth))
    throw new ApiError(422, "INVALID_MONTH", "Choose a valid month.");
  const rows = await BudgetModel.find({
    bucketId,
    state: state && state !== "all" ? state : { $ne: "deleted" },
    ...(scope ? { scope } : {}),
  }).sort({
    createdAt: -1,
  });
  return Promise.all(
    rows.map(async (row) => ({
      budget: await budgetDto(row, String(user._id), bucket.primaryCurrency),
      usage: await usageFor(
        row,
        bucket.primaryCurrency,
        bucket.financialRevision,
        selectedMonth,
        todayInZone(bucket.timezone),
      ),
    })),
  );
}

export async function getBudget(identity: DecodedIdToken, bucketId: string, budgetId: string) {
  objectId.parse(budgetId);
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const row = await BudgetModel.findOne({ _id: budgetId, bucketId, state: { $ne: "deleted" } });
  if (!row) throw missing();
  return budgetDto(row, String(user._id), bucket.primaryCurrency);
}

export async function getBudgetUsage(
  identity: DecodedIdToken,
  bucketId: string,
  budgetId: string,
  month: string,
) {
  objectId.parse(budgetId);
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const row = await BudgetModel.findOne({ _id: budgetId, bucketId, state: { $ne: "deleted" } });
  if (!row) throw missing();
  return usageFor(
    row,
    bucket.primaryCurrency,
    bucket.financialRevision,
    month || todayInZone(bucket.timezone).slice(0, 7),
    todayInZone(bucket.timezone),
  );
}

async function validateCategories(
  bucketId: string,
  categoryIds: string[],
  session: ClientSession,
  existingIds: string[] = [],
) {
  const count = await OptionModel.countDocuments({
    bucketId,
    kind: "category",
    $or: [{ state: "active" }, { _id: { $in: existingIds } }],
    _id: { $in: categoryIds },
  }).session(session);
  if (count !== categoryIds.length)
    throw new ApiError(422, "INVALID_CATEGORY", "Select active categories from this bucket.");
}

async function replayBudget(
  identity: DecodedIdToken,
  bucketId: string,
  id: string,
  session: ClientSession,
) {
  const user = await activeUser(identity, session);
  const bucket = await bucketForUser(bucketId, user, session);
  const budget = await BudgetModel.findOne({ _id: id, bucketId }).session(session);
  if (!budget) throw missing();
  return budget.state === "deleted"
    ? { id, deleted: true }
    : budgetDto(budget, String(user._id), bucket.primaryCurrency, session);
}

export async function createBudget(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
) {
  const input = budgetInput.parse(raw);
  return mutate(
    identity,
    `budget:${bucketId}:create`,
    key,
    input,
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true);
      if (input.scope === "shared" && String(bucket.ownerUserId) !== String(user._id))
        throw new ApiError(403, "FORBIDDEN", "Only the bucket owner can manage shared budgets.");
      const limit = minorUnits(input.limitAmount, bucket.primaryCurrency);
      if (limit <= 0n) throw new ApiError(422, "INVALID_AMOUNT", "Budget limit must be positive.");
      await validateCategories(bucketId, input.categoryIds, session);
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: user._id,
        state: "active",
      }).session(session);
      const [row] = await BudgetModel.create(
        [
          {
            bucketId,
            name: input.name,
            scope: input.scope,
            createdByUserId: user._id,
            memberUserId: input.scope === "member" ? user._id : undefined,
            creatorMembershipId: input.scope === "member" ? membership?._id : undefined,
            categoryIds: input.categoryIds,
            limitAmount: decimal(input.limitAmount),
            periodType: input.periodType,
            startDate: input.from,
            endDateExclusive: input.toExclusive,
            thresholdPercentages: input.thresholdPercentages
              .map((value) => String(Number(value)))
              .sort((a, b) => Number(a) - Number(b)),
          },
        ],
        { session },
      );
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: "budget.created",
            entityId: row._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return {
        resourceId: String(row._id),
        status: 201,
        data: await budgetDto(row, String(user._id), bucket.primaryCurrency, session),
      };
    },
    (id, session) => replayBudget(identity, bucketId, id, session),
  );
}

export async function changeBudget(
  identity: DecodedIdToken,
  bucketId: string,
  budgetId: string,
  action: "edit" | "delete",
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(budgetId);
  const edits = action === "edit" ? budgetEditInput.parse(raw) : {};
  if (action === "edit" && Object.keys(edits).length === 0)
    throw new ApiError(422, "VALIDATION_FAILED", "Change at least one field.");
  return mutate(
    identity,
    `budget:${bucketId}:${budgetId}:${action}`,
    key,
    { edits, revisionHeader },
    async (session) => {
      const user = await activeUser(identity, session);
      const bucket = await bucketForUser(bucketId, user, session, true);
      const row = await BudgetModel.findOne({ _id: budgetId, bucketId, state: "active" }).session(
        session,
      );
      if (!row) throw missing();
      const allowed =
        row.scope === "shared"
          ? String(bucket.ownerUserId) === String(user._id)
          : String(row.createdByUserId) === String(user._id) &&
            Boolean(
              await MembershipModel.exists({
                _id: row.creatorMembershipId,
                state: "active",
              }).session(session),
            );
      if (!allowed) throw new ApiError(403, "FORBIDDEN", "You cannot manage this budget.");
      assertRevision(revisionHeader, row.revision);
      if (action === "delete") row.state = "deleted";
      else {
        const merged = budgetInput.parse({
          name: edits.name ?? row.name,
          scope: row.scope,
          categoryIds: edits.categoryIds ?? row.categoryIds.map(String),
          limitAmount: edits.limitAmount ?? row.limitAmount.toString(),
          periodType: edits.periodType ?? row.periodType,
          from: edits.from ?? (edits.periodType === "monthly" ? undefined : row.startDate),
          toExclusive:
            edits.toExclusive ??
            (edits.periodType === "monthly" ? undefined : row.endDateExclusive),
          thresholdPercentages: edits.thresholdPercentages ?? row.thresholdPercentages,
        });
        const limit = minorUnits(merged.limitAmount, bucket.primaryCurrency);
        if (limit <= 0n)
          throw new ApiError(422, "INVALID_AMOUNT", "Budget limit must be positive.");
        await validateCategories(
          bucketId,
          merged.categoryIds,
          session,
          row.categoryIds.map(String),
        );
        row.name = merged.name;
        row.categoryIds = merged.categoryIds.map((id) => new mongoose.Types.ObjectId(id));
        row.limitAmount = decimal(merged.limitAmount);
        row.periodType = merged.periodType;
        row.startDate = merged.from;
        row.endDateExclusive = merged.toExclusive;
        row.thresholdPercentages = merged.thresholdPercentages
          .map((value) => String(Number(value)))
          .sort((a, b) => Number(a) - Number(b));
      }
      row.revision += 1;
      await row.save({ session });
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: `budget.${action}`,
            entityId: row._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return {
        resourceId: budgetId,
        status: action === "delete" ? 200 : 200,
        data: await replayBudget(identity, bucketId, budgetId, session),
      };
    },
    (id, session) => replayBudget(identity, bucketId, id, session),
  );
}

export async function reconcileBudgetThresholds(
  bucketId: string,
  dates: string[],
  prior: Map<string, bigint>,
  session: ClientSession,
  reason: "notified" | "import_suppressed" | "channels_disabled" = "channels_disabled",
) {
  if (!dates.length) return;
  const bucket = await BucketModel.findById(bucketId).session(session);
  const budgets = await BudgetModel.find({
    bucketId,
    state: "active",
    thresholdPercentages: { $ne: [] },
  }).session(session);
  for (const budget of budgets) {
    const keys = [
      ...new Set(
        dates.map((date) => (budget.periodType === "monthly" ? date.slice(0, 7) : "custom")),
      ),
    ];
    for (const key of keys) {
      const range = rangeFor(budget, key);
      if (!dates.some((date) => date >= range.from && date < range.toExclusive)) continue;
      const usage = await usageFor(
        budget,
        bucket.primaryCurrency,
        bucket.financialRevision,
        key,
        todayInZone(bucket.timezone),
        session,
      );
      const after = units(usage.usedAmount, bucket.primaryCurrency);
      const before = prior.get(`${budget.id}:${key}`) ?? after;
      const limit = units(budget.limitAmount.toString(), bucket.primaryCurrency);
      const period = await BudgetPeriodModel.findOneAndUpdate(
        { budgetId: budget._id, periodKey: key },
        {
          $setOnInsert: {
            bucketId,
            startDate: range.from,
            endDateExclusive: range.toExclusive,
            handledThresholds: [],
          },
        },
        { session, upsert: true, returnDocument: "after" },
      );
      const handled = new Set(
        (period.handledThresholds ?? []).map((item: HandledThreshold) => item.percentage),
      );
      const crossed = budget.thresholdPercentages.filter((percentage: string) => {
        const scaled = BigInt(Math.round(Number(percentage) * 100));
        return (
          !handled.has(percentage) &&
          before * 10_000n < limit * scaled &&
          after * 10_000n >= limit * scaled
        );
      });
      if (crossed.length) {
        period.handledThresholds.push(
          ...crossed.map((percentage: string) => ({ percentage, handledAt: new Date(), reason })),
        );
        await AuditModel.create(
          [
            {
              bucketId,
              actorUserId: budget.createdByUserId,
              actorKind: "system",
              action: "budget.threshold_crossed",
              changedFields: [crossed.at(-1)],
              entityId: budget._id,
            },
          ],
          { session },
        );
        if (reason !== "import_suppressed")
          await recordDomainEvent(session, {
            eventKey: `budget.threshold:${budget._id}:${key}:${crossed.at(-1)}`,
            type: "budget.threshold_reached",
            bucketId,
            entityType: "budget",
            entityId: budget._id,
            ...(budget.scope === "member" ? { recipientUserId: budget.createdByUserId } : {}),
          });
      }
      period.usedAmount = decimal(fromMinor(after, bucket.primaryCurrency));
      period.computedFinancialRevision = bucket.financialRevision;
      period.computedBudgetRevision = budget.revision;
      await period.save({ session });
    }
  }
}

export async function captureBudgetUsage(
  bucketId: string,
  dates: string[],
  session: ClientSession,
) {
  const bucket = await BucketModel.findById(bucketId).session(session);
  const budgets = await BudgetModel.find({
    bucketId,
    state: "active",
    thresholdPercentages: { $ne: [] },
  }).session(session);
  const prior = new Map<string, bigint>();
  for (const budget of budgets) {
    const keys = [
      ...new Set(
        dates.map((date) => (budget.periodType === "monthly" ? date.slice(0, 7) : "custom")),
      ),
    ];
    for (const key of keys) {
      const range = rangeFor(budget, key);
      if (dates.some((date) => date >= range.from && date < range.toExclusive)) {
        const usage = await usageFor(
          budget,
          bucket.primaryCurrency,
          bucket.financialRevision,
          key,
          todayInZone(bucket.timezone),
          session,
        );
        prior.set(`${budget.id}:${key}`, units(usage.usedAmount, bucket.primaryCurrency));
      }
    }
  }
  return prior;
}
