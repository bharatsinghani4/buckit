import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import mongoose, { type ClientSession } from "mongoose";
import { ApiError, assertRevision } from "@/lib/api/errors";
import {
  AuditModel,
  BucketModel,
  CommentModel,
  ExpenseModel,
  EmiInstallmentModel,
  EmiPlanModel,
  MembershipModel,
  OptionModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser, mutate } from "@/features/identity/service";
import {
  commentInput,
  conversionPreviewInput,
  expenseEditInput,
  expenseInput,
  objectId,
  type ExpenseInput,
} from "./contracts";
import { convertAmount, minorUnits, precision } from "./money";
import { captureBudgetUsage, reconcileBudgetThresholds } from "@/features/insights/budget-service";
import { z } from "zod";
import { dueInstant } from "@/features/scheduling/dates";
import { recordDomainEvent } from "@/features/notifications/event-service";

const missing = () => new ApiError(404, "RESOURCE_NOT_FOUND", "This expense is not available.");
const decimal = (value: string) => mongoose.Types.Decimal128.fromString(value);
type ExpenseRow = {
  _id: mongoose.Types.ObjectId;
  bucketId: mongoose.Types.ObjectId;
  actualCreatorUserId: mongoose.Types.ObjectId;
  creatorMembershipId: mongoose.Types.ObjectId;
  paidByUserId: mongoose.Types.ObjectId;
  addedByUserId: mongoose.Types.ObjectId;
  categoryId: mongoose.Types.ObjectId;
  accountId: mongoose.Types.ObjectId;
  platformId: mongoose.Types.ObjectId;
  refundOfExpenseId?: mongoose.Types.ObjectId | null;
  expenseDate: string;
  description: string;
  notes?: string;
  paymentMode: string;
  originalAmount: mongoose.Types.Decimal128;
  originalCurrency: string;
  bucketCurrency: string;
  referenceLabels?: { category?: string; account?: string; platform?: string };
  conversion?: {
    status: string;
    convertedAmount?: mongoose.Types.Decimal128;
    rate?: mongoose.Types.Decimal128;
    rateDate?: string;
  };
  postingState: string;
  reviewState?: string;
  source?: {
    kind?: string;
    emiPlanId?: mongoose.Types.ObjectId;
    emiInstallmentId?: mongoose.Types.ObjectId;
  };
  deletedAt?: Date | null;
  restoreUntil?: Date | null;
  revision: number;
};
const dateInZone = (zone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

async function expenseDto(expense: ExpenseRow, userId: string, session?: ClientSession) {
  const people = await UserModel.find({
    _id: { $in: [expense.paidByUserId, expense.addedByUserId] },
  }).session(session ?? null);
  const names = new Map(people.map((person) => [String(person._id), person.displayName]));
  const bucket = await BucketModel.findById(expense.bucketId).session(session ?? null);
  const today = dateInZone(bucket?.timezone ?? "UTC");
  const deleted = Boolean(expense.deletedAt);
  const currentMembership = await MembershipModel.exists({
    _id: expense.creatorMembershipId,
    bucketId: expense.bucketId,
    userId,
    state: "active",
  }).session(session ?? null);
  const creator = String(expense.actualCreatorUserId) === userId && Boolean(currentMembership);
  const displayStatus = deleted
    ? "deleted"
    : expense.reviewState === "archive_review_required"
      ? "archive_review"
      : expense.expenseDate > today
        ? "scheduled"
        : expense.conversion?.status === "missing"
          ? "conversion_needed"
          : expense.postingState === "posted"
            ? "actual"
            : "pending_processing";
  return {
    id: String(expense._id),
    bucketId: String(expense.bucketId),
    expenseDate: expense.expenseDate,
    description: expense.description,
    notes: expense.notes ?? "",
    paidByUserId: String(expense.paidByUserId),
    paidByName: names.get(String(expense.paidByUserId)) ?? "Former member",
    addedByUserId: String(expense.addedByUserId),
    addedByName: names.get(String(expense.addedByUserId)) ?? "Former member",
    actualCreatorUserId: String(expense.actualCreatorUserId),
    categoryId: String(expense.categoryId),
    categoryName: expense.referenceLabels?.category ?? "Category",
    accountId: String(expense.accountId),
    accountName: expense.referenceLabels?.account ?? "Account",
    platformId: String(expense.platformId),
    platformName: expense.referenceLabels?.platform ?? "Other",
    paymentMode: expense.paymentMode,
    originalAmount: expense.originalAmount.toString(),
    originalCurrency: expense.originalCurrency,
    bucketCurrency: expense.bucketCurrency,
    convertedAmount: expense.conversion?.convertedAmount?.toString() ?? null,
    conversionStatus: expense.conversion?.status ?? "missing",
    rate: expense.conversion?.rate?.toString() ?? null,
    rateDate: expense.conversion?.rateDate ?? null,
    displayStatus,
    refundOfExpenseId: expense.refundOfExpenseId ? String(expense.refundOfExpenseId) : null,
    deletedAt: expense.deletedAt?.toISOString() ?? null,
    restoreUntil: expense.restoreUntil?.toISOString() ?? null,
    revision: expense.revision,
    source:
      expense.source?.kind === "emi"
        ? {
            kind: "emi",
            planId: String(expense.source.emiPlanId),
            installmentId: String(expense.source.emiInstallmentId),
          }
        : { kind: "manual" },
    permissions: {
      canEdit: creator && !deleted && bucket?.status === "active",
      canDelete: creator && !deleted && bucket?.status === "active",
      canRestore:
        creator &&
        deleted &&
        Boolean(expense.restoreUntil && expense.restoreUntil > new Date()) &&
        bucket?.status === "active",
      canComment: !deleted && bucket?.status === "active",
    },
  };
}

async function replayExpense(
  identity: DecodedIdToken,
  bucketId: string,
  expenseId: string,
  session: ClientSession,
) {
  const user = await activeUser(identity, session);
  await bucketForUser(bucketId, user, session);
  const membership = await MembershipModel.findOne({
    bucketId,
    userId: user._id,
    state: "active",
  }).session(session);
  const expense = await ExpenseModel.findOne({
    _id: expenseId,
    bucketId,
    actualCreatorUserId: user._id,
    creatorMembershipId: membership?._id,
  }).session(session);
  if (!expense) throw missing();
  return expenseDto(expense, String(user._id), session);
}

export async function conversionFor(
  input: Pick<
    ExpenseInput,
    "expenseDate" | "originalAmount" | "originalCurrency" | "manualConversion"
  >,
  currency: string,
  zone: string,
) {
  const today = dateInZone(zone);
  const future = input.expenseDate > today;
  const state = future ? "estimated" : "final";
  const amount = input.originalAmount;
  minorUnits(amount, input.originalCurrency);
  if (input.originalCurrency === currency)
    return {
      status: state,
      method: "identity",
      convertedAmount: decimal(amount),
      rate: decimal("1"),
      rateDate: input.expenseDate,
      manualFixed: true,
    };
  if (input.manualConversion?.method === "manual_amount") {
    const converted = input.manualConversion.convertedAmount;
    const convertedMinor = minorUnits(converted, currency);
    const originalMinor = minorUnits(amount, input.originalCurrency);
    if (convertedMinor * originalMinor <= 0n)
      throw new ApiError(
        422,
        "INVALID_CONVERSION",
        "Converted amount must have the same sign as the original.",
      );
    const numerator =
      (convertedMinor < 0n ? -convertedMinor : convertedMinor) *
      10n ** BigInt(precision(input.originalCurrency)) *
      100_000_000n;
    const denominator =
      (originalMinor < 0n ? -originalMinor : originalMinor) * 10n ** BigInt(precision(currency));
    const scaledRate = (numerator + denominator / 2n) / denominator;
    if (scaledRate === 0n)
      throw new ApiError(422, "INVALID_CONVERSION", "The derived exchange rate is too small.");
    const rate = `${scaledRate / 100_000_000n}.${String(scaledRate % 100_000_000n).padStart(8, "0")}`;
    return {
      status: state,
      method: "manual_amount",
      convertedAmount: decimal(converted),
      rate: decimal(rate),
      manualFixed: true,
      rateDate: input.expenseDate,
    };
  }
  if (input.manualConversion?.method === "manual_rate")
    return {
      status: state,
      method: "manual_rate",
      convertedAmount: decimal(
        convertAmount(amount, input.originalCurrency, currency, input.manualConversion.rate),
      ),
      rate: decimal(input.manualConversion.rate),
      rateDate: input.expenseDate,
      manualFixed: true,
    };
  try {
    const day = future ? "latest" : input.expenseDate;
    const endpoint = `https://api.frankfurter.dev/v1/${day}?base=${encodeURIComponent(input.originalCurrency)}&symbols=${encodeURIComponent(currency)}`;
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Rate unavailable");
    const quote = (await response.json()) as { date?: string; rates?: Record<string, number> };
    const rate = quote.rates?.[currency];
    if (
      !rate ||
      !Number.isFinite(rate) ||
      !quote.date ||
      (!future && quote.date > input.expenseDate)
    )
      throw new Error("Rate unavailable");
    const rateText = rate.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    return {
      status: state,
      method: "provider",
      convertedAmount: decimal(convertAmount(amount, input.originalCurrency, currency, rateText)),
      rate: decimal(rateText),
      rateDate: quote.date,
      provider: "Frankfurter",
      manualFixed: false,
    };
  } catch {
    return { status: "missing", method: "provider", manualFixed: false };
  }
}

export async function conversionPreview(identity: DecodedIdToken, bucketId: string, raw: unknown) {
  const input = conversionPreviewInput.parse(raw);
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const conversion = await conversionFor(input, bucket.primaryCurrency, bucket.timezone);
  return {
    status: conversion.status,
    bucketCurrency: bucket.primaryCurrency,
    convertedAmount: conversion.convertedAmount?.toString() ?? null,
    rate: conversion.rate?.toString() ?? null,
    rateDate: conversion.rateDate ?? null,
  };
}

export async function validateReferences(
  input: ExpenseInput,
  bucketId: string,
  session: ClientSession,
  existing?: Pick<ExpenseRow, "categoryId" | "accountId" | "platformId">,
  allowFormerPayer = false,
) {
  const member = await MembershipModel.exists({
    bucketId,
    userId: input.paidByUserId,
    ...(!allowFormerPayer ? { state: "active" } : {}),
  }).session(session);
  if (!member)
    throw new ApiError(
      422,
      "INVALID_PAYER",
      allowFormerPayer
        ? "Choose a current or former bucket member as the payer."
        : "Choose a current bucket member as the payer.",
    );
  const references = await OptionModel.find({
    bucketId,
    $or: [
      { _id: { $in: [input.categoryId, input.accountId, input.platformId].filter(Boolean) } },
      { kind: "platform", systemKey: "other" },
    ],
  }).session(session);
  const find = (kind: string, id?: string, existingId?: mongoose.Types.ObjectId) =>
    references.find(
      (item) =>
        item.kind === kind &&
        String(item._id) === id &&
        (item.state === "active" || String(existingId) === id),
    );
  const category = find("category", input.categoryId, existing?.categoryId);
  const account = find("account", input.accountId, existing?.accountId);
  const platform = input.platformId
    ? find("platform", input.platformId, existing?.platformId)
    : references.find((item) => item.systemKey === "other" && item.state === "active");
  if (!category || !account || (input.platformId && !platform))
    throw new ApiError(
      422,
      "INVALID_REFERENCE",
      "Choose active category, account, and platform options.",
    );
  return { category, account, platform };
}

export async function listExpenses(
  identity: DecodedIdToken,
  bucketId: string,
  params: URLSearchParams,
) {
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const query: Record<string, unknown> = { bucketId };
  const deleted = params.get("deleted") === "only";
  if (deleted) {
    const membership = await MembershipModel.findOne({
      bucketId,
      userId: user._id,
      state: "active",
    });
    query.deletedAt = { $ne: null };
    query.restoreUntil = { $gt: new Date() };
    query.actualCreatorUserId = user._id;
    query.creatorMembershipId = membership?._id;
  } else {
    query.deletedAt = null;
    query.postingState = { $ne: "canceled" };
  }
  for (const [param, field] of [
    ["categoryId", "categoryId"],
    ["accountId", "accountId"],
    ["platformId", "platformId"],
    ["paidByUserId", "paidByUserId"],
  ]) {
    const value = params.get(param);
    if (value) {
      objectId.parse(value);
      query[field] = value;
    }
  }
  const mode = params.get("paymentMode");
  if (mode) query.paymentMode = mode;
  const from = params.get("from");
  const to = params.get("toExclusive");
  if (from || to)
    query.expenseDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
  const status = params.get("status");
  const today = dateInZone((await BucketModel.findById(bucketId))?.timezone ?? "UTC");
  if (status === "scheduled") query.expenseDate = { ...(query.expenseDate as object), $gt: today };
  if (status === "conversion_needed") query["conversion.status"] = "missing";
  if (status === "archive_review") query.reviewState = "archive_review_required";
  if (status === "actual") {
    query.postingState = "posted";
    query.expenseDate = { ...(query.expenseDate as object), $lte: today };
  }
  if (status === "pending_processing") {
    query.postingState = "unposted";
    query.expenseDate = { ...(query.expenseDate as object), $lte: today };
    query["conversion.status"] = { $ne: "missing" };
  }
  const search = params.get("q")?.trim();
  if (search) {
    const expression = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 100);
    query.$or = ["description", "notes", "referenceLabels.platform"].map((field) => ({
      [field]: { $regex: expression, $options: "i" },
    }));
  }
  const cursor = params.get("cursor");
  if (cursor) {
    objectId.parse(cursor);
    query._id = { $lt: cursor };
  }
  const limit = Math.min(Math.max(Number(params.get("limit")) || 25, 1), 100);
  const found = await ExpenseModel.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1);
  const page = found.slice(0, limit);
  const data = await Promise.all(page.map((item) => expenseDto(item, String(user._id))));
  return {
    data,
    nextCursor: found.length > limit ? String(page.at(-1)?._id) : null,
    hasMore: found.length > limit,
  };
}

