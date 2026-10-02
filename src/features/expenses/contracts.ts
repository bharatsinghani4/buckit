import { z } from "zod";
import { currencies } from "@/features/identity/contracts";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i);
export const optionKinds = {
  accounts: "account",
  categories: "category",
  platforms: "platform",
} as const;
export type OptionKind = keyof typeof optionKinds;
export const paymentModes = ["upi", "cash", "neft", "imps", "credit_card"] as const;
export const amountSchema = z.string().regex(/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/);
export const expenseInput = z
  .object({
    expenseDate: z.iso.date(),
    description: z.string().trim().min(1).max(160),
    paidByUserId: objectId,
    categoryId: objectId,
    accountId: objectId,
    platformId: objectId.optional(),
    paymentMode: z.enum(paymentModes),
    originalAmount: amountSchema,
    originalCurrency: z
      .string()
      .refine((code) => currencies.some((currency) => currency.code === code))
      .optional(),
    notes: z.string().max(2000).default(""),
    refundOfExpenseId: objectId.optional(),
    manualConversion: z
      .discriminatedUnion("method", [
        z.object({ method: z.literal("manual_amount"), convertedAmount: amountSchema }),
        z.object({
          method: z.literal("manual_rate"),
          rate: z.string().regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,8})?$/),
        }),
      ])
      .optional(),
  })
  .strict();
export const expenseEditInput = expenseInput
  .omit({ refundOfExpenseId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export const optionInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    iconKey: z.string().max(40).optional(),
    ownerLabel: z.string().trim().max(80).optional(),
  })
  .strict();
export const optionEditInput = optionInput
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export const commentInput = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
export const conversionPreviewInput = z
  .object({
    expenseDate: z.iso.date(),
    originalAmount: amountSchema,
    originalCurrency: z
      .string()
      .refine((code) => currencies.some((currency) => currency.code === code)),
  })
  .strict();

export type ExpenseInput = Omit<z.infer<typeof expenseInput>, "originalCurrency"> & {
  originalCurrency: string;
};
export type Expense = {
  id: string;
  bucketId: string;
  expenseDate: string;
  description: string;
  notes: string;
  paidByUserId: string;
  paidByName: string;
  addedByUserId: string;
  addedByName: string;
  actualCreatorUserId: string;
  categoryId: string;
  categoryName: string;
  accountId: string;
  accountName: string;
  platformId: string;
  platformName: string;
  paymentMode: (typeof paymentModes)[number];
  originalAmount: string;
  originalCurrency: string;
  bucketCurrency: string;
  convertedAmount: string | null;
  conversionStatus: "final" | "estimated" | "missing";
  rate: string | null;
  rateDate: string | null;
  displayStatus:
    | "actual"
    | "scheduled"
    | "pending_processing"
    | "conversion_needed"
    | "archive_review"
    | "deleted";
  refundOfExpenseId: string | null;
  deletedAt: string | null;
  restoreUntil: string | null;
  revision: number;
  source?: { kind: "manual" } | { kind: "emi"; planId: string; installmentId: string };
  permissions: { canEdit: boolean; canDelete: boolean; canRestore: boolean; canComment: boolean };
};
export type Option = {
  id: string;
  name: string;
  kind: "account" | "category" | "platform";
  state: "active" | "archived";
  iconKey?: string;
  ownerLabel?: string;
  revision: number;
  usageCount: number;
  budgetCount?: number;
  systemKey?: string;
};
export type Member = {
  id: string;
  membershipId: string;
  displayName: string;
  isOwner: boolean;
  joinedAt: string;
  revision: number;
};
export type Comment = {
  id: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  revision: number;
  canEdit: boolean;
};
