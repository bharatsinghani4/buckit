"use client";

import { X } from "lucide-react";
import { CalendarField } from "@/components/calendar-field";

export function LedgerMonthPicker({
  value,
  onChange,
  onClear,
  fullWidth = false,
}: {
  value: string;
  onChange: (month: string) => void;
  onClear?: () => void;
  fullWidth?: boolean;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-1 ${fullWidth ? "w-full" : ""}`}>
      <CalendarField
        mode="month"
        value={value}
        onValueChange={onChange}
        aria-label="Ledger month"
        containerClassName={fullWidth ? "flex-1" : ""}
        className={fullWidth ? "!w-full" : "w-40 max-[900px]:w-32"}
      />
      {value && (
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--soft)]"
          aria-label="Reset to current month"
          title="Reset to current month"
          onClick={() => (onClear ? onClear() : onChange(""))}
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