export async function expenseSummary(
  identity: DecodedIdToken,
  bucketId: string,
  month?: string | null,
) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const today = dateInZone(bucket.timezone);
  const match: Record<string, unknown> = {
    bucketId: new mongoose.Types.ObjectId(bucketId),
    deletedAt: null,
    postingState: { $ne: "canceled" },
  };
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [year, number] = month.split("-").map(Number);
    if (number >= 1 && number <= 12) {
      const next = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10);
      match.expenseDate = { $gte: `${month}-01`, $lt: next };
    }
  }
  const [result] = await ExpenseModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        actualTotal: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$postingState", "posted"] },
                  { $eq: ["$conversion.status", "final"] },
                ],
              },
              "$conversion.convertedAmount",
              decimal("0"),
            ],
          },
        },
        actualCount: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$postingState", "posted"] },
                  { $eq: ["$conversion.status", "final"] },
                ],
              },
              1,
              0,
            ],
          },
        },
        scheduledTotal: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gt: ["$expenseDate", today] },
                  { $ne: ["$conversion.status", "missing"] },
                ],
              },
              "$conversion.convertedAmount",
              decimal("0"),
            ],
          },
        },
        scheduledCount: { $sum: { $cond: [{ $gt: ["$expenseDate", today] }, 1, 0] } },
        conversionNeededCount: {
          $sum: { $cond: [{ $eq: ["$conversion.status", "missing"] }, 1, 0] },
        },
      },
    },
  ]);
  return {
    currency: bucket.primaryCurrency,
    actualTotal: result?.actualTotal?.toString() ?? "0",
    actualCount: result?.actualCount ?? 0,
    scheduledTotal: result?.scheduledTotal?.toString() ?? "0",
    scheduledCount: result?.scheduledCount ?? 0,
    conversionNeededCount: result?.conversionNeededCount ?? 0,
    incomplete: (result?.conversionNeededCount ?? 0) > 0,
  };
}

