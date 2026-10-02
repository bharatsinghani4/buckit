import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { ApiError } from "@/lib/api/errors";
import {
  BucketModel,
  EmiInstallmentModel,
  EmiPlanModel,
  ExpenseModel,
  UserModel,
} from "@/lib/db/models";
import { activeUser, bucketForUser } from "@/features/identity/service";
import { fromMinor } from "@/features/expenses/money";
import { listBudgets } from "./budget-service";
import { periodRange, priorElapsedRange, todayInZone, units } from "./calculations";

const datePattern = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const groupFields = [
  "category",
  "account",
  "platform",
  "payment_mode",
  "member",
  "day",
  "month",
] as const;
type GroupBy = (typeof groupFields)[number];

function parseRange(params: URLSearchParams, today: string) {
  const period = params.get("period") ?? "month";
  const anchor = params.get("anchorDate") ?? today;
  if (!datePattern.test(anchor)) throw new ApiError(422, "INVALID_DATE", "Choose a valid date.");
  const from = params.get("from") ?? undefined;
  const toExclusive = params.get("toExclusive") ?? undefined;
  if ((from && !datePattern.test(from)) || (toExclusive && !datePattern.test(toExclusive)))
    throw new ApiError(422, "INVALID_DATE", "Choose a valid date range.");
  try {
    const range = periodRange(period, anchor, from, toExclusive);
    const days = (Date.parse(range.toExclusive) - Date.parse(range.from)) / 86_400_000;
    if (days < 1 || days > 3660) throw new Error("Range too long");
    return { ...range, period, anchor };
  } catch {
    throw new ApiError(422, "INVALID_DATE", "Choose a valid reporting period.");
  }
}

async function spending(
  bucketId: string,
  currency: string,
  financialRevision: number,
  from: string,
  toExclusive: string,
  today: string,
  groupBy: GroupBy,
  filters: URLSearchParams,
) {
  const match: Record<string, unknown> = {
    bucketId,
    deletedAt: null,
    postingState: { $ne: "canceled" },
    expenseDate: { $gte: from, $lt: toExclusive },
  };
  for (const [parameter, field] of [
    ["categoryId", "categoryId"],
    ["accountId", "accountId"],
    ["platformId", "platformId"],
    ["paidByUserId", "paidByUserId"],
  ]) {
    const value = filters.get(parameter);
    if (value) {
      if (!/^[a-f\d]{24}$/i.test(value))
        throw new ApiError(422, "INVALID_FILTER", "Choose a valid filter.");
      match[field] = value;
    }
  }
  const paymentMode = filters.get("paymentMode");
  if (paymentMode) {
    if (!["upi", "cash", "neft", "imps", "credit_card"].includes(paymentMode))
      throw new ApiError(422, "INVALID_FILTER", "Choose a valid payment mode.");
    match.paymentMode = paymentMode;
  }
  const memberNames = new Map<string, string>();
  const groups = new Map<string, { id: string; name: string; amount: bigint; count: number }>();
  let total = 0n;
  let scheduled = 0n;
  let actualCount = 0;
  let incompleteCount = 0;
  let pendingCount = 0;
  let scheduledCount = 0;
  for await (const row of ExpenseModel.find(match).lean().cursor()) {
    const date = row.expenseDate as string;
    const conversion = row.conversion as
      { status?: string; convertedAmount?: { toString(): string } } | undefined;
    if (date > today) {
      scheduledCount++;
      if (conversion?.convertedAmount)
        scheduled += units(conversion.convertedAmount.toString(), currency);
      continue;
    }
    if (conversion?.status === "missing") {
      incompleteCount++;
      continue;
    }
    if (
      row.postingState !== "posted" ||
      conversion?.status !== "final" ||
      !conversion.convertedAmount
    ) {
      pendingCount++;
      continue;
    }
    const amount = units(conversion.convertedAmount.toString(), currency);
    total += amount;
    actualCount++;
    const labels = row.referenceLabels as
      { category?: string; account?: string; platform?: string } | undefined;
    let id = "";
    let name = "";
    if (groupBy === "category" || groupBy === "account" || groupBy === "platform") {
      id = String(row[`${groupBy}Id` as keyof typeof row] ?? "other");
      name = labels?.[groupBy] ?? "Other";
    } else if (groupBy === "member") {
      id = String(row.paidByUserId);
      if (!memberNames.has(id)) {
        const user = await UserModel.findById(id).select("displayName");
        memberNames.set(id, user?.displayName ?? "Former member");
      }
      name = memberNames.get(id)!;
    } else if (groupBy === "payment_mode") {
      id = String(row.paymentMode);
      name = id.replaceAll("_", " ").toUpperCase();
    } else {
      id = groupBy === "month" ? date.slice(0, 7) : date;
      name = id;
    }
    const existing = groups.get(id) ?? { id, name, amount: 0n, count: 0 };
    existing.amount += amount;
    existing.count++;
    groups.set(id, existing);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    groupBy === "day" || groupBy === "month"
      ? a.id.localeCompare(b.id)
      : a.amount === b.amount
        ? a.name.localeCompare(b.name)
        : a.amount > b.amount
          ? -1
          : 1,
  );
  return {
    currency,
    from,
    toExclusive,
    totalAmount: fromMinor(total, currency),
    actualCount,
    incompleteCount,
    pendingCount,
    scheduledCount,
    scheduledAmount: fromMinor(scheduled, currency),
    groups: ordered.map((group) => ({
      id: group.id,
      name: group.name,
      amount: fromMinor(group.amount, currency),
      count: group.count,
    })),
    financialRevision,
  };
}

