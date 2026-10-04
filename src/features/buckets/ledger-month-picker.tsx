"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { controls } from "@/components/control-styles";

const months = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2025, index, 1)),
  ),
);

function monthLabel(value: string, style: "long" | "short") {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return "All months";
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: style, year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export function LedgerMonthPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (month: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState(
    Number(value.slice(0, 4)) || new Date().getFullYear(),
  );
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function select(month: string) {
    onChange(month);
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        className={`${controls.secondary} shrink-0 shadow-sm`}
        aria-label={`Ledger month: ${monthLabel(value, "long")}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="ledger-month-menu"
        onClick={() => {
          setVisibleYear(Number(value.slice(0, 4)) || new Date().getFullYear());
          setOpen((current) => !current);
        }}
      >
        <CalendarDays
          size={16}
          className="hidden text-[var(--muted)] sm:block max-[450px]:!block"
          aria-hidden="true"
        />
        <span className="hidden whitespace-nowrap sm:inline">{monthLabel(value, "long")}</span>
        <span className="whitespace-nowrap sm:hidden max-[450px]:hidden">
          {monthLabel(value, "short")}
        </span>
        <ChevronDown
          size={14}
          className="text-[var(--muted)] max-[450px]:hidden"
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          id="ledger-month-menu"
          role="dialog"
          aria-label="Choose ledger month"
          className={controls.pickerContent}
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              className="grid size-8 place-items-center rounded-lg hover:bg-[var(--soft)]"
              aria-label="Previous year"
              onClick={() => setVisibleYear((year) => year - 1)}
            >
              <ChevronLeft size={17} />
            </button>
            <strong className="text-sm">{visibleYear}</strong>
            <button
              type="button"
              className="grid size-8 place-items-center rounded-lg hover:bg-[var(--soft)]"
              aria-label="Next year"
              onClick={() => setVisibleYear((year) => year + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {months.map((month, index) => {
              const option = `${visibleYear}-${String(index + 1).padStart(2, "0")}`;
              const selected = option === value;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  className={`h-9 rounded-lg text-xs font-medium transition-colors ${selected ? "bg-[var(--button-primary)] !text-white dark:!text-[#17251e]" : "hover:bg-[var(--soft)]"}`}
                  onClick={() => select(option)}
                >
                  {month}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="mt-3 w-full border-t border-[var(--line)] pt-3 text-center text-xs font-semibold text-[var(--green)] hover:underline !rounded-none"
            onClick={() => select("")}
          >
            Show all months
          </button>
        </div>
      )}
    </div>
  );
}