export async function getExpense(identity: DecodedIdToken, bucketId: string, expenseId: string) {
  objectId.parse(expenseId);
  const user = await activeUser(identity);
  await bucketForUser(bucketId, user);
  const expense = await ExpenseModel.findOne({ _id: expenseId, bucketId });
  const creatorMembership =
    expense?.deletedAt &&
    (await MembershipModel.exists({
      _id: expense.creatorMembershipId,
      bucketId,
      userId: user._id,
      state: "active",
    }));
  if (!expense || expense.postingState === "canceled" || (expense.deletedAt && !creatorMembership))
    throw missing();
  return expenseDto(expense, String(user._id));
}

export async function linkedRefunds(identity: DecodedIdToken, bucketId: string, expenseId: string) {
  await getExpense(identity, bucketId, expenseId);
  const user = await activeUser(identity);
  const refunds = await ExpenseModel.find({
    bucketId,
    refundOfExpenseId: expenseId,
    deletedAt: null,
  }).sort({ expenseDate: -1, _id: -1 });
  return Promise.all(refunds.map((refund) => expenseDto(refund, String(user._id))));
}

export async function expenseActivity(
  identity: DecodedIdToken,
  bucketId: string,
  expenseId: string,
) {
  await getExpense(identity, bucketId, expenseId);
  const refunds = await ExpenseModel.find({ bucketId, refundOfExpenseId: expenseId }).select("_id");
  const events = await AuditModel.find({
    bucketId,
    entityId: {
      $in: [new mongoose.Types.ObjectId(expenseId), ...refunds.map((refund) => refund._id)],
    },
    action: /^expense\./,
  })
    .sort({ occurredAt: -1 })
    .limit(100);
  const actors = await UserModel.find({ _id: { $in: events.map((event) => event.actorUserId) } });
  const names = new Map(actors.map((actor) => [String(actor._id), actor.displayName]));
  return events.map((event) => ({
    id: String(event._id),
    action: event.action,
    changedFields: event.changedFields ?? [],
    actorName: names.get(String(event.actorUserId)) ?? "Former member",
    occurredAt: event.occurredAt.toISOString(),
    linkedExpenseId: String(event.entityId) === expenseId ? null : String(event.entityId),
  }));
}

