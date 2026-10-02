import { z } from "zod";
import { objectId } from "@/features/expenses/contracts";

const percentage = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) > 0 && Number(value) <= 100);

const budgetBase = z
  .object({
    name: z.string().trim().min(1).max(80),
    scope: z.enum(["shared", "member"]),
    categoryIds: z
      .array(objectId)
      .min(1)
      .max(30)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length),
    limitAmount: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/),
    periodType: z.enum(["monthly", "custom"]),
    from: z.iso.date().optional(),
    toExclusive: z.iso.date().optional(),
    thresholdPercentages: z.array(percentage).max(20).default([]),
  })
  .strict();

export const budgetInput = budgetBase.superRefine((value, context) => {
  if (value.periodType === "custom") {
    if (!value.from || !value.toExclusive || value.from >= value.toExclusive)
      context.addIssue({ code: "custom", message: "Choose a valid custom date range." });
  } else if (value.from || value.toExclusive) {
    context.addIssue({ code: "custom", message: "Monthly budgets do not use custom dates." });
  }
  if (new Set(value.thresholdPercentages.map(Number)).size !== value.thresholdPercentages.length)
    context.addIssue({ code: "custom", message: "Alert thresholds must be unique." });
});

export const budgetEditInput = budgetBase.omit({ scope: true }).partial().strict();

export type Budget = {
  id: string;
  name: string;
  scope: "shared" | "member";
  categoryIds: string[];
  categoryNames: string[];
  limitAmount: string;
  currency: string;
  periodType: "monthly" | "custom";
  from: string | null;
  toExclusive: string | null;
  thresholdPercentages: string[];
  state: "active" | "historical";
  ownerName: string;
  canManage: boolean;
  revision: number;
};

export type BudgetUsage = {
  currency: string;
  from: string;
  toExclusive: string;
  limitAmount: string;
  usedAmount: string;
  remainingAmount: string;
  exceededAmount: string;
  usagePercent: number;
  incompleteCount: number;
  financialRevision: number;
  handledThresholds: { percentage: string; handledAt: string; reason: string }[];
};

export type SpendingGroup = { id: string; name: string; amount: string; count: number };
export type SpendingReport = {
  currency: string;
  from: string;
  toExclusive: string;
  totalAmount: string;
  actualCount: number;
  incompleteCount: number;
  pendingCount: number;
  scheduledCount: number;
  scheduledAmount: string;
  groups: SpendingGroup[];
  financialRevision: number;
};
