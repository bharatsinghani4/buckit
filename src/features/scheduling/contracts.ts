import { z } from "zod";
import { currencies } from "@/features/identity/contracts";
import { amountSchema, objectId, paymentModes } from "@/features/expenses/contracts";

const planBase = z
  .object({
    title: z.string().trim().min(1).max(160),
    installmentAmount: amountSchema,
    currency: z.string().refine((code) => currencies.some((item) => item.code === code)),
    totalInstallments: z.number().int().min(1).max(120),
    previouslyPaidCount: z.number().int().min(0).default(0),
    firstInstallmentDate: z.iso.date(),
    categoryId: objectId,
    accountId: objectId,
    platformId: objectId.optional(),
    paymentMode: z.enum(paymentModes),
    paidByUserId: objectId,
  })
  .strict();

export const planInput = planBase.refine(
  (value) => value.previouslyPaidCount < value.totalInstallments,
  {
    message: "At least one installment must remain.",
    path: ["previouslyPaidCount"],
  },
);

export const planEditInput = planBase
  .omit({ previouslyPaidCount: true, firstInstallmentDate: true, totalInstallments: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export type PlanInput = z.infer<typeof planInput>;
export type Plan = {
  id: string;
  bucketId: string;
  title: string;
  installmentAmount: string;
  currency: string;
  totalInstallments: number;
  previouslyPaidCount: number;
  firstInstallmentDate: string;
  generatedThroughNumber: number;
  state: "active" | "ended" | "completed" | "owner_departed";
  revision: number;
  creatorName: string;
  isCreator: boolean;
  categoryId: string;
  accountId: string;
  platformId: string;
  categoryName: string;
  accountName: string;
  platformName: string;
  paymentMode: (typeof paymentModes)[number];
  paidByUserId: string;
  recordedCount: number;
  upcomingCount: number;
  unpaidCount: number;
  nextDate: string | null;
};

export type Installment = {
  id: string;
  number: number;
  scheduledDate: string;
  originalScheduledDate: string;
  amount: string;
  currency: string;
  state: "scheduled" | "recorded" | "skipped" | "unpaid" | "canceled";
  expenseId: string | null;
  expenseRevision: number | null;
  revision: number;
};