export async function createExpense(
  identity: DecodedIdToken,
  bucketId: string,
  raw: unknown,
  key: string,
) {
  const parsed = expenseInput.parse(raw);
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const input: ExpenseInput = {
    ...parsed,
    originalCurrency: parsed.originalCurrency ?? bucket.primaryCurrency,
  };
  const conversion = await conversionFor(input, bucket.primaryCurrency, bucket.timezone);
  return mutate(
    identity,
    `expense:${bucketId}:create`,
    key,
    input,
    async (session) => {
      const actor = await activeUser(identity, session);
      const target = await bucketForUser(bucketId, actor, session, true);
      const creatorMembership = await MembershipModel.findOne({
        bucketId,
        userId: actor._id,
        state: "active",
      }).session(session);
      if (!creatorMembership) throw missing();
      const refs = await validateReferences(input, bucketId, session);
      if (input.refundOfExpenseId) {
        const original = await ExpenseModel.findOne({
          _id: input.refundOfExpenseId,
          bucketId,
          deletedAt: null,
        }).session(session);
        if (!original || minorUnits(input.originalAmount, input.originalCurrency) >= 0n)
          throw new ApiError(
            422,
            "INVALID_REFUND",
            "A refund must be negative and link to a current expense.",
          );
      }
      const budgetBefore = await captureBudgetUsage(bucketId, [input.expenseDate], session);
      const future = input.expenseDate > dateInZone(target.timezone);
      const [expense] = await ExpenseModel.create(
        [
          {
            bucketId,
            actualCreatorUserId: actor._id,
            creatorMembershipId: creatorMembership._id,
            addedByUserId: actor._id,
            paidByUserId: input.paidByUserId,
            expenseDate: input.expenseDate,
            description: input.description,
            notes: input.notes,
            categoryId: refs.category._id,
            accountId: refs.account._id,
            platformId: refs.platform?._id,
            referenceLabels: {
              category: refs.category.name,
              account: refs.account.name,
              platform: refs.platform?.name ?? "Other",
            },
            paymentMode: input.paymentMode,
            originalAmount: decimal(input.originalAmount),
            originalCurrency: input.originalCurrency,
            bucketCurrency: target.primaryCurrency,
            conversion,
            postingState: future || conversion.status === "missing" ? "unposted" : "posted",
            postedAt: future || conversion.status === "missing" ? null : new Date(),
            scheduleTimezone: target.timezone,
            dueAt: future ? dueInstant(input.expenseDate, target.timezone) : undefined,
            refundOfExpenseId: input.refundOfExpenseId,
          },
        ],
        { session },
      );
      await BucketModel.updateOne(
        { _id: target._id },
        {
          $set: { currencyLockedAt: target.currencyLockedAt ?? new Date() },
          $inc: { financialRevision: 1, exportRevision: 1 },
        },
        { session },
      );
      await reconcileBudgetThresholds(bucketId, [input.expenseDate], budgetBefore, session);
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: actor._id,
            action: input.refundOfExpenseId ? "expense.refund_created" : "expense.created",
            entityId: expense._id,
            operationKey: key,
          },
        ],
        { session },
      );
      await recordDomainEvent(session, {
        eventKey: `expense.added:${key}`,
        type: "expense.added",
        actorUserId: actor._id,
        bucketId,
        entityType: "expense",
        entityId: expense._id,
      });
      return {
        resourceId: String(expense._id),
        status: 201,
        data: await expenseDto(expense, String(actor._id), session),
      };
    },
    async (id, session) => replayExpense(identity, bucketId, id, session),
  );
}