async function spendingReportOnce(
  identity: DecodedIdToken,
  bucketId: string,
  params: URLSearchParams,
) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const today = todayInZone(bucket.timezone);
  const range = parseRange(params, today);
  const groupBy = params.get("groupBy") ?? "category";
  if (!groupFields.includes(groupBy as GroupBy))
    throw new ApiError(422, "INVALID_GROUP", "Choose a valid report grouping.");
  return spending(
    bucketId,
    bucket.primaryCurrency,
    bucket.financialRevision,
    range.from,
    range.toExclusive,
    today,
    groupBy as GroupBy,
    params,
  );
}

export async function spendingReport(
  identity: DecodedIdToken,
  bucketId: string,
  params: URLSearchParams,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await spendingReportOnce(identity, bucketId, params);
    const latest = await BucketModel.findById(bucketId).select("financialRevision");
    if (latest?.financialRevision === result.financialRevision) return result;
  }
  throw new ApiError(409, "DATA_CHANGED", "Spending changed while loading. Try again.");
}

async function dashboardOnce(identity: DecodedIdToken, bucketId: string, params: URLSearchParams) {
  const user = await activeUser(identity);
  const bucket = await bucketForUser(bucketId, user);
  const today = todayInZone(bucket.timezone);
  const range = parseRange(params, today);
  const previousRange = priorElapsedRange(range.from, range.toExclusive, today, range.period);
  const empty = new URLSearchParams();
  const [
    category,
    member,
    trend,
    previous,
    budgets,
    recent,
    activeEmiPlans,
    upcomingInstallments,
    unpaidInstallments,
    nextInstallment,
  ] = await Promise.all([
    spending(
      bucketId,
      bucket.primaryCurrency,
      bucket.financialRevision,
      range.from,
      range.toExclusive,
      today,
      "category",
      empty,
    ),
    spending(
      bucketId,
      bucket.primaryCurrency,
      bucket.financialRevision,
      range.from,
      range.toExclusive,
      today,
      "member",
      empty,
    ),
    spending(
      bucketId,
      bucket.primaryCurrency,
      bucket.financialRevision,
      range.from,
      range.toExclusive,
      today,
      "day",
      empty,
    ),
    spending(
      bucketId,
      bucket.primaryCurrency,
      bucket.financialRevision,
      previousRange.from,
      previousRange.toExclusive,
      today,
      "category",
      empty,
    ),
    listBudgets(identity, bucketId, range.anchor.slice(0, 7)),
    ExpenseModel.find({ bucketId, deletedAt: null, postingState: { $ne: "canceled" } })
      .sort({ expenseDate: -1, _id: -1 })
      .limit(5)
      .lean(),
    EmiPlanModel.countDocuments({ bucketId, state: "active" }),
    EmiInstallmentModel.countDocuments({ bucketId, state: "scheduled" }),
    EmiInstallmentModel.countDocuments({ bucketId, state: { $in: ["skipped", "unpaid"] } }),
    EmiInstallmentModel.findOne({ bucketId, state: "scheduled" })
      .sort({ scheduledDate: 1 })
      .select("scheduledDate"),
  ]);
  const latest = await BucketModel.findById(bucketId).select("financialRevision writeRevision");
  return {
    ...category,
    period: range.period,
    comparable: {
      from: previousRange.from,
      toExclusive: previousRange.toExclusive,
      totalAmount: previous.totalAmount,
    },
    categories: category.groups,
    members: member.groups,
    trend: trend.groups,
    budgetCount: budgets.filter((entry) => entry.budget.state === "active").length,
    emi: {
      activePlans: activeEmiPlans,
      upcomingInstallments,
      unpaidInstallments,
      nextDate: nextInstallment?.scheduledDate ?? null,
    },
    budgets: budgets.filter((entry) => entry.budget.state === "active").slice(0, 4),
    recentExpenses: recent.map((row) => ({
      id: String(row._id),
      description: row.description,
      date: row.expenseDate,
      category: row.referenceLabels?.category ?? "Other",
      amount: row.conversion?.convertedAmount?.toString() ?? null,
      status:
        row.expenseDate > today
          ? "scheduled"
          : row.conversion?.status === "missing"
            ? "conversion_needed"
            : row.postingState === "posted"
              ? "actual"
              : "pending",
    })),
    stale:
      latest?.financialRevision !== bucket.financialRevision ||
      latest?.writeRevision !== bucket.writeRevision,
  };
}

export async function dashboard(
  identity: DecodedIdToken,
  bucketId: string,
  params: URLSearchParams,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await dashboardOnce(identity, bucketId, params);
    if (!result.stale) return result;
  }
  throw new ApiError(409, "DATA_CHANGED", "Spending changed while loading. Try again.");
}
