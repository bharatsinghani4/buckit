import { paymentModes } from "./contracts";

export type PaymentMode = string;
export type PaymentModeOption = { value: PaymentMode; label: string; usageCount?: number };

const labels: Record<(typeof paymentModes)[number], string> = {
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

export function paymentModeOptions(overrides: Record<string, string>) {
  const builtIn = defaultPaymentModes.map((mode) => ({
    ...mode,
    label: overrides[mode.value] || mode.label,
  }));
  const custom = Object.entries(overrides)
    .filter(([value]) => /^custom_[a-f\d]{24}$/i.test(value))
    .map(([value, label]) => ({ value, label }));
  return [...builtIn, ...custom.sort((a, b) => a.label.localeCompare(b.label))];
}