export async function changeExpense(
  identity: DecodedIdToken,
  bucketId: string,
  expenseId: string,
  action: "edit" | "delete" | "restore",
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(expenseId);
  const edits = action === "edit" ? expenseEditInput.parse(raw) : {};
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const existing = await ExpenseModel.findOne({ _id: expenseId, bucketId });
  const creatorMembership = await MembershipModel.exists({
    _id: existing?.creatorMembershipId,
    bucketId,
    userId: user._id,
    state: "active",
  });
  if (
    !existing ||
    existing.postingState === "canceled" ||
    String(existing.actualCreatorUserId) !== String(user._id) ||
    !creatorMembership
  )
    throw missing();
  const merged = {
    expenseDate: existing.expenseDate,
    description: existing.description,
    paidByUserId: String(existing.paidByUserId),
    categoryId: String(existing.categoryId),
    accountId: String(existing.accountId),
    platformId: String(existing.platformId),
    paymentMode: existing.paymentMode,
    originalAmount: existing.originalAmount.toString(),
    originalCurrency: existing.originalCurrency,
    notes: existing.notes ?? "",
    ...edits,
  } as ExpenseInput;
  const conversion =
    action === "edit" ? await conversionFor(merged, bucket.primaryCurrency, bucket.timezone) : null;
  return mutate(
    identity,
    `expense:${bucketId}:${expenseId}:${action}`,
    key,
    { edits, revisionHeader },
    async (session) => {
      const actor = await activeUser(identity, session);
      await bucketForUser(bucketId, actor, session, true);
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: actor._id,
        state: "active",
      }).session(session);
      const expense = await ExpenseModel.findOne({
        _id: expenseId,
        bucketId,
        actualCreatorUserId: actor._id,
        creatorMembershipId: membership?._id,
      }).session(session);
      if (!expense) throw missing();
      assertRevision(revisionHeader, expense.revision);
      if (action === "edit" && expense.source?.kind === "emi" && "expenseDate" in edits)
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          "Reschedule this date from the installment schedule.",
        );
      const affectedDates = [...new Set([expense.expenseDate, merged.expenseDate])];
      const budgetBefore = await captureBudgetUsage(bucketId, affectedDates, session);
      const changedFields =
        action === "edit"
          ? Object.keys(edits).filter(
              (field) =>
                JSON.stringify(expense.get(field)) !==
                JSON.stringify((edits as Record<string, unknown>)[field]),
            )
          : [];
      if (action === "restore") {
        if (!expense.deletedAt || expense.restoreUntil <= new Date())
          throw new ApiError(409, "RESTORE_EXPIRED", "This expense can no longer be restored.");
        expense.deletedAt = null;
        expense.restoreUntil = null;
        expense.deletedByUserId = null;
      } else if (action === "delete") {
        if (expense.deletedAt) throw missing();
        expense.deletedAt = new Date();
        expense.restoreUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        expense.deletedByUserId = actor._id;
      } else {
        if (expense.deletedAt) throw missing();
        const refs = await validateReferences(merged, bucketId, session, expense);
        Object.assign(expense, {
          expenseDate: merged.expenseDate,
          description: merged.description,
          notes: merged.notes,
          paidByUserId: merged.paidByUserId,
          categoryId: refs.category._id,
          accountId: refs.account._id,
          platformId: refs.platform?._id,
          referenceLabels: {
            category: refs.category.name,
            account: refs.account.name,
            platform: refs.platform?.name ?? "Other",
          },
          paymentMode: merged.paymentMode,
          originalAmount: decimal(merged.originalAmount),
          originalCurrency: merged.originalCurrency,
          conversion,
          postingState:
            expense.reviewState === "archive_review_required" ||
            merged.expenseDate > dateInZone(bucket.timezone) ||
            conversion?.status === "missing"
              ? "unposted"
              : "posted",
          dueAt: dueInstant(merged.expenseDate, bucket.timezone),
          postedAt:
            expense.reviewState === "archive_review_required" ||
            merged.expenseDate > dateInZone(bucket.timezone) ||
            conversion?.status === "missing"
              ? null
              : new Date(),
        });
      }
      expense.revision += 1;
      await expense.save({ session });
      if (expense.source?.kind === "emi" && expense.source.emiInstallmentId) {
        const installment = await EmiInstallmentModel.findOne({
          _id: expense.source.emiInstallmentId,
          expenseId: expense._id,
        }).session(session);
        if (installment) {
          if (action === "delete") installment.state = "unpaid";
          else if (action === "restore" || action === "edit") {
            installment.state = expense.postingState === "posted" ? "recorded" : "scheduled";
            installment.scheduledDate = expense.expenseDate;
            installment.amount = expense.originalAmount;
            installment.currency = expense.originalCurrency;
          }
          installment.revision += 1;
          await installment.save({ session });
          if (action === "delete" && expense.source.emiPlanId)
            await EmiPlanModel.updateOne(
              { _id: expense.source.emiPlanId, state: "completed" },
              { $set: { state: "active" }, $inc: { revision: 1 } },
              { session },
            );
          if (action === "restore" && expense.source.emiPlanId) {
            const plan = await EmiPlanModel.findById(expense.source.emiPlanId).session(session);
            if (
              plan?.state === "active" &&
              plan.generatedThroughNumber === plan.totalInstallments &&
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
        }
      }
      await BucketModel.updateOne(
        { _id: bucketId },
        { $inc: { financialRevision: 1, exportRevision: 1 } },
        { session },
      );
      await reconcileBudgetThresholds(bucketId, affectedDates, budgetBefore, session);
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: actor._id,
            action: `expense.${action}`,
            changedFields,
            entityId: expense._id,
            operationKey: key,
          },
        ],
        { session },
      );
      await recordDomainEvent(session, {
        eventKey: `expense.${action}:${key}`,
        type: action === "delete" ? "expense.deleted" : "expense.edited",
        actorUserId: actor._id,
        bucketId,
        entityType: "expense",
        entityId: expense._id,
      });
      return {
        resourceId: expenseId,
        status: 200,
        data: await expenseDto(expense, String(actor._id), session),
      };
    },
    async (id, session) => replayExpense(identity, bucketId, id, session),
  );
}

