import "server-only";
import { createHash } from "node:crypto";
import { RecurringPlanModel } from "@/lib/db/models";
import { currentReferenceName, currentReferenceNames } from "@/features/expenses/reference-labels";
import { fromMinor, minorUnits } from "@/features/expenses/money";
import { recurringDate, type RecurringFrequency } from "./recurring-dates";

export type RecurringCommitments = {
  count: number;
  amount: string;
  unconvertedCount: number;
  entries?: RecurringCommitmentEntry[];
};

export type RecurringCommitmentEntry = {
  id: string;
  planId: string;
  expenseDate: string;
  description: string;
  amount: string;
  currency: string;
  categoryId: string;
  categoryName: string;
  accountId: string;
  accountName: string;
  platformId: string;
  platformName: string;
  paidByUserId: string;
  actualCreatorUserId: string;
  paymentMode: string;
  revision: number;
};

export async function recurringCommitments(
  bucketId: string,
  currency: string,
  from: string,
  toExclusive: string,
  today: string,
  filters = new URLSearchParams(),
  includeEntries = false,
): Promise<RecurringCommitments> {
  const firstDay =
    from > today
      ? from
      : new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (firstDay >= toExclusive) return { count: 0, amount: "0", unconvertedCount: 0 };

  const match: Record<string, unknown> = {
    bucketId,
    state: "active",
    startDate: { $lt: toExclusive },
    $and: [{ $or: [{ endDate: null }, { endDate: { $gte: firstDay } }] }],
  };
  for (const field of ["categoryId", "accountId", "platformId", "paidByUserId", "paymentMode"])
    if (filters.get(field)) match[field] = filters.get(field);
  if (filters.get("categoryIds"))
    match.categoryId = { $in: filters.get("categoryIds")!.split(",") };
  const search = filters.get("q")?.trim();
  if (search) {
    const expression = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 100);
    (match.$and as Record<string, unknown>[]).push({
      $or: [
        { title: { $regex: expression, $options: "i" } },
        { "referenceLabels.platform": { $regex: expression, $options: "i" } },
      ],
    });
  }

  const plans = await RecurringPlanModel.find(match)
    .select(
      "title amount currency frequency startDate endDate nextIndex skippedDates categoryId accountId platformId referenceLabels paidByUserId actualCreatorUserId paymentMode revision",
    )
    .lean();
  const referenceNames = includeEntries
    ? await currentReferenceNames(bucketId, plans)
    : new Map<string, string>();
  let count = 0;
  let amount = 0n;
  let unconvertedCount = 0;
  const entries: RecurringCommitmentEntry[] = [];
  for (const plan of plans) {
    const frequency = plan.frequency as RecurringFrequency;
    const skippedDates = new Set(plan.skippedDates ?? []);
    // nextIndex skips installments already recorded by the plan.
    for (let index = plan.nextIndex; index < plan.nextIndex + 2_000; index++) {
      const date = recurringDate(plan.startDate, frequency, index);
      if (date >= toExclusive || (plan.endDate && date > plan.endDate)) break;
      if (skippedDates.has(date)) continue;
      if (date < firstDay) continue;
      count++;
      if (plan.currency === currency) amount += minorUnits(plan.amount.toString(), currency);
      else unconvertedCount++;
      if (includeEntries) {
        const planId = String(plan._id);
        entries.push({
          id: createHash("sha256").update(`${planId}:${date}`).digest("hex").slice(0, 24),
          planId,
          expenseDate: date,
          description: plan.title,
          amount: plan.amount.toString(),
          currency: plan.currency,
          categoryId: String(plan.categoryId),
          categoryName: currentReferenceName(
            referenceNames,
            plan.categoryId,
            plan.referenceLabels?.category,
            "Category",
          ),
          accountId: String(plan.accountId),
          accountName: currentReferenceName(
            referenceNames,
            plan.accountId,
            plan.referenceLabels?.account,
            "Account",
          ),
          platformId: plan.platformId ? String(plan.platformId) : "",
          platformName: currentReferenceName(
            referenceNames,
            plan.platformId,
            plan.referenceLabels?.platform,
            "Other",
          ),
          paidByUserId: String(plan.paidByUserId),
          actualCreatorUserId: String(plan.actualCreatorUserId),
          paymentMode: plan.paymentMode,
          revision: plan.revision,
        });
      }
    }
  }
  return {
    count,
    amount: fromMinor(amount, currency),
    unconvertedCount,
    ...(includeEntries ? { entries } : {}),
  };
}
