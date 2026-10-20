import { paymentModes, type Expense } from "./contracts";

export type PaymentMode = Expense["paymentMode"];
export type PaymentModeOption = { value: PaymentMode; label: string };

const labels: Record<PaymentMode, string> = {
  upi: "UPI",
  cash: "Cash",
  neft: "NEFT",
  imps: "IMPS",
  credit_card: "Credit card",
  auto_debit: "Auto debit",
};

export const defaultPaymentModes: PaymentModeOption[] = paymentModes.map((value) => ({
  value,
  label: labels[value],
}));

export type PaymentModeSettings = {
  modes: PaymentModeOption[];
  revision: number;
};

export function paymentModeOptions(overrides: Partial<Record<PaymentMode, string>>) {
  return defaultPaymentModes.map((mode) => ({
    ...mode,
    label: overrides[mode.value] || mode.label,
  }));
}