export async function resolveArchiveExpense(
  identity: DecodedIdToken,
  bucketId: string,
  expenseId: string,
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(expenseId);
  const { decision } = z
    .object({ decision: z.enum(["post", "cancel"]) })
    .strict()
    .parse(raw);
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const candidate = await ExpenseModel.findOne({
    _id: expenseId,
    bucketId,
    actualCreatorUserId: user._id,
    reviewState: "archive_review_required",
    postingState: "unposted",
    deletedAt: null,
  });
  if (!candidate) throw missing();
  if (candidate.expenseDate > dateInZone(bucket.timezone))
    throw new ApiError(409, "INVALID_STATE_TRANSITION", "This expense is not due yet.");
  const conversion =
    decision === "post"
      ? candidate.conversion?.manualFixed && candidate.conversion.convertedAmount
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
          )
      : null;
  if (decision === "post" && conversion?.status !== "final")
    throw new ApiError(
      422,
      "INVALID_CONVERSION",
      "Resolve this expense's conversion before posting it.",
    );
  return mutate(
    identity,
    `expense:${bucketId}:${expenseId}:archive-resolution`,
    key,
    { decision, revisionHeader },
    async (session) => {
      const actor = await activeUser(identity, session);
      await bucketForUser(bucketId, actor, session, true);
      const membership = await MembershipModel.findOne({
        bucketId,
        userId: actor._id,
        state: "active",
      }).session(session);
      const expense = await ExpenseModel.findOne({
        _id: expenseId,
        bucketId,
        actualCreatorUserId: actor._id,
        creatorMembershipId: membership?._id,
        reviewState: "archive_review_required",
        postingState: "unposted",
        deletedAt: null,
      }).session(session);
      if (!expense) throw missing();
      assertRevision(revisionHeader, expense.revision);
      const before = await captureBudgetUsage(bucketId, [expense.expenseDate], session);
      if (decision === "post") {
        expense.conversion = conversion!;
        expense.postingState = "posted";
        expense.postedAt = new Date();
      } else expense.postingState = "canceled";
      expense.reviewState = "none";
      expense.revision += 1;
      await expense.save({ session });
      if (expense.source?.emiInstallmentId)
        await EmiInstallmentModel.updateOne(
          { _id: expense.source.emiInstallmentId },
          { $set: { state: decision === "post" ? "recorded" : "unpaid" }, $inc: { revision: 1 } },
          { session },
        );
      await BucketModel.updateOne(
        { _id: bucketId },
        { $inc: { financialRevision: 1, exportRevision: 1 } },
        { session },
      );
      await reconcileBudgetThresholds(bucketId, [expense.expenseDate], before, session);
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: actor._id,
            action: `scheduled.archive_${decision}`,
            entityId: expense._id,
            operationKey: key,
          },
        ],
        { session },
      );
      return {
        resourceId: expenseId,
        status: 200,
        data: await expenseDto(expense, String(actor._id), session),
      };
    },
    async (id, session) => {
      const actor = await activeUser(identity, session);
      await bucketForUser(bucketId, actor, session);
      const expense = await ExpenseModel.findById(id).session(session);
      if (!expense || String(expense.actualCreatorUserId) !== String(actor._id)) throw missing();
      return expenseDto(expense, String(actor._id), session);
    },
  );
}

export async function listComments(identity: DecodedIdToken, bucketId: string, expenseId: string) {
  await getExpense(identity, bucketId, expenseId);
  const user = await activeUser(identity);
  const comments = await CommentModel.find({ bucketId, expenseId, deletedAt: null }).sort({
    createdAt: 1,
  });
  const people = await UserModel.find({
    _id: { $in: comments.map((comment) => comment.authorUserId) },
  });
  const names = new Map(people.map((person) => [String(person._id), person.displayName]));
  return comments.map((comment) => ({
    id: String(comment._id),
    authorUserId: String(comment.authorUserId),
    authorName: names.get(String(comment.authorUserId)) ?? "Former member",
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt?.toISOString() ?? null,
    revision: comment.revision,
    canEdit: String(comment.authorUserId) === String(user._id),
  }));
}

export async function changeComment(
  identity: DecodedIdToken,
  bucketId: string,
  expenseId: string,
  commentId: string | null,
  action: "create" | "edit" | "delete",
  raw: unknown,
  key: string,
  revisionHeader: string | null,
) {
  objectId.parse(expenseId);
  if (commentId) objectId.parse(commentId);
  const input = action === "delete" ? {} : commentInput.parse(raw);
  return mutate(
    identity,
    `comment:${bucketId}:${expenseId}:${commentId ?? "new"}:${action}`,
    key,
    { input, revisionHeader },
    async (session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session, true);
      const expense = await ExpenseModel.findOne({
        _id: expenseId,
        bucketId,
        deletedAt: null,
      }).session(session);
      if (!expense) throw missing();
      let comment;
      if (action === "create") {
        [comment] = await CommentModel.create(
          [{ bucketId, expenseId, authorUserId: user._id, body: (input as { body: string }).body }],
          { session },
        );
      } else {
        comment = await CommentModel.findOne({
          _id: commentId,
          bucketId,
          expenseId,
          authorUserId: user._id,
          deletedAt: null,
        }).session(session);
        if (!comment)
          throw new ApiError(404, "RESOURCE_NOT_FOUND", "This comment is not available.");
        assertRevision(revisionHeader, comment.revision);
        if (action === "delete") comment.deletedAt = new Date();
        else {
          comment.body = (input as { body: string }).body;
          comment.editedAt = new Date();
        }
        comment.revision += 1;
        await comment.save({ session });
      }
      await AuditModel.create(
        [
          {
            bucketId,
            actorUserId: user._id,
            action: `comment.${action}`,
            entityId: comment._id,
            operationKey: key,
          },
        ],
        { session },
      );
      if (action === "create")
        await recordDomainEvent(session, {
          eventKey: `comment.added:${key}`,
          type: "comment.added",
          actorUserId: user._id,
          bucketId,
          entityType: "expense",
          entityId: expense._id,
        });
      await BucketModel.updateOne({ _id: bucketId }, { $inc: { exportRevision: 1 } }, { session });
      return {
        resourceId: String(comment._id),
        status: action === "create" ? 201 : 200,
        data: {
          id: String(comment._id),
          body: comment.body,
          revision: comment.revision,
          deleted: Boolean(comment.deletedAt),
        },
      };
    },
    async (id, session) => {
      const user = await activeUser(identity, session);
      await bucketForUser(bucketId, user, session);
      const comment = await CommentModel.findById(id).session(session);
      return {
        id,
        body: comment?.body,
        revision: comment?.revision,
        deleted: Boolean(comment?.deletedAt),
      };
    },
  );
}
